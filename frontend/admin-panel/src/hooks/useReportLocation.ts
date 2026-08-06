'use client';

/**
 * @file useReportLocation.ts
 * @description Captura a localização real do dispositivo enquanto a pessoa usa o
 * sistema e regista-a no servidor (POST /v1/users/me/location). Silencioso: se a
 * permissão for negada, o contexto não for seguro ou a rede falhar, não faz nada.
 */

import { useEffect } from 'react';
import { adminApi } from '@/services/api';

const REPORT_INTERVAL_MS = 180_000; // 3 minutos

export function useReportLocation() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    if (typeof window !== 'undefined' && !window.isSecureContext) return;

    let cancelled = false;

    const report = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          void adminApi
            .reportMyLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy)
            .catch(() => { /* 401/rede — ignorar em silêncio */ });
        },
        () => { /* permissão negada / indisponível — ignorar */ },
        { enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000 },
      );
    };

    report();
    const id = setInterval(report, REPORT_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
}
