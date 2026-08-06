'use client';

/**
 * @file MapaGPS.tsx
 * @description Rastreamento GPS ao vivo — motoristas + localização real do dispositivo.
 *
 * Duas capacidades:
 *   1. Ver os motoristas e a sua posição GPS no mapa (GET /v1/drivers/locations).
 *   2. "Pegar a localização atual" — captura o GPS real deste dispositivo via a
 *      Geolocation API do browser (watchPosition) e, opcionalmente, transmite-o
 *      para o backend como a posição de um motorista (PUT /v1/drivers/:id/gps),
 *      fechando o ciclo captura → mapa.
 *
 * Robustez de localização:
 *   - A Geolocation API só funciona em contexto seguro (HTTPS ou localhost). Se
 *     for aberto por um IP em http, avisamos explicitamente.
 *   - Mensagens de erro acionáveis por código (permissão negada / indisponível /
 *     timeout), incluindo o caso Windows (Serviços de Localização desligados).
 *   - Botão "Tentar novamente" (getCurrentPosition num gesto do utilizador, que é
 *     mais fiável a mostrar o pedido de permissão).
 *   - Fallback manual: clicar no mapa define a posição, mesmo sem GPS.
 *
 * Nota: a lista de posições exige autenticação (role ADMIN/SUPPORT). Por isso
 * usamos `fetchApi`, que anexa o JWT do localStorage — um `fetch` cru devolve 401
 * e o mapa fica vazio.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Circle, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { fetchApi, type UserLocation } from '@/services/api';

const POLL_INTERVAL_MS = 10_000;      // recarrega posições dos motoristas
const BROADCAST_INTERVAL_MS = 5_000;  // frequência de envio da minha posição

// ──────────────────────────────────────────────────────────────────────────
// Fix Leaflet icons (Next.js asset paths issue)
// ──────────────────────────────────────────────────────────────────────────
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// ──────────────────────────────────────────────────────────────────────────
// Ícones
// ──────────────────────────────────────────────────────────────────────────
function makeDriverIcon(tag: string, isSelected: boolean) {
  return L.divIcon({
    className: '',
    html: `
      <div style="
        width: 44px; height: 44px;
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 15px; font-weight: 700; color: #fff; letter-spacing: 0.5px;
        background: ${isSelected ? 'rgba(99,102,241,0.9)' : 'rgba(30,41,59,0.92)'};
        border: 3px solid ${isSelected ? '#818cf8' : 'rgba(99,102,241,0.4)'};
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        transition: all 0.3s ease;
        cursor: pointer;
      ">${tag}</div>`,
    iconSize:   [44, 44],
    iconAnchor: [22, 22],
    popupAnchor:[0, -26],
  });
}

/** Marcador pulsante "minha localização" (azul = parado, verde = a transmitir). */
function makeMyLocationIcon(isLive: boolean) {
  return L.divIcon({
    className: '',
    html: `<div class="gps-me-dot${isLive ? ' gps-me-dot--live' : ''}"></div>`,
    iconSize:   [18, 18],
    iconAnchor: [9, 9],
    popupAnchor:[0, -12],
  });
}

/** Marcador de "utilizador do sistema" (pino roxo com ícone de pessoa em SVG). */
function makeUserIcon() {
  return L.divIcon({
    className: '',
    html: `<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);
      background:rgba(168,85,247,0.92);border:2px solid #c084fc;box-shadow:0 3px 12px rgba(0,0,0,0.5);
      display:flex;align-items:center;justify-content:center;">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="#fff" style="transform:rotate(45deg);">
        <path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z"/></svg>
      </div>`,
    iconSize:   [26, 26],
    iconAnchor: [13, 26],
    popupAnchor:[0, -24],
  });
}

/** Abreviatura do tipo de veículo (sem emoji): M=Moto, V=Van, C=Carro, CM=Caminhão. */
function getVehicleTag(vehicleType: string): string {
  const t = vehicleType.toLowerCase();
  if (t.includes('moto')) return 'M';
  if (t.includes('van'))  return 'V';
  if (t.includes('cami')) return 'CM';
  return 'C';
}

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────
interface DriverLocation {
  id:             string;
  name:           string;
  vehicle: {
    type:          string;
    plate:         string;
    capacity_kg: number;
  };
  current_status:  string;
  gps: {
    lat:       number;
    lng:       number;
    heading:   number;
    speed:     number;
    updatedAt: string;
  } | null;
}

interface MyPosition {
  lat:      number;
  lng:      number;
  accuracy: number | null;  // metros (null = definido manualmente)
  heading:  number | null;
  speed:    number | null;  // m/s
  source:   'gps' | 'manual';
  at:       Date;
}

// ──────────────────────────────────────────────────────────────────────────
// MapController (flyTo)
// ──────────────────────────────────────────────────────────────────────────
function MapController({ target }: { target: { center: [number, number]; nonce: number } | null }) {
  const map = useMap();
  const prevNonce = useRef<number>(-1);

  useEffect(() => {
    if (target && target.nonce !== prevNonce.current) {
      map.flyTo(target.center, Math.max(map.getZoom(), 15), { animate: true, duration: 1.2 });
      prevNonce.current = target.nonce;
    }
  }, [target, map]);

  return null;
}

/** Captura cliques no mapa quando o modo manual está ativo. */
function ManualPicker({ active, onPick }: { active: boolean; onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      if (active) onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Main Component
// ──────────────────────────────────────────────────────────────────────────
export default function MapaGPS() {
  const [drivers,    setDrivers]    = useState<DriverLocation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [loadError,  setLoadError]  = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [flyTarget,  setFlyTarget]  = useState<{ center: [number, number]; nonce: number } | null>(null);

  // ── Localização real deste dispositivo ──
  const [myPos,      setMyPos]      = useState<MyPosition | null>(null);
  const [geoError,   setGeoError]   = useState<string | null>(null);
  const [geoDenied,  setGeoDenied]  = useState(false);   // permissão negada de forma persistente
  const [locating,   setLocating]   = useState(false);   // pedido em curso
  const [manualMode, setManualMode] = useState(false);   // a aguardar clique no mapa
  const myPosRef = useRef<MyPosition | null>(null);
  const didCenterOnMe = useRef(false);

  // ── Transmissão da minha posição como um motorista ──
  const [broadcastId,    setBroadcastId]    = useState<string>('');
  const [broadcasting,   setBroadcasting]   = useState(false);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const [lastBroadcast,  setLastBroadcast]  = useState<Date | null>(null);

  // ── Localização dos utilizadores do sistema (monitorização) ──
  const [showUsers,     setShowUsers]     = useState(false);
  const [userLocations, setUserLocations] = useState<UserLocation[]>([]);

  const flyToCenter = useCallback((center: [number, number]) => {
    setFlyTarget({ center, nonce: Date.now() });
  }, []);

  // ── Aplica uma leitura de posição (GPS ou manual) ──
  const applyPosition = useCallback((p: MyPosition) => {
    myPosRef.current = p;
    setMyPos(p);
    setGeoError(null);
    setGeoDenied(false);
    if (!didCenterOnMe.current) {
      didCenterOnMe.current = true;
      flyToCenter([p.lat, p.lng]);
    }
  }, [flyToCenter]);

  // ── Traduz um erro da Geolocation API em mensagem acionável ──
  const handleGeoError = useCallback((err: GeolocationPositionError) => {
    setLocating(false);
    if (err.code === err.PERMISSION_DENIED) {
      setGeoDenied(true);
      setGeoError('Permissão de localização negada. Clique no ícone 🔒 na barra de endereço → Localização → Permitir, e volte a tentar. (Windows: Definições → Privacidade e segurança → Localização deve estar LIGADA e o navegador autorizado.)');
    } else if (err.code === err.POSITION_UNAVAILABLE) {
      setGeoError('Posição indisponível. No Windows 11, ligue os Serviços de Localização (Definições → Privacidade e segurança → Localização) e permita o acesso ao navegador. Depois clique em "Tentar novamente".');
    } else {
      setGeoError('Tempo esgotado a obter o GPS. Verifique o sinal e clique em "Tentar novamente".');
    }
  }, []);

  const geoOptions: PositionOptions = { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 };

  const onGeoSuccess = useCallback((pos: GeolocationPosition) => {
    setLocating(false);
    applyPosition({
      lat:      pos.coords.latitude,
      lng:      pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      heading:  pos.coords.heading,
      speed:    pos.coords.speed,
      source:   'gps',
      at:       new Date(),
    });
  }, [applyPosition]);

  // ── Pedido explícito (gesto do utilizador → mais fiável a mostrar o prompt) ──
  const requestLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGeoError('Este navegador não suporta geolocalização.');
      return;
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setGeoError('O navegador só permite GPS em HTTPS ou localhost. Abra o painel em http://localhost:3010 (não por um endereço IP).');
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(onGeoSuccess, handleGeoError, geoOptions);
  }, [onGeoSuccess, handleGeoError]);

  // ── Ao montar: contexto seguro + estado de permissão + watch contínuo ──
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGeoError('Este dispositivo/navegador não suporta geolocalização.');
      return;
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setGeoError('O navegador bloqueia o GPS fora de HTTPS/localhost. Abra o painel em http://localhost:3010 (não por um endereço IP).');
      return;
    }

    // Se a Permissions API existir, deteta "denied" cedo para dar instruções certas.
    let permStatus: PermissionStatus | null = null;
    const onPermChange = () => {
      if (permStatus?.state === 'denied') {
        setGeoDenied(true);
      } else if (permStatus?.state === 'granted') {
        setGeoDenied(false);
      }
    };
    navigator.permissions?.query({ name: 'geolocation' as PermissionName })
      .then((status) => {
        permStatus = status;
        onPermChange();
        status.onchange = onPermChange;
      })
      .catch(() => { /* Permissions API indisponível — ignorar */ });

    setLocating(true);
    const watchId = navigator.geolocation.watchPosition(onGeoSuccess, handleGeoError, geoOptions);

    return () => {
      navigator.geolocation.clearWatch(watchId);
      if (permStatus) permStatus.onchange = null;
    };
  }, [onGeoSuccess, handleGeoError]);

  // ── Define a posição manualmente ao clicar no mapa ──
  const handleManualPick = useCallback((lat: number, lng: number) => {
    setManualMode(false);
    applyPosition({ lat, lng, accuracy: null, heading: null, speed: null, source: 'manual', at: new Date() });
  }, [applyPosition]);

  // ── Carrega posições dos motoristas (com JWT via fetchApi) ──
  const fetchLocations = useCallback(async () => {
    try {
      const data = await fetchApi<DriverLocation[]>('/drivers/locations');
      setDrivers(Array.isArray(data) ? data : []);
      setLastUpdate(new Date());
      setLoadError(null);
    } catch {
      setLoadError('Não foi possível carregar as posições dos motoristas.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLocations();
    const interval = setInterval(fetchLocations, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchLocations]);

  // ── Localização dos utilizadores (só quando a camada está ligada) ──
  const fetchUserLocations = useCallback(async () => {
    try {
      const data = await fetchApi<UserLocation[]>('/users/locations');
      setUserLocations(Array.isArray(data) ? data : []);
    } catch {
      /* sem permissão ou serviço em baixo — silencioso */
    }
  }, []);

  useEffect(() => {
    if (!showUsers) return;
    void fetchUserLocations();
    const id = setInterval(fetchUserLocations, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [showUsers, fetchUserLocations]);

  // ── Transmite a minha posição real para o backend, como um motorista ──
  useEffect(() => {
    if (!broadcasting || !broadcastId) return;

    let cancelled = false;

    const push = async () => {
      const p = myPosRef.current;
      if (!p) return;
      try {
        await fetchApi(`/drivers/${broadcastId}/gps`, {
          method: 'PUT',
          body: JSON.stringify({
            lat:     p.lat,
            lng:     p.lng,
            heading: p.heading ?? 0,
            speed:   p.speed ?? 0,
          }),
        });
        if (cancelled) return;
        setLastBroadcast(new Date());
        setBroadcastError(null);
        void fetchLocations(); // reflete imediatamente no mapa
      } catch {
        if (!cancelled) setBroadcastError('Falha ao transmitir a posição.');
      }
    };

    void push();
    const interval = setInterval(push, BROADCAST_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [broadcasting, broadcastId, fetchLocations]);

  function handleSelectDriver(d: DriverLocation) {
    if (!d.gps) return;
    setSelectedId(d.id);
    flyToCenter([d.gps.lat, d.gps.lng]);
  }

  const STATUS_MAP: Record<string, { label: string; cls: string }> = {
    on_route:  { label: 'Em Rota',    cls: 'badge-brand'   },
    available: { label: 'Disponível', cls: 'badge-success' },
    offline:   { label: 'Offline',    cls: 'badge-neutral' },
  };

  const activeDrivers = drivers.filter((d) => d.gps);
  const centerDefault: [number, number] = myPos
    ? [myPos.lat, myPos.lng]
    : [-25.9655, 32.5832]; // Maputo (fallback)
  const broadcastDriver = drivers.find((d) => d.id === broadcastId) ?? null;
  const showAccuracyCircle = myPos && typeof myPos.accuracy === 'number' && myPos.accuracy > 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white">Rastreamento GPS — Motoristas</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {lastUpdate
              ? `Atualizado às ${lastUpdate.toLocaleTimeString('pt-BR')} · a cada 10s · ${activeDrivers.length} com GPS`
              : 'A carregar posições...'}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => myPos && flyToCenter([myPos.lat, myPos.lng])}
            disabled={!myPos}
            className="btn btn-secondary btn-sm flex items-center gap-2"
            title={myPos ? 'Centrar na minha localização' : 'A obter a sua localização...'}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8a4 4 0 100 8 4 4 0 000-8z"/>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2v3m0 14v3m10-10h-3M5 12H2"/>
            </svg>
            Minha localização
          </button>
          <button
            onClick={() => setShowUsers((v) => !v)}
            className={`btn btn-sm flex items-center gap-2 ${showUsers ? 'btn-primary' : 'btn-secondary'}`}
            title="Mostrar onde os utilizadores usam o sistema"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
            Utilizadores{showUsers && userLocations.length ? ` (${userLocations.length})` : ''}
          </button>
          <button
            onClick={fetchLocations}
            className="btn btn-secondary btn-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>
            Atualizar
          </button>
        </div>
      </div>

      {/* ── Painel: localização atual + transmissão ── */}
      <div className="card !p-4 flex flex-col lg:flex-row lg:items-center gap-4 justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${myPos ? (myPos.source === 'gps' ? 'bg-sky-400 animate-pulse' : 'bg-amber-400') : 'bg-slate-600'}`} />
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Localização atual (este dispositivo)</p>
            {myPos ? (
              <p className="text-sm text-slate-200 font-mono truncate">
                {myPos.lat.toFixed(5)}, {myPos.lng.toFixed(5)}
                <span className="text-slate-500 font-sans">
                  {' · '}{myPos.source === 'gps'
                    ? `precisão ±${Math.round(myPos.accuracy ?? 0)} m`
                    : 'definido manualmente'}
                </span>
              </p>
            ) : (
              <p className="text-sm text-slate-400">{locating ? 'A obter posição do GPS...' : 'Sem localização.'}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={broadcastId}
            onChange={(e) => setBroadcastId(e.target.value)}
            disabled={broadcasting}
            className="input !py-1.5 !w-auto text-sm"
            title="Escolher o motorista cuja posição será a minha localização real"
          >
            <option value="">Transmitir como…</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <button
            onClick={() => setBroadcasting((b) => !b)}
            disabled={!myPos || !broadcastId}
            className={`btn btn-sm ${broadcasting ? 'btn-danger' : 'btn-primary'}`}
            title={!myPos ? 'Sem localização disponível' : !broadcastId ? 'Escolha um motorista' : ''}
          >
            {broadcasting ? 'Parar transmissão' : 'Transmitir posição'}
          </button>
        </div>
      </div>

      {/* ── Erro / ajuda de localização ── */}
      {geoError && (
        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.07] p-3.5 flex flex-col sm:flex-row sm:items-center gap-3 justify-between -mt-1">
          <div className="flex items-start gap-3 min-w-0">
            <svg className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            </svg>
            <p className="text-xs text-amber-200/90 leading-relaxed">{geoError}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={requestLocation} disabled={locating} className="btn btn-secondary btn-sm">
              {locating ? 'A localizar...' : 'Tentar novamente'}
            </button>
            <button
              onClick={() => setManualMode((m) => !m)}
              className={`btn btn-sm ${manualMode ? 'btn-primary' : 'btn-ghost'}`}
            >
              {manualMode ? 'Clique no mapa…' : 'Definir no mapa'}
            </button>
          </div>
        </div>
      )}

      {manualMode && !geoError && (
        <div className="text-xs text-brand-300 -mt-1 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" />
          Clique no mapa para definir manualmente a sua localização.
        </div>
      )}

      {broadcasting && broadcastDriver && (
        <div className="flex items-center gap-2 text-xs text-emerald-400 -mt-1">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          A transmitir a minha localização como <strong className="text-emerald-300">{broadcastDriver.name}</strong>
          {lastBroadcast && <span className="text-slate-500">· último envio {lastBroadcast.toLocaleTimeString('pt-BR')}</span>}
          {broadcastError && <span className="text-red-400">· {broadcastError}</span>}
        </div>
      )}

      {/* ── Split Layout: List + Map ── */}
      <div className="flex gap-4 flex-1 overflow-hidden">

        {/* ── Driver list ── */}
        <div className="w-72 shrink-0 flex flex-col gap-2 overflow-y-auto pr-1">
          {loading ? (
            <div className="text-slate-500 text-sm text-center mt-8">A carregar motoristas...</div>
          ) : loadError ? (
            <div className="text-red-400 text-sm text-center mt-8 px-3">{loadError}</div>
          ) : activeDrivers.length === 0 ? (
            <div className="text-slate-500 text-sm text-center mt-8">Nenhum motorista com GPS ativo.</div>
          ) : (
            activeDrivers.map((d) => {
              const gps = d.gps!;
              const isActive = d.id === selectedId;
              const statusMeta = STATUS_MAP[d.current_status] ?? { label: d.current_status, cls: 'badge-neutral' };
              const tag = getVehicleTag(d.vehicle?.type || '');
              const speed = Math.round((gps.speed ?? 0) * 3.6);
              const ageMs = gps.updatedAt ? Date.now() - new Date(gps.updatedAt).getTime() : null;
              const ageText = ageMs !== null
                ? ageMs < 60000 ? 'há menos de 1 min' : `há ${Math.round(ageMs / 60000)}m`
                : '';
              const isBroadcastTarget = broadcasting && d.id === broadcastId;

              return (
                <button
                  key={d.id}
                  onClick={() => handleSelectDriver(d)}
                  className={`text-left p-3 rounded-2xl border transition-all duration-200 ${
                    isActive
                      ? 'bg-brand-500/10 border-brand-500/30 ring-1 ring-brand-500/20'
                      : 'bg-surface border-white/[0.06] hover:border-white/10 hover:bg-surface-elevated'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className={`text-sm font-bold text-slate-200 w-10 h-10 flex items-center justify-center rounded-xl ${
                      isActive ? 'bg-brand-500/20' : 'bg-surface-elevated'
                    }`}>{tag}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 justify-between">
                        <p className="text-sm font-bold text-slate-200 truncate">{d.name}</p>
                        <span className={`badge text-[10px] ${statusMeta.cls}`}>{statusMeta.label}</span>
                      </div>
                      <p className="text-[11px] text-slate-500 truncate mt-0.5">
                        {d.vehicle?.type || ''} {d.vehicle?.plate ? `(${d.vehicle.plate})` : ''}
                      </p>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-[10px] text-slate-600 font-mono">
                          {gps.lat.toFixed(4)}, {gps.lng.toFixed(4)}
                        </span>
                        {speed > 0 && (
                          <span className="text-[10px] font-semibold text-brand-400">{speed} km/h</span>
                        )}
                      </div>
                      {isBroadcastTarget ? (
                        <p className="text-[10px] text-emerald-400 mt-0.5 font-semibold flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />a receber a sua posição
                        </p>
                      ) : ageText && (
                        <p className="text-[10px] text-slate-600 mt-0.5">{ageText}</p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* ── Leaflet Map ── */}
        <div className={`flex-1 rounded-2xl overflow-hidden border shadow-2xl relative ${manualMode ? 'border-brand-500/50 ring-2 ring-brand-500/30' : 'border-white/[0.06]'}`}>
          <MapContainer
            center={centerDefault}
            zoom={13}
            style={{ width: '100%', height: '100%', cursor: manualMode ? 'crosshair' : '' }}
            zoomControl={false}
          >
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            />

            <MapController target={flyTarget} />
            <ManualPicker active={manualMode} onPick={handleManualPick} />

            {/* Minha localização (real ou manual) + círculo de precisão */}
            {myPos && (
              <>
                {showAccuracyCircle && (
                  <Circle
                    center={[myPos.lat, myPos.lng]}
                    radius={myPos.accuracy as number}
                    pathOptions={{
                      color:       broadcasting ? '#34d399' : '#38bdf8',
                      fillColor:   broadcasting ? '#34d399' : '#38bdf8',
                      fillOpacity: 0.08,
                      weight:      1,
                    }}
                  />
                )}
                <Marker
                  position={[myPos.lat, myPos.lng]}
                  icon={makeMyLocationIcon(broadcasting)}
                  zIndexOffset={1000}
                >
                  <Popup>
                    <div style={{ fontFamily: 'Inter, sans-serif', minWidth: 170, color: '#e2e8f0' }}>
                      <p style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Minha localização</p>
                      <p style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
                        {myPos.source === 'gps'
                          ? `Precisão ±${Math.round(myPos.accuracy ?? 0)} m`
                          : 'Definida manualmente'}
                      </p>
                      <p style={{ fontSize: 10, color: '#475569' }}>
                        {myPos.lat.toFixed(5)}, {myPos.lng.toFixed(5)}
                      </p>
                      {broadcasting && broadcastDriver && (
                        <p style={{ fontSize: 10, color: '#34d399', marginTop: 6, fontWeight: 600 }}>
                          A transmitir como {broadcastDriver.name}
                        </p>
                      )}
                    </div>
                  </Popup>
                </Marker>
              </>
            )}

            {activeDrivers.map((d) => {
              const gps = d.gps!;
              const isSelected = d.id === selectedId;
              const tag = getVehicleTag(d.vehicle?.type || '');
              const statusMeta = STATUS_MAP[d.current_status] ?? { label: d.current_status, cls: 'badge-neutral' };
              const speed = Math.round((gps.speed ?? 0) * 3.6);

              return (
                <Marker
                  key={d.id}
                  position={[gps.lat, gps.lng]}
                  icon={makeDriverIcon(tag, isSelected)}
                  eventHandlers={{ click: () => handleSelectDriver(d) }}
                >
                  <Popup>
                    <div style={{ fontFamily: 'Inter, sans-serif', minWidth: 160, color: '#e2e8f0' }}>
                      <p style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{d.name}</p>
                      <p style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
                        {d.vehicle?.type || ''} {d.vehicle?.plate ? `(${d.vehicle.plate})` : ''}
                      </p>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, background: 'rgba(99,102,241,0.15)', color: '#818cf8', padding: '2px 8px', borderRadius: 99, fontWeight: 600 }}>
                          {statusMeta.label}
                        </span>
                        {speed > 0 && (
                          <span style={{ fontSize: 10, background: 'rgba(52,211,153,0.1)', color: '#34d399', padding: '2px 8px', borderRadius: 99, fontWeight: 600 }}>
                            {speed} km/h
                          </span>
                        )}
                      </div>
                      <p style={{ fontSize: 10, color: '#475569', marginTop: 6 }}>
                        {gps.lat.toFixed(5)}, {gps.lng.toFixed(5)}
                      </p>
                    </div>
                  </Popup>
                </Marker>
              );
            })}
            {/* Utilizadores do sistema (camada opcional) */}
            {showUsers && userLocations.map((u) => (
              <Marker key={u.user_id} position={[u.lat, u.lng]} icon={makeUserIcon()}>
                <Popup>
                  <div style={{ fontFamily: 'Inter, sans-serif', minWidth: 170, color: '#e2e8f0' }}>
                    <p style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>{u.email || u.user_id}</p>
                    <p style={{ fontSize: 10, color: '#c084fc', fontWeight: 600 }}>{u.role || '—'}</p>
                    <p style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>
                      {u.lat.toFixed(5)}, {u.lng.toFixed(5)}{u.accuracy != null ? ` · ±${Math.round(u.accuracy)} m` : ''}
                    </p>
                    <p style={{ fontSize: 10, color: '#475569' }}>
                      Visto {new Date(u.updated_at).toLocaleString('pt-BR')}
                    </p>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>

          {/* Legend Overlay */}
          <div className="absolute bottom-4 left-4 z-[999] bg-slate-900/90 backdrop-blur-md border border-white/10 rounded-xl p-3 flex flex-col gap-1.5 pointer-events-none">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Legenda</p>
            {[['M', 'Moto'], ['V', 'Van'], ['C', 'Carro']].map(([e, l]) => (
              <div key={l} className="flex items-center gap-2">
                <span className="w-5 h-5 flex items-center justify-center rounded-md bg-surface-elevated border border-white/10 text-[10px] font-bold text-slate-200">{e}</span>
                <span className="text-[11px] text-slate-400">{l}</span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-sky-400 border-2 border-white shrink-0" />
              <span className="text-[11px] text-slate-400">Minha localização</span>
            </div>
            {showUsers && (
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 bg-purple-400 border-2 border-white shrink-0" style={{ borderRadius: '50% 50% 50% 0' }} />
                <span className="text-[11px] text-slate-400">Utilizador do sistema</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
