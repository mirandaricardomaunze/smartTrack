/**
 * @file offline-assets.spec.ts
 * @description O build de produção e o primeiro desenho não podem depender da rede.
 *
 * Vive em tests/integration/ e não dentro de cada app porque a regra é do
 * repositório inteiro: as três aplicações compilam no mesmo `docker build`, e
 * basta uma delas ir buscar a fonte à internet para a imagem não fechar.
 *
 * Não precisa de PostgreSQL — só lê ficheiros.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { scanExternalAssets, describeAssetRefs } from '../harness/external-assets';

const ROOT = join(__dirname, '..', '..');
const APPS = ['admin-panel', 'client-app', 'driver-app'] as const;

describe('frontends · compilar e desenhar sem rede', () => {
  it.each(APPS)('%s não importa next/font/google', (app) => {
    const { googleFontImports } = scanExternalAssets(join(ROOT, 'frontend', app));

    expect(
      googleFontImports,
      `next/font/google descarrega a fonte durante \`next build\` — a compilação\n` +
      `de produção passa a exigir internet. Usar @font-face sobre os ficheiros de\n` +
      `public/fonts/:\n${describeAssetRefs(googleFontImports)}`,
    ).toEqual([]);
  });

  it.each(APPS)('%s não vai buscar recursos a domínios de terceiros', (app) => {
    const { assets } = scanExternalAssets(join(ROOT, 'frontend', app));
    // As tiles do mapa são rede por natureza — ver a nota em external-assets.ts.
    const externos = assets.filter((a) => !a.isTile);

    expect(
      externos,
      `Estes recursos deixam de chegar quando o cliente está atrás de uma firewall\n` +
      `que bloqueia CDNs — o painel fica sem tipo de letra, o mapa sem marcadores.\n` +
      `Servir a partir de public/:\n${describeAssetRefs(externos)}`,
    ).toEqual([]);
  });

  it.each(APPS)('%s traz a fonte Inter vendorizada em public/fonts', async (app) => {
    const { access } = await import('node:fs/promises');
    const base = join(ROOT, 'frontend', app, 'public', 'fonts');

    // Os dois subconjuntos: latin cobre o português, latin-ext cobre nomes e
    // moradas com caracteres fora dele.
    await expect(access(join(base, 'inter-latin.woff2'))).resolves.toBeUndefined();
    await expect(access(join(base, 'inter-latin-ext.woff2'))).resolves.toBeUndefined();
  });
});
