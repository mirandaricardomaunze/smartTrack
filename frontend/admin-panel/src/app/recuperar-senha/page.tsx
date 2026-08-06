'use client';

/**
 * @file page.tsx
 * @description Recuperar senha — pedido do link por email.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.22 (Recuperação de senha)
 *
 * A resposta é sempre a mesma, exista ou não a conta: um ecrã que dissesse
 * "esse email não existe" seria um verificador de contas para quem quisesse
 * atacar. Por isso esta página confirma o envio sem afirmar que a conta existe.
 *
 * Sem emojis — apenas SVG/CSS.
 */

import React, { useState } from 'react';
import Link from 'next/link';
import { adminApi } from '@/services/api';
import { Button, Card, Input } from '@/components/ui';

export default function RecuperarSenhaPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');
  const [debugLink, setDebugLink] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const result = await adminApi.forgotPassword(email.trim().toLowerCase());
      setMessage(result.message);
      // Só chega preenchido em desenvolvimento com email simulado.
      setDebugLink(result.debug_link ?? null);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível processar o pedido.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base p-4">
      <Card className="w-full max-w-md flex flex-col gap-5">
        <div>
          <h1 className="text-lg font-bold text-slate-100">Recuperar senha</h1>
          <p className="text-xs text-slate-500 mt-1">
            Indique o e-mail da sua conta. Enviamos um link para escolher uma senha nova.
          </p>
        </div>

        {sent ? (
          <>
            <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-4 rounded-2xl text-xs">
              {message}
            </div>
            <p className="text-[11px] text-slate-500">
              O link é válido por tempo limitado e só pode ser usado uma vez. Se não chegar,
              verifique a pasta de spam ou peça outro dentro de alguns minutos.
            </p>

            {debugLink && (
              <div className="rounded-xl bg-surface-elevated p-3 text-[11px] text-slate-400 break-all">
                <strong className="block text-slate-300 mb-1">Modo de desenvolvimento</strong>
                Não há provedor de email configurado, por isso o link aparece aqui:
                <Link href={debugLink.replace(/^https?:\/\/[^/]+/, '')} className="block mt-1.5 text-brand-400 hover:underline">
                  {debugLink}
                </Link>
              </div>
            )}

            <div className="flex justify-between items-center border-t border-white/[0.06] pt-4">
              <Link href="/login" className="text-xs text-brand-400 hover:underline">Voltar ao início de sessão</Link>
              <Button variant="ghost" size="sm" onClick={() => { setSent(false); setDebugLink(null); }}>
                Usar outro e-mail
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Input
              label="E-mail" type="email" required autoFocus value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="o.seu.email@empresa.co.mz"
              className="text-sm"
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <Button type="submit" variant="primary" fullWidth loading={loading}>Enviar link</Button>
            <Link href="/login" className="text-xs text-brand-400 hover:underline text-center">
              Lembrei-me da senha
            </Link>
          </form>
        )}
      </Card>
    </div>
  );
}
