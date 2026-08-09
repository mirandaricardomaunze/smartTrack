# SmartTrack

Plataforma web de logística e rastreamento de entregas para clientes,
motoristas e administração.

## Arquitetura

```text
frontend/   ← três aplicações Next.js (cliente, motorista e administração)
backend/    ← monólito modular Node.js/Express, API única em /v1
infra/      ← PostgreSQL e recursos de infraestrutura
docs/       ← especificação, contratos e decisões arquiteturais
tests/      ← harness, testes de integração e E2E
```

Frontend e backend permanecem separados. As aplicações web nunca importam
código do backend; toda comunicação passa pela API HTTP na porta 4000.

## Arranque rápido

```bash
npm install
npm run migrate:backend
npm run dev:backend
```

Ou inicie backend e os três frontends:

```bash
npm run dev
```

- API/health: `http://localhost:4000/health`
- Não é necessário iniciar processos nas portas 4001–4005.

## Testes

```bash
npm test
npm run test:integration
npm run typecheck
```

## Documentação

| Documento | Caminho |
|---|---|
| Especificação técnica | [`docs/spec/especificacao-tecnica-v1.md`](docs/spec/especificacao-tecnica-v1.md) |
| Idioma e nomenclatura do código | [`docs/spec/code-language-policy.md`](docs/spec/code-language-policy.md) |
| Plano de migração da nomenclatura | [`docs/spec/code-language-migration-plan.md`](docs/spec/code-language-migration-plan.md) |
| Decisão do monólito modular | [`docs/adr/ADR-004-modular-monolith.md`](docs/adr/ADR-004-modular-monolith.md) |
| Backend e módulos | [`backend/README.md`](backend/README.md) |
| Regras para agentes | [`.agents/AGENTS.md`](.agents/AGENTS.md) |
