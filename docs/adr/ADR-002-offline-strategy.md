# ADR-002: Estratégia de Suporte Offline — App do Motorista

**Status:** Accepted
**Date:** 2025-07
**Deciders:** Tech Lead, Mobile Lead

---

## Contexto

O app do motorista deve funcionar sem conexão de rede em áreas com cobertura ruim.
Eventos críticos (coleta, entrega, foto, assinatura, GPS) não podem ser perdidos.

## Decisão

**Arquitetura: Local-First com Event Queue Persistida**

1. Toda ação do motorista gera um evento gravado no SQLite local antes de qualquer chamada de rede.
2. Uma fila de sincronização (`pending_events`) persiste eventos não enviados.
3. Ao reconectar: eventos são enviados ao backend em batch, em ordem cronológica por `device_timestamp`.
4. Backend processa idempotentemente (via `correlation_id` único por evento).
5. Conflitos são resolvidos por `last-write-wins` no `device_timestamp`, com log de auditoria.

## Alternativas Consideradas

| Alternativa | Descartada por |
|---|---|
| Queue em memória (sem SQLite) | Perda de dados em crash do app |
| Sync em tempo real apenas | Não funciona sem rede |
| CRDTs (Conflict-free Replicated Data Types) | Complexidade desproporcional ao caso de uso |
| Operational Transform | Idem — usado em editores colaborativos, não em logistics |

## Consequências

**Positivas:**
- Zero perda de dados mesmo em crash do dispositivo
- UX fluida para o motorista: sem bloqueios de rede
- Backend simples: eventos são append-only, idempotentes

**Negativos / Riscos:**
- Conflitos podem ocorrer (dois motoristas com o mesmo pedido?) — mitigado por regra: pedido só pode estar em uma rota por vez
- SQLite tem limitações de tamanho — rotação de eventos sincronizados necessária (deletar após ACK)
- Sincronização fora de ordem pode confundir clientes — mitigado por `device_timestamp` como ordering key

## Referência de Implementação

Ver `.agents/skills/offline-sync-resolver/SKILL.md` para schema SQLite e regras de conflito.
