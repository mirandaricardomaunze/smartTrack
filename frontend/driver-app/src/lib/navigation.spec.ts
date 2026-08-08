/**
 * @file navigation.spec.ts
 * @description Abertura da morada na aplicação de navegação do telemóvel.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.2, § 3.6
 */
import { describe, expect, it } from 'vitest';
import { NavigationFactory, MAPUTO_COORDS } from 'tests/harness';
import { navigationUrl, readAddress, readCoords } from './navigation';

describe('readCoords', () => {
  it('should read the coordinates of a dispatched stop', () => {
    expect(readCoords(NavigationFactory.build())).toEqual(MAPUTO_COORDS);
  });

  it.each(NavigationFactory.invalidCoordCases())('should refuse $label', ({ value }) => {
    expect(readCoords(value)).toBeNull();
  });
});

describe('readAddress', () => {
  it('should join the parts of a JSONB address', () => {
    const address = readAddress(NavigationFactory.buildDestination());
    expect(address).toContain('Maputo');
    expect(address).toContain('Av. 25 de Setembro, 1234');
  });

  it('should leave the coordinates out of the address text', () => {
    const destination = NavigationFactory.buildDestination({ lat: MAPUTO_COORDS.lat, lng: MAPUTO_COORDS.lng });
    const address = readAddress(destination);
    expect(address).not.toContain(String(MAPUTO_COORDS.lat));
    expect(address).not.toContain(String(MAPUTO_COORDS.lng));
  });

  it('should accept an already formatted string', () => {
    expect(readAddress('  Bairro Polana, Maputo  ')).toBe('Bairro Polana, Maputo');
  });
});

describe('navigationUrl', () => {
  it('should prefer the coordinates over the address text', () => {
    const stop = NavigationFactory.build();
    const url = navigationUrl(stop, stop.address);
    expect(url).toBe(`https://www.google.com/maps/dir/?api=1&destination=${MAPUTO_COORDS.lat},${MAPUTO_COORDS.lng}`);
  });

  it('should fall back to the address when the stop has no GPS', () => {
    const stop = NavigationFactory.buildWithoutCoords();
    const url = navigationUrl(stop, stop.address);
    expect(url).toContain(encodeURIComponent(stop.address));
    expect(url).not.toContain('null');
  });

  it('should encode an address with spaces and accents', () => {
    const url = navigationUrl(null, 'Rua da Concórdia 12, Matola');
    expect(url).toBe('https://www.google.com/maps/dir/?api=1&destination=Rua%20da%20Conc%C3%B3rdia%2012%2C%20Matola');
  });

  it('should return null when there is nothing worth opening', () => {
    const stop = NavigationFactory.buildUnnavigable();
    expect(navigationUrl(stop, stop.address)).toBeNull();
  });

  it('should navigate from the order destination alone, without a separate address', () => {
    const destination = NavigationFactory.buildDestination({ lat: MAPUTO_COORDS.lat, lng: MAPUTO_COORDS.lng });
    expect(navigationUrl(destination)).toContain(`${MAPUTO_COORDS.lat},${MAPUTO_COORDS.lng}`);
  });
});
