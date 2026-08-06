'use client';

/**
 * @file page.tsx
 * @description Auto-registo de empresa (SaaS multi-tenant).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.4
 *
 * Cria a empresa + o primeiro utilizador ADMIN e autentica-o (token já com a
 * empresa). Rota pública. Sem emojis — apenas SVG/CSS.
 */

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { adminApi } from '@/services/api';

export default function RegistarEmpresaPage() {
  const router = useRouter();
  const [form, setForm] = useState({ company_name: '', admin_name: '', admin_email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (form.password.length < 6) { setError('A senha deve ter pelo menos 6 caracteres.'); return; }
    setLoading(true);
    try {
      const data = await adminApi.registerCompany({
        company_name: form.company_name.trim(),
        admin_name: form.admin_name.trim() || undefined,
        admin_email: form.admin_email.trim(),
        password: form.password,
      });
      if (!data?.token) throw new Error('Retorno inválido do servidor.');
      localStorage.setItem('token', data.token);
      document.cookie = `token=${data.token}; path=/; max-age=3600; SameSite=Lax`;
      router.push('/pedidos');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Não foi possível criar a empresa.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-base px-4 py-10">
      <div className="card flex w-full max-w-md flex-col gap-6 border border-white/[0.06] bg-surface-elevated p-8 shadow-xl">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-600 to-brand-400 shadow-[0_4px_14px_rgba(99,102,241,0.4)]">
            <svg className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h6" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight text-slate-100">Criar empresa</h1>
            <p className="mt-1 text-xs text-slate-500">Registe a sua transportadora e comece a operar.</p>
          </div>
        </div>

        {error && <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-center text-xs text-red-400">{error}</div>}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="company" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-400">Nome da empresa</label>
            <input id="company" type="text" className="input h-10" value={form.company_name} onChange={set('company_name')} required placeholder="Ex: Transportes Rápidos, Lda." />
          </div>
          <div>
            <label htmlFor="name" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-400">O seu nome</label>
            <input id="name" type="text" className="input h-10" value={form.admin_name} onChange={set('admin_name')} placeholder="Nome do administrador" />
          </div>
          <div>
            <label htmlFor="email" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-400">E-mail do administrador</label>
            <input id="email" type="email" autoComplete="username" className="input h-10" value={form.admin_email} onChange={set('admin_email')} required />
          </div>
          <div>
            <label htmlFor="password" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-400">Senha</label>
            <input id="password" type="password" autoComplete="new-password" className="input h-10" value={form.password} onChange={set('password')} required minLength={6} />
          </div>
          <button type="submit" className="btn btn-primary mt-2 h-10 w-full" disabled={loading}>
            {loading ? 'A criar...' : 'Criar empresa e entrar'}
          </button>
        </form>

        <p className="text-center text-[11px] leading-relaxed text-slate-500">
          Já tem conta? <Link href="/login" className="text-brand-400 hover:text-brand-300 font-semibold">Entrar</Link>
        </p>
      </div>
    </div>
  );
}
