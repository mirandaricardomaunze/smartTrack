/**
 * @file navigation.ts
 * @description Abre a morada da entrega na aplicação de navegação do telemóvel.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.2, § 3.6
 *
 * PORQUÊ ASSIM: um mapa embebido obrigaria a uma biblioteca, a uma chave de API e
 * a tiles que não existem offline — e mesmo assim não dava voz nem trânsito. O
 * motorista já tem uma aplicação de navegação instalada e é essa que sabe conduzi-lo.
 * Entregamos-lhe as coordenadas e saímos da frente.
 *
 * As coordenadas mandam sobre o texto: em Moçambique há bairros que a pesquisa por
 * morada não resolve, e o despacho já guarda o ponto exato da paragem.
 */

/** Ponto no mapa, depois de validado. */
export interface Coords {
  lat: number;
  lng: number;
}

/**
 * Extrai coordenadas utilizáveis de um valor solto (paragem, morada, JSONB).
 * Rejeita fora de alcance e o (0,0) — que na prática é sempre campo por preencher
 * e não a ilha imaginária no Golfo da Guiné. PURA.
 */
export function readCoords(value: unknown): Coords | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/**
 * Texto legível de uma morada — objeto JSONB ou string já formatada.
 * Ignora as chaves numéricas (lat/lng) para não as mandar como parte do endereço.
 * PURA.
 */
export function readAddress(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value as Record<string, unknown>)
    .filter(([key, part]) => key !== 'lat' && key !== 'lng' && typeof part === 'string' && part.trim())
    .map(([, part]) => String(part).trim())
    .join(', ');
}

/**
 * URL de navegação ponto-a-ponto. O esquema universal do Google Maps abre a
 * aplicação nativa quando instalada (Android e iOS) e o site quando não está,
 * sem chave de API nem SDK.
 *
 * @returns a URL, ou `null` quando não há destino que valha a pena abrir.
 */
export function navigationUrl(destination: unknown, address?: unknown): string | null {
  const coords = readCoords(destination);
  if (coords) {
    return `https://www.google.com/maps/dir/?api=1&destination=${coords.lat},${coords.lng}`;
  }
  const text = readAddress(address ?? destination);
  if (!text) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(text)}`;
}
