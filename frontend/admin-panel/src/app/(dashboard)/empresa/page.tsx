'use client';

/**
 * @file page.tsx
 * @description Perfil da empresa — identificação, marca e papel timbrado dos PDF.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20 (Documentos PDF da empresa)
 *
 * O que se preenche aqui sai em TODOS os documentos que a empresa entrega:
 * faturas, notas de crédito, mapa de IVA, relatórios e acertos. O NUIT daqui é o
 * do **emissor** das faturas fiscais (§ 3.16), por isso é validado a sério.
 *
 * Sem emojis — apenas SVG/CSS.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { adminApi, type CompanyProfileData } from '@/services/api';
import { useAdminUser } from '@/hooks/useAdminUser';
import { useCompanyProfile } from '@/hooks/useCompanyProfile';
import { exportReportPdf } from '@/services/documentPdf';
import { Button, Card, Input, PageHeader } from '@/components/ui';

/** Teto do logótipo: viaja dentro de cada PDF, não pode ser uma fotografia. */
const LOGO_MAX_BYTES = 300 * 1024;

const EMPTY: CompanyProfileData = {
  legal_name: '', trade_name: '', tax_id: '', address: '', city: '', country: 'Moçambique',
  phone: '', email: '', website: '', brand_color: '#0F172A', bank_details: '', footer_note: '',
};

export default function EmpresaPage() {
  const { role, isAuthenticated } = useAdminUser();
  const { profile, loading, refresh } = useCompanyProfile();
  const [form, setForm] = useState<CompanyProfileData>(EMPTY);
  const [logo, setLogo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const canEdit = role === 'ADMIN';

  useEffect(() => {
    if (!profile) return;
    setForm({
      legal_name: profile.legal_name,
      trade_name: profile.trade_name ?? '',
      tax_id: profile.tax_id ?? '',
      address: profile.address ?? '',
      city: profile.city ?? '',
      country: profile.country,
      phone: profile.phone ?? '',
      email: profile.email ?? '',
      website: profile.website ?? '',
      brand_color: profile.brand_color,
      bank_details: profile.bank_details ?? '',
      footer_note: profile.footer_note ?? '',
    });
    setLogo(profile.logo ?? null);
  }, [profile]);

  const set = (key: keyof CompanyProfileData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const pickLogo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    if (file.size > LOGO_MAX_BYTES) {
      setError('Logótipo demasiado grande — use uma imagem até 300 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.onerror = () => setError('Não foi possível ler a imagem.');
    reader.readAsDataURL(file);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      // `logo: ''` diz ao backend para limpar; `undefined` deixaria como está.
      await adminApi.updateCompanyProfile({ ...form, logo: logo ?? '' });
      await refresh();
      setNotice('Perfil gravado. Os próximos documentos saem com estes dados.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao gravar o perfil.');
    } finally {
      setSaving(false);
    }
  };

  /** Prova visual: gera um documento de exemplo com o timbre atual. */
  const previewPdf = useCallback(async () => {
    await exportReportPdf({
      title: 'Amostra do papel timbrado',
      subtitle: 'Documento de demonstração — confirme o logótipo, os dados e a cor da marca.',
      tables: [{
        title: 'Exemplo de tabela',
        columns: [
          { header: 'Descrição', width: 5 },
          { header: 'Quantidade', width: 1.5, align: 'right' },
          { header: 'Valor', width: 2, align: 'right' },
        ],
        rows: [
          ['Serviço de entrega — Maputo Cidade', '1', '1 160,00 MZN'],
          ['Serviço de entrega — Matola', '2', '2 320,00 MZN'],
        ],
        totals: [
          { label: 'Base tributável', value: '3 000,00 MZN' },
          { label: 'IVA 16%', value: '480,00 MZN' },
          { label: 'Total', value: '3 480,00 MZN', strong: true },
        ],
      }],
      notes: ['Este documento é apenas uma amostra e não tem qualquer valor fiscal.'],
      filename: 'amostra-papel-timbrado.pdf',
    }, { ...(profile ?? { company_id: '', country: 'Moçambique', created_at: '', updated_at: '' }),
        legal_name: form.legal_name || 'Empresa',
        trade_name: form.trade_name || undefined,
        tax_id: form.tax_id || undefined,
        address: form.address || undefined,
        city: form.city || undefined,
        country: form.country || 'Moçambique',
        phone: form.phone || undefined,
        email: form.email || undefined,
        website: form.website || undefined,
        brand_color: form.brand_color || '#0F172A',
        bank_details: form.bank_details || undefined,
        footer_note: form.footer_note || undefined,
        logo: logo ?? undefined });
  }, [form, logo, profile]);

  if (isAuthenticated && !canEdit && role !== 'SUPPORT') {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Empresa" description="Identificação e marca da empresa." />
        <Card className="p-10 text-center text-sm text-slate-400">
          Esta área é do <strong className="text-slate-200">administrador</strong> da empresa.
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Empresa"
        description="Identificação, marca e papel timbrado usados em todos os documentos."
        actions={<Button variant="secondary" size="sm" onClick={previewPdf}>Ver amostra em PDF</Button>}
      />

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-2xl text-xs">{error}</div>
      )}
      {notice && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-4 rounded-2xl text-xs">{notice}</div>
      )}

      <form onSubmit={submit} className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
        <Card className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-bold text-slate-100">Identificação</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              O NUIT é o do emissor das faturas — tem de estar correto antes de faturar.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Designação social" value={form.legal_name ?? ''} onChange={set('legal_name')} className="text-xs" containerClassName="sm:col-span-2" disabled={!canEdit} />
            <Input label="Nome comercial" value={form.trade_name ?? ''} onChange={set('trade_name')} className="text-xs" disabled={!canEdit} />
            <Input label="NUIT" value={form.tax_id ?? ''} onChange={set('tax_id')} className="text-xs font-mono" placeholder="400123456" disabled={!canEdit} />
            <Input label="Endereço" value={form.address ?? ''} onChange={set('address')} className="text-xs" containerClassName="sm:col-span-2" disabled={!canEdit} />
            <Input label="Cidade" value={form.city ?? ''} onChange={set('city')} className="text-xs" disabled={!canEdit} />
            <Input label="País" value={form.country ?? ''} onChange={set('country')} className="text-xs" disabled={!canEdit} />
            <Input label="Telefone" value={form.phone ?? ''} onChange={set('phone')} className="text-xs" disabled={!canEdit} />
            <Input label="E-mail" value={form.email ?? ''} onChange={set('email')} className="text-xs" disabled={!canEdit} />
            <Input label="Website" value={form.website ?? ''} onChange={set('website')} className="text-xs" containerClassName="sm:col-span-2" disabled={!canEdit} />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-300" htmlFor="bank">Coordenadas bancárias</label>
            <textarea
              id="bank" rows={3} value={form.bank_details ?? ''} onChange={set('bank_details')} disabled={!canEdit}
              placeholder="Banco, titular, NIB/IBAN — impresso nas faturas."
              className="w-full rounded-xl bg-surface-elevated border border-white/[0.06] px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-300" htmlFor="footer">Rodapé legal</label>
            <textarea
              id="footer" rows={2} value={form.footer_note ?? ''} onChange={set('footer_note')} disabled={!canEdit}
              placeholder="Capital social, matrícula na conservatória, avisos legais."
              className="w-full rounded-xl bg-surface-elevated border border-white/[0.06] px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
          </div>

          {canEdit && (
            <div className="flex justify-end gap-2 border-t border-white/[0.06] pt-3">
              <Button type="button" variant="secondary" onClick={() => refresh()}>Repor</Button>
              <Button type="submit" variant="primary" loading={saving}>Gravar</Button>
            </div>
          )}
        </Card>

        <Card className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-bold text-slate-100">Marca</h2>
            <p className="text-xs text-slate-500 mt-0.5">Logótipo e cor do cabeçalho dos documentos.</p>
          </div>

          <div className="rounded-xl bg-surface-elevated p-4 flex items-center justify-center min-h-[96px]">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="Logótipo da empresa" className="max-h-16 max-w-full object-contain" />
            ) : (
              <span className="text-xs text-slate-500">Sem logótipo</span>
            )}
          </div>

          {canEdit && (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-semibold text-slate-300" htmlFor="logo">Carregar logótipo</label>
              <input
                id="logo" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={pickLogo}
                className="text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-surface-overlay file:px-3 file:py-1.5 file:text-xs file:text-slate-200"
              />
              <p className="text-[11px] text-slate-500">PNG, JPEG, WEBP ou GIF até 300 KB. A transparência é achatada sobre branco no PDF.</p>
              {logo && <Button type="button" variant="ghost" size="sm" className="text-red-400 self-start" onClick={() => setLogo(null)}>Remover logótipo</Button>}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-300" htmlFor="color">Cor da marca</label>
            <div className="flex items-center gap-2">
              <input
                id="color" type="color" value={form.brand_color ?? '#0F172A'} disabled={!canEdit}
                onChange={(e) => setForm((f) => ({ ...f, brand_color: e.target.value }))}
                className="h-9 w-14 rounded-lg bg-transparent border border-white/[0.06] cursor-pointer"
              />
              <Input value={form.brand_color ?? ''} onChange={set('brand_color')} className="text-xs font-mono" containerClassName="flex-1" disabled={!canEdit} />
            </div>
          </div>

          <p className="text-[11px] text-slate-500 border-t border-white/[0.06] pt-3">
            {loading ? 'A carregar o perfil...' : 'Estes dados são o cabeçalho de faturas, notas de crédito, mapa de IVA, relatórios e acertos.'}
          </p>
        </Card>
      </form>
    </div>
  );
}
