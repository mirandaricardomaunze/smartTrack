/**
 * @file hr-schedule.js
 * @description Liga o colaborador ao seu turno — base do cálculo de assiduidade.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.18 (Recursos Humanos)
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * A tabela `hr_shifts` já existia mas não era usada em lado nenhum: a
 * assiduidade comparava a entrada com uma hora fixa no código (07:00 UTC) e uma
 * jornada de 8 horas. Com `shift_id` no colaborador, o horário passa a ser
 * política da empresa — por turno, com fuso horário e dias de trabalho.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyHrScheduleSchema(client) {
  const { rows } = await client.query("SELECT to_regclass('public.hr_employees') AS t");
  if (rows[0].t === null) return; // base ainda sem RH — nada a ligar

  await client.query(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS shift_id TEXT;`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_hr_employees_shift ON hr_employees(company_id, shift_id);`);
}

module.exports = { applyHrScheduleSchema };
