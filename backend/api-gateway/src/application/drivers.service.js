/**
 * @file drivers.service.js
 * @description Camada de aplicação — use cases de Motoristas (em Inglês).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Entidades — Motorista)
 */
'use strict';

const { DriverRepository } = require('../infrastructure/pg.repository');

// ─── Erros de Aplicação ──────────────────────────────────────────────────────

class DriverNotFoundError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`Driver not found: ${id}`);
    this.name       = 'DriverNotFoundError';
    this.statusCode = 404;
  }
}

class InvalidGpsPayloadError extends Error {
  constructor() {
    super('Invalid GPS payload: lat and lng are required and must be numbers');
    this.name       = 'InvalidGpsPayloadError';
    this.statusCode = 400;
  }
}

// ─── Use Cases ───────────────────────────────────────────────────────────────

/**
 * Lista todos os motoristas.
 * @returns {Promise<object[]>}
 */
async function listDrivers() {
  return DriverRepository.findAll();
}

/**
 * Retorna posições GPS de todos os motoristas.
 *
 * @returns {Promise<Array<{ id: string; name: string; vehicle: object; current_status: string; gps: object }>>}
 */
async function listDriverLocations() {
  const drivers = await DriverRepository.findAll();
  return drivers.map((d) => ({
    id:             d.id,
    name:           d.name,
    vehicle:        d.vehicle,
    current_status: d.current_status,
    gps:            d.gps,
  }));
}

/**
 * Atualiza a posição GPS de um motorista.
 *
 * @param {string} driverId
 * @param {{ lat: number; lng: number; heading: number; speed: number }} dto
 * @returns {Promise<{ success: boolean; gps: object }>}
 */
async function updateDriverGps(driverId, dto) {
  if (
    typeof dto.lat !== 'number' ||
    typeof dto.lng !== 'number'
  ) {
    throw new InvalidGpsPayloadError();
  }

  const driver = await DriverRepository.findById(driverId);
  if (!driver) throw new DriverNotFoundError(driverId);

  const updatedDriver = {
    ...driver,
    gps: {
      lat:       dto.lat,
      lng:       dto.lng,
      heading:   typeof dto.heading === 'number' ? dto.heading : 0,
      speed:     typeof dto.speed   === 'number' ? dto.speed   : 0,
      updatedAt: new Date().toISOString(),
    },
  };

  await DriverRepository.update(updatedDriver);
  return { success: true, gps: updatedDriver.gps };
}

module.exports = {
  listDrivers,
  listDriverLocations,
  updateDriverGps,
  DriverNotFoundError,
  InvalidGpsPayloadError,
};
