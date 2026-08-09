/**
 * @file incidents.service.js
 * @description Ocorrências — o que tem dono, prazo e um percurso registado.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.42 (implementa o § 3.26)
 *
 * O QUE DISTINGUE DA FILA DE EXCEÇÕES (§ 3.39): aquela mostra o que está parado,
 * renova-se sozinha e não tem dono. Uma ocorrência é o oposto — alguém fica
 * responsável, há um prazo para resolver, e o percurso fica registado. Serve o
 * caso em que a resolução leva dias e passa por várias mãos: um extravio, um
 * dano, uma divergência de COD.
 *
 * DUAS REGRAS QUE NÃO SE NEGOCEIAM:
 *
 *   1. **O prazo grava-se na abertura.** Mudar a prioridade depois não reescreve
 *      o prazo que já estava a correr. Se reescrevesse, o cumprimento passaria a
 *      ser ajustável a posteriori e o indicador deixaria de valer nada.
 *   2. **Fechar exige motivo.** Uma ocorrência que fecha sem explicação não
 *      ensina nada a ninguém e torna o histórico inútil — que é precisamente a
 *      razão de o histórico existir.
 */
'use strict';

const crypto = require('crypto');
const pool = require('../infrastructure/db');
const { readCompanyId, writeCompanyId } = require('../infrastructure/tenant-context');
const audit = require('./audit.service');

const IncidentKind = Object.freeze([
  'recipient_absent', 'wrong_address', 'damage', 'delay', 'refusal', 'loss', 'cod_mismatch',
]);

const IncidentStatus = Object.freeze({
  ABERTA:    'aberta',
  EM_CURSO:  'em_curso',
  RESOLVIDA: 'resolvida',
  CANCELADA: 'cancelada',
});

/** Transições possíveis. Fechada é terminal — reabrir cria outra ocorrência. */
const VALID_TRANSITIONS = Object.freeze({
  [IncidentStatus.ABERTA]:    [IncidentStatus.EM_CURSO, IncidentStatus.RESOLVIDA, IncidentStatus.CANCELADA],
  [IncidentStatus.EM_CURSO]:  [IncidentStatus.RESOLVIDA, IncidentStatus.CANCELADA],
  [IncidentStatus.RESOLVIDA]: [],
  [IncidentStatus.CANCELADA]: [],
});

/**
 * Prazo interno de resolução por prioridade, em horas.
 *
 * São prazos INTERNOS — o compromisso com o cliente é o SLA de entrega (§ 3.42),
 * outra coisa. Estes existem para a ocorrência não ficar esquecida.
 */
const PRIORITY_HOURS = Object.freeze({ critical: 4, high: 24, normal: 72, low: 168 });

// ─── Erros ───────────────────────────────────────────────────────────────────

class IncidentValidationError extends Error {
  constructor(message) { super(message); this.name = 'IncidentValidationError'; this.statusCode = 400; }
}
class IncidentNotFoundError extends Error {
  constructor(id) { super(`Ocorrência não encontrada: ${id}`); this.name = 'IncidentNotFoundError'; this.statusCode = 404; }
}
class IncidentTransitionError extends Error {
  constructor(from, to) {
    super(`Transição inválida de "${from}" para "${to}".`);
    this.name = 'IncidentTransitionError';
    this.statusCode = 409;
  }
}

// ─── Núcleo puro ─────────────────────────────────────────────────────────────

/** @param {string} from @param {string} to @returns {boolean} */
function isValidTransition(from, to) {
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Prazo de resolução a partir da prioridade. PURA.
 *
 * @param {string} priority
 * @param {string} openedAtIso
 * @returns {string} ISO
 */
function resolutionDeadline(priority, openedAtIso) {
  const horas = PRIORITY_HOURS[priority] ?? PRIORITY_HOURS.normal;
  return new Date(Date.parse(openedAtIso) + horas * 3_600_000).toISOString();
}

/** Código legível e ordenável. PURA. */
function generateIncidentCode(nowIso = new Date().toISOString()) {
  return `OC${nowIso.slice(0, 4)}/${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * Valida e normaliza a abertura. PURA.
 * @param {object} dto
 * @returns {object}
 */
function normalizeIncident(dto = {}) {
  const kind = String(dto.kind ?? '').trim();
  if (!IncidentKind.includes(kind)) {
    throw new IncidentValidationError(`Espécie inválida. Use ${IncidentKind.join(', ')}.`);
  }

  const priority = String(dto.priority ?? 'normal').trim();
  if (!Object.keys(PRIORITY_HOURS).includes(priority)) {
    throw new IncidentValidationError(`Prioridade inválida. Use ${Object.keys(PRIORITY_HOURS).join(', ')}.`);
  }

  const title = String(dto.title ?? '').trim();
  if (!title) throw new IncidentValidationError('O título é obrigatório.');

  return {
    kind,
    priority,
    title: title.slice(0, 200),
    description: dto.description ? String(dto.description).trim().slice(0, 4000) : null,
    order_id: dto.order_id ? String(dto.order_id).trim() : null,
    tracking_code: dto.tracking_code ? String(dto.tracking_code).trim().toUpperCase() : null,
    client_ref_id: dto.client_ref_id ? String(dto.client_ref_id).trim() : null,
    assignee_id: dto.assignee_id ? String(dto.assignee_id).trim() : null,
    evidence: Array.isArray(dto.evidence)
      ? dto.evidence.slice(0, 20).map((e) => String(e).slice(0, 500))
      : [],
  };
}

// ─── Leitura e escrita ───────────────────────────────────────────────────────

function companyFilter(params) {
  const cid = readCompanyId();
  if (!cid) return '';
  params.push(cid);
  return ` AND company_id = $${params.length}`;
}

function rowToIncident(row) {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    priority: row.priority,
    status: row.status,
    title: row.title,
    description: row.description ?? null,
    order_id: row.order_id ?? null,
    tracking_code: row.tracking_code ?? null,
    client_ref_id: row.client_ref_id ?? null,
    assignee_id: row.assignee_id ?? null,
    due_at: row.due_at instanceof Date ? row.due_at.toISOString() : row.due_at,
    evidence: row.evidence ?? [],
    resolution: row.resolution ?? null,
    opened_by: row.opened_by ?? null,
    opened_at: row.opened_at instanceof Date ? row.opened_at.toISOString() : row.opened_at,
    closed_at: row.closed_at instanceof Date ? row.closed_at.toISOString() : (row.closed_at ?? null),
    // Derivado: uma ocorrência aberta para lá do prazo interno é a que ninguém
    // pegou. É o que a lista precisa de mostrar primeiro.
    overdue: Boolean(row.due_at) && !row.closed_at && Date.parse(row.due_at) < Date.now(),
  };
}

/** Abre uma ocorrência e escreve o primeiro evento do histórico. */
async function openIncident(dto = {}) {
  const dados = normalizeIncident(dto);
  const now = new Date().toISOString();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      INSERT INTO incidents (
        id, company_id, code, kind, priority, status, title, description,
        order_id, tracking_code, client_ref_id, assignee_id, due_at, evidence,
        opened_by, opened_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
      RETURNING *
    `, [
      `incident-${crypto.randomUUID()}`,
      writeCompanyId(),
      generateIncidentCode(now),
      dados.kind, dados.priority, IncidentStatus.ABERTA,
      dados.title, dados.description,
      dados.order_id, dados.tracking_code, dados.client_ref_id, dados.assignee_id,
      // O prazo grava-se AQUI e não se recalcula: ver a regra 1 no topo.
      resolutionDeadline(dados.priority, now),
      JSON.stringify(dados.evidence),
      dto.user_id ?? null, now,
    ]);

    await client.query(`
      INSERT INTO incident_events (id, incident_id, type, to_status, note, actor_id)
      VALUES ($1,$2,'opened',$3,$4,$5)
    `, [`incident-event-${crypto.randomUUID()}`, rows[0].id, IncidentStatus.ABERTA, dados.title, dto.user_id ?? null]);

    await client.query('COMMIT');

    const ocorrencia = rowToIncident(rows[0]);
    await audit.record({
      action: 'incidents.open',
      summary: `Ocorrência ${ocorrencia.code} aberta: ${ocorrencia.title}`,
      entity_type: 'incident', entity_id: ocorrencia.id, entity_label: ocorrencia.code,
      outcome: audit.Outcome.SUCCESS,
      metadata: { kind: ocorrencia.kind, priority: ocorrencia.priority, tracking_code: ocorrencia.tracking_code },
      request: { user_id: dto.user_id },
    });
    return ocorrencia;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Move a ocorrência, exigindo motivo para fechar.
 *
 * @param {string} id
 * @param {{ to: string, note?: string, user_id?: string }} dto
 */
async function transitionIncident(id, dto = {}) {
  const atual = await getIncident(id);
  const destino = String(dto.to ?? '').trim();

  if (!isValidTransition(atual.status, destino)) {
    throw new IncidentTransitionError(atual.status, destino);
  }

  const fecha = destino === IncidentStatus.RESOLVIDA || destino === IncidentStatus.CANCELADA;
  const nota = String(dto.note ?? '').trim();
  // Ver a regra 2 no topo: uma ocorrência que fecha sem explicação torna o
  // histórico inútil.
  if (fecha && !nota) {
    throw new IncidentValidationError('Fechar uma ocorrência exige um motivo.');
  }

  const now = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const params = [destino, fecha ? nota : null, fecha ? now : null, now, id];
    const filtro = companyFilter(params);
    const { rows } = await client.query(`
      UPDATE incidents
         SET status = $1, resolution = COALESCE($2, resolution), closed_at = $3, updated_at = $4
       WHERE id = $5${filtro}
      RETURNING *
    `, params);
    if (rows.length === 0) throw new IncidentNotFoundError(id);

    await client.query(`
      INSERT INTO incident_events (id, incident_id, type, from_status, to_status, note, actor_id)
      VALUES ($1,$2,'transition',$3,$4,$5,$6)
    `, [`incident-event-${crypto.randomUUID()}`, id, atual.status, destino, nota || null, dto.user_id ?? null]);

    await client.query('COMMIT');

    const ocorrencia = rowToIncident(rows[0]);
    await audit.record({
      action: 'incidents.transition',
      summary: `Ocorrência ${ocorrencia.code}: ${atual.status} → ${destino}`,
      entity_type: 'incident', entity_id: id, entity_label: ocorrencia.code,
      outcome: audit.Outcome.SUCCESS,
      metadata: { from: atual.status, to: destino, note: nota || undefined },
      request: { user_id: dto.user_id },
    });
    return ocorrencia;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Acrescenta um comentário ao histórico. Não muda o estado. */
async function commentIncident(id, dto = {}) {
  await getIncident(id);
  const nota = String(dto.note ?? '').trim();
  if (!nota) throw new IncidentValidationError('O comentário não pode estar vazio.');

  await pool.query(`
    INSERT INTO incident_events (id, incident_id, type, note, actor_id)
    VALUES ($1,$2,'comment',$3,$4)
  `, [`incident-event-${crypto.randomUUID()}`, id, nota.slice(0, 4000), dto.user_id ?? null]);

  return getIncident(id);
}

/** @param {string} id */
async function getIncident(id) {
  const params = [id];
  const filtro = companyFilter(params);
  const { rows } = await pool.query(
    `SELECT * FROM incidents WHERE id = $1${filtro} LIMIT 1`, params,
  );
  if (rows.length === 0) throw new IncidentNotFoundError(id);
  return rowToIncident(rows[0]);
}

/** O histórico completo, na ordem em que aconteceu. */
async function getIncidentHistory(id) {
  await getIncident(id);
  const { rows } = await pool.query(
    'SELECT * FROM incident_events WHERE incident_id = $1 ORDER BY created_at ASC', [id],
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    from_status: r.from_status ?? null,
    to_status: r.to_status ?? null,
    note: r.note ?? null,
    actor_id: r.actor_id ?? null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  }));
}

/**
 * Lista, com as vencidas primeiro.
 *
 * @param {{ status?: string, kind?: string, assignee_id?: string }} [opts]
 */
async function listIncidents(opts = {}) {
  const params = [];
  const clauses = [];
  const cid = readCompanyId();
  if (cid) { params.push(cid); clauses.push(`company_id = $${params.length}`); }
  if (opts.status)      { params.push(opts.status);      clauses.push(`status = $${params.length}`); }
  if (opts.kind)        { params.push(opts.kind);        clauses.push(`kind = $${params.length}`); }
  if (opts.assignee_id) { params.push(opts.assignee_id); clauses.push(`assignee_id = $${params.length}`); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`
    SELECT * FROM incidents ${where}
     ORDER BY (closed_at IS NULL AND due_at < NOW()) DESC, due_at ASC NULLS LAST, opened_at DESC
     LIMIT 200
  `, params);
  return rows.map(rowToIncident);
}

/** Contagens para o painel. */
async function getIncidentStats() {
  const params = [];
  const filtro = companyFilter(params);
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'aberta')                                    AS abertas,
      COUNT(*) FILTER (WHERE status = 'em_curso')                                  AS em_curso,
      COUNT(*) FILTER (WHERE status = 'resolvida')                                 AS resolvidas,
      COUNT(*) FILTER (WHERE closed_at IS NULL AND due_at < NOW())                 AS vencidas
    FROM incidents
    WHERE TRUE${filtro}
  `, params);

  const r = rows[0];
  return {
    abertas: Number(r.abertas),
    em_curso: Number(r.em_curso),
    resolvidas: Number(r.resolvidas),
    vencidas: Number(r.vencidas),
  };
}

module.exports = {
  // Puros
  isValidTransition,
  resolutionDeadline,
  generateIncidentCode,
  normalizeIncident,
  IncidentKind,
  IncidentStatus,
  VALID_TRANSITIONS,
  PRIORITY_HOURS,
  // Casos de uso
  openIncident,
  transitionIncident,
  commentIncident,
  getIncident,
  getIncidentHistory,
  listIncidents,
  getIncidentStats,
  // Erros
  IncidentValidationError,
  IncidentNotFoundError,
  IncidentTransitionError,
};
