'use client';

import React, { forwardRef } from 'react';
import { clsx } from 'clsx';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
}

const variants: Record<ButtonVariant, string> = {
  primary: 'border-brand-600 bg-brand-600 text-white hover:bg-brand-500',
  secondary: 'border-white/10 bg-surface-elevated text-slate-100 hover:bg-surface-overlay',
  ghost: 'border-transparent bg-transparent text-slate-400 hover:bg-surface-elevated hover:text-white',
  danger: 'border-red-500/25 bg-red-500/10 text-red-400 hover:bg-red-500/20',
  success: 'border-emerald-500/25 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25',
};
const sizes: Record<ButtonSize, string> = { sm: 'min-h-10 px-3 text-xs', md: 'min-h-12 px-4 text-sm', lg: 'min-h-14 px-5 text-base', icon: 'h-12 w-12 p-0' };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, fullWidth, leftIcon, className, disabled, children, type = 'button', ...props }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx('inline-flex items-center justify-center gap-2 rounded-xl border font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50', variants[variant], sizes[size], fullWidth && 'w-full', className)}
      {...props}
    >
      {loading ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden /> : leftIcon}
      {children}
    </button>
  );
});

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> { label?: string; hint?: string; error?: string }
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ id, label, hint, error, className, ...props }, ref) {
  const generatedId = React.useId(); const inputId = id ?? generatedId; const helpId = `${inputId}-help`;
  return <div className="w-full">{label && <label htmlFor={inputId} className="mb-1.5 block text-xs font-semibold text-slate-400">{label}</label>}<input ref={ref} id={inputId} className={clsx('min-h-12 w-full rounded-xl border border-white/10 bg-surface-elevated px-3.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20', error && 'border-red-500/60', className)} aria-invalid={Boolean(error) || undefined} aria-describedby={error || hint ? helpId : undefined} {...props}/>{(error || hint) && <p id={helpId} className={clsx('mt-1 text-xs', error ? 'text-red-400' : 'text-slate-500')}>{error ?? hint}</p>}</div>;
});

export interface SelectOption { value: string; label: string; disabled?: boolean }
export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> { label?: string; hint?: string; error?: string; options: SelectOption[] }
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ id, label, hint, error, options, className, ...props }, ref) {
  const generatedId = React.useId(); const selectId = id ?? generatedId; const helpId = `${selectId}-help`;
  return <div className="w-full">{label && <label htmlFor={selectId} className="mb-1.5 block text-xs font-semibold text-slate-400">{label}</label>}<select ref={ref} id={selectId} className={clsx('min-h-12 w-full rounded-xl border border-white/10 bg-surface-elevated px-3.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20', error && 'border-red-500/60', className)} aria-invalid={Boolean(error) || undefined} aria-describedby={error || hint ? helpId : undefined} {...props}>{options.map((option)=><option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select>{(error || hint) && <p id={helpId} className={clsx('mt-1 text-xs', error ? 'text-red-400' : 'text-slate-500')}>{error ?? hint}</p>}</div>;
});

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { label?: string; hint?: string; error?: string }
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ id, label, hint, error, className, ...props }, ref) {
  const generatedId = React.useId(); const textareaId = id ?? generatedId; const helpId = `${textareaId}-help`;
  return <div className="w-full">{label && <label htmlFor={textareaId} className="mb-1.5 block text-xs font-semibold text-slate-400">{label}</label>}<textarea ref={ref} id={textareaId} className={clsx('min-h-24 w-full resize-y rounded-xl border border-white/10 bg-surface-elevated p-3 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20', error && 'border-red-500/60', className)} aria-invalid={Boolean(error) || undefined} aria-describedby={error || hint ? helpId : undefined} {...props}/>{(error || hint) && <p id={helpId} className={clsx('mt-1 text-xs', error ? 'text-red-400' : 'text-slate-500')}>{error ?? hint}</p>}</div>;
});

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={clsx('rounded-2xl border border-white/[0.06] bg-surface p-4 sm:p-5', className)} {...props}/>; }
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) { return <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h1 className="text-xl font-bold text-slate-100">{title}</h1>{description && <p className="mt-1 text-sm text-slate-500">{description}</p>}</div>{actions && <div className="flex flex-wrap gap-2">{actions}</div>}</div>; }

export function paginationMeta(totalItems: number, page: number, pageSize: number) { const safeSize=Math.max(1,pageSize); const totalPages=Math.max(1,Math.ceil(totalItems/safeSize)); const currentPage=Math.min(Math.max(1,page),totalPages); return {currentPage,totalPages,start:totalItems===0?0:(currentPage-1)*safeSize+1,end:Math.min(currentPage*safeSize,totalItems)}; }
export function Pagination({page,pageSize,totalItems,onPageChange,itemLabel='registos'}:{page:number;pageSize:number;totalItems:number;onPageChange:(page:number)=>void;itemLabel?:string}) { const meta=paginationMeta(totalItems,page,pageSize); return <nav className="flex flex-wrap items-center justify-between gap-3 py-3" aria-label="Paginação"><p className="text-xs text-slate-500">{totalItems===0?`Nenhum ${itemLabel}`:`${meta.start}–${meta.end} de ${totalItems} ${itemLabel}`}</p><div className="flex gap-2"><Button size="sm" variant="ghost" disabled={meta.currentPage===1} onClick={()=>onPageChange(meta.currentPage-1)} aria-label="Página anterior">Anterior</Button><span className="flex min-w-16 items-center justify-center text-xs font-semibold text-slate-300">{meta.currentPage} / {meta.totalPages}</span><Button size="sm" variant="ghost" disabled={meta.currentPage===meta.totalPages} onClick={()=>onPageChange(meta.currentPage+1)} aria-label="Próxima página">Seguinte</Button></div></nav>; }
