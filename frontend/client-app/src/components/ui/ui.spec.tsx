import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrderFactory, PaginationFactory } from 'tests/harness';
import { Button, Input, Pagination, paginationMeta } from './index';

describe('Client UI components', () => {
  it('should render reusable order controls', () => {
    const order = OrderFactory.build();
    render(<><Input label="Código de rastreio" defaultValue={order.tracking_code}/><Button>{order.tracking_code}</Button></>);
    expect(screen.getAllByDisplayValue(order.tracking_code)).toBeTruthy();
    expect(screen.getByRole('button', { name: order.tracking_code })).toBeTruthy();
  });

  it('should paginate client lists with harness scenarios', () => {
    const scenario = PaginationFactory.build({ currentPage: 2 });
    const onPageChange = vi.fn();
    render(<Pagination page={scenario.currentPage} pageSize={scenario.pageSize} totalItems={scenario.totalItems} onPageChange={onPageChange}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    expect(paginationMeta(scenario.totalItems, scenario.currentPage, scenario.pageSize).start).toBe(11);
  });
});
