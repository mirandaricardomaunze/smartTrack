# ADR-004 — Backend como monólito modular

- **Estado:** Aceite
- **Data:** 2026-07-24
- **Decisão:** consolidar os serviços do backend num único processo e numa única base de dados.

## Contexto

O produto ainda tem dimensão pequena, mas exigia seis processos Node, cinco
saltos HTTP internos e várias bases para executar funcionalidades relacionadas.
Isso aumentava a operação local e criava falhas de disponibilidade sem trazer
benefício proporcional nesta fase.

## Decisão

O backend passa a arrancar exclusivamente pelo `api-gateway`, na porta 4000.
Pedidos, rotas, pagamentos, notificações, rastreio internacional e sincronização
offline continuam separados por domínio e camadas, mas os casos de uso são
carregados diretamente no mesmo processo.

- Os contratos HTTP `/v1` permanecem inalterados.
- JWT e RBAC continuam aplicados no adaptador HTTP de cada módulo.
- Todos os módulos usam a base PostgreSQL definida por `PGDATABASE` (`track` por padrão).
- As portas internas 4001–4005 deixam de ser necessárias.
- Os diretórios `*-service` são mantidos como fronteiras de módulo durante a transição.

## Consequências

### Positivas

- Um único comando, processo, deploy e health check.
- Menos pontos de falha e diagnóstico mais simples.
- Transações e dados ficam disponíveis numa base única.
- Os módulos preservam regras de domínio e podem voltar a ser extraídos se a escala justificar.

### Negativas

- Falha do processo afeta todos os módulos.
- Escalabilidade é feita para a aplicação inteira.
- É necessário manter disciplina de fronteiras internas para evitar acoplamento indevido.

## Regra de evolução

Um módulo só deve voltar a ser um serviço independente quando houver uma razão
mensurável, como escala muito diferente, equipa proprietária independente ou
requisito de isolamento operacional.
