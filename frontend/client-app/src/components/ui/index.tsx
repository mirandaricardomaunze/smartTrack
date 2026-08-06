'use client';

import React, { forwardRef } from 'react';
import { clsx } from 'clsx';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'border-transparent bg-transparent text-slate-400 hover:bg-surface-elevated hover:text-slate-100',
  danger: 'border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20',
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-xs',
  md: 'h-11',
  lg: 'h-12 px-6 text-base',
  icon: 'h-10 w-10 p-0',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, fullWidth, leftIcon, rightIcon, className, disabled, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx('btn', buttonVariants[variant], buttonSizes[size], fullWidth && 'w-full', className)}
      {...props}
    >
      {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { id, label, hint, error, leftIcon, rightIcon, className, containerClassName, ...props },
  ref,
) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const helpId = `${inputId}-help`;
  return (
    <div className={clsx('w-full', containerClassName)}>
      {label && <label htmlFor={inputId} className="mb-1.5 block text-xs font-semibold text-slate-400">{label}</label>}
      <div className="relative">
        {leftIcon && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden>{leftIcon}</span>}
        <input
          ref={ref}
          id={inputId}
          className={clsx('input h-11', leftIcon && 'pl-10', rightIcon && 'pr-10', error && 'border-red-500/60', className)}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error || hint ? helpId : undefined}
          {...props}
        />
        {rightIcon && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden>{rightIcon}</span>}
      </div>
      {(error || hint) && <p id={helpId} className={clsx('mt-1 text-xs', error ? 'text-red-400' : 'text-slate-500')}>{error ?? hint}</p>}
    </div>
  );
});

export interface SelectOption { value: string; label: string; disabled?: boolean }
export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  label?: string;
  hint?: string;
  error?: string;
  options: SelectOption[];
  containerClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { id, label, hint, error, options, className, containerClassName, ...props },
  ref,
) {
  const generatedId = React.useId();
  const selectId = id ?? generatedId;
  const helpId = `${selectId}-help`;
  return (
    <div className={clsx('w-full', containerClassName)}>
      {label && <label htmlFor={selectId} className="mb-1.5 block text-xs font-semibold text-slate-400">{label}</label>}
      <select
        ref={ref}
        id={selectId}
        className={clsx('input h-11 bg-surface-elevated', error && 'border-red-500/60', className)}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error || hint ? helpId : undefined}
        {...props}
      >
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
      {(error || hint) && <p id={helpId} className={clsx('mt-1 text-xs', error ? 'text-red-400' : 'text-slate-500')}>{error ?? hint}</p>}
    </div>
  );
});

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { id, label, hint, error, className, ...props },
  ref,
) {
  const generatedId = React.useId();
  const textareaId = id ?? generatedId;
  const helpId = `${textareaId}-help`;
  return (
    <div className="w-full">
      {label && <label htmlFor={textareaId} className="mb-1.5 block text-xs font-semibold text-slate-400">{label}</label>}
      <textarea ref={ref} id={textareaId} className={clsx('input min-h-28 resize-y', error && 'border-red-500/60', className)} aria-invalid={Boolean(error) || undefined} aria-describedby={error || hint ? helpId : undefined} {...props}/>
      {(error || hint) && <p id={helpId} className={clsx('mt-1 text-xs', error ? 'text-red-400' : 'text-slate-500')}>{error ?? hint}</p>}
    </div>
  );
});

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('card p-5 sm:p-6', className)} {...props} />;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
      <div><h1 className="text-2xl font-bold text-slate-100">{title}</h1>{description && <p className="mt-1 text-sm text-slate-500">{description}</p>}</div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function paginationMeta(totalItems: number, page: number, pageSize: number) {
  const safeSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  return {
    currentPage,
    totalPages,
    start: totalItems === 0 ? 0 : (currentPage - 1) * safeSize + 1,
    end: Math.min(currentPage * safeSize, totalItems),
  };
}

export function Pagination({ page, pageSize, totalItems, onPageChange, itemLabel = 'registos' }: {
  page: number; pageSize: number; totalItems: number; onPageChange: (page: number) => void; itemLabel?: string;
}) {
  const meta = paginationMeta(totalItems, page, pageSize);
  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 py-3" aria-label="Paginação">
      <p className="text-xs text-slate-500">{totalItems === 0 ? `Nenhum ${itemLabel}` : `${meta.start}–${meta.end} de ${totalItems} ${itemLabel}`}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" disabled={meta.currentPage === 1} onClick={() => onPageChange(meta.currentPage - 1)} aria-label="Página anterior">Anterior</Button>
        <span className="flex min-w-20 items-center justify-center text-xs font-semibold text-slate-300">{meta.currentPage} / {meta.totalPages}</span>
        <Button size="sm" variant="ghost" disabled={meta.currentPage === meta.totalPages} onClick={() => onPageChange(meta.currentPage + 1)} aria-label="Próxima página">Seguinte</Button>
      </div>
    </nav>
  );
}
