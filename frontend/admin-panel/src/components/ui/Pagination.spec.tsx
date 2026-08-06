import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaginationFactory } from 'tests/harness';
import { Pagination, paginationMeta } from './Pagination';

describe('Pagination', () => {
  it('should calculate the visible range for the current page', () => {
    const scenario = PaginationFactory.build({ currentPage: 2 });

    expect(paginationMeta(scenario.totalItems, scenario.currentPage, scenario.pageSize)).toEqual({
      currentPage: 2,
      totalPages: 3,
      start: 11,
      end: 20,
    });
  });

  it('should clamp an invalid page and handle an empty list', () => {
    const beyondLastPage = PaginationFactory.build({ currentPage: 99 });
    const empty = PaginationFactory.buildEmpty();

    expect(paginationMeta(beyondLastPage.totalItems, beyondLastPage.currentPage, beyondLastPage.pageSize).currentPage).toBe(3);
    expect(paginationMeta(empty.totalItems, empty.currentPage, empty.pageSize)).toEqual({
      currentPage: 1,
      totalPages: 1,
      start: 0,
      end: 0,
    });
  });

  it('should navigate and change the page size', () => {
    const scenario = PaginationFactory.build();
    const onPageChange = vi.fn();
    const onPageSizeChange = vi.fn();

    render(
      <Pagination
        page={scenario.currentPage}
        pageSize={scenario.pageSize}
        totalItems={scenario.totalItems}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Registos por página' }), { target: { value: '20' } });

    expect(onPageChange).toHaveBeenCalledWith(2);
    expect(onPageSizeChange).toHaveBeenCalledWith(20);
  });
});
