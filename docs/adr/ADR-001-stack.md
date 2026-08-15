# ADR-001: Escolha de Stack Tecnológica

**Status:** Superseded por [ADR-002](ADR-002-monolito-modular.md) (2026-08)
**Date:** 2025-07
**Deciders:** Tech Lead, Arquiteto, CTO

> **Este documento descreve um sistema que não foi construído.** Fica como
> registo histórico da intenção inicial — é para isso que servem os ADR —, mas
> não descreve o código: não há NestJS, React Native, Redis, Kafka nem
> Kubernetes. O que existe é um monólito modular num só processo, com
> PostgreSQL, e está registado no [ADR-002](ADR-002-monolito-modular.md).
>
> Não o siga para provisionar infraestrutura.

---

## Contexto

O SmartTrack precisava de uma stack que atendesse simultaneamente:
- Multi-plataforma mobile (iOS + Android) para cliente e motorista
- Painel web administrativo
- Backend escalável com suporte a microsserviços
- Suporte offline obrigatório no app do motorista

## Decisão

| Camada | Escolha | Alternativas Consideradas |
|---|---|---|
| Mobile | React Native | Flutter, native (Swift/Kotlin) |
| Admin Web | Next.js | Vite+React, Angular |
| Backend | NestJS (Node.js + TypeScript) | Go, Django, Spring Boot |
| DB | PostgreSQL + Redis | MySQL+Memcached, MongoDB |
| Mensageria | Kafka / AWS SQS | RabbitMQ, Google Pub/Sub |
| Infra | AWS / K8s | GCP, Azure, Heroku |

## Justificativas

**React Native:** Time com expertise em JS/TS. Code sharing máximo entre iOS e Android. Comunidade grande. Suporte a SQLite offline via `react-native-sqlite-storage`.

**NestJS:** TypeScript end-to-end (shared types com frontend). Arquitetura modular natural para microsserviços. Decorators facilitam RBAC, validação, OpenAPI.

**PostgreSQL:** ACID compliance para dados transacionais (pagamentos, pedidos). `timestamptz` nativo. JSON support para campos flexíveis.

**Redis:** Geolocalização de motoristas em tempo real (GEO commands). Cache de status de pedidos. Session management.

**Kafka/SQS:** Desacoplamento de serviços. Replay de eventos. DLQ para falhas. Suporte a consumers idempotentes.

## Consequências

**Positivas:**
- TypeScript em toda a stack reduz erros de integração
- Shared types package evita duplicação de modelos
- React Native acelera entrega do MVP mobile

**Negativas / Riscos:**
- NestJS tem curva de aprendizado (decorators/DI)
- Kafka adiciona complexidade operacional vs SQS managed
- React Native pode ter limitações de performance para mapas em tempo real (mitigar com Mapbox GL Native)

## Revisão

Esta decisão deve ser revisada se: volume superar 100k pedidos/dia (avaliar Go para serviços de alto throughput), ou se o time crescer significativamente com expertise em outra stack.
