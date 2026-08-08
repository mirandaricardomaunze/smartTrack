/**
 * @file external-assets.ts — sonda de recursos externos no código dos frontends
 *
 * PORQUÊ EXISTE: `next/font/google` vai à rede durante `next build`. Enquanto
 * houve internet na máquina de quem compilava, ninguém reparou; a compilação de
 * produção partia dentro do `docker build` e em qualquer runner sem saída para
 * fora. O mesmo vale para folhas de estilo e imagens vindas de um CDN — não
 * quebram o build, mas deixam o painel sem tipo de letra e o mapa sem marcadores
 * no cliente cuja rede bloqueia domínios de terceiros.
 *
 * Esta sonda lê o código-fonte e devolve as referências a hosts externos. Não é
 * um teste: é a ferramenta de leitura. A decisão do que é aceitável fica no
 * .spec que a usa.
 *
 * O que NÃO é apanhado de propósito: as tiles do mapa. Um mapa sem servidor de
 * tiles não é um mapa — essa é uma dependência de rede inerente à
 * funcionalidade, não um descuido de empacotamento. Por isso `TILE_HOSTS`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Extensões que podem conter um URL que o navegador vai buscar. */
const SCANNED = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.mjs']);

/** Pastas geradas ou instaladas — o que lá está não é código nosso. */
const SKIPPED_DIRS = new Set(['node_modules', '.next', '.turbo', 'dist', 'coverage']);

/**
 * Hosts de tiles de mapa. Aparecem no relatório marcados como `isTile` para o
 * teste os poder aceitar sem ter de repetir a lista de exceções.
 */
export const TILE_HOSTS = [
  'basemaps.cartocdn.com',
  'tile.openstreetmap.org',
  'api.mapbox.com',
];

/** Uma referência a um recurso servido por outro domínio. */
export interface ExternalAssetRef {
  /** Caminho do ficheiro, relativo à raiz passada à sonda. */
  file: string;
  /** Linha (1-based) onde o URL aparece. */
  line: number;
  /** Host referido, em minúsculas. Ex.: `fonts.googleapis.com`. */
  host: string;
  /** O URL completo, tal como está no código. */
  url: string;
  /** O host serve tiles de mapa? Ver a nota no topo do ficheiro. */
  isTile: boolean;
  /** Linha de código onde foi encontrado, aparada — para a mensagem de erro. */
  snippet: string;
}

/** Importa `next/font/google`, que descarrega a fonte durante o build. */
export interface GoogleFontImportRef {
  file: string;
  line: number;
  snippet: string;
}

/** O que a sonda devolve para uma aplicação. */
export interface ExternalAssetReport {
  /** URLs http(s) absolutos encontrados no código. */
  assets: ExternalAssetRef[];
  /** Importações de `next/font/*` que resolvem pela rede. */
  googleFontImports: GoogleFontImportRef[];
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // pasta inexistente (ex.: app sem public/) — nada a varrer
  }

  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (SCANNED.has(entry.slice(entry.lastIndexOf('.')))) {
      yield full;
    }
  }
}

/**
 * Varre uma aplicação à procura de recursos servidos por outro domínio.
 *
 * @param appRoot Raiz da aplicação (ex.: `frontend/admin-panel`).
 * @returns Referências encontradas, na ordem em que aparecem nos ficheiros.
 */
export function scanExternalAssets(appRoot: string): ExternalAssetReport {
  const assets: ExternalAssetRef[] = [];
  const googleFontImports: GoogleFontImportRef[] = [];

  for (const file of walk(appRoot)) {
    const rel = relative(appRoot, file).split(sep).join('/');
    const linhas = readFileSync(file, 'utf8').split(/\r?\n/);

    linhas.forEach((linha, i) => {
      // Comentários explicam porque NÃO usamos um host; não são referências.
      const semComentario = linha.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');

      for (const m of semComentario.matchAll(/https?:\/\/([a-z0-9.-]+)[^\s'"`)]*/gi)) {
        const host = m[1].toLowerCase();
        assets.push({
          file: rel,
          line: i + 1,
          host,
          url: m[0],
          isTile: TILE_HOSTS.includes(host),
          snippet: linha.trim(),
        });
      }

      if (/from\s+['"]next\/font\/google['"]/.test(semComentario)) {
        googleFontImports.push({ file: rel, line: i + 1, snippet: linha.trim() });
      }
    });
  }

  return { assets, googleFontImports };
}

/**
 * Formata uma lista de referências para a mensagem de falha do teste — sem
 * isto, o relatório é um array de objetos e ninguém percebe onde ir mexer.
 */
export function describeAssetRefs(refs: Array<ExternalAssetRef | GoogleFontImportRef>): string {
  return refs.map((r) => `  ${r.file}:${r.line} → ${r.snippet}`).join('\n');
}
