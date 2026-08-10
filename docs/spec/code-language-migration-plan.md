# Plano de migração da nomenclatura técnica

**Data da auditoria inicial:** 2026-08-09  
**Política:** [code-language-policy.md](code-language-policy.md)

## Objetivo

Eliminar gradualmente identificadores técnicos em português, sem quebrar a API,
o banco de dados, a sincronização offline ou trabalho ainda não integrado.

## Inventário inicial confirmado

| Prioridade | Nome atual | Nome alvo | Área | Estratégia |
|---|---|---|---|---|
| P1 | `getPedidosPage` | `getOrdersPage` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `getPedidos` | `getOrders` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `createPedido` | `createOrder` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `reagendarEntrega` | `rescheduleDelivery` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `getMotoristas` | `getDrivers` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `createMotorista` | `createDriver` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `getArmazemStats` | `getWarehouseStats` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `createArmazem` | `createWarehouse` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `updateArmazem` | `updateWarehouse` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `deactivateArmazem` | `deactivateWarehouse` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `getArmazemOrders` | `getWarehouseOrders` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `getArmazemMovements` | `getWarehouseMovements` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `getRentabilidadeViaturas` | `getVehicleProfitability` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `getDesempenhoMotoristas` | `getDriverPerformance` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P1 | `getDesempenhoMotorista` | `getDriverPerformanceById` | Admin API client | Migrado; alias antigo marcado `@deprecated` |
| P3 | `Pedido` | `Order` | Alias TypeScript legado | Migrar imports e remover numa versão posterior |
| P3 | `EventoRastreioFactory` | `TrackingEventFactory` | Test harness | Exportar ambos temporariamente; migrar testes |
| P3 | `sairParaEntrega` | `startDelivery` | Delivery journey | Novo método chama a mesma etapa; migrar testes |
| P3 | `provaDeEntrega` | `captureProofOfDelivery` | Delivery journey | Novo método chama a mesma etapa; migrar testes |

Textos, mensagens de erro, comentários, nomes de documentos fiscais e conteúdo de
factories em português **não são violações**. A auditoria deve distinguir conteúdo
do utilizador de identificadores técnicos.

## Sequência de execução

1. Introduzir aliases ingleses sem remover os nomes atuais.
2. Adicionar testes garantindo que os dois nomes produzem o mesmo resultado.
3. Migrar consumidores por módulo, começando pelos clientes internos de API.
4. Medir com pesquisa global até o nome antigo não possuir consumidores.
5. Marcar o alias antigo como `@deprecated` durante pelo menos uma versão.
6. Remover nomes antigos apenas numa alteração própria, após testes completos.

## Regra de acompanhamento

Cada pull request que tocar num ficheiro listado deve reduzir ou manter o número de
identificadores legados; nunca pode aumentá-lo. Novos casos descobertos devem ser
adicionados a este inventário com nome alvo, proprietário e estratégia de
compatibilidade.
