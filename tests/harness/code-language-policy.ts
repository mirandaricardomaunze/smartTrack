export type LanguagePolicyResult = 'compliant' | 'violation' | 'exempt';

export interface LanguagePolicyFinding {
  identifier: string;
  line: number;
}

const ALLOWED_IDENTIFIERS = new Set([
  'id', 'api', 'url', 'gps', 'jwt', 'otp', 'pod', 'sla', 'pdf', 'csv', 'mapPII',
]);

const PORTUGUESE_TERMS = [
  'aguardando', 'armazem', 'calcular', 'cliente', 'coletado', 'criar', 'entrega',
  'evento', 'fatura', 'motorista', 'pedido', 'pedidos', 'pendente', 'pendentes', 'preco', 'rastreio',
  'rota', 'utilizador', 'viatura',
];

function normalize(identifier: string): string {
  return identifier
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

export class CodeLanguagePolicy {
  static evaluate(identifier: string): LanguagePolicyResult {
    if (ALLOWED_IDENTIFIERS.has(identifier)) return 'exempt';
    const words = normalize(identifier).split(/\s+/).filter(Boolean);
    return words.some((word) => PORTUGUESE_TERMS.includes(word)) ? 'violation' : 'compliant';
  }

  static violations(identifiers: string[]): string[] {
    return identifiers.filter((identifier) => this.evaluate(identifier) === 'violation');
  }

  /**
   * Audits declarations and object methods without inspecting UI strings or
   * comments. This intentionally favours few false positives over pretending
   * to be a complete JavaScript parser.
   */
  static auditSource(source: string): LanguagePolicyFinding[] {
    const sanitized = source
      .replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, '')
      .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (value) => value.replace(/[^\n]/g, ' '));
    const declaration = /\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|\b(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^={]+)?\{/g;
    const findings: LanguagePolicyFinding[] = [];
    const seen = new Set<string>();

    for (const match of sanitized.matchAll(declaration)) {
      const identifier = match[1] ?? match[2];
      if (!identifier || this.evaluate(identifier) !== 'violation') continue;
      const line = sanitized.slice(0, match.index).split('\n').length;
      const key = `${line}:${identifier}`;
      if (!seen.has(key)) findings.push({ identifier, line });
      seen.add(key);
    }

    return findings;
  }
}
