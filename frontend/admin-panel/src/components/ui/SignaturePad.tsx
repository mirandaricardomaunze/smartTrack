'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { clsx } from 'clsx';

export interface SignaturePadProps {
  /** Emite o PNG (data URL) a cada traço concluído; null quando limpo/vazio. */
  onChange?: (dataUrl: string | null) => void;
  className?: string;
  /** Altura do canvas em px (largura é 100%). */
  height?: number;
  disabled?: boolean;
}

/**
 * Bloco de assinatura desenhada — canvas self-contained (pointer events), sem
 * dependências externas. Usado no comprovativo de entrega (POD).
 */
export function SignaturePad({ onChange, className, height = 160, disabled }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawing = useRef(false);
  const inked = useRef(false);
  const [empty, setEmpty] = useState(true);

  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    canvas.width = rect.width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#e2e8f0'; // slate-200 — visível sobre fundo escuro
    ctxRef.current = ctx;
  }, [height]);

  useEffect(() => {
    setup();
    window.addEventListener('resize', setup);
    return () => window.removeEventListener('resize', setup);
  }, [setup]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled || !ctxRef.current) return;
    drawing.current = true;
    const { x, y } = point(e);
    ctxRef.current.beginPath();
    ctxRef.current.moveTo(x, y);
    canvasRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !ctxRef.current) return;
    const { x, y } = point(e);
    ctxRef.current.lineTo(x, y);
    ctxRef.current.stroke();
    inked.current = true;
  };

  const onPointerUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (inked.current) {
      setEmpty(false);
      onChange?.(canvasRef.current!.toDataURL('image/png'));
    }
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    inked.current = false;
    setEmpty(true);
    onChange?.(null);
  };

  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <div className="relative rounded-xl border border-white/10 bg-surface-elevated overflow-hidden">
        <canvas
          ref={canvasRef}
          style={{ height, touchAction: 'none' }}
          className={clsx('w-full block', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-crosshair')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />
        {empty && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-slate-600">
            Assine aqui
          </span>
        )}
      </div>
      <div className="flex justify-end">
        <button type="button" onClick={clear} disabled={disabled || empty} className="btn btn-ghost btn-sm">
          Limpar
        </button>
      </div>
    </div>
  );
}
