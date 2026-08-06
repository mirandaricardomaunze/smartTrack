# SmartTrack — Backend

O backend é um **monólito modular**: uma API, um processo e uma base PostgreSQL,
com regras de negócio separadas por domínio. A decisão está registada em
[`ADR-004`](../docs/adr/ADR-004-modular-monolith.md).

## Estrutura

```text
backend/
├── api-gateway/              # entry point, auth/RBAC e adaptadores HTTP /v1
├── orders-service/           # módulo de sync offline e conflitos
├── routes-service/           # módulo de otimização de rotas
├── payments-service/         # módulo financeiro
├── notifications-service/    # módulo de notificações e preferências
├── tracking-intl-service/    # módulo de rastreio internacional
└── shared/                   # contratos compartilhados do backend
```

Os nomes `*-service` foram mantidos para evitar uma migração de caminhos sem
valor funcional. Esses diretórios são módulos internos e não precisam de abrir
portas próprias.

## Arranque

Na raiz do projeto:

```bash
npm run dev:backend
```

A API fica em `http://localhost:4000`. O health check é `GET /health` e informa
`architecture: "modular-monolith"`.

## Base de dados

Todos os módulos usam as mesmas variáveis:

```env
PGHOST=localhost
PGPORT=5432
PGDATABASE=track
PGUSER=postgres
PGPASSWORD=...
```

Para preparar todas as tabelas na base única:

```bash
npm run migrate:backend
```

O comando normal é não destrutivo e apenas prepara tabelas dos módulos. Para
recriar também as tabelas operacionais e dados de demonstração, existe
`npm run migrate:reset --workspace=api-gateway`; esse comando exige backup.

## Módulos e contratos

| Módulo | Prefixo público | Responsabilidade |
|---|---|---|
| Auth | `/v1/auth` | Login, registo, JWT e RBAC |
| Pedidos | `/v1/orders` | Pedidos e histórico imutável |
| Motoristas | `/v1/drivers` | Equipa, veículos e GPS |
| Armazéns | `/v1/warehouses` | Receção e movimentos |
| Rotas | `/v1/routes` | Otimização e execução |
| Pagamentos | `/v1/payments` | Cobrança, reembolso e conciliação |
| Notificações | `/v1/notifications` | Push, histórico e preferências |
| Rastreio | `/v1/tracking` | Normalização de transportadoras |
| Sync offline | `/v1/driver-sync` | Eventos offline e conflitos |

O frontend continua separado e comunica exclusivamente por HTTP com `/v1`.
Nenhum contrato público foi alterado pela consolidação.

## Integrações simuladas

Enquanto não forem configurados fornecedores reais, o gateway de pagamentos,
FCM e transportadoras internacionais continuam com adaptadores simulados.

## Testes

```bash
npm test
npm run test:integration
```

Os testes de domínio continuam dentro de cada módulo. Factories, fixtures e
mocks canónicos vivem em `tests/harness`.
