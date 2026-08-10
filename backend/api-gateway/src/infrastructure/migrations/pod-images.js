/**
 * @file pod-images.js
 * @description Tira as imagens do comprovativo de entrega de dentro da linha do pedido.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.28
 *
 * ADITIVA e idempotente.
 *
 * PORQUÊ: a assinatura e a foto viviam em `orders.pod` (JSONB), até ~2,2 MB cada.
 * Como todas as leituras de pedidos fazem `SELECT *`, abrir a lista de encomendas
 * arrastava as imagens de todas as entregas da página — dezenas ou centenas de MB
 * para desenhar um ecrã que nem mostra imagens. Os relatórios, com teto de 20.000
 * pedidos, eram inviáveis. E cada `pg_dump` levava tudo atrás.
 *
 * Depois desta migração `orders.pod` guarda só metadados (quem recebeu, quando,
 * coordenadas, notas) mais os sinalizadores `has_signature` / `has_photo`. As
 * imagens ficam em `order_pod_images`, lidas apenas quando alguém abre o detalhe.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyPodImagesSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS order_pod_images (
      order_id   TEXT        PRIMARY KEY,
      signature  TEXT,
      photo      TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Backfill: as entregas já registadas mudam de sítio sem perder a prova.
  // `jsonb_exists` em vez do operador `?` — o ponto de interrogação é ambíguo
  // demais em SQL passado por driver.
  await client.query(`
    INSERT INTO order_pod_images (order_id, signature, photo, updated_at)
    SELECT id, pod->>'signature', pod->>'photo', updated_at
      FROM orders
     WHERE pod IS NOT NULL
       AND (jsonb_exists(pod, 'signature') OR jsonb_exists(pod, 'photo'))
    ON CONFLICT (order_id) DO NOTHING;
  `);

  // Só depois de copiadas é que saem do pedido. Os sinalizadores substituem-nas,
  // para o ecrã saber que há prova sem ter de a carregar.
  await client.query(`
    UPDATE orders
       SET pod = (pod - 'signature' - 'photo') || jsonb_build_object(
                   'has_signature', coalesce(nullif(pod->>'signature', ''), NULL) IS NOT NULL,
                   'has_photo',     coalesce(nullif(pod->>'photo', ''),     NULL) IS NOT NULL
                 )
     WHERE pod IS NOT NULL
       AND (jsonb_exists(pod, 'signature') OR jsonb_exists(pod, 'photo'));
  `);
}

module.exports = { applyPodImagesSchema };
