'use client';

/**
 * @file page.tsx
 * @description Contas de acesso ao sistema — criar, reemitir senha e suspender.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.32 (Contas e acessos)
 *
 * Mostra TODAS as contas da empresa, incluindo motoristas e colaboradores do
 * portal: a pergunta que esta página responde é "quem tem acesso ao sistema?" e
 * a resposta não pode deixar ninguém de fora. Criar aqui só faz contas de painel
 * (ADMIN/SUPPORT) — as de motorista criam-se em Motoristas, porque a conta tem
 * de ficar ligada ao registo do motorista.
 */

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { adminApi, type AccessAccount, type AccountRole, type PanelRole } from '@/services/api';
import { Button, Card, DataTable, Input, PageHeader, Select, type DataTableColumn } from '@/components/ui';

/** Rótulo e cor de cada papel. Sem emojis — só texto e cor (regra do projeto). */
const ROLE_LABEL: Record<AccountRole, { label: string; className: string }> = {
  SUPERADMIN: { label: 'Plataforma', className: 'bg-violet-500/10 text-violet-300 border-violet-500/20' },
  ADMIN:      { label: 'Administrador', className: 'bg-brand-500/10 text-brand-300 border-brand-500/20' },
  SUPPORT:    { label: 'Suporte', className: 'bg-sky-500/10 text-sky-300 border-sky-500/20' },
  DRIVER:     { label: 'Motorista', className: 'bg-amber-500/10 text-amber-300 border-amber-500/20' },
  EMPLOYEE:   { label: 'Colaborador', className: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' },
  CLIENT:     { label: 'Cliente', className: 'bg-slate-500/10 text-slate-300 border-slate-500/20' },
  SYSTEM:     { label: 'Integração', className: 'bg-slate-500/10 text-slate-300 border-slate-500/20' },
};

const EMPTY_FORM = { name: '', email: '', password: '', role: 'SUPPORT' as PanelRole };

function formatDate(value?: string): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export default function UsersPage() {
  const [accounts, setAccounts] = useState<AccessAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  /** Conta cuja senha está a ser reemitida (id) e a senha escrita. */
  const [reissuing, setReissuing] = useState<{ id: string; password: string } | null>(null);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAccounts(await adminApi.getAccounts());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar as contas.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const activeAdmins = useMemo(
    () => accounts.filter((account) => account.role === 'ADMIN' && account.status === 'active').length,
    [accounts],
  );

  async function createAccount(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const created = await adminApi.createAccount(form);
      setSuccess(`Conta ${created.email} criada. Comunique a senha à pessoa por um canal seguro.`);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao criar a conta.');
    } finally {
      setSaving(false);
    }
  }

  async function reissuePassword(event: FormEvent) {
    event.preventDefault();
    if (!reissuing) return;
    setBusyId(reissuing.id);
    setError('');
    setSuccess('');
    try {
      const updated = await adminApi.setAccountPassword(reissuing.id, reissuing.password);
      setSuccess(`Senha de ${updated.email} substituída. A senha anterior deixou de servir.`);
      setReissuing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao reemitir a senha.');
    } finally {
      setBusyId('');
    }
  }

  async function toggleStatus(account: AccessAccount) {
    const next = account.status === 'active' ? 'blocked' : 'active';
    setBusyId(account.id);
    setError('');
    setSuccess('');
    try {
      await adminApi.setAccountStatus(account.id, next);
      setSuccess(next === 'blocked'
        ? `Acesso de ${account.email} suspenso. O histórico da pessoa é preservado.`
        : `Acesso de ${account.email} reativado.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao alterar o acesso.');
    } finally {
      setBusyId('');
    }
  }

  const columns: DataTableColumn<AccessAccount>[] = [
    {
      key: 'person',
      header: 'Pessoa',
      cell: (account) => (
        <div>
          <p className="font-semibold text-slate-200">{account.name}</p>
          <p className="text-xs text-slate-500">{account.email}</p>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Papel',
      cell: (account) => {
        const role = ROLE_LABEL[account.role] ?? { label: account.role, className: 'bg-slate-500/10 text-slate-300 border-slate-500/20' };
        return <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${role.className}`}>{role.label}</span>;
      },
    },
    {
      key: 'status',
      header: 'Acesso',
      cell: (account) => account.status === 'active'
        ? <span className="text-xs font-semibold text-emerald-400">Ativo</span>
        : (
          <span className="text-xs font-semibold text-red-400">
            Suspenso
            <span className="ml-1 font-normal text-slate-500">desde {formatDate(account.blocked_at)}</span>
          </span>
        ),
    },
    { key: 'created', header: 'Criada', cell: (account) => <span className="text-xs text-slate-500">{formatDate(account.created_at)}</span> },
    {
      key: 'actions',
      header: 'Ações',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      cell: (account) => {
        // A conta da plataforma não se administra a partir do painel da empresa.
        if (account.role === 'SUPERADMIN') return <span className="text-xs text-slate-600">—</span>;
        const lastAdmin = account.role === 'ADMIN' && account.status === 'active' && activeAdmins <= 1;
        return (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busyId === account.id}
              onClick={() => setReissuing({ id: account.id, password: '' })}
            >
              Nova senha
            </Button>
            <Button
              size="sm"
              variant={account.status === 'active' ? 'danger' : 'secondary'}
              loading={busyId === account.id}
              disabled={lastAdmin}
              title={lastAdmin ? 'É a última conta de administrador ativa. Crie outra antes de suspender esta.' : undefined}
              onClick={() => void toggleStatus(account)}
            >
              {account.status === 'active' ? 'Suspender' : 'Reativar'}
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        title="Utilizadores"
        description="Quem tem acesso ao sistema, com que papel e em que estado."
      />

      {error && <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
      {success && <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-300">{success}</div>}

      <Card>
        <form onSubmit={createAccount} className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            required
            label="Nome"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <Input
            required
            type="email"
            label="E-mail de acesso"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
          <Input
            required
            type="password"
            minLength={10}
            label="Senha inicial"
            hint="Mínimo 10 caracteres, com maiúscula, minúscula e número."
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />
          <Select
            required
            label="Papel"
            value={form.role}
            onChange={(event) => setForm({ ...form, role: event.target.value as PanelRole })}
            options={[
              { value: 'SUPPORT', label: 'Suporte — operação e atendimento' },
              { value: 'ADMIN', label: 'Administrador — acesso total' },
            ]}
          />
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" variant="primary" className="h-10" loading={saving}>Criar conta de painel</Button>
            <p className="mt-2 text-xs text-slate-500">
              Acesso de motorista cria-se em <Link href="/motoristas" className="text-brand-400 hover:text-brand-300">Motoristas</Link>,
              e do colaborador em <Link href="/rh-contas" className="text-brand-400 hover:text-brand-300">Acessos do RH</Link> —
              nesses casos a conta tem de ficar ligada ao respetivo registo.
            </p>
          </div>
        </form>
      </Card>

      {reissuing && (
        <Card>
          <form onSubmit={reissuePassword} className="grid items-start gap-4 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <p className="text-sm font-semibold text-slate-200">
                Nova senha para {accounts.find((account) => account.id === reissuing.id)?.email}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Não é preciso a senha antiga. O ato fica registado na auditoria com quem o fez.
              </p>
            </div>
            <Input
              required
              autoFocus
              type="password"
              minLength={10}
              label="Senha"
              hint="Mínimo 10 caracteres, com maiúscula, minúscula e número."
              containerClassName="sm:col-span-2"
              value={reissuing.password}
              onChange={(event) => setReissuing({ ...reissuing, password: event.target.value })}
            />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" className="h-10" loading={busyId === reissuing.id}>Substituir senha</Button>
              <Button type="button" variant="ghost" className="h-10" onClick={() => setReissuing(null)}>Cancelar</Button>
            </div>
          </form>
        </Card>
      )}

      <DataTable
        data={accounts}
        columns={columns}
        getRowKey={(account) => account.id}
        loading={loading}
        loadingLabel="A carregar contas..."
        emptyTitle="Nenhuma conta encontrada"
        emptyDescription="Crie a primeira conta de painel no formulário acima."
      />
    </div>
  );
}
