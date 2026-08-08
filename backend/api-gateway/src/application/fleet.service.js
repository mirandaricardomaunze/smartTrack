'use strict';const crypto=require('crypto');const{FleetRepository}=require('../infrastructure/pg.repository');const modals=require('../domain/delivery-modals');class FleetValidationError extends Error{constructor(m){super(m);this.statusCode=400;}}class FleetNotFoundError extends Error{constructor(m){super(m);this.statusCode=404;}}const text=v=>typeof v==='string'?v.trim():'';function calculateConsumption(previousKm,currentKm,volumeMl){const distance=Number(currentKm)-Number(previousKm);if(distance<=0||Number(volumeMl)<=0)return null;return Math.round((Number(volumeMl)/1000)/distance*100*100)/100;}
/**
 * Normaliza o tipo de viatura pelo catálogo de modais (§ 3.33).
 *
 * Reconhecido ("mota", "triciclo", "MOTOTRICICLO") passa a código canónico — é
 * o que permite contar as motos da frota e cruzá-las com o despacho. Não
 * reconhecido é preservado tal como veio: a coluna sempre foi texto livre e já
 * tem valores como `pickup` gravados; recusá-los agora partia cadastros que
 * funcionavam, sem tornar nenhum dado mais correto.
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeVehicleType(value){const code=modals.normalizeModalCode(value);if(code)return code;const free=text(value);return free||null;}
async function createVehicle(dto={}){const plate=text(dto.plate).toUpperCase(),make=text(dto.make),model=text(dto.model);if(!plate||!make||!model)throw new FleetValidationError('Matrícula, marca e modelo são obrigatórios.');const odometer=Math.max(0,Math.round(Number(dto.odometer_km)||0));const vehicle_type=normalizeVehicleType(dto.vehicle_type);const modal=modals.getModal(vehicle_type);
// Motos e mototriciclos são a gasolina; deixar o default `diesel` do formulário
// entrar aqui punha a frota inteira a comparar consumos com o combustível errado.
return FleetRepository.createVehicle({id:crypto.randomUUID(),...dto,plate,make,model,vehicle_type,odometer_km:odometer,fuel_type:text(dto.fuel_type)||modal?.default_fuel||'diesel'});}
async function createFuel(dto,userId){const v=await FleetRepository.findVehicle(dto.vehicle_id);if(!v)throw new FleetNotFoundError('Viatura não encontrada.');const km=Math.round(Number(dto.odometer_km)),volume=Math.round(Number(dto.volume_ml)),cost=Math.round(Number(dto.cost_cents));if(km<v.odometer_km)throw new FleetValidationError('A quilometragem não pode regredir.');if(volume<=0||cost<=0)throw new FleetValidationError('Volume e custo devem ser maiores que zero.');const previous=dto.full_tank===false?null:await FleetRepository.latestFullFuel(v.id);const consumption=previous?calculateConsumption(previous.odometer_km,km,volume):null;return FleetRepository.createFuel({id:crypto.randomUUID(),...dto,odometer_km:km,volume_ml:volume,cost_cents:cost,full_tank:dto.full_tank!==false,consumption_l_per_100km:consumption,created_by:userId});}
module.exports={listVehicles:()=>FleetRepository.listVehicles(),createVehicle,listFuel:id=>FleetRepository.listFuel(id),createFuel,getStats:()=>FleetRepository.stats(),listModals:()=>modals.listModals(),normalizeVehicleType,calculateConsumption,FleetValidationError,FleetNotFoundError};
