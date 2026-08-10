# Especificação de idioma e nomenclatura do código

**Versão:** 1.0  
**Estado:** obrigatório para código novo; migração gradual para código existente  
**Atualizado em:** 2026-08-09

## 1. Decisão

O idioma canónico do código-fonte do SmartTrack é **inglês**. A interface e a
comunicação com utilizadores permanecem em **português**.

Esta separação aplica-se da seguinte forma:

| Área | Idioma obrigatório | Exemplo |
|---|---|---|
| Variáveis, funções, classes e tipos | Inglês | `pendingOrders`, `calculateDeliveryPrice` |
| Ficheiros e diretórios técnicos novos | Inglês | `delivery-attempt.service.ts` |
| Campos novos de API, banco e eventos | Inglês | `deliveryAddress`, `company_id` |
| Testes (`describe`/`it`) | Inglês | `it('should reject an expired token')` |
| Texto visível, mensagens e relatórios | Português | `Entrega concluída com sucesso.` |
| Termos legais/fiscais oficiais | Português quando necessário | Nome oficial do documento |
| Documentação de produto | Português | Esta especificação |

Comentários técnicos novos devem preferencialmente ser escritos em inglês. Um
ficheiro não deve alternar idiomas sem uma razão ligada à interface ou ao domínio
legal.

## 2. Regras obrigatórias

1. Todo identificador técnico novo deve ser inglês e expressar intenção.
2. Funções usam verbo + objeto: `createOrder`, `assignDriver`, `calculateTax`.
3. Booleanos usam `is`, `has`, `can` ou `should`: `isActive`, `hasProofOfDelivery`.
4. Coleções usam plural: `orders`, `deliveryAttempts`.
5. Tipos/classes usam `PascalCase`; funções/variáveis usam `camelCase`; constantes
   globais usam `UPPER_SNAKE_CASE`; tabelas e colunas usam `snake_case`.
6. Abreviações ambíguas são proibidas. São permitidas abreviações universais do
   projeto, como `id`, `api`, `url`, `gps`, `jwt`, `otp`, `pod`, `sla`, `pdf` e `csv`.
7. Não traduzir nomes de bibliotecas, protocolos, marcas nem termos oficiais.
8. Um contrato público existente não pode ser renomeado silenciosamente.

## 3. Exceções controladas

Português é permitido em:

- strings apresentadas ao utilizador;
- conteúdo de e-mail, SMS, WhatsApp, push, PDF e CSV;
- traduções, etiquetas e mensagens de validação;
- fixtures que representam conteúdo real recebido ou apresentado;
- nomes legais que perderiam precisão ao serem traduzidos;
- campos legados durante o período formal de compatibilidade.

Uma exceção em identificador técnico deve ser documentada no código com
`language-policy: allow <motivo>` e não pode ser usada para contornar a regra.

## 4. Prioridade e sequência de migração

### P0 — imediatamente

- Todo código e contrato novo segue esta especificação.
- Renomeações feitas dentro de uma alteração já em curso devem ser concluídas antes
  de integrar essa alteração.
- O harness deve validar nomes novos nas áreas alteradas.

### P1 — fronteiras públicas

1. Tipos e DTOs internos ainda não publicados.
2. Serviços e funções de aplicação.
3. Campos de API novos.
4. Eventos assíncronos e documentação OpenAPI.

Contratos já publicados exigem compatibilidade, depreciação e versionamento.

### P2 — domínio e persistência

1. Entidades e value objects.
2. Repositórios e adaptadores.
3. Colunas e tabelas legadas, somente por migration expand/contract.

### P3 — frontend e testes existentes

1. Hooks, serviços e estado.
2. Props e componentes internos.
3. Factories, mocks e descrições de testes.

### P4 — limpeza não funcional

- Comentários antigos, nomes locais isolados e ficheiros que não justificam uma
  alteração própria.

## 5. Procedimento seguro de renomeação

1. Consultar a spec funcional e o harness do domínio.
2. Identificar consumidores com pesquisa global.
3. Classificar o nome como interno, persistido ou contrato público.
4. Criar ou atualizar factory/fixture antes da implementação.
5. Para contrato público, aplicar expand/contract: adicionar o nome inglês,
   aceitar temporariamente o antigo, migrar consumidores, medir uso, deprecar e só
   depois remover numa versão compatível.
6. Para banco, usar migration reversível; nunca renomear diretamente uma coluna em
   produção sem janela de compatibilidade.
7. Executar testes, typecheck, lint, build e testes de integração pertinentes.

## 6. Critérios de aceite

Uma alteração está conforme quando:

- não introduz identificadores técnicos portugueses sem exceção documentada;
- mantém português correto na experiência do utilizador;
- não quebra API, eventos, banco, dados offline ou integrações;
- atualiza spec, OpenAPI e schemas quando o contrato muda;
- usa o `CodeLanguagePolicy` e os cenários da `NamingPolicyFactory` nos testes de
  nomenclatura;
- passa nas verificações automáticas aplicáveis.

