'use client';

import { useReportLocation } from '@/hooks/useReportLocation';

/** Componente invisível: dispara a captura/registo da localização do utilizador. */
export default function LocationReporter() {
  useReportLocation();
  return null;
}
