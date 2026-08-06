import React from 'react';
import { clsx } from 'clsx';

export interface DataTableColumn<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  headerClassName?: string;
  cellClassName?: string;
}

export interface DataTableProps<T> {
  data: T[];
  columns: DataTableColumn<T>[];
  getRowKey: (row: T) => React.Key;
  loading?: boolean;
  loadingLabel?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  tableClassName?: string;
  rowClassName?: (row: T) => string | undefined;
  footer?: React.ReactNode;
}

export function DataTable<T>({
  data,
  columns,
  getRowKey,
  loading = false,
  loadingLabel = 'A carregar dados...',
  emptyTitle = 'Nenhum registo encontrado',
  emptyDescription = 'Ajuste os filtros ou atualize os dados para tentar novamente.',
  tableClassName,
  rowClassName,
  footer,
}: DataTableProps<T>) {
  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-surface" aria-busy={loading}>
      <div className="overflow-x-auto">
        {loading ? (
          <div className="flex min-h-48 items-center justify-center gap-3 px-6 py-10 text-sm text-slate-500">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-500 border-r-transparent" aria-hidden />
            {loadingLabel}
          </div>
        ) : data.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
            <div className="mb-3 rounded-full bg-surface-overlay p-3 text-slate-500" aria-hidden>
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-3-3v6m9-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-slate-300">{emptyTitle}</p>
            <p className="mt-1 max-w-md text-xs text-slate-500">{emptyDescription}</p>
          </div>
        ) : (
          <table className={clsx('data-table', tableClassName)}>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key} className={column.headerClassName}>{column.header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={getRowKey(row)} className={rowClassName?.(row)}>
                  {columns.map((column) => (
                    <td key={column.key} className={column.cellClassName}>{column.cell(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!loading && footer}
    </section>
  );
}
