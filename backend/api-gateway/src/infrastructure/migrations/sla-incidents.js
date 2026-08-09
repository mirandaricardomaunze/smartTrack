/**
 * @file sla-incidents.js
 * @description Prazos de SLA por zona e registo de ocorrências.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.42 (implementa o § 3.26)
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * PORQUE OS PRAZOS FICAM NA ZONA: o prazo prometido varia com o destino e com o
 * nível de serviço, que é exatamente o que a zona de tarifação já modela. Uma
 * tabela nova de SLA teria as mesmas chaves e ficaria a divergir da de preços à
 * primeira zona criada só num dos sítios.
 *
 * NULL por omissão, e é deliberado: uma zona sem prazo acordado não produz
 * incumprimento nenhum. Um default plausível criaria incumprimentos que ninguém
 * prometeu, e o primeiro relatório apareceria a acusar a operação de falhar um
 * compromisso que nunca existiu.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applySlaIncidentsSchema(client) {
  await client.query(`ALTER TABLE pricing_zones ADD COLUMN IF NOT EXISTS sla_hours_normal INTEGER;`);
  await client.query(`ALTER TABLE pricing_zones ADD COLUMN IF NOT EXISTS sla_hours_express INTEGER;`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS incidents (
      id           TEXT        PRIMARY KEY,
      company_id   TEXT,
      code         TEXT        NOT NULL,
      -- recipient_absent | wrong_address | damage | delay | refusal | loss | cod_mismatch
      kind         TEXT        NOT NULL,
      -- low | normal | high | critical
      priority     TEXT        NOT NULL DEFAULT 'normal',
      -- aberta | em_curso | resolvida | cancelada
      status       TEXT        NOT NULL DEFAULT 'aberta',
      title        TEXT        NOT NULL,
      description  TEXT,
      -- A encomenda a que diz respeito, quando há uma.
      order_id     TEXT,
      tracking_code TEXT,
      client_ref_id TEXT,
      assignee_id  TEXT,
      -- Gravado NA ABERTURA a partir da prioridade. Mudar a prioridade depois
      -- não reescreve este prazo: se reescrevesse, o cumprimento passaria a ser
      -- ajustável a posteriori e o indicador deixaria de valer nada.
      due_at       TIMESTAMPTZ,
      -- Referências e notas, não ficheiros: a fotografia do dano é a do
      -- comprovativo (§ 3.28) e o que falta aqui é apontar-lhe.
      evidence     JSONB       NOT NULL DEFAULT '[]',
      resolution   TEXT,
      opened_by    TEXT,
      opened_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at    TIMESTAMPTZ,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uidx_incidents_company_code
      ON incidents (company_id, code);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_incidents_company_status
      ON incidents (company_id, status, opened_at DESC);
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_incidents_order ON incidents (order_id);`);

  // Histórico append-only. Não há UPDATE nem DELETE em lado nenhum: sem isto,
  // "esta encomenda esteve três semanas parada" não tem resposta (§ 3.21).
  await client.query(`
    CREATE TABLE IF NOT EXISTS incident_events (
      id          TEXT        PRIMARY KEY,
      incident_id TEXT        NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
      -- opened | transition | comment
      type        TEXT        NOT NULL,
      from_status TEXT,
      to_status   TEXT,
      note        TEXT,
      actor_id    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_incident_events_incident
      ON incident_events (incident_id, created_at);
  `);
}

module.exports = { applySlaIncidentsSchema };
