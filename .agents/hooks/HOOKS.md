# Hooks — sistemaTrack Agent Pre/Post Code Generation

Este diretório define **hooks obrigatórios** que todo agente de IA deve seguir
antes e depois de gerar código neste projeto.

> [!IMPORTANT]
> Estes hooks **não são opcionais**. Qualquer geração de código sem consultar
> a spec e o harness é considerada não-conformidade e deve ser revertida.

---

## ════════════════════════════════════════
## PRE-GENERATE — Obrigatório antes de qualquer código
## ════════════════════════════════════════

### PASSO 0 — Ler Spec e Harness (SEMPRE, SEM EXCEÇÃO)

Antes de escrever **qualquer linha de código**, o agente DEVE:

#### 0.1 Ler a Especificação Técnica

```
docs/spec/especificacao-tecnica-v1.md
```

Verificar obrigatoriamente:
- [ ] O módulo/feature que vou implementar está descrito na spec?
- [ ] Há requisitos funcionais ou não-funcionais que impactam minha implementação?
- [ ] Há fluxos críticos (seção 8 da spec) que se aplicam ao que vou construir?
- [ ] O modelo de dados que vou usar está alinhado com as entidades da seção 7?

Se a feature **não está na spec** → parar e documentar antes de codificar.

#### 0.2 Consultar o Test Harness

```
tests/harness/factories/     ← usar factories existentes, não criar dados ad-hoc
tests/harness/fixtures/      ← usar fixtures existentes para dados de teste
tests/harness/mocks/         ← usar mocks de JWT, gateways, etc.
```

Verificar obrigatoriamente:
- [ ] Existe factory para a entidade que vou testar? (`OrderFactory`, etc.)
  - Se sim: usar. Se não: criar em `tests/harness/factories/`.
- [ ] Existe fixture de dados relevante? (`carrier-status-samples.json`, etc.)
  - Se sim: usar. Se não: criar em `tests/harness/fixtures/`.
- [ ] Existe mock JWT para os roles que vou testar?
  - Se sim: usar `MockJwtPayloads` de `tests/harness/mocks/jwt-payloads.mock.ts`.
  - Se não: adicionar ao arquivo existente — nunca criar mock duplicado.

**Regra de ouro:** Nunca criar dados de teste inline em arquivos de spec/test.
Sempre extrair para `tests/harness/`.

---

### PASSO 1 — Qual serviço/app está sendo modificado?

- [ ] `backend/orders-service` → Ler skill `order-status-mapper` se tocar em status
- [ ] `backend/payments-service` → Ler skill `payment-idempotency` **obrigatoriamente**
- [ ] `frontend/driver-app` → Ler skill `offline-sync-resolver` se tocar em sync/offline
- [ ] Qualquer endpoint novo → Ler skill `rbac-enforcement`

Caminhos das skills:
```
.agents/skills/order-status-mapper/SKILL.md
.agents/skills/offline-sync-resolver/SKILL.md
.agents/skills/payment-idempotency/SKILL.md
.agents/skills/rbac-enforcement/SKILL.md
```

---

### PASSO 2 — Conformidade com AGENTS.md

- [ ] Nenhum secret/credencial hardcoded?
- [ ] Timestamps em UTC com timezone explícita?
- [ ] Dados PII mascarados nos logs?
- [ ] Endpoints novos têm guard `@UseGuards()` explícito?
- [ ] Valores financeiros em centavos inteiros (nunca float)?
- [ ] Frontend: JWT nunca em `localStorage`?

---

### PASSO 3 — Contrato de API

- [ ] Identificadores técnicos novos estão em inglês conforme `docs/spec/code-language-policy.md`?
- [ ] Textos visíveis ao utilizador continuam em português?
- [ ] Uma renomeação de contrato usa expand/contract e mantém compatibilidade?
- [ ] Testes de nomenclatura reutilizam `CodeLanguagePolicy`/`NamingPolicyFactory` do harness?

- [ ] Mudança de campo em DTO → atualizar `docs/openapi/` correspondente
- [ ] Novo evento Kafka/SQS → registrar schema em `docs/events/schemas/`
- [ ] Breaking change → incrementar versão da API (`/v2/`)

---

### PASSO 4 — Planejamento de Testes (antes de codificar)

Antes de escrever código, definir:

```
FEATURE: [nome da feature]
SPEC REF: docs/spec/especificacao-tecnica-v1.md § [seção]
FACTORIES USADAS: [OrderFactory | DriverFactory | ...]
FIXTURES USADAS: [carrier-status-samples.json | ...]
MOCKS USADOS: [MockJwtPayloads.ADMIN | ...]

CENÁRIOS DE TESTE:
  - [ ] Happy path: ...
  - [ ] Edge case: ...
  - [ ] Error case: ...
  - [ ] Unauthorized (RBAC): ...
```

---

## ════════════════════════════════════════
## POST-GENERATE — Obrigatório após gerar código
## ════════════════════════════════════════

### PASSO 5 — Escrever/Atualizar Testes usando o Harness

```typescript
// CORRETO — usa harness
import { OrderFactory } from '../../tests/harness/factories/order.factory';
import { MockJwtPayloads } from '../../tests/harness/mocks/jwt-payloads.mock';
import carrierSamples from '../../tests/harness/fixtures/carrier-status-samples.json';

// ERRADO — dados inline (proibido)
const order = { id: 'abc', status: 'criado', ... }; // ← NÃO fazer isso
```

Cobertura mínima obrigatória:
- `src/domain/` e `src/application/` → **80% mínimo**
- Testes de autorização → **100% dos roles** da matriz RBAC testados

---

### PASSO 6 — Lint, Tipos e Formatação

```bash
# Backend (NestJS)
npx eslint src/ --fix
npx prettier --write src/
npx tsc --noEmit

# Frontend (Next.js)
npx eslint src/ --fix
npx prettier --write src/
npx tsc --noEmit

# Cobertura
npm run test:cov   # verificar >= 80% em domain/
```

---

### PASSO 7 — Documentação

- [ ] README do serviço/app atualizado se comportamento mudou?
- [ ] ADR necessário? (mudança arquitetural → criar `docs/adr/ADR-XXX-<titulo>.md`)
- [ ] Schema OpenAPI atualizado?
- [ ] Spec precisa ser atualizada? (se feature foi clarificada durante implementação)

---

### PASSO 8 — Segurança

- [ ] `npm audit` sem vulnerabilidades críticas/altas
- [ ] Nenhum `@Public()` adicionado sem justificativa documentada
- [ ] Nenhum `console.log` ou dado PII em logs

---

## ════════════════════════════════════════
## HOOKS ESPECIALIZADOS
## ════════════════════════════════════════

### Ao Criar Eventos Kafka/SQS

1. Criar schema JSON em `docs/events/schemas/<event-name>.json`
2. Seguir estrutura padrão:
   ```json
   {
     "eventType": "ORDER_STATUS_CHANGED",
     "schemaVersion": "1.0",
     "correlationId": "uuid",
     "timestamp": "2025-01-01T00:00:00Z",
     "sourceService": "orders-service",
     "payload": { "..." : "..." }
   }
   ```
3. Registrar no índice `docs/events/README.md`
4. Criar fixture de exemplo em `tests/harness/fixtures/<event-name>.fixture.json`
5. Escrever teste de consumer usando a fixture

---

### Ao Criar Migrations de Banco

1. Localização: `backend/<service>/src/infrastructure/database/migrations/`
2. Naming: `YYYYMMDDHHMMSS_<descricao>.ts`
3. Implementar `up()` e `down()` (reversível)
4. Nunca dropar coluna sem período de deprecação de ≥ 1 sprint
5. Adicionar seed em `tests/harness/fixtures/` se migration criar dados de referência

---

### Ao Criar Factory Nova no Harness

1. Localização: `tests/harness/factories/<entity>.factory.ts`
2. Deve ter método estático `build(overrides?)` e `buildList(count, overrides?)`
3. Defaults devem ser válidos para o domínio (passar validação do DTO)
4. Nunca usar IDs fixos como `'abc'` — usar padrão `<entity>-test-uuid-NNNN`
5. Exportar do barrel `tests/harness/factories/index.ts`

---

> **Regra absoluta:** Spec e Harness primeiro, código depois.
> Um agente que gera código sem consultar estes dois recursos
> está operando fora do padrão do projeto.
