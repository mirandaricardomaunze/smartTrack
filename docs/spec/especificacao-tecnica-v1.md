# Especificação Técnica — App de Logística e Rastreamento de Entregas

**Versão:** 1.0
**Papel:** Documento de requisitos e arquitetura, escrito no padrão usado por um engenheiro de software sênior para orientar equipe de desenvolvimento (ou para ser usado como prompt-base em ferramentas de geração de código/IA).
**Atualizado em:** 2025-07

---

## 1. Visão Geral

Aplicativo de logística multi-plataforma (cliente, motorista, administração) para gestão de entregas de ponta a ponta: rastreamento em tempo real, otimização de rotas, pagamentos, comunicação com suporte e relatórios gerenciais. O sistema deve suportar encomendas nacionais e internacionais (incluindo integração com rastreadores de encomendas vindas da China).

**Objetivo de negócio:** reduzir custo operacional por entrega e reduzir o prazo médio de entrega, com visibilidade completa do ciclo de vida do pedido para cliente, motorista e gestão.

---

## 2. Perfis de Usuário (Personas)

| Perfil | Necessidade principal |
|---|---|
| **Cliente** | Rastrear encomenda por código, saber status atual, escolher destino de entrega, pagar taxas, falar com suporte |
| **Motorista** | Ver rotas otimizadas, atualizar status mesmo offline, ser avaliado de forma justa |
| **Administrador/Gestão** | Visão consolidada de operação, métricas, relatórios, custos |
| **Suporte** | Atender clientes via chat em tempo real com contexto do pedido |
| **SUPERADMIN (plataforma)** | Gerir as empresas do sistema (criar/suspender), visão da plataforma |

---

## 2.4 Multiempresa (multi-tenant)

O sistema é **multiempresa**: cada empresa (tenant) tem os seus dados **isolados**.

- **Modelo:** base partilhada (PG único `track`) com **`company_id`** em todas as tabelas de
  dados (orders, drivers, warehouses, clients, pricing_zones, invoices, settlements, support,
  users…). Entidade de topo **`companies`**. Dados anteriores à multiempresa pertencem à
  **Empresa Padrão** (`company-default`).
- **Contexto por requisição:** a empresa vai no **JWT** (`company_id`) e é colocada num contexto
  assíncrono (`AsyncLocalStorage`, `infrastructure/tenant-context.js`) por um middleware global. Os
  repositórios filtram/gravam por essa empresa. Sem empresa no contexto (tarefas de fundo/testes)
  o comportamento é single-tenant (Empresa Padrão) — retrocompatível.
- **Papéis:** utilizadores pertencem a uma empresa (ADMIN/SUPPORT/DRIVER). O **SUPERADMIN** é da
  plataforma (`company_id` null) e gere as empresas; o email é **identidade global**.
- **Auto-registo (SaaS):** `POST /v1/companies/register` (público) cria a empresa + o primeiro
  ADMIN e devolve o token. Frontend: página pública `/registar-empresa` (ligada do `/login`).
  Gestão em `GET /v1/companies` + `POST /v1/companies/:id/status` (SUPERADMIN); consola admin
  `/empresas` (visível só a SUPERADMIN). **Empresa suspensa bloqueia o login** dos seus utilizadores.
- **Rastreio público:** os **códigos de rastreio são globais únicos**; `GET /orders/:code/status`
  resolve o pedido (e a sua empresa) sem filtro de tenant. Um único site de cliente serve todas.
- **Numeração de faturas por empresa:** cada empresa tem a sua sequência `FT{ano}/{seq}`
  (`invoice_counters` por `(company_id, year)`; `invoices.number` único por empresa).
- **Estado (backend):** isolamento **ativo** em Pedidos, Clientes, Faturas, Tarifas (zonas),
  Armazéns (+movimentos), Motoristas, Acertos, Suporte e localizações — todos os repositórios do
  gateway filtram/gravam por empresa. As conversas de suporte abertas pelo cliente (público)
  herdam a empresa do pedido. **Frontend:** registo público de empresa, consola SUPERADMIN
  (`/empresas`) e contexto de empresa no JWT (o admin já opera na sua empresa). Os módulos
  **notifications-service** (notificações, mensagens SMS/email) e **tracking-intl-service**
  (envios rastreados) também isolam por empresa, partilhando o mesmo contexto assíncrono; o
  poller de background corre sem contexto (vê todas as empresas). **Multiempresa completo.**

---

## 2.5 Planos, subscrições e limites (SaaS)

A plataforma **cobra as empresas**. Não confundir com § 3.14 (Faturação), onde a **empresa cobra os
seus clientes** pelo frete: são duas cadeias de faturação distintas, com tabelas e numeração próprias.

- **Catálogo (`plans`).** Global, editável pelo SUPERADMIN: preço mensal (centavos MZN, **IVA incluído**),
  dias de avaliação, limites (`max_orders_per_month`, `max_users`, `max_warehouses` — `NULL` = ilimitado)
  e `self_serve` (falso = plano negociado, fora do upgrade self-service). Por omissão: **Grátis**
  (50 pedidos/mês · 2 utilizadores · 1 armazém), **Starter** (2.500,00 MZN · 500 · 5 · 3, 14 dias de
  avaliação), **Pro** (9.500,00 MZN · 5.000 · 25 · 10) e **Enterprise** (negociado, ilimitado).
- **Subscrição (`subscriptions`).** Uma por empresa, atravessa as mudanças de plano.
  Estados: `trialing` → `active` → `past_due` → `canceled`. O auto-registo (§ 2.4) abre a avaliação do
  plano `SAAS_DEFAULT_PLAN` (por omissão `starter`).
- **Ciclo preguiçoso, sem agendador.** O fim da avaliação, a renovação do período e a emissão da fatura
  são calculados na **primeira leitura após a data** (`computeLifecycle`, pura). Uma fatura por empresa
  e período (índice único parcial) torna a renovação segura sob concorrência.
- **Tolerância antes de cortar.** `past_due` não suspende o serviço de imediato:
  `SAAS_PAST_DUE_GRACE_DAYS` (7) a contar do **primeiro** atraso. Passada a tolerância — ou com a
  subscrição cancelada — as **escritas** são bloqueadas (as leituras nunca).
- **Medição e imposição.** `usage_counters` conta por `(empresa, mês, métrica)`; hoje a métrica é
  `orders`, incrementada na criação do pedido. Utilizadores e armazéns são contados por linha. Ao
  exceder, a API responde **402** com `code` (`QuotaExceededError` / `SubscriptionBlockedError`).
  Pontos de imposição: criar pedido, criar utilizador (`/auth/register`) e criar armazém.
- **Falha aberta.** Empresa sem subscrição (dados anteriores a esta funcionalidade → `enterprise`) ou
  sem empresa no contexto (testes, tarefas de fundo, SUPERADMIN, rotas públicas) **nunca** é bloqueada.
- **Faturação da subscrição (`subscription_invoices`).** Numeração **SB{ano}/{seq}** — sequência
  **global**, porque o emissor é a plataforma. IVA 16% extraído do preço do plano (mesmo
  `splitTaxInclusive` de § 3.14). Duas vias de pagamento: **carteira móvel** (M-Pesa/eMola, hoje
  gateway **simulado** e determinístico em `infrastructure/billing.gateway.js`, com chave de
  idempotência derivada da fatura) e **confirmação manual** pelo SUPERADMIN (transferência/depósito).
  Paga a última fatura em aberto, a subscrição volta a `active`.
- **Mudança de plano.** Sem proração: anula a fatura em aberto do ciclo e abre um período novo ao preço
  novo. Durante a avaliação, mudar de plano não cobra nada.
- **API.** `/v1/subscriptions/plans` (catálogo) · `/me`, `/me/plan`, `/me/cancel`,
  `/me/invoices/:id/checkout` (ADMIN da empresa) · `/`, `/stats`, `/invoices`, `/invoices/:id/pay`,
  `/invoices/:id/void`, `/:companyId/plan`, `POST|PATCH /plans` (SUPERADMIN).
- **Frontend.** Página `/plano` (plano atual, medidores de consumo, catálogo, faturas e checkout),
  aviso global `SubscriptionBanner` (avaliação a terminar, atraso, quota perto do limite) e consola
  `/empresas` com MRR, cobrado/por cobrar, plano por empresa e confirmação manual de pagamentos.
- **Migração.** O esquema vive em `infrastructure/migrations/saas.js` (aditivo e idempotente), aplicado
  pelo núcleo em bases novas e por `migrate-saas.js` — em `migrate-all.js` — em bases já com dados.

---

## 3. Requisitos Funcionais

### 3.1 Rastreamento em Tempo Real
- Rastreamento via GPS de todas as entregas, com atualização automática de localização e status.
- Cliente consulta o status pelo **número do pedido** (sem precisar de login, se possível).
- Estados do pedido padronizados — ver enum canônico em `packages/shared-types/src/order-status.enum.ts`.
- Histórico detalhado e imutável de todas as movimentações (auditoria/timeline por pedido) — ver `EventoRastreio`.
- **Comprovativo de entrega (POD):** na transição `OUT_FOR_DELIVERY → DELIVERED`, captura-se
  **nome de quem recebeu (obrigatório) + assinatura + foto opcional + GPS/hora**, anexado ao pedido
  (`ProofOfDelivery`) e ao evento `delivered` na cadeia de hash. A alternativa é o **insucesso**
  (`OUT_FOR_DELIVERY → FAILED`) com motivo (`DeliveryFailureReason`). Exposto no admin e na tela
  pública do cliente. Endpoints: `POST /v1/orders/:id/deliver` e `.../delivery-failure`.
- **Código de entrega (OTP):** opcionalmente, gera-se um código de 6 dígitos que é enviado ao
  cliente **por SMS** (`POST /v1/orders/:id/delivery-otp`); a entrega exige o código correto. Guarda-se
  apenas o **hash** do código (o texto só sai no SMS), com validação em tempo constante, expiração
  (`DELIVERY_OTP_TTL_MINUTES`, default 240) e limite de tentativas. Um pedido sem OTP emitido entrega
  normalmente.

**Listagem paginada.** `GET /v1/orders` devolve `{ items, total, page, pageSize }`, com filtros
resolvidos em **SQL**: estado, pesquisa (código de rastreio, cliente, cidade de destino), motorista,
armazém, estado do COD e janela de datas. Teto de 200 por página, 25 por omissão. Antes devolvia
**todos** os pedidos da empresa — com dezenas de milhares, a página deixava de abrir e o servidor
carregava a tabela inteira para memória. Os índices `(company_id, created_at DESC)` e
`(company_id, current_status)` servem exatamente esta consulta.

Os **contadores do topo** vêm de `GET /v1/orders/stats`, agregados na base de dados — contá-los no
browser exigia descarregar tudo. A taxa de sucesso é calculada sobre o que já **terminou** (entregues
mais insucessos), porque uma percentagem sobre pedidos ainda em curso não diz nada.

O **relatório** (`/v1/reports/summary`) passou a limitar-se à janela que anuncia, devolvendo
`period`. Antes carregava o histórico completo e apresentava-o sob o rótulo "últimos N dias" — era
ao mesmo tempo um problema de escala e um número que não correspondia ao que a página dizia.

A procura da encomenda a receber, no ecrã de pedidos, passou a ser feita **no servidor**: com a
listagem paginada, o código lido pode não estar na página aberta.

### 3.2 Otimização de Rotas
- Motor de otimização de rotas (multi-parada) considerando: distância, trânsito, janelas de entrega, capacidade do veículo.
- Reotimização dinâmica quando novo pedido entra na rota ou há atraso.
- **Regra de negócio a definir:** ao chegar ao armazém o cliente pode "solicitar envio para determinado destino". Isso recalcula a rota em tempo real — tratar como evento assíncrono (não cadastro estático). Status intermediário: `AWAITING_DESTINATION`.

### 3.3 Notificações Push
- Notificações push segmentadas por perfil, configuráveis por tipo de evento.
- Preferências de notificação por usuário (ligar/desligar por categoria).
- Canal: Firebase Cloud Messaging (FCM).
- **Canais SMS e email:** além do push, o cliente pode ser avisado por **SMS e email** (o pedido
  guarda `client_phone`/`client_email`, capturados no cadastro). Clientes simulados por default e
  **reais quando configurados por ambiente** (`SMS_API_URL`/`SMS_API_KEY`; `EMAIL_API_URL`/
  `EMAIL_API_KEY`) — mesmo padrão do FCM/17TRACK. Cada envio é registado em `outbound_messages`
  (auditoria). **Disparo na entrada no armazém:** ao dar entrada de uma encomenda, envia-se SMS+email
  ("Recebemos a sua encomenda [código] no armazém [nome]."), best-effort (a receção conclui mesmo
  que um canal falhe). Endpoints de leitura: `GET /v1/messaging/messages|stats|provider`.

### 3.4 Painel Administrativo (Dashboard)
- Métricas: entregas no prazo x atrasadas, custo médio, tempo médio, ocupação de veículos.
- Gestão de motoristas, pedidos, rotas e pagamentos em interface única.
- A interface deve usar componentes reutilizáveis do design system para botões, inputs, selects,
  cards, cabeçalhos, tabelas e estados de carregamento/vazio, preservando acessibilidade e
  consistência visual entre módulos.
- Listagens administrativas devem ter paginação com total de registos, intervalo visível,
  navegação anterior/seguinte e tamanho de página configurável (10, 20 ou 50). Tabelas devem
  preservar a largura legível das colunas e usar deslocamento horizontal em ecrãs menores.

### 3.5 Pagamentos
- Integração com gateway (cartão, Pix/boleto).
- Idempotência de transações — ver `.agents/skills/payment-idempotency/SKILL.md`.
- Conciliação financeira diária automática.
- **Cobrança na entrega (COD):** cada pedido pode ter um `cod_amount` (centavos) a cobrar na
  entrega. No fluxo de entrega, o motorista regista o **método** (numerário `CASH` ou mobile money
  `MPESA/EMOLA/MKESH`) e a cobrança fica `collected`. **Acerto de caixa** (`DriverSettlement`): um
  acerto por motorista junta o COD `collected` por acertar, separa o esperado em **numerário** (o
  que entra no caixa) do **mobile money** (informativo — já na conta), e a reconciliação compara o
  numerário recebido com o esperado, registando a **diferença**. Endpoints: `POST /v1/settlements`,
  `POST /v1/settlements/:id/reconcile`, `GET /v1/settlements/driver/:id/cod`.

### 3.6 Suporte Offline (Motorista)
- App do motorista funciona sem conexão: captura eventos localmente e sincroniza ao retornar.
- Resolução de conflitos — ver `.agents/skills/offline-sync-resolver/SKILL.md`.

### 3.7 Avaliação de Desempenho de Motoristas
- Métricas: pontualidade, taxa de sucesso, avaliação do cliente, aderência à rota.
- Histórico por período visível no painel admin.

### 3.8 Relatórios
- Relatórios mensais automáticos: desempenho logístico, por motorista, custos, volume — enviados por e-mail/painel.
- **Painel de relatórios (`GET /v1/reports/summary?days=N`, RBAC ADMIN/SUPPORT):** KPIs
  agregados (total, taxa de sucesso, tempo médio de entrega, % em ≤48h, valor total, COD por
  numerário/mobile), série diária de volume (criados vs entregues, últimos N dias), distribuição
  por estado e ranking de desempenho por motorista. As funções de cálculo (`compute*`) são puras
  sobre pedidos/motoristas; valores em centavos (MZN). Frontend em `/relatorios` com gráfico SVG
  (paleta categórica validada para daltonismo) e exportação CSV. Seletor de intervalo 7/14/30 dias.

### 3.9 Chat em Tempo Real com Suporte
- Canal cliente↔suporte com contexto do pedido já carregado.
- Histórico de conversas por pedido/cliente.
- **Implementação (`/v1/support`):** atendimento **humano** (agentes SUPPORT/ADMIN); o
  campo `sender` reserva `'bot'` para automação futura sem alterar o schema. O "tempo real"
  é por **polling curto** (coerente com o resto do sistema — sem webhooks/sockets nem
  dependências novas). Entidades: `support_threads` + `support_messages`.
  - **Cliente (público, sem login):** `POST /threads` abre a conversa (rate-limited) e
    devolve um `access_token` opaco; `GET /threads/:id?token=` e `POST /threads/:id/reply`
    dão acesso apenas àquela conversa. O token é guardado **apenas como hash SHA-256**
    (texto claro só na resposta de abertura) e verificado em tempo constante — mesmo padrão
    do OTP de entrega. O contexto do pedido é resolvido pelo código de rastreio.
  - **Agente (JWT + RBAC ADMIN/SUPPORT):** `GET /agent/threads[?status=]` (fila),
    `GET /agent/threads/:id` (detalhe + pedido), `POST /agent/threads/:id/reply` (auto-atribui
    o agente), `PATCH /agent/threads/:id` (resolver/reabrir), `GET /agent/stats`.
  - **Frontends:** cliente em `/suporte` (chat que retoma a conversa via token em localStorage);
    admin em `/suporte` (consola com fila + atendimento). Sem emojis.

### 3.10 Integração com Rastreamento Internacional
- Integração com 17TRACK, Cainiao, Correios para consolidar status internacionais.
- Normalização de status via `StatusMapper` — ver `.agents/skills/order-status-mapper/SKILL.md`.
- **Painel admin (tela "Rastreio Internacional"):** registar código+transportadora, disparar
  polling (por código ou ciclo completo), ver a timeline normalizada (status canónico + valor cru
  para auditoria) e métricas. O polling é por **polling periódico, não webhook** (spec §6): além
  do disparo manual, há um agendador de background opcional no backend, configurável por ambiente
  (`TRACKING_POLL_ENABLED`, `TRACKING_POLL_INTERVAL_MS`, `TRACKING_POLL_LIMIT`).
- **Provedor real:** com `TRACK17_API_KEY` definido, o `carrier.client` usa o **cliente HTTP real
  do 17TRACK v2.2** (`track17.client.js` — `register` + `gettrackinfo`, auto-deteção de
  transportadora, key só via ambiente §4). Sem key, cai num simulador determinístico de
  desenvolvimento (assinalado na UI e no arranque). O `raw_status` real (campo `stage` do 17TRACK)
  é normalizado pelo `StatusMapper` como qualquer outro.

### 3.11 Sistema de Design dos Frontends
- Admin, Cliente e Motorista devem usar componentes React reutilizáveis para botões, campos,
  selects, cards, cabeçalhos, alertas, estados vazios/carregamento e paginação.
- Os componentes devem manter o mesmo contrato de acessibilidade e comportamento, permitindo
  apresentação específica por aplicação: maior densidade no Admin e alvos de toque maiores no
  Cliente/Motorista.
- Páginas não devem criar versões locais duplicadas de componentes já existentes no respetivo
  `components/ui`; componentes compostos do domínio podem combinar esses elementos base.
- A adoção do design system não pode alterar regras de rastreio, auditoria, RBAC nem a fila offline
  do Motorista.

### 3.12 Clientes / Remetentes
- Registo de **clientes/remetentes** como entidade reutilizável (contactos, **NUIT**, morada,
  individual ou empresa B2B), base para reaproveitar contactos e apresentar histórico.
- **Backend (`/v1/clients`, RBAC ADMIN/SUPPORT):** `GET` (pesquisa por nome/email/telefone/NUIT +
  paginação), `GET /stats`, `POST` (deduplicação por email), `GET /:id` (detalhe + **histórico de
  encomendas** e agregados), `PUT /:id`, `POST /:id/deactivate`. Entidade `clients`; ligação
  `orders.client_ref_id` (nullable — pedidos antigos continuam válidos).
- **Frontend admin (`/clientes`):** lista com pesquisa/estado/paginação, criação/edição, e detalhe
  com contactos + métricas + histórico. No cadastro de pedido (`/pedidos`), a escolha de um cliente
  registado **pré-preenche** nome/telefone/email e liga o pedido ao cliente. Sem emojis.

### 3.13 Tarifação (motor de preços)
- Preço do frete derivado de **zona de destino** (preço base + preço por kg, com peso incluído) e
  **nível de serviço** (multiplicador Normal/Expresso, configurável por ambiente). Opcional:
  sobretaxa de COD (% configurável). Valores em **centavos (MZN)**. Cálculo por **função pura
  `computeQuote`** (testável); o pedido guarda `weight_grams` e o detalhe `pricing` (base para a
  faturação §3.14).
- **Backend (`/v1/pricing`, RBAC ADMIN/SUPPORT; gestão de zonas só ADMIN):** `GET /zones`,
  `POST /quote`, `POST /zones`, `PUT /zones/:id`, `POST /zones/:id/deactivate`. Entidade
  `pricing_zones` com **zonas por default de Moçambique** (Maputo Cidade, Grande Maputo, Sul,
  Centro, Norte, Internacional). `orders` += `weight_grams`, `pricing` (nullable).
- **Frontend admin (`/tarifas`):** gestão de zonas + **simulador de orçamento**. No cadastro de
  pedido, campos peso/zona/serviço com **"Calcular orçamento"** que preenche o valor. Sem emojis.

### 3.14 Faturação (fatura-recibo)
- **Fatura-recibo interna** do serviço de entrega (frete), emitida a partir de um pedido. O valor do
  pedido é o **total com IVA incluído**; a base tributável e o **IVA (16%, MZ, configurável)** são
  extraídos. Numeração **`FT{ano}/{seq}`** atribuída atomicamente. Uma fatura ativa (não anulada)
  por pedido (idempotente). Valores em centavos (MZN). O **COD** (valor das mercadorias) é um fluxo
  à parte e não entra na fatura.
- **Backend (`/v1/invoices`, RBAC ADMIN/SUPPORT):** `GET` (lista/pesquisa/paginação), `GET /stats`,
  `GET /:id` (+ emissor), `POST` (emitir de pedido), `POST /:id/pay` (marcar paga), `POST /:id/void`
  (anular — não permitido se paga). Entidades `invoices` + `invoice_counters`. **Ligação ao COD:**
  ao cobrar COD na entrega (`deliverOrder`), a fatura ativa do pedido é marcada **paga** com o método
  cobrado (best-effort). Emissor configurável por ambiente (`INVOICE_ISSUER_*`, `INVOICE_TAX_RATE_PCT`).
- **Frontend admin (`/faturas`):** lista + stats + detalhe com **impressão** (documento isolado);
  ação **"Gerar fatura"** no detalhe do pedido. Sem emojis.

### 3.15 Etiquetas e leitura no armazém
- **Etiqueta de expedição imprimível** por pedido, com **código de barras Code128** (gerado em SVG,
  sem dependências — `services/code128.ts`) que codifica o código de rastreio, além de destino,
  cliente, frete e COD. Impressão single (detalhe do pedido) e em lote (página da lista) via
  `services/labelPrint.ts` (janela isolada, formato ~100x60 mm).
- **Leitura no armazém:** o código de barras é lido por leitor de mão (que age como entrada de
  teclado). Na tela de Armazéns, um **"Modo leitura"** com campo auto-focado dá **entrada imediata**
  a cada código lido (reutiliza `intakeOrder`/`dispatchOrder`, que já aceitam `tracking_code`),
  mantendo o foco e um registo das leituras. Sem novas dependências. Sem emojis.
- Nota: Code128 é o formato adequado a leitores de mão de armazém; QR (leitura por câmara) pode ser
  adicionado depois com uma biblioteca dedicada.

### 3.16 Recursos Humanos
- **Núcleo (`/v1/hr`, RBAC ADMIN):** cadastro multiempresa de colaboradores e departamentos,
  com número interno único, contrato, cargo, admissão, salário base, contactos e estado.
- **Férias e licenças:** submissão por período, cálculo de dias e decisão auditável
  (aprovado/recusado, utilizador e data da decisão).
- **Painel (`/rh`):** total/ativos/ausentes, massa salarial base, pedidos pendentes,
  estrutura por departamento, pesquisa e filtros de colaboradores.
- Evolução prevista: assiduidade, processamento salarial, recrutamento, desempenho,
  formação, documentos e portal do colaborador.
- **Assiduidade (`/v1/hr/attendance`):** um registo diário por colaborador, com entrada,
  saída, pausa, minutos trabalhados, atraso e horas extraordinárias. O backend calcula
  os totais a partir das marcações; ajustes manuais guardam motivo e utilizador responsável.
- O painel permite marcar entrada/saída, filtrar por data e consultar o resumo diário.
- **Folha salarial (`/v1/hr/payroll`):** processamento mensal idempotente por empresa e mês,
  com uma linha por colaborador ativo. O bruto parte do salário-base e aceita subsídios,
  bónus e horas extraordinárias; descontos fiscais/previdenciários são valores explícitos
  configurados pelo RH, sem presumir taxas legais. Líquido = bruto + proventos - descontos.
- Estados da folha: `draft`, `approved`, `paid`; aprovação e pagamento guardam utilizador e data.
- **Detalhe e recibo:** folhas em rascunho permitem editar, por colaborador, subsídios, bónus,
  horas extra, imposto, previdência e outros descontos. Cada alteração recalcula os totais.
  O recibo salarial imprimível apresenta colaborador, período, proventos, descontos, líquido,
  estado, assinaturas e data de geração; é documento interno, não certificado fiscalmente.
- **Recrutamento (`/v1/hr/recruitment`):** vagas por departamento, cargo, local e tipo de contrato;
  candidatos ligados a uma vaga e pipeline canónico `applied`, `screening`, `interview`, `offer`,
  `hired`, `rejected`. Toda mudança guarda data de atualização e observações do RH.
- A contratação não cria automaticamente uma conta de acesso nem colaborador, evitando
  provisionamento acidental; o RH confirma o cadastro na etapa de admissão.
- **Desempenho (`/v1/hr/performance`):** avaliações por colaborador e período com objetivos,
  competências (qualidade, produtividade, colaboração e pontualidade), feedback e plano de
  desenvolvimento. Cada nota usa escala 1–5 e a nota final é a média aritmética das competências.
- Estados: `draft` e `completed`; somente rascunhos podem ser alterados e a conclusão é auditada.
- **Operações complementares (`/v1/hr/operations`, RBAC ADMIN):** saldos anuais de férias,
  turnos, banco de horas, documentos, checklists de admissão/desligamento, formação e
  benefícios/adiantamentos, sempre isolados por empresa e com utilizador/data de criação.
- Saldo disponível de férias = dias atribuídos + transitados - utilizados; valores negativos
  são rejeitados. Banco de horas usa minutos inteiros: crédito soma e débito subtrai.
- Documentos guardam apenas metadados e referência segura ao ficheiro, incluindo validade e
  estado; binários não são armazenados na base. Checklists têm tipo `onboarding` ou `offboarding`
  e progresso derivado dos itens concluídos.
- Formações usam estados `planned`, `in_progress`, `completed`, `cancelled` e participantes
  explícitos. Benefícios e adiantamentos são valores em centavos; prestações nunca podem superar
  o saldo do adiantamento. O resumo operacional agrega alertas e totais sem expor PII desnecessária.
- **Portal do colaborador (`/v1/hr/portal`, RBAC EMPLOYEE):** cada conta é provisionada por
  um ADMIN e ligada a exatamente um colaborador da mesma empresa. O backend resolve sempre o
  colaborador pelo `sub` do JWT; o cliente nunca escolhe um `employee_id` nas consultas pessoais.
- O portal apresenta perfil profissional, assiduidade, saldo e pedidos de férias, banco de horas,
  documentos, formações, benefícios, avaliações concluídas e recibos de folhas aprovadas/pagas.
  O colaborador pode submeter pedidos de férias, mas não aprová-los nem alterar dados de RH.
- Provisionamento (`POST /v1/hr/portal/accounts`, RBAC ADMIN) exige e-mail válido e senha inicial
  forte; e-mail e vínculo são únicos e sujeitos ao isolamento multiempresa.


**Assiduidade pelo turno (revisão de 2026-08).** O horário deixou de ser uma constante no código:

- `hr_shifts` (entrada, saída, pausa, dias de trabalho) alimenta o cálculo, com o colaborador ligado
  por `hr_employees.shift_id`. Resolução: turno do colaborador → único turno ativo da empresa →
  turno de omissão (`HR_SHIFT_*`). Antes, a entrada estava fixa em 07:00 UTC e a jornada em 8 horas,
  o que perdoava qualquer chegada até às 09:00 locais.
- As marcações gravam-se em UTC e o turno é em hora **local**: a conversão usa
  `HR_TIMEZONE_OFFSET_MINUTES` (120 = UTC+2; Moçambique não tem horário de verão). O dia civil do
  turno é o local, para uma entrada à 01:00 não ser lida como o dia anterior.
- Turno com `work_days` definidos: fora desses dias não há atraso possível e todo o tempo trabalhado
  é extraordinário (estado `rest_day`). Sem `work_days` não se aplica regra semanal.
- As horas extraordinárias medem-se contra a **jornada líquida do turno** (duração menos pausa),
  incluindo turnos que atravessam a meia-noite.

**Regras reforçadas na mesma revisão:** a folha inclui *todos* os colaboradores ativos (a listagem
paginada limitava a 100 e deixava gente de fora em silêncio); aprovar férias desconta `used_days` de
forma atómica e recusa sem saldo (sem saldo configurado não há política e a aprovação passa);
licenças sobrepostas são recusadas e cada pedido só se decide uma vez; violações de unicidade
respondem **409** em vez de 500; e a conta do portal conta para o limite de utilizadores do plano
(§ 2.5) — antes era uma porta lateral para exceder a quota.

**Acesso.** Todas as rotas de RH exigem ADMIN no backend e o portal exige EMPLOYEE. No painel, a
guarda vive num `layout.tsx` por rota (`components/RoleGuard.tsx`) e **nunca dentro da página**: um
`return` antecipado no componente saltaria os hooks seguintes.
---

### 3.17 Finanças
- **Núcleo (`/v1/finance`, RBAC ADMIN):** plano de contas multiempresa e títulos financeiros
  a pagar/receber. Valores são armazenados em centavos MZN e datas em UTC/data civil explícita.
- Plano de contas: `asset`, `liability`, `equity`, `revenue`, `expense`; código único por empresa.
- Títulos: tipo `payable` ou `receivable`; estados `open`, `paid`, `overdue`, `void`.
  Liquidação é idempotente, guarda método, referência, utilizador e data; títulos pagos não
  podem ser anulados. O estado vencido é derivado na leitura quando `due_date < hoje`.
- Painel financeiro apresenta caixa realizado (entradas - saídas pagas), valores a receber,
  valores a pagar, vencidos e série mensal. Esta fase não substitui contabilidade fiscal oficial.

### 3.18 Gestão de Frota e Combustível
- **Backend (`/v1/fleet`, RBAC ADMIN):** cadastro multiempresa de viaturas com matrícula única,
  marca/modelo, ano, tipo, combustível, quilometragem, estado e datas de seguro/inspeção.
- **Abastecimentos:** litros em mililitros e custos em centavos MZN, sempre associados à
  quilometragem atual. A quilometragem nunca pode regredir. Consumo entre abastecimentos completos
  é calculado por `litros / km * 100`; o primeiro abastecimento não produz consumo.
- Estados da viatura: `available`, `in_use`, `maintenance`, `inactive`. Alertas incluem documentos
  vencidos/a vencer em 30 dias e consumo acima do limite configurado.
- Painel apresenta frota ativa, custo de combustível, litros, consumo médio e histórico.

---

### 3.19 Conformidade fiscal (Moçambique)

O que transforma a faturação de § 3.14 num **arquivo fiscal defensável**: documentos numerados sem
saltos, imutáveis, encadeados por assinatura, com o IVA discriminado por taxa, e exportáveis para
auditoria. Aplica-se aos documentos que a **empresa** emite aos seus clientes; as faturas de
subscrição da plataforma (§ 2.5) usam o mesmo mecanismo de assinatura.

**Limite honesto:** o sistema implementa a MECÂNICA da conformidade. Não substitui a **certificação
do software pela AT** (o `SoftwareCertificateNumber` sai a `0` enquanto não houver número atribuído)
nem o parecer do contabilista. Os textos legais das isenções são configuráveis precisamente porque
devem citar a norma em vigor — o sistema obriga a que existam, não inventa o conteúdo.

- **Tipos de documento.** `FT` fatura · `FR` fatura-recibo · `NC` nota de crédito · `ND` nota de
  débito · `RC` recibo (`application/fiscal.js`).
- **Séries e numeração.** `document_series` numera por `(empresa, tipo, série, ano)`. O número legal
  é `FT A2026/0001`. A reserva do número faz-se com `INSERT … ON CONFLICT DO UPDATE`, que **bloqueia
  a linha da série** e serializa as emissões concorrentes — sem saltos nem duplicados. Uma empresa
  pode ter várias séries (ex.: uma por loja); cada uma é uma cadeia independente.
- **Assinatura encadeada.** Cada documento assina `data;dataHoraGravacao;número;total;hashAnterior`
  (SHA-256) e guarda `hash`, `previous_hash` e `hash_control` (4 caracteres impressos no documento,
  para conferir o papel contra o arquivo). Alterar um documento antigo quebra todos os seguintes.
  Quando houver chave privada certificada, a assinatura RSA entra no mesmo ponto e com a mesma
  string canónica.
- **Imutabilidade e correção.** Depois de assinado, um documento **não muda de valores** — só de
  estado. Anular só é possível **antes do pagamento**, fica no arquivo com número, assinatura e
  motivo (a sequência nunca ganha buracos). Depois de pago, corrige-se com **nota de crédito**
  (total ou parcial, com motivo obrigatório e referência ao documento de origem).
- **IVA por taxa.** Cada linha tem a sua taxa; o documento guarda o resumo `tax_summary`
  (base + imposto por taxa). Linha a **0% obriga a código + motivo por extenso** — o requisito legal
  mais esquecido, imposto no núcleo e não na UI. NUIT do emissor e do adquirente validados (9 dígitos).
- **Mapa de IVA.** `GET /v1/invoices/tax-report?period=AAAA-MM` — base tributável e imposto por taxa,
  com as **notas de crédito subtraídas**, mais a contagem por tipo de documento. É a base da
  declaração periódica.
- **Ficheiro de auditoria (SAF-T).** `GET /v1/invoices/saft?period=AAAA-MM` devolve XML no padrão
  OCDE (`application/saft.js`) com cabeçalho da empresa, clientes, tabela de taxas e os documentos do
  período — incluindo os anulados (estado `A`), com hash e hash control. O esquema oficial de MZ deve
  ser confirmado junto da AT; o namespace e a versão são configuráveis.
- **Verificação de integridade.** `GET /v1/invoices/integrity` recalcula a assinatura de cada
  documento, confirma o encadeamento e procura saltos — por série. Documentos anteriores a esta
  funcionalidade contam como **não assinados** (assiná-los agora fabricaria prova que não existiu).
- **Impressão.** O documento leva designação legal e "Original", NUIT do emissor e do adquirente,
  IVA discriminado por taxa, motivo de isenção, referência ao documento retificado, assinatura
  (4 caracteres), "Processado por computador" e identificação do software.
- **API.** Documentos: `POST /v1/invoices/:id/credit-note`, `POST /:id/void { reason }`,
  `GET /v1/invoices?doc_type=`. Fiscal (ADMIN): `tax-report`, `saft`, `integrity`, `GET|POST /series`.
- **Frontend.** Página `/fiscal` (mapa de IVA, integridade por série, exportação SAF-T, séries) e
  `/faturas` com tipo de documento, IVA por taxa, assinatura e emissão de nota de crédito.
- **Migração.** `infrastructure/migrations/fiscal.js` (aditiva e idempotente) + `migrate-fiscal.js`
  em `migrate-all.js`. A numeração **continua** de onde `invoice_counters` (§ 3.14) ficou. A regra
  "uma fatura ativa por pedido" passou a valer só para `FT`/`FR` — a nota de crédito refere o mesmo
  pedido e tem de coexistir com a fatura.

---

### 3.20 Documentos PDF da empresa

Tudo o que a empresa entrega a terceiros sai em **PDF com o seu papel timbrado** — não em impressão
genérica do browser. Uma peça partilhada: perfil/marca da empresa + motor de PDF + modelo único.

- **Perfil da empresa (`company_profiles`).** Designação social, nome comercial, **NUIT**, endereço,
  contactos, **logótipo** (data URL, teto ~300 KB), **cor da marca**, coordenadas bancárias e rodapé
  legal. Tabela à parte de `companies` de propósito: o logótipo é texto pesado e `companies` é lido
  em quase todos os pedidos. Cada empresa nasce com um perfil mínimo a partir do seu nome, para que
  o primeiro documento já saia identificado.
- **É o emissor fiscal.** `invoices.service.resolveIssuer()` lê o perfil da empresa em contexto, com
  o emissor de ambiente (`INVOICE_ISSUER_*`) apenas como rede de segurança. Multiempresa: o
  cabeçalho de uma fatura nunca pode ser o da plataforma. O emissor fica **congelado no documento**
  no momento da assinatura (§ 3.19) — mudar o perfil depois não reescreve o passado.
- **Motor próprio (`services/pdf.ts`), sem dependências.** Pelo mesmo critério do Code128 (§ 3.15):
  páginas A4, fontes-base Helvetica (sem incorporar ficheiros), **acentuação por WinAnsiEncoding**,
  medição real pelas métricas AFM (alinhamento e quebra corretos), filetes, retângulos e imagens
  JPEG. O logótipo passa por canvas para JPEG — resolve PNG/WEBP/transparência de uma vez. Documento
  típico: poucos KB. A tabela de larguras cobre a **pontuação de Latin-1 e o bloco tipográfico do
  WinAnsi** (`—`, `·`, `º`, `…`): sem isso o travessão saía impresso como `?` e cada separador `·`
  era medido a mais do dobro da largura real, o que desalinhava tudo o que está encostado à direita.
- **Modelo único (`services/companyPdf.ts`).** Duas colunas no cabeçalho, com larguras calculadas
  para **não se sobreporem**: à esquerda logótipo (por cima, não ao lado) e identificação do
  emissor; à direita o tipo de documento como etiqueta e, por baixo, o **número em destaque** — é o
  número que se procura ao telefone ou na contabilidade, não a palavra "Fatura". Depois: subtítulo →
  metadados em duas colunas → **caixa das partes** → tabelas → totais → notas → coordenadas
  bancárias → assinaturas → nota legal → rodapé com "Página X de Y" repetido em todas as páginas.
  Quebra de página automática com repetição do cabeçalho reduzido **e dos títulos das colunas da
  tabela**, marcados com "(continuação)": uma segunda página sem títulos é uma lista de números sem
  nome. Nas tabelas usam-se faixas alternadas em vez de um filete por linha (um filete por linha faz
  o documento parecer uma folha de cálculo exportada).
- **O selo de estado tem cor pelo significado**, não pela marca: verde para resolvido (paga, ativa,
  sem violações), cinzento para anulado, âmbar para o que exige ação, cor da marca para o resto. Um
  documento ANULADO com o mesmo selo de um PAGO é ler o estado errado. A cor da letra sobre as
  faixas da marca é escolhida por **contraste** (luminância WCAG) — a marca é escolhida por cada
  empresa e pode ser clara. O total em destaque sai numa faixa cheia, para se encontrar sem procurar.
- **Nada transborda.** As linhas das partes são envolvidas antes de a caixa ser medida, a designação
  social envolve na largura da sua coluna e o rodapé — que é a única linha que não pode crescer — é
  **cortado** com reserva de espaço para o contador de páginas. Verificado por sonda: ver "Testes".
- **Onde já está ligado** (`services/documentPdf.ts`): fatura e **nota de crédito** (com IVA por
  taxa, motivo de isenção, documento retificado e assinatura), **mapa de IVA**, **relatório de
  integridade fiscal**, **fatura de subscrição**, **relatório operacional**, **acertos de caixa** e
  **recibo de remuneração** (com as duas linhas de assinatura manuscrita). Uma página nova ganha
  exportação com uma chamada a `exportReportPdf`.
- **UI.** Página `/empresa` (identificação, marca, logótipo, cor, dados bancários) com **amostra do
  papel timbrado em PDF** antes de gravar. O perfil é lido uma vez por sessão
  (`useCompanyProfile`, cache de módulo) porque viaja com o logótipo.
- **API.** `GET /v1/companies/me/profile` (ADMIN/SUPPORT) · `PUT /v1/companies/me/profile` (ADMIN),
  com validação de NUIT (9 dígitos), cor `#RRGGBB`, e-mail e tipo/tamanho do logótipo.
- **Migração.** `infrastructure/migrations/branding.js` (aditiva e idempotente) + `migrate-branding.js`
  em `migrate-all.js`.
- **Testes.** "Está profissional" não se verifica sem olhar — mas o que estraga um documento
  verifica-se: a sonda `tests/harness/pdf-layout.ts` lê os fluxos de conteúdo (deixados **por
  comprimir** de propósito) e devolve a posição, o corpo e a largura de cada texto. Com ela,
  `companyPdf.spec.ts` afirma que **nada sai fora das margens** e que **nenhum texto é escrito por
  cima de outro**, num conjunto de casos que inclui um documento com designação social, nome de
  cliente e nota legal longos. Foi a sonda que encontrou o rodapé a transbordar. As decisões de cor
  (`badgeColor`, `readableOn`) e o corte de linha (`fitOneLine`) são funções puras, testadas à parte.
  Dados de teste em `tests/harness/factories/company-pdf.factory.ts`.

---

### 3.21 Registo de auditoria

Quem fez o quê, quando e de onde. É o que um cliente empresarial pede primeiro numa avaliação e o
que permite responder a "quem anulou esta fatura?" sem depender da memória de ninguém.

- **Captura automática.** Um middleware regista **todas** as requisições que alteram estado
  (POST/PUT/PATCH/DELETE), **incluindo as recusadas** — uma tentativa sem permissão é exatamente o
  que interessa ver. A cobertura não depende de alguém se lembrar de instrumentar cada caso de uso
  novo, e os módulos que já existiam ficaram cobertos sem lhes tocar. A ação é derivada da rota
  (`POST /v1/invoices/:id/void` → `invoices.void`).
- **Eventos de negócio por cima.** Os atos sensíveis acrescentam contexto que só o caso de uso
  conhece: anulação de documento fiscal e nota de crédito, suspensão de empresa, mudança de plano,
  confirmação manual de pagamento, decisão de licença e estado da folha salarial. Marcam a
  requisição para não haver evento duplicado.
- **Nunca parte a operação.** Uma falha a escrever no registo não impede uma entrega nem uma
  fatura: os erros são apanhados e **contados** (`GET /v1/audit/health`). O contador existe para a
  falha não passar calada — um registo que falha em silêncio é pior do que não ter registo.
- **Append-only e encadeado.** Não existe endpoint nem método de repositório para alterar ou apagar
  um evento (há um teste que falha se algum aparecer). Cada evento é assinado com o hash do anterior
  **da mesma empresa**, com sequência própria: editar uma linha quebra a assinatura, apagar uma
  linha abre um buraco na sequência, e `GET /v1/audit/integrity` denuncia as duas coisas. A escrita
  usa um bloqueio consultivo por empresa, o que serializa apenas o mesmo tenant.
- **Sem corpos de requisição, por decisão.** Trazem senhas, fotografias de comprovativo e
  assinaturas; o valor de auditoria é baixo e o risco é alto. O contexto vai em `metadata`, curado
  por quem regista e passado por uma redação recursiva que oculta senhas, tokens, assinaturas e
  números de telemóvel a qualquer profundidade.
- **Multiempresa.** O registo é filtrado pela empresa em contexto (§ 2.4); o SUPERADMIN vê todas.
  Sequência e cadeia são independentes por empresa.
- **API (só leitura, ADMIN/SUPERADMIN).** `GET /v1/audit` (filtros: período, ação, ator, entidade,
  estado, texto livre, paginação) · `/stats` · `/actions` · `/integrity` · `/health`.
- **Frontend.** Página `/auditoria` com filtros, detalhe do evento (incluindo origem, correlação e
  assinatura), verificação de integridade e exportação em PDF timbrado (§ 3.20).
- **Migração.** `infrastructure/migrations/audit.js` + `migrate-audit.js`, em `migrate-all.js`.

---

### 3.22 Recuperação de senha

Antes disto, um utilizador que perdesse a senha dependia do administrador para a repor à mão — e o
administrador da empresa não tinha a quem recorrer.

- **Fluxo.** `POST /v1/auth/forgot-password` gera um token, envia o link por email e responde;
  `GET /v1/auth/reset-password/:token` diz se o link ainda serve (a página valida antes de pedir a
  senha nova); `POST /v1/auth/reset-password` troca a senha. Públicas por natureza — quem perdeu a
  senha não se consegue autenticar — mas cobertas pelo rate limit estrito de `/v1/auth`.
- **Não revelar quem existe.** O pedido responde **sempre a mesma coisa**, exista ou não a conta,
  esteja ou não travada pelo teto de pedidos. Um formulário que diz "esse email não existe" é um
  verificador de contas gratuito para quem quiser atacar.
- **O token nunca é gravado.** Guarda-se o SHA-256; o valor em claro só existe no email. Quem lê a
  base de dados não consegue redefinir a senha de ninguém.
- **Uso único, prazo curto, substituição.** Validade de `PASSWORD_RESET_TTL_MINUTES` (60 por
  omissão); o consumo do token e a troca da senha acontecem na **mesma transação**; pedir um link
  novo invalida os anteriores, para que um email antigo reencaminhado deixe de abrir a porta.
- **Empresa suspensa não recupera** (§ 2.4): seria uma porta lateral para uma conta cujo acesso está
  deliberadamente cortado. A resposta continua neutra.
- **Teto de pedidos** por conta e por hora (`PASSWORD_RESET_MAX_PER_HOUR`, 5), para o formulário não
  virar uma máquina de enviar email.
- **Política de senha partilhada.** `passwordStrength` em `infrastructure/password.utils.js` com
  limiares por contexto: registo 6 caracteres (retrocompatibilidade), redefinição 8 com letra e
  número, conta do portal do colaborador 10 com maiúsculas e minúsculas.
- **Auditoria.** Pedido e redefinição deixam eventos (§ 3.21) com IP e correlação; o token nunca
  aparece no registo.
- **Email.** Usa o adaptador de `notifications-service`, **simulado** enquanto não houver
  `EMAIL_API_URL`/`EMAIL_API_KEY`. Em desenvolvimento e modo simulado, a resposta devolve o link
  (`debug_link`) para dar para testar sem provedor — nunca em produção.
- **Frontend.** `/recuperar-senha` (pedido, com confirmação neutra) e `/redefinir-senha?token=…`
  (valida o link antes do formulário), ligadas a partir de `/login`.
- **Migração.** `infrastructure/migrations/password-reset.js` + `migrate-password-reset.js`, em
  `migrate-all.js`.

---

### 3.23 Levantamento no armazém (balcão)

Nem toda a encomenda sai para entrega: o cliente pode vir buscá-la ao armazém. Antes disto, dar
baixa de um levantamento obrigava a fingir uma saída para entrega e a marcar entregue logo a seguir
— o que sujava o histórico, estragava as métricas do motorista e produzia um comprovativo a dizer
uma coisa que não aconteceu.

- **Transição própria.** `at_warehouse → delivered` e `awaiting_destination → delivered` passaram a
  ser válidas, sem passar por `out_for_delivery`. Uma encomenda que aguardava decisão de destino
  também pode ser levantada: aparecer ao balcão É a decisão.
- **Movimento próprio.** `pickup` no histórico do armazém, distinto de `dispatch` (saída para
  entrega por motorista). A ocupação do armazém liberta-se naturalmente com a mudança de estado.
- **Quem levanta fica identificado.** Nome e **documento de identificação** são sempre obrigatórios.
- **Terceiros são aceites, com prova.** Quem não é o destinatário tem de declarar a **relação** e
  **como foi autorizado** (autorização escrita, mensagem do destinatário, etc.). Sem esses dois
  campos o levantamento é recusado — é o que permite responder mais tarde a "quem levou a minha
  encomenda?".
- **Verificações.** O **código de entrega** (OTP), quando a encomenda tem um, é exigido ao balcão tal
  como seria à porta, com as mesmas regras de expiração e tentativas. A encomenda tem de estar
  **naquele** armazém — o operador procura por código de rastreio e nada garante que o que leu
  pertence ao balcão onde está.
- **Assinatura e fotografia** opcionais, guardadas no mesmo comprovativo (`pod`) da entrega ao
  domicílio, com um bloco `pickup` que responde a quem levou, com que documento e com que autorização.
- **COD ao balcão.** O valor é cobrado antes de libertar a encomenda e fica marcado com
  `channel: 'warehouse'`. **É excluído do acerto de caixa do motorista** (§ 3.5): o dinheiro entrou
  no caixa do armazém e não pode ser cobrado a quem nunca lhe tocou. A fatura do pedido é marcada
  paga como em qualquer cobrança.
- **API.** `POST /v1/warehouses/:id/pickup` (ADMIN/SUPPORT), com evento de auditoria (§ 3.21) que
  regista o coletor, o documento e a autorização.
- **Frontend.** Botão "Levantar" em cada encomenda da lista do armazém, com formulário que só pede
  relação e autorização quando não é o destinatário, e método de cobrança quando há COD.

**Nota de implementação:** no evento de auditoria o campo chama-se `authorized_how` e não
`authorization` — a redação do registo oculta chaves parecidas com credenciais (cabeçalho
`Authorization`) e apagava justamente a prova que interessa guardar.

---

### 3.24 Saúde das integrações e proibição de dados fictícios em produção

- Pagamentos, SMS, email, push, mapas e rastreio devem expor estado operacional canónico: `production`, `simulated`, `degraded` ou `unavailable`.
- O painel administrativo deve apresentar adaptador, modo, última verificação, último sucesso e erro sanitizado. Chaves, tokens e payloads pessoais nunca são devolvidos.
- `simulated` só é permitido fora de produção. O arranque em produção falha quando uma integração obrigatória não tem configuração real.
- Interfaces operacionais nunca substituem uma falha da API por dados fictícios. Devem mostrar erro, última sincronização conhecida e ação de nova tentativa.
- Alertas devem ser emitidos quando uma integração crítica permanece degradada ou indisponível.

**Critérios de aceitação:** uma falha real não aparece como sucesso; nenhum registo simulado entra em relatórios financeiros ou operacionais; a saúde respeita isolamento por empresa.

### 3.25 Portal autenticado do cliente

- O cliente pode criar conta, autenticar-se, manter endereços, solicitar recolha, obter orçamento e confirmar um envio.
- Pode consultar apenas os próprios pedidos, eventos, faturas, pagamentos, comprovativos de entrega, ocorrências e devoluções.
- Pode descarregar documentos, avaliar a entrega e configurar preferências de contacto.
- Criação e pagamento devem ser idempotentes; o preço confirmado guarda a versão da tarifa aplicada.
- A consulta pública por código continua limitada ao estado necessário, sem expor PII.

**Critérios de aceitação:** tentativa de acesso cruzado retorna `404` ou `403` sem revelar identificadores; reenvio da mesma confirmação não duplica pedido nem cobrança.

### 3.26 Ocorrências e gestão de exceções

- Ocorrências suportadas inicialmente: destinatário ausente, endereço incorreto, dano, atraso, recusa, perda e divergência COD.
- Cada ocorrência possui prioridade, responsável, prazo, descrição, evidências, comentários e histórico imutável de transições.
- Ocorrências críticas aparecem no dashboard e podem gerar notificações e escalonamento por SLA.
- Resolver ou cancelar exige motivo; eventos relevantes são escritos no registo de auditoria.

**Critérios de aceitação:** evidência inválida é rejeitada; resolução sem motivo é rejeitada; alterações entre empresas são bloqueadas.

### 3.27 Logística reversa

- Fluxo canónico: `requested → approved → collecting → received → refunded`; `rejected` encerra um pedido recusado.
- A devolução liga-se ao pedido original e guarda motivo, endereço de recolha, custos, inspeção, responsável e eventual nota de crédito/reembolso.
- Aprovação, reembolso e rejeição são idempotentes e auditados.
- A entrada física da devolução deve produzir movimento de armazém, sem alterar retroativamente eventos do pedido original.

**Critérios de aceitação:** não há reembolso acima do valor elegível; repetição do webhook não duplica reembolso; transições inválidas retornam conflito.

### 3.28 Prova de entrega reforçada

- A política da empresa pode exigir combinação de assinatura, fotografia, OTP, nome do recebedor, GPS e data/hora do dispositivo.
- O servidor guarda também a hora de receção e calcula distância ao destino; tolerância geográfica é configurável.
- Entrega fora da tolerância exige justificativa ou aprovação conforme a política.
- Evidências offline usam idempotency key, checksum e fila cronológica; ACK do servidor é obrigatório antes da remoção local.
- O comprovativo PDF deve conter apenas dados permitidos e pode ser enviado automaticamente ao cliente.

**Critérios de aceitação:** entrega sem evidência obrigatória é rejeitada; replay offline não duplica POD; divergência de relógio ou localização fica auditada.

### 3.29 Planeamento operacional avançado e leitura logística

- A otimização considera capacidade/peso, janela de atendimento, prioridade/SLA, turno, pausa, trânsito e tempo de serviço por paragem.
- O sistema rejeita carga acima da capacidade e explica restrições inviáveis, em vez de produzir uma rota silenciosamente inválida.
- Reotimização preserva paragens concluídas e mantém histórico entre plano original e plano executado.
- Leituras de código cobrem receção, triagem, armazenamento, carregamento, saída e entrega.
- Manifesto de carga bloqueia encomenda/viatura incorreta e suporta localização interna por corredor, prateleira e posição.

**Critérios de aceitação:** uma leitura duplicada é idempotente; leitura fora da sequência gera ocorrência; nenhuma reotimização apaga o plano anterior.

### 3.30 Indicadores, alertas e rentabilidade

- Dashboard prioriza exceções acionáveis: atrasos, falta de atualização, COD pendente, títulos vencidos, documentação da frota e capacidade do armazém.
- Indicadores mínimos: entrega no prazo, sucesso à primeira tentativa, custo por entrega, tempo no armazém, quilómetros por entrega, ocupação, consumo e COD pendente.
- Rentabilidade por entrega usa valores em centavos: receita menos combustível, motorista, portagens, manutenção, taxa de pagamento e terceiros.
- Todo indicador pode ser filtrado por período, empresa, cliente, zona, motorista, rota e armazém, respeitando RBAC.
- Cálculos guardam versão e instante de apuramento para permitir reprodução.

**Critérios de aceitação:** o detalhe reconcilia com o total; divisão por zero é tratada; exportação aplica os mesmos filtros e permissões da tela.

### 3.31 Permissões sensíveis, aprovação e observabilidade

- Permissões são definidas por ação, além do papel: valores financeiros, anulação fiscal, preço, desconto, stock, reembolso, exportação, utilizadores e salários.
- A política da empresa pode exigir dupla aprovação para anulação, desconto, ajuste de stock, reembolso ou liquidação acima de limite configurado.
- Solicitante e aprovador devem ser pessoas diferentes; decisões exigem motivo e são auditadas.
- Todas as requisições recebem `correlation_id`; logs são estruturados e mascaram PII.
- Métricas mínimas: latência, taxa de erro, jobs atrasados, fila offline, webhooks, integrações e estado do banco. Backups devem ter restauração testada.

**Critérios de aceitação:** utilizador sem permissão recebe `403`; autoaprovação é bloqueada; alertas não incluem segredos; restauração é ensaiada e registada.

---

## 4. Requisitos Não Funcionais

### Cópias de segurança e restauro

A base de dados é o **arquivo fiscal** dos clientes — faturas assinadas, cadeias de hash, registo de
auditoria. Perdê-la não é perder dados de trabalho, é perder documentos com valor legal. Por isso o
mecanismo não se limita a copiar.

- **Cópia** (`npm run backup`): `pg_dump` em formato custom comprimido, mais um **manifesto** ao lado
  com SHA-256 do ficheiro e a contagem de linhas das tabelas críticas. O manifesto é o que permite
  provar mais tarde que o restauro trouxe tudo.
- **Retenção** (`backup.policy.js`, puro e testado): guarda a cópia mais recente de cada dia, semana e
  mês — 7/4/6 por omissão. Ficheiros com nomes que não reconhece **nunca** são apagados: decidir o que
  se elimina é a única parte perigosa de um sistema de cópias, e está isolada para poder ser testada
  sem tocar em bases de dados.
- **Cópia fora da máquina**: `BACKUP_UPLOAD_CMD` recebe qualquer comando (`rclone`, `aws s3 cp`, `scp`,
  `rsync`) com `{file}` substituído pelo caminho. Sem fornecedor imposto. Sem esta variável, o script
  **avisa** que a cópia fica apenas no disco que mais provavelmente falha.
- **Ensaio de restauro** (`npm run backup:verify`): confirma o SHA-256, restaura para uma base
  **descartável**, compara as contagens com o manifesto, **revalida as cadeias de hash** dos documentos
  fiscais (§ 3.19) e da auditoria (§ 3.21), e apaga a base de ensaio. Um restauro que traz as linhas
  mas parte a cadeia não é defensável numa inspeção — daí a verificação ir até aí.
- **Restauro** (`npm run restore -- <ficheiro> --into=base`): recusa-se a escrever sobre a base em uso
  sem `--force` explícito, e verifica o SHA-256 antes de destruir o que existe.
- **Regra**: uma cópia só conta depois de restaurada com sucesso. O ensaio deve correr agendado, não
  apenas quando há um problema.

| Atributo | Requisito |
|---|---|
| **Segurança** | OAuth2/JWT, TLS em trânsito, criptografia em repouso para dados sensíveis, RBAC |
| **Privacidade/LGPD** | Consentimento para GPS, retenção e exclusão de dados pessoais sob demanda |
| **Escalabilidade** | Suportar picos sazonais sem degradação (auto-scaling no K8s) |
| **Disponibilidade** | SLA 99,9% para serviço de rastreamento (núcleo do produto) |
| **Observabilidade** | Logs estruturados, métricas, alertas para falhas de sync e gateways externos |
| **Auditabilidade** | Todo evento de status rastreável: quem, quando, de onde, qual sistema |
| **Performance** | API de status de pedido: P99 < 200ms; sincronização offline: processada em < 30s após reconexão |

---

## 5. Arquitetura (Alto Nível)

```
[App Cliente]      [App Motorista]      [Painel Admin Web]
      |                   |                     |
      +-------------------+---------------------+
                          |
                    [API Gateway]
                    (Auth + Rate Limit)
                          |
        +----------+----------+-----------+------------+-----------+
        |          |          |           |            |           |
   [orders-   [routes-    [payments-  [notifications- [tracking-  
   service]   service]    service]    service]        intl-service]
        |          |          |           |            |
        +----------+----------+-----------+------------+
                          |
              [Event Bus: Kafka / AWS SQS+SNS]
                          |
         +----------------+----------------+
         |                                 |
  [PostgreSQL]                          [Redis]
  (transacional)                   (cache + geo realtime)
```

### Serviços e Responsabilidades

| Serviço | Responsabilidade |
|---|---|
| `orders-service` | CRUD de pedidos, timeline de eventos, sync offline |
| `routes-service` | Otimização de rotas, reotimização dinâmica |
| `payments-service` | Cobranças, webhooks de gateway, conciliação |
| `notifications-service` | FCM push, preferências de notificação |
| `tracking-intl-service` | Polling de APIs externas, normalização de status |

---

## 6. Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| App Cliente / Motorista | React Native (multiplataforma) |
| Painel Admin | Next.js (React) |
| Backend | NestJS (Node.js) + TypeScript |
| Banco de dados principal | PostgreSQL 15+ |
| Cache / Geo realtime | Redis 7+ |
| Mensageria | Kafka (self-hosted) ou AWS SQS/SNS (managed) |
| Push Notification | Firebase Cloud Messaging (FCM) |
| Mapas / Roteirização | Google Maps Platform (Directions API + Route Optimization API) |
| Pagamentos | Mercado Pago (mercado BR) / Stripe (internacional) |
| Rastreio Internacional | 17TRACK API (agregador multi-carrier) |
| Infra | AWS/GCP, Docker + Kubernetes (EKS/GKE) |
| Observabilidade | Datadog ou OpenTelemetry + Grafana |
| Auth | Keycloak ou AWS Cognito (OAuth2/OIDC) |
| Offline local DB | SQLite (app motorista) |

---

## 7. Modelo de Dados — Entidades Principais

```typescript
// Pedido
interface Pedido {
  id: string;                               // UUID
  cliente_id: string;
  codigo_rastreio: string;                  // público, sem login
  status_atual: OrderStatus;
  origem: Endereco;
  destino: Endereco;
  transportadora_intl_id?: string;          // null para entregas nacionais
  motorista_id?: string;
  rota_id?: string;
  armazem_id?: string;                      // armazém onde a encomenda se encontra (null fora de armazém)
  criado_em: Date;                          // UTC
  atualizado_em: Date;
}

// EventoRastreio — imutável
interface EventoRastreio {
  id: string;
  pedido_id: string;
  status: OrderStatus;
  localizacao?: GeoPoint;
  descricao?: string;
  origem_evento: 'MOTORISTA' | 'SISTEMA' | 'TRANSPORTADORA_INTL' | 'ADMIN';
  usuario_id?: string;
  device_id?: string;                       // app motorista
  device_timestamp?: Date;                  // para sync offline
  timestamp: Date;                          // UTC, imutável
}

// Motorista
interface Motorista {
  id: string;
  nome: string;
  veiculo: Veiculo;
  status_atual: 'DISPONIVEL' | 'EM_ROTA' | 'OFFLINE';
  metricas_desempenho: MetricasMotorista;
}

// Rota
interface Rota {
  id: string;
  motorista_id: string;
  paradas: Parada[];       // ordenadas por sequência otimizada
  status: 'PLANEJADA' | 'EM_ANDAMENTO' | 'CONCLUIDA' | 'CANCELADA';
  otimizada_em: Date;
}

// Armazem — gestão dinâmica (cadastro, capacidade, ocupação)
interface Armazem {
  id: string;
  codigo: string;                           // curto e único, ex.: 'WH-MPT'
  nome: string;
  endereco: Endereco;
  capacidade: number;                       // 0 = ilimitada
  status: 'ACTIVE' | 'INACTIVE';
  gps?: GeoPoint;                           // origem para recálculo de rota na expedição
  // ocupação é SEMPRE derivada: encomendas com armazem_id e status de armazém
  criado_em: Date;
  atualizado_em: Date;
}

// MovimentoArmazem — registo imutável de entrada/envio (auditoria — §4)
interface MovimentoArmazem {
  id: string;
  armazem_id: string;
  pedido_id: string;
  codigo_rastreio?: string;
  tipo: 'INTAKE' | 'DISPATCH';              // entrada | envio
  observacao?: string;
  usuario_id?: string;
  criado_em: Date;                          // UTC, imutável
}

// Pagamento
interface Pagamento {
  id: string;
  pedido_id: string;
  valor: number;           // em centavos
  status: PaymentStatus;
  gateway: string;
  gateway_transaction_id?: string;
  idempotency_key: string;
  tentativa_numero: number;
}

// Avaliacao
interface Avaliacao {
  id: string;
  motorista_id: string;
  pedido_id: string;
  periodo_inicio: Date;
  periodo_fim: Date;
  pontualidade: number;    // 0-100
  taxa_sucesso: number;    // 0-100
  nota_cliente?: number;   // 1-5
}

// Conversa
interface Conversa {
  id: string;
  cliente_id: string;
  pedido_id: string;
  atendente_id?: string;
  status: 'ABERTA' | 'FECHADA' | 'AGUARDANDO';
  mensagens: Mensagem[];
}
```

---

## 8. Fluxos Críticos

### 8.1 Sincronização Offline → Online (App Motorista)
Ver `.agents/skills/offline-sync-resolver/SKILL.md` para especificação completa.

**Resumo:** eventos registrados no SQLite local → ao reconectar, enviar em batch ordenado por `device_timestamp` → servidor processa idempotentemente → conflitos logados → ACK confirma remoção da fila local.

### 8.2 Solicitar Envio ao Chegar no Armazém
> **Gestão dinâmica de armazéns:** os armazéns são entidades de primeira classe
> (cadastro `Armazem` com capacidade e status). A **entrada** (intake) liga o pedido
> ao armazém (`pedido.armazem_id`) e regista um `MovimentoArmazem`; o **envio**
> (dispatch) liberta a ocupação (limpa `armazem_id`) e regista o movimento inverso.
> A ocupação de um armazém é sempre derivada dos pedidos com `armazem_id` cujo status
> é de armazém — nunca um contador mantido à mão.

1. Pedido chega ao armazém → status `AT_WAREHOUSE`
2. Push notification para cliente com link de confirmação de destino
3. Cliente tem **X horas** (configurável, default 24h) para confirmar destino
4. Se não responder: status vai para `AWAITING_DESTINATION`, pedido fica em hold
5. Ao confirmar: evento `DESTINATION_CONFIRMED` → routes-service recalcula rota → status `OUT_FOR_DELIVERY`

### 8.3 Status Internacional → Status Interno
Ver `.agents/skills/order-status-mapper/SKILL.md`.

### 8.4 Falha de Pagamento
Ver `.agents/skills/payment-idempotency/SKILL.md`.

---

## 9. Roadmap

### Base existente
- [x] Multiempresa, JWT/RBAC, pedidos, rotas, armazéns, faturação, fiscal, finanças, RH, frota e auditoria
- [x] Aplicação PWA do motorista com sincronização offline, conflitos, POD, OTP e insucesso
- [x] Tarifação, COD, acertos, suporte, subscrições e rastreio internacional com adaptadores
- [x] Painel administrativo e portais web separados por API HTTP

### Fase P0 — prontidão para produção
- [ ] Remover dados fictícios das telas operacionais e tornar falhas explícitas
- [ ] Implementar painel de saúde das integrações e bloquear simuladores em produção
- [ ] Ativar provedores reais de pagamento, SMS, email, push, mapas e rastreio
- [ ] Reforçar permissões por ação, dupla aprovação, observabilidade, backups e restauração
- [ ] Cobrir fluxos críticos com testes E2E e testes de isolamento multiempresa

### Fase P1 — experiência e controlo operacional
- [ ] Portal autenticado completo do cliente
- [ ] Centro de ocorrências com SLA, evidências e escalonamento
- [ ] Logística reversa com nota de crédito/reembolso idempotente
- [ ] POD reforçado por política, geofence e comprovativo automático
- [ ] Cadeia de leitura e manifesto de carga do armazém à entrega

### Fase P2 — eficiência e gestão
- [ ] Otimização com capacidade, janelas, turnos, trânsito e replaneamento
- [ ] Dashboard de exceções acionáveis e indicadores operacionais
- [ ] Rentabilidade por entrega, rota, cliente, zona e armazém
- [ ] Relatórios automáticos e exportações com RBAC

---

## 10. Perguntas em Aberto

| # | Questão | Impacto |
|---|---|---|
| 1 | Mercado-alvo inicial (país)? | Define gateway de pagamento e exigências regulatórias |
| 2 | App terá versão web para cliente ou só mobile? | Define escopo do frontend |
| 3 | Quem paga a taxa: cliente final ou remetente? | Impacta fluxo de pagamento e modelo de dados |
| 4 | SLA do chat de suporte: humano, bot ou híbrido? | Impacta arquitetura do serviço de chat |
| 5 | Prazo para cliente confirmar destino no armazém (default 24h)? | Regra de negócio crítica |
| 6 | Bloqueio de entrega por falta de pagamento: a partir de qual fase? | Impacta MVP |
| 7 | Volume esperado de pedidos/dia no lançamento? | Impacta dimensionamento de infra |
