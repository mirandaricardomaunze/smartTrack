'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { adminApi, type PasswordRecoveryAvailability } from '@/services/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<PasswordRecoveryAvailability | null>(null);

  // Sem provedor de email configurado, o link de recuperação prometia um email
  // que nunca era enviado (spec § 3.32). Vale mais indicar o caminho que existe:
  // pedir ao administrador da empresa para reemitir a senha.
  useEffect(() => {
    adminApi.getPasswordRecovery()
      .then(setRecovery)
      // Falha a consultar não pode esconder o caminho de recuperação: em dúvida,
      // mostra-se o link (é o comportamento anterior a esta verificação).
      .catch(() => setRecovery({ available: true, channel: 'email', fallback: '' }));
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      const data = await adminApi.login({ email, password });
      if (!data?.token) throw new Error('Retorno inválido do servidor.');
      localStorage.setItem('token', data.token);
      document.cookie = `token=${data.token}; path=/; max-age=3600; SameSite=Lax`;
      router.push(data.user?.role === 'EMPLOYEE' ? '/portal-colaborador' : '/pedidos');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Erro de rede. Tente novamente.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-base px-4">
      <div className="card flex w-full max-w-md flex-col gap-6 border border-white/[0.06] bg-surface-elevated p-8 shadow-xl">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-600 to-brand-400 shadow-[0_4px_14px_rgba(99,102,241,0.4)]">
            <svg className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v3" />
              <rect x="9" y="11" width="14" height="10" rx="2" />
              <circle cx="12" cy="20" r="1" /><circle cx="20" cy="20" r="1" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight text-slate-100">SmartTrack</h1>
            <p className="mt-1 text-xs text-slate-500">Painel Operacional e Administrativo</p>
          </div>
        </div>

        {error && <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-center text-xs text-red-400">{error}</div>}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="email" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-400">E-mail</label>
            <input id="email" type="email" autoComplete="username" className="input h-10" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </div>
          <div>
            <label htmlFor="password" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-400">Senha</label>
            <input id="password" type="password" autoComplete="current-password" className="input h-10" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </div>
          <button type="submit" className="btn btn-primary mt-2 h-10 w-full" disabled={isLoading}>
            {isLoading ? 'A autenticar...' : 'Entrar no painel'}
          </button>
        </form>

        <p className="text-center text-[11px] leading-relaxed text-slate-500">
          {recovery?.available === false ? (
            <span>Esqueceu-se da senha? {recovery.fallback}</span>
          ) : (
            <Link href="/recuperar-senha" className="text-brand-400 hover:text-brand-300 font-semibold">Esqueci-me da senha</Link>
          )}
        </p>

        <p className="text-center text-[11px] leading-relaxed text-slate-500">
          Ainda não tem empresa? <Link href="/registar-empresa" className="text-brand-400 hover:text-brand-300 font-semibold">Criar empresa</Link>
        </p>
      </div>
    </div>
  );
}
