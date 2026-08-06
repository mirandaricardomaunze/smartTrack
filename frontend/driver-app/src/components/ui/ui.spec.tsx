import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DriverFactory, PaginationFactory } from 'tests/harness';
import { Button, Card, Pagination } from './index';

describe('Driver UI components', () => {
  it('should render touch-friendly reusable actions', () => {
    const driver = DriverFactory.build();
    render(<Card><Button fullWidth>{driver.name}</Button></Card>);
    expect(screen.getByRole('button', { name: driver.name })).toBeTruthy();
  });

  it('should paginate driver history with harness scenarios', () => {
    const scenario = PaginationFactory.build();
    const onPageChange = vi.fn();
    render(<Pagination page={scenario.currentPage} pageSize={scenario.pageSize} totalItems={scenario.totalItems} onPageChange={onPageChange}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });
});
