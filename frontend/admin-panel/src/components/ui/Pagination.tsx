import React from 'react';
import { Button } from './Button';
import { Select } from './Select';

export interface PaginationProps {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  itemLabel?: string;
}

export function paginationMeta(totalItems: number, page: number, pageSize: number) {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = totalItems === 0 ? 0 : (currentPage - 1) * safePageSize + 1;
  const end = Math.min(currentPage * safePageSize, totalItems);
  return { currentPage, totalPages, start, end };
}

function pageNumbers(currentPage: number, totalPages: number): number[] {
  const start = Math.max(1, Math.min(currentPage - 1, totalPages - 2));
  const end = Math.min(totalPages, start + 2);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function Pagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50],
  itemLabel = 'registos',
}: PaginationProps) {
  const meta = paginationMeta(totalItems, page, pageSize);

  return (
    <nav
      className="flex flex-col gap-3 border-t border-white/[0.06] bg-surface/70 px-4 py-3 lg:flex-row lg:items-center lg:justify-between"
      aria-label="Paginação da tabela"
    >
      <p className="text-xs text-slate-500" aria-live="polite">
        {totalItems === 0
          ? `Nenhum ${itemLabel}`
          : `A mostrar ${meta.start}–${meta.end} de ${totalItems} ${itemLabel}`}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {onPageSizeChange && (
          <Select
            aria-label="Registos por página"
            value={String(pageSize)}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            options={pageSizeOptions.map((size) => ({ value: String(size), label: `${size} por página` }))}
            containerClassName="w-[142px]"
            className="h-8 py-1 text-xs"
          />
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onPageChange(meta.currentPage - 1)}
          disabled={meta.currentPage === 1}
          aria-label="Página anterior"
        >
          Anterior
        </Button>
        <div className="flex items-center gap-1" aria-label={`Página ${meta.currentPage} de ${meta.totalPages}`}>
          {pageNumbers(meta.currentPage, meta.totalPages).map((pageNumber) => (
            <Button
              key={pageNumber}
              size="sm"
              variant={pageNumber === meta.currentPage ? 'primary' : 'ghost'}
              className="min-w-8 px-2"
              onClick={() => onPageChange(pageNumber)}
              aria-current={pageNumber === meta.currentPage ? 'page' : undefined}
              aria-label={`Ir para página ${pageNumber}`}
            >
              {pageNumber}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onPageChange(meta.currentPage + 1)}
          disabled={meta.currentPage === meta.totalPages}
          aria-label="Próxima página"
        >
          Seguinte
        </Button>
      </div>
    </nav>
  );
}
