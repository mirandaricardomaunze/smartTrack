# ADR-003: Frontend 100% Next.js — Sem React Native

**Status:** Accepted
**Date:** 2025-07
**Deciders:** Tech Lead, Product Owner, CTO

---

## Contexto

A especificação técnica v1.0 previa React Native para os apps de cliente e motorista.
Após avaliação do time, a decisão foi revisada para unificar toda a camada frontend em Next.js.

## Decisão

**Todo o frontend do SmartTrack será desenvolvido em Next.js 14 (App Router).**

| App | Antes | Depois |
|-----|-------|--------|
| `client-app` | React Native | **Next.js 14** (web responsivo) |
| `driver-app` | React Native | **Next.js 14** (PWA + Service Worker) |
| `admin-panel` | Next.js ✓ | **Next.js 14** (sem mudança) |

## Justificativas

**Velocidade de entrega:**
- Uma única stack para todo o time de frontend elimina contexto-switching.
- Componentes, design system, hooks e utilitários são reaproveitados entre os três apps.
- CI/CD unificado (Turborepo pipeline serve para todos).

**Suporte offline via PWA:**
- O app do motorista precisa de suporte offline para captura de eventos sem conexão.
- Next.js + `next-pwa` (ou Service Worker manual) + IndexedDB (`idb`) entrega o mesmo resultado funcional com menos complexidade de stack.
- IndexedDB substitui SQLite para a fila de eventos pendentes — mesmo modelo de dados, sem SDK nativo.

**Distribuição:**
- Apps web são acessíveis via browser, sem necessidade de publicação em App Store / Play Store no MVP.
- PWA pode ser adicionado à tela inicial do dispositivo (add-to-homescreen) — UX equivalente para motoristas.
- Versão nativa pode ser reintroduzida como Fase 4 se métricas de UX indicarem necessidade.

**TypeScript end-to-end:**
- Tipos e contratos de API compartilhados via `@sistematrack/types` funcionam igualmente no Next.js.
- Sem bridge nativa nem incompatibilidades de tipos entre JS e código nativo.

## Impacto nas Skills de Agentes

| Skill | Mudança |
|-------|---------|
| `offline-sync-resolver` | Atualizada: SQLite → IndexedDB (`idb`), sem mudança na lógica de fila |
| `rbac-enforcement` | Sem mudança — roles e guards aplicados via middleware Next.js |
| `order-status-mapper` | Sem mudança — backend apenas |
| `payment-idempotency` | Sem mudança — backend apenas |

## Consequências

**Positivas:**
- Stack unificada: menos overhead operacional
- Code sharing entre os 3 apps (design system, hooks de API, formatters)
- Sem dependência de Apple Developer Account / Google Play para lançar o MVP
- Mais fácil de testar com Playwright (cross-browser)

**Negativas / Riscos:**
- PWA tem limitações em iOS (notificações push, acesso a câmera em alguns browsers) — mitigar com libs específicas (`@capacitor/camera` se necessário em Fase 2)
- Performance de mapas em tempo real pode ser inferior ao nativo — usar Mapbox GL JS (WebGL) para minimizar
- Motoristas podem precisar instalar o PWA na tela inicial — requer onboarding claro

## Revisão

Esta decisão deve ser revisada se:
- Mais de 30% dos motoristas reportarem problemas de UX críticos específicos de PWA/web
- A equipe crescer e dedicar um time exclusivo para mobile nativo
