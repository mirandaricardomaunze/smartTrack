import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OrderFactory, type TestOrder } from 'tests/harness';
import { DataTable, type DataTableColumn } from './DataTable';

const columns: DataTableColumn<TestOrder>[] = [
  { key: 'tracking', header: 'Código', cell: (order) => order.tracking_code },
  { key: 'status', header: 'Estado', cell: (order) => order.current_status },
];

describe('DataTable', () => {
  it('should render rows built by the harness', () => {
    const orders = OrderFactory.buildList(2);

    render(<DataTable data={orders} columns={columns} getRowKey={(order) => order.id} />);

    expect(screen.getByText(orders[0].tracking_code)).toBeTruthy();
    expect(screen.getByText(orders[1].tracking_code)).toBeTruthy();
  });

  it('should render professional loading and empty states', () => {
    const { rerender } = render(
      <DataTable<TestOrder> data={[]} columns={columns} getRowKey={(order) => order.id} loading />,
    );
    expect(screen.getByText('A carregar dados...')).toBeTruthy();

    rerender(<DataTable<TestOrder> data={[]} columns={columns} getRowKey={(order) => order.id} />);
    expect(screen.getByText('Nenhum registo encontrado')).toBeTruthy();
  });
});
