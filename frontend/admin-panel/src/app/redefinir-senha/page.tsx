'use client';

/**
 * @file page.tsx
 * @description Redefinir senha a partir do link enviado por email.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.22 (Recuperação de senha)
 *
 * O token é validado ANTES de pedir a senha nova: é frustrante escrever duas
 * vezes uma senha para só depois descobrir que o link expirou.
 *
 * Sem emojis — apenas SVG/CSS.
 */

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { adminApi } from '@/services/api';
import { Button, Card, Input } from '@/components/ui';

/** Espelha a política do backend, para o erro aparecer antes de submeter. */
function localStrength(password: string): string | null {
  if (password.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
  if (!/[0-9]/.test(password)) return 'A senha deve incluir pelo menos um número.';
  if (!/[a-zA-Z]/.test(password)) return 'A senha deve incluir pelo menos uma letra.';
  return null;
}

function RedefinirSenhaForm() {
  const token = useSearchParams().get('token') ?? '';

  const [checking, setChecking] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);
  const [tokenReason, setTokenReason] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) { setChecking(false); setTokenReason('Link sem token.'); return; }
    let alive = true;
    adminApi.checkResetToken(token)
      .then((r) => { if (!alive) return; setTokenValid(r.valid); setTokenReason(r.reason ?? ''); })
      .catch(() => { if (alive) setTokenReason('Não foi possível validar o link.'); })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const weak = localStrength(password);
    if (weak) { setError(weak); return; }
    if (password !== confirm) { setError('As senhas não coincidem.'); return; }

    setLoading(true);
    setError('');
    try {
      await adminApi.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível redefinir a senha.');
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return <p className="text-xs text-slate-500">A validar o link...</p>;
  }

  if (done) {
    return (
      <>
        <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-4 rounded-2xl text-xs">
          Senha redefinida. Já pode iniciar sessão com a senha nova.
        </div>
        <Link href="/login" className="text-xs text-brand-400 hover:underline text-center">Iniciar sessão</Link>
      </>
    );
  }

  if (!tokenValid) {
    return (
      <>
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs">
          {tokenReason || 'Este link já não é válido.'}
        </div>
        <p className="text-[11px] text-slate-500">
          Os links expiram e só servem uma vez. Peça um novo para continuar.
        </p>
        <Link href="/recuperar-senha" className="text-xs text-brand-400 hover:underline text-center">
          Pedir um link novo
        </Link>
      </>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Input
        label="Senha nova" type="password" required autoFocus value={password}
        onChange={(e) => setPassword(e.target.value)} className="text-sm"
      />
      <Input
        label="Confirmar senha nova" type="password" required value={confirm}
        onChange={(e) => setConfirm(e.target.value)} className="text-sm"
      />
      <p className="text-[11px] text-slate-500">
        Mínimo de 8 caracteres, com pelo menos uma letra e um número.
      </p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <Button type="submit" variant="primary" fullWidth loading={loading}>Definir senha</Button>
    </form>
  );
}

export default function RedefinirSenhaPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base p-4">
      <Card className="w-full max-w-md flex flex-col gap-5">
        <div>
          <h1 className="text-lg font-bold text-slate-100">Definir senha nova</h1>
          <p className="text-xs text-slate-500 mt-1">Escolha a senha com que vai entrar de agora em diante.</p>
        </div>
        {/* `useSearchParams` exige fronteira de Suspense no App Router. */}
        <Suspense fallback={<p className="text-xs text-slate-500">A carregar...</p>}>
          <RedefinirSenhaForm />
        </Suspense>
      </Card>
    </div>
  );
}
