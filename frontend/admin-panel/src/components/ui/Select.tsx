import React, { forwardRef } from 'react';
import { clsx } from 'clsx';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  label?: string;
  hint?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
  containerClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { id, label, hint, error, options, placeholder, className, containerClassName, ...props },
  ref,
) {
  const generatedId = React.useId();
  const selectId = id ?? generatedId;
  const helpId = `${selectId}-help`;

  return (
    <div className={clsx('w-full', containerClassName)}>
      {label && (
        <label htmlFor={selectId} className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-400">
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={selectId}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error || hint ? helpId : undefined}
        className={clsx(
          'input h-10 appearance-none bg-surface-elevated pr-9',
          error && 'border-red-500/60 focus:border-red-500 focus:ring-red-500/20',
          className,
        )}
        {...props}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {(error || hint) && (
        <p id={helpId} className={clsx('mt-1.5 text-xs', error ? 'text-red-400' : 'text-slate-500')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
});
