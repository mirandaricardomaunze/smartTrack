# AGENTS.md — sistemaTrack: Logistics & Delivery Tracking Platform

> **Arquitetura:** Frontend e Backend são projetos **separados** dentro do monorepo.
> Nunca importar código de `backend/` dentro de `frontend/` diretamente.
> O backend é um monólito modular; os módulos são carregados pelo entry point da API.
> Comunicação do frontend exclusivamente via HTTP (API Gateway) ou WebSocket.

> Regras de comportamento e restrições para agentes de IA que trabalham neste repositório.
> Todo agente (Antigravity, Copilot, Cursor, etc.) **deve** seguir estas diretrizes ao modificar código.

---

## ⚡ REGRA ZERO — Spec e Harness Primeiro (SEM EXCEÇÃO)

> [!CAUTION]
> **Todo agente DEVE consultar spec e harness ANTES de gerar qualquer código.**
> Gerar código sem esta consulta é não-conformidade e deve ser revertido.

### Antes de qualquer código, consultar obrigatoriamente:

| Recurso | Caminho | O que verificar |
|---------|---------|-----------------|
| **Spec técnica** | `docs/spec/especificacao-tecnica-v1.md` | Requisitos, entidades, fluxos críticos |
| **Factories** | `tests/harness/factories/` | Usar factory existente ou criar nova |
| **Fixtures** | `tests/harness/fixtures/` | Dados de teste canônicos do projeto |
| **Mocks JWT** | `tests/harness/mocks/jwt-payloads.mock.ts` | Payloads de autenticação para testes |

### Regras de uso do harness

```typescript
// ✅ CORRETO — sempre usar o harness
import { OrderFactory }    from 'tests/harness/factories/order.factory';
import { MockJwtPayloads } from 'tests/harness/mocks/jwt-payloads.mock';

// ❌ PROIBIDO — dados inline em testes
const order = { id: 'abc', status: 'criado' }; // nunca fazer isso
```

- **Nunca** criar dados de teste inline em arquivos `.spec.ts` / `.test.ts`.
- **Sempre** extrair dados reutilizáveis para `tests/harness/`.
- Se a factory/fixture não existe → criar primeiro, depois usar.
- Ver checklist completo em `.agents/hooks/HOOKS.md`.

---

## 1. Contexto do Projeto

**sistemaTrack** é um sistema multi-plataforma de logística e rastreamento de entregas com suporte a:
- **App Cliente** — Next.js (web, responsivo)
- **App Motorista** — Next.js (web, PWA com suporte offline via Service Worker)
- **Painel Admin** — Next.js
- Backend monólito modular — Node.js + PostgreSQL, com fronteiras de domínio
- Integração com rastreamento internacional (17TRACK, Cainiao, Correios)

> **Decisão de stack (ADR-003):** Todo o frontend usa **Next.js**. Não há React Native neste projeto.
> Apps de motorista e cliente são web apps responsivos/PWA. Ver `docs/adr/ADR-003-nextjs-only-frontend.md`.

Leia `docs/spec/especificacao-tecnica-v1.md` antes de propor mudanças arquiteturais.

---

## 2. Regras Globais para Agentes

### 2.1 Segurança (NUNCA violar)

- **Nunca** hardcode credenciais, chaves de API, secrets ou tokens em código-fonte.
  - Use `.env` (nunca commitado) ou serviço de secrets gerenciado (AWS Secrets Manager, GCP Secret Manager).
- **Nunca** desabilitar validação de JWT ou checks de RBAC sem aprovação explícita do tech lead.
- **Nunca** logar dados pessoais brutos (CPF, GPS, dados de cartão) — mascarar sempre com `maskPII()`.
- Toda rota de API exposta deve ter middleware de auth aplicado. Rotas públicas devem ser decoradas com `@Public()` de forma explícita — o default é protegido.
- Inputs de API sempre validados via DTOs com `class-validator` (NestJS) ou equivalente. Nunca aceitar `any` sem schema.

### 2.2 Dados e Privacidade (LGPD)

- Localização GPS só coletada após consentimento explícito do usuário armazenado em `ConsentLog`.
- Dados pessoais em respostas de API: aplicar princípio do menor privilégio — expor somente campos necessários para o perfil do token.
- Nunca expor `cliente_id`, `motorista_id` ou dados PII em mensagens de erro retornadas ao cliente.
- Retenção de dados: seguir a política em `docs/spec/politica-retencao-dados.md` (a ser criada pelo time jurídico/produto).

### 2.3 Auditoria e Eventos de Status

- Todo evento de mudança de status de pedido **deve** gerar um `EventoRastreio` imutável no banco.
- Nunca deletar `EventoRastreio` — apenas soft delete com flag se absolutamente necessário, mas o histórico é inviolável.
- Timestamps sempre em UTC; armazenar como `timestamptz` no PostgreSQL. Nunca armazenar string de data sem timezone.
- Cada evento publicado na fila (Kafka/SQS) deve incluir obrigatoriamente: `correlation_id`, `timestamp`, `source_service`, `schema_version`.

### 2.4 Consistência de Código

- Seguir linters configurados: ESLint + Prettier (NestJS/Next.js), golangci-lint (Go se usado).
- **Proibido** em código de produção: `console.log`, `fmt.Println` de debug, `TODO` sem issue linkada.
- Testes unitários **obrigatórios** para: lógica de domínio, mapeamento de status, resolução de conflito offline, cálculo de métricas de motorista.
- Cobertura mínima: 80% em `src/domain/` e `src/application/`.
- Nomear testes no padrão: `describe('OrderStatus mapper') → it('should map 17TRACK "Delivered" to OrderStatus.DELIVERED')`.

### 2.5 Contratos de API

- Mudanças de contrato (campos adicionados, removidos ou com tipo alterado) **devem** atualizar o schema OpenAPI correspondente em `docs/openapi/`.
- Versionar APIs com prefixo: `/v1/`, `/v2/`. Nunca quebrar contrato de uma versão existente — deprecar e adicionar versão nova.
- DTOs de request/response devem ter exemplos em `docs/openapi/` para cada endpoint.

### 2.6 Mensageria / Eventos Assíncronos

- Schemas de eventos Kafka/SQS registrados em `docs/events/schemas/` e versionados.
- Consumers **devem** ser idempotentes — processar o mesmo evento duas vezes não deve gerar efeito duplicado.
- Usar `idempotency_key` baseado em `(entity_id + event_type + timestamp_bucket)`.
- Dead Letter Queue (DLQ) configurada para toda fila de consumo — falhas nunca silenciadas.

### 2.7 Offline / PWA (App Motorista — Next.js)

- App do motorista é uma **PWA** (Progressive Web App) com Service Worker para cache offline.
- Ações críticas (atualização de status, fotos) são armazenadas no **IndexedDB** do browser via `idb` quando sem conexão.
- Sincronização: ao recuperar conexão, a fila do IndexedDB é drenada em ordem cronológica por `device_timestamp` via API.
- Resolução de conflito: `last-write-wins` por `device_timestamp`. Conflitos logados em `ConflictLog` no servidor — nunca silenciados.
- Service Worker registrado em `frontend/driver-app/public/sw.js` — não modificar sem revisão do tech lead.
- Nunca assumir que sincronização foi bem-sucedida sem ACK confirmado do servidor.

---

## 3. Estrutura de Diretórios

```
sistemaTrack/                     ← raiz do monorepo (Turborepo)
├── .agents/                      # Configurações de agentes
│   ├── AGENTS.md                 # Este arquivo
│   ├── skills/                   # Skills por domínio
│   └── hooks/                    # Checklists pre/post geração
│
├── frontend/                     # ══ FRONTEND — 100% Next.js ══
│   ├── README.md
│   ├── client-app/               # Next.js — Portal do Cliente (web responsivo)
│   │   └── src/
│   │       ├── app/              # App Router Next.js
│   │       ├── components/
│   │       ├── services/         # fetch wrappers → API Gateway
│   │       ├── hooks/
│   │       └── lib/              # utils, formatters
│   ├── driver-app/               # Next.js — App do Motorista (PWA offline)
│   │   ├── public/
│   │   │   └── sw.js             # Service Worker (cache offline)
│   │   └── src/
│   │       ├── app/              # App Router Next.js
│   │       ├── components/
│   │       ├── services/
│   │       ├── hooks/
│   │       └── lib/
│   │           └── offline/      # IndexedDB queue, sync logic
│   └── admin-panel/              # Next.js — Painel Admin
│       └── src/
│           ├── app/              # App Router Next.js
│           ├── components/
│           ├── services/
│           └── hooks/
│
├── backend/                      # ══ BACKEND (monólito modular) ══
│   ├── README.md
│   ├── api-gateway/              # Entry point único, auth/RBAC e HTTP
│   ├── orders-service/           # Módulo de pedidos, eventos e sync offline
│   │   └── src/
│   │       ├── domain/           # Entidades, value objects, regras de negócio
│   │       ├── application/      # Use cases, DTOs de serviço
│   │       ├── infrastructure/   # DB, Kafka, Redis adapters
│   │       ├── api/              # Controllers, DTOs de request/response
│   │       └── auth/             # Guards, decorators RBAC
│   ├── routes-service/           # Otimização de rotas
│   ├── payments-service/         # Cobranças, webhooks, conciliação
│   ├── notifications-service/    # Push FCM, preferências
│   ├── tracking-intl-service/    # 17TRACK/Cainiao, StatusMapper
│   └── shared/                   # Packages compartilhados APENAS entre serviços
│       ├── types/src/            # Enums e interfaces (@sistematrack/types)
│       ├── events/schemas/       # JSON Schemas de eventos Kafka/SQS
│       └── utils/src/            # Logger, maskPII, retry (@sistematrack/utils)
│
├── infra/
│   ├── docker/
│   │   └── docker-compose.yml    # PostgreSQL + Redis + Kafka + UIs de dev
│   └── k8s/                      # Kubernetes manifests
│
├── docs/
│   ├── spec/                     # Especificação técnica
│   ├── openapi/                  # Schemas OpenAPI por serviço
│   ├── events/                   # Documentação de eventos async
│   └── adr/                      # Architecture Decision Records
│
├── tests/
│   ├── e2e/                      # Testes end-to-end (Playwright/Detox)
│   ├── integration/              # Testes entre serviços
│   └── harness/                  # Factories, fixtures, mocks
│       ├── factories/            # Builders de dados de teste
│       ├── fixtures/             # JSON de dados estáticos
│       └── mocks/                # Mocks de JWT, gateways, etc.
│
├── package.json                  # Workspaces root
├── turbo.json                    # Pipeline Turborepo
└── tsconfig.json                 # TypeScript base config
```

### Fronteira Frontend ↔ Backend

> [!IMPORTANT]
> Frontend **nunca** importa código de `backend/` diretamente.
> Toda comunicação é via HTTP/WebSocket para o `api-gateway`.

| De \ Para | `frontend/` | `backend/shared/` | `backend/*-service` |
|-----------|:-----------:|:-----------------:|:-------------------:|
| `frontend/` | ✓ interno | ✗ proibido | ✗ proibido |
| `backend/*-service` | ✗ proibido | ✓ via npm | ✓ módulos internos |
| `backend/api-gateway` | ✗ proibido | ✓ via npm | ✓ chamadas diretas aos casos de uso |

---

## 4. Status de Pedido — Vocabulário Canônico

```typescript
// packages/shared-types/src/order-status.enum.ts
export enum OrderStatus {
  CREATED               = 'criado',
  COLLECTED             = 'coletado',
  IN_TRANSIT            = 'em_transito',
  AT_WAREHOUSE          = 'no_armazem',
  AWAITING_DESTINATION  = 'aguardando_destino',
  OUT_FOR_DELIVERY      = 'saiu_para_entrega',
  DELIVERED             = 'entregue',
  FAILED                = 'insucesso',
  CANCELLED             = 'cancelado',
}
```

- **Nunca** usar strings literais de status fora deste enum no código de domínio.
- Status externos (transportadoras internacionais) **sempre** mapeados via `StatusMapper` antes de persistir.
- Skill de referência: `.agents/skills/order-status-mapper/SKILL.md`

---

## 5. Fluxos Críticos — Restrições para Agentes

### Sincronização Offline → Online
Ver `.agents/skills/offline-sync-resolver/SKILL.md` antes de modificar qualquer lógica de sync.

### Rastreamento Internacional
- Status brutos de transportadoras **nunca** persistidos sem normalização.
- Timeout na API externa → status interno `IN_TRANSIT` mantido, evento de alerta emitido.
- Ver `.agents/skills/order-status-mapper/SKILL.md`.

### Pagamentos
- Toda tentativa de cobrança usa `idempotency_key` único: `pedido_id:tentativa_numero`.
- Falha → retry com exponential backoff (3 tentativas), depois alerta manual.
- MVP: pedido não bloqueado por falta de pagamento. Fase 2: implementar bloqueio.
- Ver `.agents/skills/payment-idempotency/SKILL.md`.

---

## 6. Referências

- [Spec Técnica v1.0](./docs/spec/especificacao-tecnica-v1.md)
- [ADR-001: Escolha de Stack](./docs/adr/ADR-001-stack.md)
- [ADR-002: Estratégia Offline](./docs/adr/ADR-002-offline-strategy.md)
- [ADR-003: Frontend 100% Next.js](./docs/adr/ADR-003-nextjs-only-frontend.md)
- [Schemas de Eventos](./docs/events/schemas/)
- [OpenAPI por Serviço](./docs/openapi/)
- [Test Harness](./tests/harness/)
- [Skills de Agentes](.agents/skills/)
