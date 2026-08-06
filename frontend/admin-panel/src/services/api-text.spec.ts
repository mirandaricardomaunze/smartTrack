import { describe, expect, it } from 'vitest';
import { WarehouseFactory } from 'tests/harness';
import { cleanDisplayText } from './api';

describe('cleanDisplayText', () => {
  it('repara mojibake legado de armazém sem alterar a fonte auditável', () => {
    const warehouse = WarehouseFactory.build({ name: 'Armaz�m Central � Maputo' });

    expect(cleanDisplayText(warehouse.name)).toBe('Armazém Central - Maputo');
    expect(warehouse.name).toBe('Armaz�m Central � Maputo');
  });

  it('repara a palavra armazém dentro de descrições', () => {
    expect(cleanDisplayText('Pedido recebido no armaz�m')).toBe('Pedido recebido no armazém');
  });
});
