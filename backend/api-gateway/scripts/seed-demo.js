/**
 * @file seed-demo.js
 * @description Povoa uma empresa de DEMONSTRAÇÃO com uma operação plausível.
 *
 * PORQUE ISTO EXISTE, E PORQUE É DESCONFORTÁVEL: o sistema inteiro assenta em
 * nunca inventar o que não foi medido — e isto inventa tudo. A tensão resolve-se
 * mantendo os dados de demonstração fisicamente separados e removíveis:
 *
 *   - vivem numa empresa própria (`company-demo`), nunca misturados com operação
 *     real, porque a fronteira de empresa é imposta em SQL em todas as leituras
 *     (§ 2.4);
 *   - a empresa chama-se "Empresa Demonstração" para ninguém a confundir num
 *     ecrã de gestão;
 *   - saem inteiros com `node scripts/seed-demo.js --remove`.
 *
 * DETERMINÍSTICO: o gerador tem semente fixa, por isso duas execuções produzem a
 * mesma operação. Um seed aleatório daria números diferentes a cada arranque e
 * tornaria impossível dizer "o painel mostra 34%" e alguém confirmar.
 *
 * AS FATURAS SÃO ASSINADAS A SÉRIO (§ 3.19). A primeira versão deste script
 * inseria-as sem `seq` nem hash, e a rehearsal de restauro passou a acusar a
 * cadeia fiscal de estar partida — com razão. A resposta certa não era afrouxar
 * a verificação para acomodar dados falsos; foi encadeá-las como o caso de uso
 * fiscal encadeia: sequência sem saltos e cada hash a apontar para o anterior.
 * O conteúdo é inventado, a cadeia é verdadeira.
 *
 * Uso:
 *   node scripts/seed-demo.js            # cria (recriando do zero)
 *   node scripts/seed-demo.js --remove   # remove tudo
 */
'use strict';

require('dotenv').config();
const pool = require('../src/infrastructure/db');
const { hashPassword } = require('../src/infrastructure/password.utils');
const { signDocument, GENESIS_HASH } = require('../src/application/fiscal');

const EMPRESA = 'company-demo';
const NOME_EMPRESA = 'Empresa Demonstração';
const EMAIL_ADMIN = 'demo@demo.mz';
const SENHA_ADMIN = 'demo123';

/** Hoje às 00:00 UTC — a base de todas as datas geradas. */
const HOJE = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime();
const DIA = 86_400_000;
const HORA = 3_600_000;

/**
 * Gerador com semente fixa (mulberry32).
 *
 * `Math.random()` daria uma operação diferente a cada execução, e ninguém
 * poderia confirmar um número visto no ecrã.
 */
function rng(semente) {
  let a = semente;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260810);

const entre = (min, max) => min + rand() * (max - min);
const inteiro = (min, max) => Math.floor(entre(min, max + 1));
const escolha = (lista) => lista[Math.floor(rand() * lista.length)];
const iso = (ms) => new Date(ms).toISOString();

// ─── A operação a inventar ───────────────────────────────────────────────────

const FILIAIS = [
  { id: 'wh-demo-maputo', code: 'MPM', name: 'Maputo — Sede', cidade: 'Maputo', lat: -25.9692, lng: 32.5732 },
  { id: 'wh-demo-beira', code: 'BEW', name: 'Beira', cidade: 'Beira', lat: -19.8436, lng: 34.8389 },
  { id: 'wh-demo-nampula', code: 'APL', name: 'Nampula', cidade: 'Nampula', lat: -15.1165, lng: 39.2666 },
];

/**
 * Zonas com prazo acordado — sem elas, o confronto entre prometido e medido
 * (§ 3.46) não tem nada que comparar, que é metade do interesse do módulo.
 *
 * `horas` é a duração REAL que a operação vai ter nesta zona. Duas das três
 * excedem o prazo prometido de propósito: um sistema em que tudo bate certo não
 * mostra para que serve medir.
 */
const ZONAS = [
  { id: 'zn-demo-1', code: 'MPM-CID', name: 'Maputo Cidade', base: 25_000, perKg: 1_500, sla: 24, horas: [6, 26] },
  { id: 'zn-demo-2', code: 'MPM-GDE', name: 'Grande Maputo', base: 35_000, perKg: 1_800, sla: 48, horas: [12, 40] },
  { id: 'zn-demo-3', code: 'CENTRO', name: 'Região Centro', base: 90_000, perKg: 4_000, sla: 72, horas: [40, 110] },
  { id: 'zn-demo-4', code: 'NORTE', name: 'Região Norte', base: 130_000, perKg: 5_500, sla: 96, horas: [60, 150] },
];

const CLIENTES = [
  ['cli-demo-1', 'Silva & Filhos, Lda', 'business'],
  ['cli-demo-2', 'Farmácia Nampula', 'business'],
  ['cli-demo-3', 'Transportes Beira', 'business'],
  ['cli-demo-4', 'Mercearia Central', 'business'],
  ['cli-demo-5', 'Ana Cumbe', 'individual'],
  ['cli-demo-6', 'João Matola', 'individual'],
];

const MOTORISTAS = [
  ['drv-demo-1', 'Alberto Sitoe', 'wh-demo-maputo', 'AAA-101-MC'],
  ['drv-demo-2', 'Célia Mabjaia', 'wh-demo-maputo', 'AAA-202-MC'],
  ['drv-demo-3', 'Rui Chissano', 'wh-demo-beira', 'BBB-303-MC'],
  ['drv-demo-4', 'Fátima Nhaca', 'wh-demo-nampula', 'CCC-404-MC'],
];

/** Quantas encomendas por zona. Maputo domina, como numa operação real. */
const VOLUME = { 'zn-demo-1': 120, 'zn-demo-2': 70, 'zn-demo-3': 40, 'zn-demo-4': 26 };

// ─── Escrita ─────────────────────────────────────────────────────────────────

async function remover(client) {
  // Ordem inversa das dependências. `orders` sai antes de motoristas e armazéns.
  for (const t of ['fleet_fuel_entries', 'invoices', 'orders', 'fleet_vehicles',
    'drivers', 'clients', 'pricing_zones', 'warehouses', 'user_branches', 'users']) {
    const coluna = t === 'user_branches' ? 'company_id' : 'company_id';
    try { await client.query(`DELETE FROM ${t} WHERE ${coluna} = $1`, [EMPRESA]); }
    catch (err) { console.warn(`[seed-demo] ${t}: ${err.message}`); }
  }
  await client.query('DELETE FROM companies WHERE id = $1', [EMPRESA]);
}

async function criar(client) {
  await client.query(
    `INSERT INTO companies (id, name, slug, status) VALUES ($1,$2,'demo','active')`,
    [EMPRESA, NOME_EMPRESA],
  );

  await client.query(`
    INSERT INTO users (id, name, email, password_hash, role, company_id, status)
    VALUES ('usr-demo-admin','Administração Demo',$1,$2,'ADMIN',$3,'active')
  `, [EMAIL_ADMIN, hashPassword(SENHA_ADMIN), EMPRESA]);

  for (const f of FILIAIS) {
    await client.query(`
      INSERT INTO warehouses (id, code, name, address, capacity, status, gps, company_id)
      VALUES ($1,$2,$3,$4,500,'active',$5,$6)
    `, [f.id, f.code, f.name, JSON.stringify({ city: f.cidade, country: 'MZ' }),
      JSON.stringify({ lat: f.lat, lng: f.lng }), EMPRESA]);
  }

  for (const [i, z] of ZONAS.entries()) {
    await client.query(`
      INSERT INTO pricing_zones (id, code, name, base_cents, per_kg_cents, included_kg,
        active, sort_order, company_id, per_km_cents, included_km, sla_hours_normal, sla_hours_express)
      VALUES ($1,$2,$3,$4,$5,1,TRUE,$6,$7,0,0,$8,$9)
    `, [z.id, z.code, z.name, z.base, z.perKg, i, EMPRESA, z.sla, Math.round(z.sla / 2)]);
  }

  for (const [id, nome, tipo] of CLIENTES) {
    await client.query(`
      INSERT INTO clients (id, name, type, email, phone, status, company_id)
      VALUES ($1,$2,$3,$4,$5,'active',$6)
    `, [id, nome, tipo, `${id}@demo.mz`, `8${inteiro(2, 7)}${inteiro(1000000, 9999999)}`, EMPRESA]);
  }

  for (const [id, nome, filial, matricula] of MOTORISTAS) {
    await client.query(`
      INSERT INTO drivers (id, name, email, phone, vehicle, current_status, company_id, branch_id)
      VALUES ($1,$2,$3,$4,$5,'available',$6,$7)
    `, [id, nome, `${id}@demo.mz`, `84${inteiro(1000000, 9999999)}`,
      JSON.stringify({ plate: matricula, modal: 'CARRINHA' }), EMPRESA, filial]);

    await client.query(`
      INSERT INTO fleet_vehicles (id, company_id, plate, make, model, year, vehicle_type,
        fuel_type, odometer_km, status, branch_id)
      VALUES ($1,$2,$3,'Toyota','Hiace',$4,'CARRINHA','diesel',$5,'available',$6)
    `, [`veh-${id}`, EMPRESA, matricula, inteiro(2016, 2023), inteiro(60_000, 180_000), filial]);
  }

  // Abastecimentos de depósito cheio: a rentabilidade (§ 3.40) mede o consumo
  // ENTRE dois cheios. Com um só, não há consumo medido e a margem fica por
  // apurar — que é exatamente o estado que o módulo declara em vez de esconder.
  for (const [id, , , ] of MOTORISTAS) {
    let km = inteiro(60_000, 70_000);
    for (let i = 0; i < 6; i += 1) {
      km += inteiro(700, 1_400);
      const litros = entre(45, 70);
      await client.query(`
        INSERT INTO fleet_fuel_entries (id, company_id, vehicle_id, fuel_date, odometer_km,
          volume_ml, cost_cents, full_tank, station, driver_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,'Petromoc',$8)
      `, [`fuel-${id}-${i}`, EMPRESA, `veh-${id}`,
        iso(HOJE - (150 - i * 25) * DIA).slice(0, 10), km,
        Math.round(litros * 1000), Math.round(litros * 8_500), id]);
    }
  }

  return semearEncomendas(client);
}

/**
 * As encomendas — a razão de ser de tudo isto.
 *
 * A maioria entregue, com durações dentro do intervalo real de cada zona, para
 * a previsão (§ 3.46) ter os 20 por segmento de que precisa. Uma minoria em
 * curso, e três dessas propositadamente atrasadas e paradas, para o § 3.47 ter
 * o que assinalar.
 */
async function semearEncomendas(client) {
  let n = 0;
  const porAssinar = [];

  for (const zona of ZONAS) {
    const total = VOLUME[zona.id];

    for (let i = 0; i < total; i += 1) {
      n += 1;
      const id = `ord-demo-${String(n).padStart(4, '0')}`;
      const rastreio = `TRK${String(700_000_000 + n)}BR`;
      const [cliId, cliNome] = escolha(CLIENTES);
      const filial = escolha(FILIAIS);
      const motorista = escolha(MOTORISTAS);
      const express = rand() < 0.25;
      const peso = Math.round(entre(500, 25_000));
      const preco = zona.base + Math.round((peso / 1000) * zona.perKg) * (express ? 2 : 1);

      // 85% concluídas: é o histórico de que a previsão vive.
      const concluida = i < total * 0.85;
      const criada = HOJE - inteiro(3, 170) * DIA - inteiro(0, 23) * HORA;

      if (concluida) {
        const falhou = rand() < 0.06;
        const horas = entre(zona.horas[0], zona.horas[1]) * (express ? 0.6 : 1);
        const fim = criada + horas * HORA;

        await client.query(`
          INSERT INTO orders (id, client_id, client_ref_id, tracking_code, current_status,
            origin, destination, driver_id, warehouse_id, branch_id, value, weight_grams,
            pricing, history, pod, delivery_attempts, created_at, updated_at, company_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'[]'::jsonb,$14,$15,$16,$17,$18)
        `, [id, cliNome, cliId, rastreio, falhou ? 'failed' : 'delivered',
          JSON.stringify({ city: filial.cidade }),
          JSON.stringify({ city: zona.name, address: `Av. Demonstração ${inteiro(1, 900)}` }),
          motorista[0], filial.id, filial.id, preco, peso,
          JSON.stringify({ zone_id: zona.id, zone_name: zona.name, service_level: express ? 'express' : 'normal' }),
          falhou ? null : JSON.stringify({ captured_at: iso(fim), recipient_name: 'Recebido em demonstração', method: 'signature' }),
          falhou ? 2 : 1, iso(criada), iso(fim), EMPRESA]);

        // Faturas para uma parte: contas a receber (§ 3.41) precisa de prazos
        // espalhados pelos escalões de antiguidade. Recolhidas agora e assinadas
        // no fim — a cadeia tem de seguir a ordem cronológica em que a
        // verificação as vai ler, não a ordem em que este ciclo as encontra.
        if (!falhou && rand() < 0.45) {
          porAssinar.push({
            client_ref_id: cliId,
            client_name: cliNome,
            total_cents: preco,
            status: rand() < 0.35 ? 'paid' : 'issued',
            due_date: iso(criada + inteiro(-60, 45) * DIA).slice(0, 10),
            issued_at: criada,
          });
        }
      } else {
        // Em curso. Três casos deliberados para o § 3.47 ter o que assinalar:
        // uma muito para lá do prazo, uma parada, e o resto normal.
        const caso = i - Math.floor(total * 0.85);
        const horasDecorridas = caso === 0 ? zona.horas[1] * 3
          : caso === 1 ? zona.horas[1] * 2.2
            : entre(1, zona.horas[0]);
        const inicio = HOJE - horasDecorridas * HORA;
        // A parada não se mexe há muito: `updated_at` fica igual ao registo.
        const mexeu = caso === 1 ? inicio : HOJE - entre(0, 4) * HORA;

        await client.query(`
          INSERT INTO orders (id, client_id, client_ref_id, tracking_code, current_status,
            origin, destination, driver_id, warehouse_id, branch_id, value, weight_grams,
            pricing, history, delivery_attempts, created_at, updated_at, company_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'[]'::jsonb,0,$14,$15,$16)
        `, [id, cliNome, cliId, rastreio,
          escolha(['collected', 'at_warehouse', 'in_transit', 'out_for_delivery']),
          JSON.stringify({ city: filial.cidade }),
          JSON.stringify({ city: zona.name, address: `Av. Demonstração ${inteiro(1, 900)}` }),
          motorista[0], filial.id, filial.id, preco, peso,
          JSON.stringify({ zone_id: zona.id, zone_name: zona.name, service_level: express ? 'express' : 'normal' }),
          iso(inicio), iso(mexeu), EMPRESA]);
      }
    }
  }

  return { encomendas: n, faturas: await assinarFaturas(client, porAssinar) };
}

/**
 * Emite as faturas com a cadeia de hash do § 3.19.
 *
 * POR ORDEM CRONOLÓGICA, porque é assim que a verificação as lê (`ORDER BY
 * signed_at, seq`). Assinadas pela ordem em que o ciclo das encomendas as
 * encontrou, a cadeia estaria correta no papel e partida à leitura.
 *
 * `signed_at` vai como ISO com milissegundos: a coluna é timestamptz e a leitura
 * normaliza de volta a ISO, por isso só um formato que sobreviva à ida e à volta
 * produz o mesmo hash na verificação.
 */
async function assinarFaturas(client, porAssinar) {
  const ordenadas = [...porAssinar].sort((a, b) => a.issued_at - b.issued_at);
  let anterior = GENESIS_HASH;

  for (const [i, f] of ordenadas.entries()) {
    const seq = i + 1;
    const numero = `FT2026A/${seq}`;
    const emitida = iso(f.issued_at);
    const total = Math.round(f.total_cents * 1.16);

    const assinatura = signDocument({
      issuedAt: emitida,
      signedAt: emitida,
      number: numero,
      totalCents: total,
      previousHash: anterior,
    });

    await client.query(`
      INSERT INTO invoices (id, number, doc_type, series, seq, client_ref_id, client_name, items,
        subtotal_cents, tax_rate_pct, tax_cents, total_cents, status, due_date, issued_at,
        company_id, tax_summary, currency, hash, previous_hash, hash_control, signed_at)
      VALUES ($1,$2,'FT','A',$3,$4,$5,'[]'::jsonb,$6,16,$7,$8,$9,$10,$11,$12,'[]'::jsonb,'MZN',$13,$14,$15,$16)
    `, [`inv-demo-${seq}`, numero, seq, f.client_ref_id, f.client_name,
      f.total_cents, Math.round(f.total_cents * 0.16), total,
      f.status, f.due_date, emitida, EMPRESA,
      assinatura.hash, assinatura.previous_hash, assinatura.hash_control, assinatura.signed_at]);

    anterior = assinatura.hash;
  }
  return ordenadas.length;
}

async function main() {
  const remocao = process.argv.includes('--remove');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await remover(client);

    if (remocao) {
      await client.query('COMMIT');
      console.info(`[seed-demo] "${NOME_EMPRESA}" removida por inteiro.`);
      return;
    }

    const { encomendas, faturas } = await criar(client);
    await client.query('COMMIT');

    console.info(`
[seed-demo] "${NOME_EMPRESA}" criada.
  ${FILIAIS.length} filiais · ${ZONAS.length} zonas com prazo · ${CLIENTES.length} clientes
  ${MOTORISTAS.length} motoristas e viaturas · ${encomendas} encomendas · ${faturas} faturas

  Entrar:  ${EMAIL_ADMIN} / ${SENHA_ADMIN}
  Remover: node scripts/seed-demo.js --remove

  Estes dados são inventados. Vivem numa empresa própria e não se misturam com
  operação real. O conteúdo é falso, mas a cadeia fiscal é verdadeira (§ 3.19).`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed-demo] Erro:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  main().then(() => pool.end()).catch(() => { pool.end(); process.exit(1); });
}

module.exports = { EMPRESA, EMAIL_ADMIN };