'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Input } from '@/components/ui';
import { driverApi } from '@/services/api';

export default function DriverLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError('');
    try {
      const session = await driverApi.login(email, password);
      localStorage.setItem('token', session.token);
      router.replace('/rota');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao autenticar.');
    } finally { setLoading(false); }
  }

  return <div className="mx-auto flex min-h-[70vh] w-full max-w-md items-center">
    <Card className="flex w-full flex-col gap-5">
      <div><h1 className="text-xl font-bold text-slate-100">Acesso do motorista</h1><p className="mt-1 text-sm text-slate-500">Entre com a conta atribuída pela gestão.</p></div>
      {error && <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">{error}</p>}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input label="E-mail" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <Input label="Senha" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        <Button type="submit" variant="primary" fullWidth loading={loading}>Entrar</Button>
      </form>
    </Card>
  </div>;
}
