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
  A **capacidade já é honrada** — não pelo otimizador, mas pelo despacho, que recusa a rota
  antes de a montar quando a carga não cabe no veículo do motorista (§ 3.33). Trânsito e
  janelas de entrega continuam por cobrir.
- Reotimização dinâmica quando novo pedido entra na rota ou há atraso.
- **Regra de negócio a definir:** ao chegar ao armazém o cliente pode "solicitar envio para determinado destino". Isso recalcula a rota em tempo real — tratar como evento assíncrono (não cadastro estático). Status intermediário: `AWAITING_DESTINATION`.
- **Navegação no terreno:** a rota otimizada só serve de alguma coisa se o motorista a conseguir seguir. Cada paragem e o ecrã de entrega abrem a morada na aplicação de navegação do telemóvel, com as coordenadas da paragem quando existem e o texto da morada quando não — em Moçambique há bairros que a pesquisa por endereço não resolve. Não há mapa embebido: obrigaria a biblioteca, chave de API e tiles que não existem offline, e mesmo assim não daria voz nem trânsito. A aplicação que o motorista já tem instalada faz isso melhor.

### 3.3 Notificações Push
- Notificações push segmentadas por perfil, configuráveis por tipo de evento.
- Preferências de notificação por usuário (ligar/desligar por categoria).
- Canal: Firebase Cloud Messaging (FCM), pela **API HTTP v1**. Simulado por default; real quando `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` e `FIREBASE_PRIVATE_KEY` estiverem definidas — as três juntas, porque meia credencial falharia só em produção. O `/health` do serviço declara `fcm: simulated | live`.
- Sem SDK `firebase-admin`: a autenticação é o fluxo JWT-bearer de service account, que o `crypto` do Node assina, e o envio é um POST. O SDK traria dezenas de MB de dependências para fazer duas chamadas, e os restantes adaptadores (email, SMS, 17TRACK) já falam HTTP directo.
- **Limpeza de tokens mortos:** o FCM responde `UNREGISTERED`/`INVALID_ARGUMENT` (400) ou 404 quando a app foi desinstalada ou o token rodou. Só esses são devolvidos em `invalidTokens` e removidos da base. Um 429, 500 ou 503 — e qualquer falha de rede — **não** invalida o token: apagá-lo por uma indisponibilidade passageira seria perder um dispositivo bom e degradar a entrega em silêncio.
- A API HTTP v1 não tem multicast: é um pedido por token, enviados em lotes concorrentes. Um token morto no meio do lote não impede a entrega aos restantes.
- **Canal WhatsApp** (WhatsApp Business Cloud API, da Meta). Simulado por default; real com
  `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ACCESS_TOKEN`. Duas regras da plataforma governam o
  adaptador e explicam porque não é um `fetch` de três linhas:
  - **Janela de 24 horas.** Texto livre só é aceite nas 24 horas seguintes à última mensagem *que o
    cliente enviou*; fora dela a Meta recusa com o erro 131047 e nada chega. Uma notificação de
    logística está quase sempre fora da janela, pelo que o adaptador envia **template** por omissão
    e o texto livre é uma escolha explícita de quem chama. Ao contrário, teríamos um canal a
    responder "enviado" sem entregar — a falha que a § 3.24 existe para impedir.
  - **O número vai só com dígitos e indicativo.** Um número guardado como `+258 84 123 4567` — que é
    como as pessoas o escrevem — é recusado. A normalização vive no adaptador, não em cada chamador,
    e um número que não sobreviva a ela é recusado **antes** de tocar na rede.
  - Os erros da Meta são traduzidos para algo acionável (janela, template não aprovado, token
    expirado, destino sem WhatsApp): a mensagem original fala de *re-engagement* e não de templates,
    e quem lê o log não percebe porque é que "enviou" e não chegou.
  - Usa o mesmo `client_phone` do SMS: é o mesmo número, e dois campos só produziriam dois sítios
    onde ele pode divergir.
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
  **modal de entrega** (§ 3.33 — moto mais barata que van) e
  sobretaxa de COD (% configurável). Valores em **centavos (MZN)**. Cálculo por **função pura
  `computeQuote`** (testável); o pedido guarda `weight_grams` e o detalhe `pricing` (base para a
  faturação §3.14).

**Peso cobrável (volume).** Um colchão pesa 8 kg e ocupa a carrinha inteira: cobrado ao peso, essa
entrega dá prejuízo, porque o custo não é o peso — é o espaço que nega a outra encomenda. Com as
três dimensões, cobra-se o **maior entre o peso real e o volumétrico**
(`C × L × A / PRICING_VOLUMETRIC_DIVISOR`, 5000 por omissão). O divisor é por ambiente e não por
zona: é uma política da empresa, e divisores diferentes na mesma tabela tornariam impossível
explicar ao cliente porque a mesma caixa custa dois preços. **Com dois lados não se calcula nada** —
assumir o terceiro produziria um preço inventado. O detalhe traz sempre `weight_grams`,
`volumetric_grams`, `chargeable_grams` e `charged_by_volume`: *"porque é que pago 24 kg se a caixa
pesa 8?"* é a pergunta mais frequente de quem recebe a fatura, e sem os dois números não tem
resposta.

**Distância.** Dentro da mesma zona, 3 km e 60 km não custam o mesmo. `per_km_cents` cobra os
quilómetros **acima** de `included_km` — cobrar desde o primeiro metro faria a entrega ao lado do
armazém sair mais cara do que a da concorrência. A parcela entra **antes** dos multiplicadores: um
expresso a 60 km custa mais do que um normal a 60 km, e deixá-la de fora dava o mesmo acréscimo aos
dois. Ambos os campos nascem a **zero**, pelo que uma base já em uso cobra exatamente o mesmo depois
da migração: uma migração que muda preços sozinha seria a pior surpresa possível.

**As dimensões também alimentam a verificação de modal.** O § 3.33 já sabia recusar por volume e por
maior lado e nunca recebia esses valores: uma caixa de 1,5 m passava na conta de peso e não entrava
na moto. A capacidade continua a ser verificada contra o **peso real** e não o cobrável — o veículo
carrega quilos, não unidades de faturação.

- **Backend (`/v1/pricing`, RBAC ADMIN/SUPPORT; gestão de zonas só ADMIN):** `GET /zones`,
  `POST /quote`, `POST /zones`, `PUT /zones/:id`, `POST /zones/:id/deactivate`. Entidade
  `pricing_zones` com **zonas por default de Moçambique** (Maputo Cidade, Grande Maputo, Sul,
  Centro, Norte, Internacional) e `per_km_cents` / `included_km`. `orders` += `weight_grams`,
  `pricing` (nullable). `POST /quote` aceita `dimensions_cm`, `distance_km` e `client_ref_id`
  (aplica o contrato — § 3.35).
- **Frontend admin (`/tarifas`):** gestão de zonas (incluindo preço por km) + **simulador de
  orçamento** com dimensões e distância. No cadastro de pedido, peso/zona/serviço mais dimensões e
  distância, com **"Calcular orçamento"** que preenche o valor e mostra os dois pesos quando o
  volumétrico manda. Sem emojis.

**Critérios de aceitação:** um orçamento sem dimensões e sem distância dá exatamente o mesmo valor
de antes; uma caixa volumosa e leve é cobrada pelo volume, com os dois pesos visíveis; os km
incluídos não são cobrados; o expresso incide também sobre a distância; e uma caixa que não cabe no
baú da moto é assinalada mesmo quando o peso caberia.

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
  O tipo passa pelo catálogo de modais (§ 3.33): motociclos e mototriciclos ficam com o
  código canónico e o combustível certo, e as estatísticas contam-nos à parte.
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

#### Captura no terreno

- A aplicação do motorista **reduz** a imagem antes de a enviar, em vez de a recusar por tamanho. Uma câmara de telemóvel produz 3 a 5 MB e o data URL acrescenta ~33%; recusar deixava o motorista sem conseguir fechar a entrega, que é a única coisa que ele não pode deixar por fazer.
- A redução baixa primeiro a qualidade e só depois a resolução — numa assinatura o que importa é o traço, não o grão. Lado maior de 1600 px, degraus de qualidade JPEG até caber no orçamento, fundo branco aplicado antes da conversão para uma assinatura PNG transparente não sair preta.
- Só falha o que não couber no degrau mais agressivo, e nesse caso a mensagem pede outra fotografia em vez de indicar um limite que o motorista não sabe controlar.

#### Onde as imagens são guardadas

- A assinatura e a foto **não vivem na linha do pedido**. Ficam em `order_pod_images`, com o `order_id` como chave; `orders.pod` guarda apenas os metadados (quem recebeu, quando, coordenadas, notas) mais `has_signature` e `has_photo`.
- Motivo: todas as leituras de pedidos fazem `SELECT *`. Com as imagens no JSONB, abrir a listagem arrastava a prova de todas as entregas da página — até centenas de MB para desenhar um ecrã que não mostra imagens — e os relatórios, com teto de 20.000 pedidos, tornavam-se inviáveis. Cada `pg_dump` levava tudo atrás.
- As imagens leem-se sob pedido: `GET /v1/orders/:id/pod` (ADMIN/SUPPORT) e `GET /v1/orders/:code/status/pod` (público, para o portal de rastreio). Ambos confirmam primeiro a visibilidade do pedido; o endpoint de imagens nunca é o ponto onde o acesso é decidido.
- A escrita continua a aceitar `signature`/`photo` no corpo da entrega. O que mudou é a leitura, não o contrato de quem regista.
- Uma atualização de estado sobre um pedido já entregue **não** apaga a prova: quando o POD chega sem imagens, os sinalizadores são preservados e a tabela de imagens não é tocada.

**Critérios de aceitação:** entrega sem evidência obrigatória é rejeitada; replay offline não duplica POD; divergência de relógio ou localização fica auditada; a listagem de pedidos nunca devolve bytes de imagem; uma foto de telemóvel de 4 MB é aceite depois de reduzida.

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
#### Observabilidade — o que está implementado

Antes disto, saber que o sistema estava mal dependia de alguém telefonar.

- **Correlação.** Cada requisição recebe um id, devolvido no cabeçalho
  `X-Request-Id` e presente na linha de log, no evento de auditoria e no erro
  gravado. Um `X-Request-Id` vindo do cliente ou do reverse proxy é respeitado
  desde que seja curto e inócuo — entra em ficheiros e numa coluna da base, e não
  se deixa um cliente escolher o que lá fica. Sem correlação, investigar uma
  queixa é procurar por hora e torcer para não haver duas.
- **Registo estruturado** (`logger.js`): uma linha JSON por evento, sem
  dependências novas. Segredos são removidos e PII é mascarada em profundidade —
  remover o email tornaria o log inútil para investigar, escrevê-lo inteiro
  deixa PII em texto limpo num ficheiro que vive anos. A lista de chaves
  proibidas é a mesma da auditoria de propósito: duas listas seriam duas
  hipóteses de esquecer uma.
- **Métricas** (`GET /v1/monitoring/metrics`): contadores do processo — pedidos,
  erros, média, máximo e p95 aproximado por rota, classes de estado e taxa de
  erro na janela. Agregam pelo **molde** da rota (`/v1/orders/:id`) e não pelo
  caminho concreto: agrupar por id daria uma linha por encomenda e o mapa
  cresceria com o tráfego. Reiniciam com o processo, e isso é deliberado —
  respondem a "como está agora"; o histórico é trabalho do agente de recolha do
  servidor, que lê as linhas do logger.
- **Registo central de erros** (`error_events`, `GET /v1/monitoring/errors`): só
  o inesperado. Um 404 ou um 422 é a API a fazer o seu trabalho; contá-los como
  avaria faria o alerta disparar com o utilizador a escrever mal um código de
  rastreio. O cliente recebe o `correlation_id` na resposta de erro — é o que
  transforma "deu erro" numa queixa investigável sem expor a causa a quem não
  deve vê-la. A listagem não devolve a pilha de chamadas: caminhos de ficheiros
  do servidor não vão para o navegador de quem consulta.
- **Alertas** (`GET /v1/monitoring/alerts`, e avaliados também no arranque):
  base inacessível ou lenta, taxa de erro acima do limiar, falhas de escrita na
  auditoria ou no próprio registo de erros, e **provedores simulados em
  produção** — a falha mais cara, porque o sistema responde "enviado" e nada sai,
  sem erro nenhum (§ 3.24). Cada alerta traz a ação a tomar: um alerta sem ação é
  um gráfico, e gráficos não resolvem incidentes. A taxa de erro exige uma
  amostra mínima — 50% de dois pedidos não significa nada, e acordar alguém por
  isso ensina a ignorar alertas.
- **Nada disto pode partir a operação.** Como no registo de auditoria, uma falha
  a gravar um erro é contada e engolida; o contador existe para a falha não
  passar despercebida. O sistema que observa não pode ser a causa da
  indisponibilidade que observa.
- Métricas ainda em falta: jobs atrasados, profundidade da fila offline e
  webhooks.

**Critérios de aceitação:** utilizador sem permissão recebe `403`; autoaprovação é bloqueada; alertas não incluem segredos; restauração é ensaiada e registada; o id de correlação devolvido ao cliente encontra a linha do erro no registo central.

---

### 3.32 Contas e acessos

Uma empresa tem de conseguir administrar-se sozinha. Até esta secção existir, uma
empresa nova ficava com **uma** conta — o ADMIN criado no auto-registo — e não havia
como criar outra pelo painel, reemitir uma senha ou cortar um acesso. Nada disto é
funcionalidade avançada: é o mínimo para entregar o sistema a um cliente.

- **Cada papel entra pela porta que garante o seu vínculo.** ADMIN e SUPPORT em
  `/utilizadores`; **DRIVER em `/motoristas`**, porque a conta tem de ficar ligada ao
  registo do motorista; EMPLOYEE em `/rh-contas`, ligado a `hr_employees`. Tentar criar
  um DRIVER pela porta errada é recusado com a indicação de onde ir — o erro ensina em
  vez de só negar.
- **O acesso do motorista usa o id do motorista como id da conta.** A aplicação do
  motorista resolve tudo pelo `sub` do token: `GET /v1/routes/me` chama
  `getActiveRouteForDriver(req.user.sub)` e `PUT /v1/drivers/:id/gps` autoriza por
  `req.params.id === req.user.sub`. Uma conta com id próprio autenticava e não
  encontrava rota, entregas nem GPS. Antes disto só funcionava por acaso: a conta de
  demonstração tinha o `sub` fixo a coincidir com um motorista semeado — e as contas
  de demonstração estão desligadas em produção.
- **Papéis de painel: apenas ADMIN e SUPPORT** — os que os endpoints honram (SUPPORT
  em 28 deles). Não se oferece um papel que nenhuma rota reconheça: uma conta que
  autentica e não faz nada é pior do que não existir.
- **Reemissão de senha por um administrador**, sem pedir a senha antiga (quem chama já
  provou ser administrador; o que protege o ato é a auditoria). Existe porque a
  recuperação por email (§ 3.22) depende de um provedor configurado — que é opcional.
  Sem esse caminho, uma pessoa que perde a senha fica de fora e, com um ADMIN único,
  perde-se a empresa inteira.
- **Suspender em vez de apagar** (`users.status`): as entregas, os documentos fiscais e
  os eventos de auditoria continuam a apontar para a pessoa. O login recusa uma conta
  suspensa com mensagem própria (distinta de empresa suspensa — a pessoa tem de saber a
  quem se dirigir), e a recuperação por email também não a deixa voltar.
- **Guardas que evitam bloqueios sem saída:** ninguém suspende a própria conta, a última
  conta ADMIN ativa da empresa não pode ser suspensa, e um ADMIN de empresa nunca toca na
  conta da plataforma. Todas as leituras e escritas passam pelo filtro da empresa em
  contexto (§ 2.4): para o ADMIN da empresa A, uma conta da empresa B não existe.
- **Registo de motoristas.** `POST /v1/drivers` passou a existir: o painel tinha um botão
  "Adicionar Motorista" que só escrevia no estado do React e o motorista desaparecia ao
  recarregar. O motorista nasce `offline` e sem acesso; a página mostra quantos estão sem
  acesso, porque um motorista sem conta não executa entregas.
- **A página de login não promete o que não pode cumprir.** `GET /v1/auth/password-recovery`
  (pública, e fora do limitador estrito de `/v1/auth` porque é consultada a cada abertura
  do ecrã) diz se o canal existe; sem provedor, o link dá lugar a "peça ao administrador".
  Em produção, `POST /forgot-password` responde 503 com essa indicação em vez de dizer que
  enviou um email que ninguém envia.
- **Auditoria (§ 3.21).** `users.create`, `users.password_reissued`, `users.blocked`,
  `users.reactivated`, `drivers.create` e `drivers.access_granted`. As senhas nunca entram
  no registo, nem em claro nem em hash — há um teste que falha se aparecerem.
- **API.** `GET/POST /v1/users` · `PUT /v1/users/:id/password` · `PUT /v1/users/:id/status`
  (ADMIN; leitura e escrita de senha/estado também SUPERADMIN) · `POST /v1/drivers` ·
  `POST /v1/drivers/:id/access` (ADMIN) · `GET /v1/auth/password-recovery` (pública).
- **Migração.** `infrastructure/migrations/user-access.js` (aditiva e idempotente) +
  `migrate-user-access.js` em `migrate-all.js`. As colunas são também garantidas no
  `ensureTable` do arranque, porque o login lê `status` em todas as autenticações.
- **Testes.** 14 unitários das decisões puras (política da senha emitida, quem administra
  quem, portas de cada papel) e 29 de integração contra PostgreSQL, incluindo o percurso
  completo que uma empresa real faz: registar motorista → criar acesso → autenticar e
  confirmar que o `sub` do token é o id do motorista. Dados em
  `tests/harness/factories/user-access.factory.ts`.

**Critérios de aceitação:** uma empresa com uma só conta consegue criar a segunda sem
suporte; um motorista registado no painel consegue entrar na aplicação e ver a sua rota;
uma conta suspensa não entra nem por senha nem por recuperação; nenhuma empresa fica sem
administrador ativo; e o painel nunca oferece um caminho de recuperação que não funciona.

---

### 3.33 Entregas de motociclo e mototriciclo

O motociclista e o mototriciclista são a última milha em Moçambique — a moto para a
encomenda pequena, o triciclo de carga para o que já não cabe nela e ainda não justifica
uma carrinha. O sistema tratava-os como um rótulo: o cadastro de motoristas tinha uma
lista fechada `MOTO/CARRO/VAN/CAMINHAO` **sem mototriciclo**, a frota (§ 3.18) tinha o
tipo em texto livre, e nenhum dos dois sabia quanto é que o veículo carrega. Daí saíam
três problemas reais: o mototriciclo não se cadastrava, a tarifa era a mesma para uma moto
e para um camião, e o § 3.2 pedia rotas que respeitassem "capacidade do veículo" sem que
nada a verificasse — 200 kg atribuídos a uma moto só se descobriam no armazém.

- **Catálogo de modais como fonte única** (`domain/delivery-modals.js`, puro). Por modal:
  capacidade (kg), volume (L), maior lado admissível (cm), categorias de carta,
  combustível por default, número de rodas e multiplicador de tarifa. Os cinco modais são
  **motociclo (25 kg)**, **mototriciclo (350 kg)**, carro (400 kg), van (1500 kg) e camião
  (8000 kg). Os limites são o que a operação aceita despachar, não o máximo teórico.
- **O vocabulário da operação é aceite e normalizado.** "mota", "motorizada", "triciclo",
  "txopela", "moto-triciclo", com ou sem acentos e maiúsculas, resolvem para o código
  canónico — recusar estas palavras não torna o cadastro mais correto, só empurra quem
  cadastra a escolher o modal errado para poder avançar. O que fica gravado é sempre o
  código.
- **A capacidade declarada nunca ultrapassa o teto do modal.** O cadastro pode declarar
  menos (um baú pequeno numa moto); escrever 500 kg numa moto é reduzido a 25 kg. Sem este
  teto, o cadastro anulava a verificação do despacho.
- **A carta tem de habilitar o modal.** Motociclo exige categoria A; mototriciclo aceita A
  ou B. Sem categoria declarada assume-se a principal do modal — o cadastro não fica
  bloqueado por um dado que nem sempre está à mão, mas o que se grava é coerente.
- **Despacho recusa a rota que o veículo não leva** (`application/dispatch.service.js`,
  em `POST /v1/routes` e no `reoptimize`). Duas verificações, porque falham por razões
  diferentes: um volume isolado maior que o veículo (nunca cabe, nem sozinho) e a soma das
  paradas acima da capacidade (cabe repartido, não de uma vez). No reoptimize contam as
  paradas **pendentes** mais as novas — o que já foi entregue saiu do veículo. A resposta
  é 422 com o motivo e o modal sugerido. **Pedido sem peso registado não é bloqueado**: o
  sistema não inventa um peso para depois recusar a operação com ele; devolve a contagem
  em `unknown_weight` e deixa a decisão a quem despacha. O serviço recusa e explica — não
  reparte a carga nem escolhe o veículo.
- **Tarifa por modal (§ 3.13).** `vehicle_modal` é opcional em `POST /v1/pricing/quote`;
  ausente, o preço é exatamente o de antes (`modal_cents: 0`). Presente, aplica-se um
  multiplicador sobre base+peso — 0,7 na moto, 0,85 no mototriciclo, 1 no carro, 1,3 na
  van, 1,8 no camião — sobreponível por ambiente (`PRICING_MODAL_MOTO_MULTIPLIER`). Um
  modal que não existe é erro 400, não ausência: ignorá-lo em silêncio devolvia o preço de
  carro a quem pediu moto. **Um peso que não cabe no modal pedido não recusa o orçamento**
  — devolve o preço com `modal_fits: false`, o motivo e `suggested_modal`, porque a
  pergunta "quanto custa de moto?" merece resposta mesmo quando a resposta é "não cabe".
- **Frota (§ 3.18).** `vehicle_type` passa pelo catálogo: reconhecido vira código canónico,
  não reconhecido é preservado como estava (a coluna sempre foi texto livre e já tem
  `pickup` gravado — recusá-lo agora partia cadastros que funcionavam). Motos e triciclos
  assumem gasolina, senão o default `diesel` do formulário comparava consumos com o
  combustível errado. As estatísticas ganham contagem por modal e o total de duas/três
  rodas, agregados em SQL.
- **Painel.** `/motoristas` e `/frota` escolhem o modal a partir de `GET /v1/fleet/modals`
  e mostram capacidade e carta exigida; `/tarifas` simula por modal e avisa quando o peso
  não cabe; `/rotas` distingue MT (mototriciclo) de M (motociclo). Nenhum ecrã repete a
  tabela de capacidades — se o catálogo não chegar, cai numa lista de reserva e continua a
  funcionar.
- **API.** `GET /v1/fleet/modals` (autenticado, não só ADMIN: é vocabulário, não dados da
  empresa, e a tarifação é ADMIN/SUPPORT). `POST /v1/drivers` aceita
  `vehicle.licence_category`. `POST /v1/pricing/quote` aceita `vehicle_modal`.
- **Sem migração.** O veículo do motorista é JSONB e `fleet_vehicles.vehicle_type` já
  existia; só mudou o que lá é escrito.
- **Testes.** 25 unitários do catálogo (normalização, tetos, cargas no limite e um grama
  acima, cartas) e 16 de integração contra PostgreSQL: mototriciclo cadastrado com o
  código canónico, capacidade reduzida ao teto, rota recusada por volume isolado e por
  soma, a mesma carga aceite no triciclo, peso desconhecido que não bloqueia, e tarifa de
  moto abaixo da de van. Dados em `tests/harness/factories/delivery-modal.factory.ts`.

**Critérios de aceitação:** um mototriciclista cadastra-se e recebe rotas; uma rota com
carga acima do que o veículo leva é recusada antes de sair do painel, com o modal
sugerido; o mesmo pedido custa menos de moto do que de van; um pedido sem peso registado
nunca é bloqueado por causa disso; e nenhum ecrã do painel tem a tabela de capacidades
escrita à mão.

---

### 3.34 Prontidão de produção

Esta secção não acrescenta funcionalidade nenhuma. Existe porque um sistema
completo em funcionalidades pode continuar a não ser entregável, e cada ponto
abaixo saiu de uma verificação que **falhou** — não de uma lista de boas
práticas.

**A compilação de produção não pode depender da internet.** Os frontends iam
buscar a fonte a `fonts.googleapis.com` durante o `next build` (via
`next/font/google`) e, em execução, também o CSS e os marcadores do mapa a um
CDN. Enquanto houve rede na máquina de quem compilava, ninguém reparou; a
compilação partia dentro de um `docker build` sem saída para fora, e o cliente
atrás de uma firewall corporativa via o painel sem tipo de letra e o mapa sem
marcadores. Os ficheiros passam a ser servidos pela própria aplicação. Único
recurso externo aceite: as *tiles* do mapa — um mapa sem servidor de tiles não é
um mapa. Guardado por sonda no harness (`external-assets.ts`), que lê o
código-fonte e reprova qualquer host novo.

**As três aplicações web têm ESLint, e o CI corre-o.** Não por estilo: as regras
que interessam apanham dependências em falta em `useEffect` (a causa de um ecrã
que mostra os dados do pedido anterior) e atribuições ao identificador `module`
(que parte o *chunk* do empacotador). Código morto fica a cargo de
`noUnusedLocals` no TypeScript, que entende posições de tipo — o `no-unused-vars`
do ESLint não entende e marcaria `import type` como não usado.

**O percurso operacional é testado ponta a ponta, sem estados semeados a meio.**
Criar → recolher → despachar → transportar → sair para entrega → entregar →
apresentar a prova, cada estado sendo o resultado do passo anterior. Um teste por
troço parte de uma encomenda já no estado de que precisa e por isso esconde as
juntas — foi numa junta que apareceu o defeito descrito a seguir. O condutor do
percurso vive no harness (`DeliveryJourney`) e recebe os módulos por injeção,
para servir tanto a base real como um duplo.

**Despachar é atribuir.** Criar a rota gravava as paradas com o `order_id` e
deixava o pedido sem `driver_id` e sem `route_id`. O painel mostrava a rota
montada e, na prática, o motorista continuava sem a encomenda: `PUT
/v1/orders/:id/status` recusava-o (o guard de dono compara `order.driver_id` com
o `sub` do token), `POST /v1/driver-sync/events` devolvia 403 ao lote inteiro, a
listagem filtrada por motorista vinha vazia e o COD cobrado nunca entrava no
acerto de caixa. Só um ADMIN conseguia mover a encomenda, o que anula a
aplicação do motorista. A atribuição corre depois de a rota estar criada — a
rota é o facto que a autoriza — e vale também para as paradas acrescentadas numa
reotimização. Paradas que a base recusa atribuir (pedido inexistente, já entregue
ou cancelado) vêm identificadas na resposta: quem despacha tem de saber que a
parada está na rota e a encomenda não vai ser levada.

**O `/health` toca na base.** Respondia `{status:'ok'}` sem consultar nada, ou
seja, respondia `ok` com o PostgreSQL em baixo — e o balanceador continuava a
mandar tráfego para um processo incapaz de servir uma página. Devolve 503 quando
a base não responde, que é o contrato que o balanceador e o `HEALTHCHECK` do
Docker percebem. Fica sem autenticação e por isso não revela mais nada: o
diagnóstico vive em `/v1/monitoring`, atrás de ADMIN.

**A implantação publica o sistema inteiro.** A app do motorista não era
construída nem servida por nenhuma pilha de deploy — com o percurso acima
testado e a funcionar, a operação real continuava a depender de alguém o fazer à
mão pelo painel. Passa a ter serviço, domínio próprio (uma PWA fica presa à
origem onde é servida) e entrada no `CORS_ORIGIN`; sem essa entrada a app abre e
não carrega nada, sem mensagem que o explique.

**Há uma só pilha de produção.** Existiu uma segunda em `infra/docker/`, que
publicava apenas a API e o portal do cliente. Chegou a ficar assinalada como
parcial — e um aviso não impede a divergência, só a documenta: aquela pilha já
tinha perdido o painel e a app do motorista, e mandava correr `--reset-core` no
primeiro arranque, quando a pilha principal passara a detetar a base vazia sem
destruir nada. Foi removida. O que sobra em `infra/docker/` é infraestrutura de
desenvolvimento e não publica nada.

**A migração de raiz é verificada contra uma base vazia.** `migrate-all
--reset-core` numa base nova tem de produzir exatamente o mesmo esquema da base
em uso. Um módulo cujo *script* de migração não entre na lista não dá erro
nenhum — dá páginas a responder 500 num cliente novo, semanas depois.

**Critérios de aceitação:** `npm run build` conclui sem acesso à rede;
`npm run lint` e `npm run typecheck` passam nos três frontends; a suíte completa
passa contra PostgreSQL real; o percurso ponta a ponta passa sem estados
semeados; uma base vazia migrada iguala a base em uso; `npm run backup:verify`
conclui o ensaio de restauro; e um `docker compose up` publica API, painel,
portal do cliente e app do motorista.

---

### 3.35 Contratos de cliente

O § 3.12 regista o cliente e o § 3.13 calcula a tabela pública. Entre os dois
faltava o que na prática rege quase toda a faturação de uma transportadora: a
**condição negociada com o cliente recorrente**. Sem ela, quem regista o pedido
tem de se lembrar do desconto acordado e escrever o preço à mão — e o erro
acontece nos dois sentidos, a cobrar de mais e a cobrar de menos.

**Um contrato tem de mudar o que acontece, não apenas ficar registado.** Um
cadastro de condições que ninguém aplica é pior do que não existir: dá a
impressão de que o sistema trata do assunto. Daí os três efeitos:

1. **O orçamento aplica-o sozinho.** `POST /v1/pricing/quote` com
   `client_ref_id` resolve o contrato em vigor e devolve o preço acordado.
2. **A fatura herda o prazo.** `invoices.due_date` sai de
   `payment_terms_days`.
3. **O limite de crédito trava encomendas.** `createOrder` recusa quando a
   dívida em aberto mais a encomenda nova passam o limite.

**Como o preço se forma, e porquê nesta ordem.** A **tarifa negociada da zona**
substitui a tabela pública *antes* do cálculo, para que o multiplicador de
expresso e o do modal incidam sobre o preço acordado — aplicá-la depois daria um
expresso calculado sobre um preço que aquele cliente não paga. O **desconto**
incide sobre o frete (base + peso + serviço + modal) e **não** sobre a sobretaxa
de COD, que é um custo repassado: descontá-la seria oferecer dinheiro que sai da
empresa à mesma. O **frete mínimo** aplica-se *depois* do desconto, que é
precisamente para o que serve — impedir que um desconto grande numa encomenda
pequena deixe o frete abaixo do que custa fazê-la. Cada parcela vem em linha
própria no detalhe (`contract_code`, `contract_discount_cents`,
`minimum_adjustment_cents`): um desconto que só aparece no total é indefensável
quando o cliente pergunta a conta.

**Um contrato ativo por cliente e por data.** Períodos sobrepostos são recusados
na escrita. A alternativa — escolher um deles na leitura — faria o preço depender
da ordem das linhas, e "porque é que esta encomenda saiu a este preço" deixaria
de ter resposta. Rascunhos e suspensos podem sobrepor-se: não estão em vigor.
`ends_on` é **inclusivo**, como qualquer pessoa lê um contrato em papel.

**Um contrato termina, não se apaga** — as encomendas faturadas apontam para ele
e sem a linha ninguém explica o preço que saiu (mesmo raciocínio do § 3.32 para
as contas). E `credit_limit_cents = 0` significa **sem limite**, não "limite
zero": tratá-lo como zero travaria todos os clientes no dia em que a
funcionalidade entrasse.

**Sem vencimento no pronto pagamento.** Uma fatura-recibo paga no ato não tem
vencimento; datá-la com o próprio dia da emissão faria qualquer mapa de dívida
contá-la como vencida na manhã seguinte.

- **Backend (`/v1/contracts`):** ler é de ADMIN e SUPPORT — quem atende precisa
  de saber a condição acordada; **escrever é só de ADMIN**, porque alterar um
  desconto é alterar a receita. `GET /`, `GET /:id`, `POST /`, `PUT /:id`,
  `POST /:id/end`, `GET /credit/:clientRefId`. Entidade `client_contracts`
  (tarifas negociadas em JSONB na própria linha — lista curta, lida sempre com o
  contrato e nunca consultada por si); `invoices` += `due_date`.
- **Não há `orders.contract_id`**: o pedido já guarda o orçamento inteiro em
  `orders.pricing`, que passou a trazer o contrato aplicado. Duplicar o dado em
  dois sítios que podem divergir seria pior do que a consulta por
  `pricing->>'contract_id'`.
- **Frontend admin:** secção de contratos no detalhe do cliente, com a
  **situação de crédito em destaque** — é o número que decide se o cliente pode
  receber mais serviço, e sem ele quem atende só descobre o problema quando a
  criação da encomenda é recusada. Sem emojis.

**Critérios de aceitação:** um cliente sem contrato paga exatamente a tabela
pública; o desconto acordado aparece no orçamento sem ninguém o escrever; a
sobretaxa de COD não é descontada; o frete nunca desce abaixo do mínimo; dois
contratos ativos sobrepostos são recusados; a fatura de um contrato a 30 dias sai
com vencimento a 30 dias e a de pronto pagamento sai sem vencimento; e uma
encomenda que ultrapassa o limite de crédito é recusada **antes** de ser gravada.

---

### 3.36 Inventário e transferências entre filiais

Havia entrada e envio, mas mover carga entre duas unidades da mesma empresa
fazia-se como um envio seguido de uma entrada — **dois atos sem ligação
nenhuma**. Entre um e outro a encomenda não estava em lado nenhum, e se não
chegasse, ninguém tinha como saber que devia ter chegado. É na transferência que
as encomendas se perdem, e sem manifesto à saída e conferência à chegada ninguém
sabe onde.

**A reconciliação é a peça central, e aparece duas vezes no domínio:** conferir o
que chegou contra o manifesto, e conferir o que está no armazém contra o que o
sistema diz. É a mesma operação — esperado contra lido — e por isso é **uma**
função pura usada pelas duas. Escrevê-la duas vezes daria duas definições de "em
falta" que divergiriam à primeira correção. Ler duas vezes a mesma etiqueta não
conta duas vezes: é o que acontece num armazém, e produziria uma divergência que
não existe. Uma encomenda **a mais** é tão errada como uma a menos — aquela
devia estar noutro sítio.

**O ciclo:** `draft` (manifesto montado, carga ainda na origem) → `in_transit`
(saiu) → `received` (conferida no destino). Três decisões definem o
comportamento:

1. **Durante o percurso a encomenda não está em armazém nenhum.** Vai a
   `in_transit` e **perde** o `warehouse_id`. Deixá-la a contar na ocupação da
   origem daria um inventário que não corresponde ao que lá está. Isto exigiu a
   transição `at_warehouse → in_transit`, que faltava porque o modelo assumia um
   único armazém.
2. **Receber nunca recusa por capacidade.** A entrada normal recusa — a encomenda
   ainda não foi aceite e diz-se ao portador que a leve a outro lado. Aqui o
   camião já descarregou: recusar seria ficção, e a encomenda ficava sem sítio
   nenhum no sistema enquanto está fisicamente no chão do armazém. O excesso é
   **reportado**, não travado.
3. **O que chega sem estar no manifesto é recebido na mesma** e marcado como
   inesperado — a encomenda está ali, e recusá-la deixava-a em limbo. **O que
   está no manifesto e não chega fica `in_transit`, sem armazém**: não se inventa
   uma localização para uma encomenda perdida.

Uma conferência com divergências entra na auditoria com resultado `denied` e não
`success`: não é um erro do sistema, mas também não pode ser um sucesso
silencioso.

**Contagem de inventário.** Ao abrir, congela-se o que o sistema diz estar no
armazém. O congelamento é o ponto: comparar no fim com o estado **atual**
acusaria como divergência tudo o que entrou e saiu legitimamente durante as duas
horas em que se andou a ler códigos. As leituras acumulam entre passagens, como o
leitor de mão funciona. Só pode haver **uma contagem aberta por armazém** — duas
dariam dois relatórios contraditórios sobre o mesmo instante. **Fechar não corrige
nada:** uma contagem diz o que está diferente; decidir o que fazer com uma
encomenda que não aparece é do responsável da unidade, e mover registos
automaticamente com base numa leitura apagaria a prova do problema.

**Idade da carga parada.** A ocupação diz quantas encomendas estão no armazém; a
idade diz **quais é que não deviam estar**. Baldes em 3 e 7 dias — a fronteira
habitual entre "está a andar", "atrasou" e "alguém tem de ir ver". Uma encomenda
parada há três semanas ocupa espaço que nega outra e é uma falha de serviço que
ninguém reparou.

- **Backend (`/v1/inventory`, RBAC ADMIN/SUPPORT):** quem está ao balcão de uma
  filial precisa de conferir o que chegou — mandar isso passar por um ADMIN
  pararia a operação enquanto o camião espera. `GET /warehouses/:id`,
  `GET|POST /transfers`, `GET /transfers/:id`, `POST /transfers/:id/dispatch`,
  `POST /transfers/:id/receive`, `POST /transfers/:id/cancel`,
  `GET|POST /warehouses/:id/counts`, `POST /counts/:id/scans`,
  `POST /counts/:id/close`. Entidades `warehouse_transfers`,
  `warehouse_transfer_items`, `warehouse_counts`.
- **Itens têm tabela, contagens não.** Um item de transferência tem ciclo de vida
  próprio e responde-se por ele individualmente — *"esta encomenda não chegou, em
  que transferência ia?"*. Uma contagem é a fotografia de um instante: interessa o
  relatório, e ninguém pergunta em que contagens é que uma encomenda apareceu.
- **Frontend admin:** no detalhe do armazém, idade da carga, transferências de
  entrada e de saída, conferência por leitura de código de barras e contagem.
  Reutiliza o padrão de campo auto-focado do "Modo leitura" (§ 3.15). Sem emojis.

**Critérios de aceitação:** uma transferência para o mesmo armazém é recusada;
encomendas que não estão na origem não entram no manifesto; despachada, a carga
não conta na ocupação de nenhum dos dois armazéns; o que não chega fica em
trânsito e nomeado como em falta, sem travar a entrada das outras; o que chega
fora do manifesto é recebido e nomeado; uma contagem compara com o instante em
que abriu e não move nada ao fechar.

---

### 3.37 Reagendamento e devolução ao remetente

Uma entrega falhada ia a `failed` com um motivo e, a partir daí, o sistema não
tinha resposta. As duas saídas que a operação real precisa não existiam: marcar
nova tentativa, ou desistir e mandar a encomenda para trás. Sem elas, quem
opera resolve por fora — telefonema, papel, memória — e a encomenda fica num
estado que o painel mostra como falhado para sempre.

**Isto não é a § 3.27.** Aquela descreve a devolução pedida pelo cliente que
recebeu o produto e o quer devolver (`requested → approved → collecting →
received → refunded`), com inspeção e reembolso. Esta secção é o caminho
inverso da operação: a encomenda **não conseguiu ser entregue** e volta ao
remetente. São fluxos diferentes, com origens e consequências diferentes, e
tratá-los como um só produziria um estado a servir dois donos. A § 3.27
continua por implementar; a § 3.26 (ocorrências com SLA e escalonamento) é da
Prioridade 3.

**Reagendar.**
- Só a partir de `failed`: reagendar uma entrega que ainda não foi tentada não
  significa nada.
- A data combinada fica **no pedido** (`next_attempt_on`), não num comentário.
  É o que permite não pôr a encomenda numa rota antes do dia acordado —
  aparecer no dia errado é falhar a entrega uma segunda vez com o cliente à
  espera.
- Datas no passado são recusadas. Uma "nova tentativa" marcada para ontem é um
  erro de digitação que ninguém apanha depois.
- Cada reagendamento **conta**. `delivery_attempts` sobe, e acima de
  `DELIVERY_MAX_ATTEMPTS` (3 por omissão) o reagendamento é recusado e o
  caminho passa a ser a devolução. Sem teto, uma encomenda entra em ciclo
  indefinido e ninguém repara — é o custo que não aparece em relatório nenhum.

**Devolver ao remetente.** É uma entrega ao contrário, e por isso tem as
mesmas exigências de uma entrega:
- Começa a partir de `failed` ou de `at_warehouse` (a encomenda voltou ao
  armazém e ficou lá), e a encomenda viaja de volta em `in_transit` com um
  bloco `return` que diz o motivo, quem decidiu e quando.
- Termina em **`returned`**, um estado terminal novo. Não é `failed` — isso é
  uma tentativa — nem `cancelled`, que é uma encomenda que nunca chegou a
  seguir. Confundi-los tiraria a única forma de contar quantas encomendas
  voltaram.
- Confirmar exige **prova**: quem recebeu de volta e quando. Uma devolução sem
  prova é indistinguível de uma encomenda perdida, e é precisamente aí que a
  discussão com o remetente acontece.

**Consequências, e o que deliberadamente NÃO se automatiza:**
- O **COD é cancelado** (`cod_status: 'cancelled'`). O dinheiro nunca foi
  cobrado, e deixá-lo `pending` fá-lo aparecer eternamente no que há a receber.
  Cancelado e não `none` porque `none` apagava o facto de ter existido um valor
  a cobrar.
- Se existir **fatura ativa**, a devolução **assinala-a e não emite nada**.
  Creditar automaticamente seria inventar uma política comercial: há
  transportadoras que cobram o frete na mesma (o trabalho foi feito) e outras
  que creditam tudo. A nota de crédito emite-se pelo § 3.19, por decisão de
  quem responde pela conta.

- **Backend (`/v1/orders/:id`, RBAC ADMIN/SUPPORT; motorista pode reagendar):**
  `POST /reschedule`, `POST /return`, `POST /return/confirm`. `orders` +=
  `delivery_attempts`, `next_attempt_on`, `return` (JSONB).
- **Frontend admin:** no detalhe de um pedido falhado, reagendar com data ou
  iniciar devolução; a data marcada e o número de tentativas ficam visíveis na
  listagem. Sem emojis.

**Critérios de aceitação:** reagendar fora de `failed` é recusado; uma data no
passado é recusada; acima do limite de tentativas o reagendamento é recusado com
a devolução indicada como caminho; confirmar a devolução sem dizer quem recebeu
é recusado; uma encomenda devolvida fica em `returned` com o COD cancelado; e a
fatura ativa é assinalada sem ser alterada.

---

### 3.38 Despacho automático

A verificação de carga (§ 3.33) e o otimizador de paradas (§ 3.2) já existiam,
mas **quem escolhia o motorista era uma pessoa**, encomenda a encomenda. Com
trinta entregas e seis motoristas isso é meia hora de trabalho todas as manhãs,
feito de cabeça e sem registo de porquê — e o resultado depende de quem está de
serviço nesse dia.

**O despacho PROPÕE; não executa sozinho.** É a decisão estruturante desta
secção. Um sistema que cria rotas sozinho de madrugada parece automação e é, na
prática, uma forma de ninguém olhar: quando a proposta estiver errada — e vai
estar, porque o mundo tem informação que o sistema não tem — a carga já saiu.
O plano é devolvido para quem despacha ver, ajustar e confirmar. A automação
poupa a meia hora; não substitui a responsabilidade.

**O que decide, e o que já não decide.** Esta secção escolhe **que encomendas
vão com que motorista**. A ordem das paradas dentro de cada rota continua a ser
do otimizador (§ 3.2) — dois problemas diferentes, resolvidos onde já estavam.

**Quem é elegível:**
- **Encomendas** prontas a sair (`at_warehouse` ou `collected`), com destino, e
  **sem data futura marcada**. Uma encomenda reagendada para sexta não entra na
  rota de terça: foi precisamente para isso que o § 3.37 pôs a data no pedido.
- **Motoristas** `available`. Um motorista `on_route` já leva carga que o sistema
  não sabe medir, e somar-lhe mais seria decidir sobre um veículo que não se vê.

**Como agrupa.** Vizinho mais próximo com capacidade: parte-se da origem, junta-se
a encomenda mais próxima, depois a mais próxima dessa, até o veículo encher.
Repete-se para o motorista seguinte. É a heurística mais simples que produz rotas
geograficamente coerentes, e é a mesma família do que o otimizador já usa —
introduzir aqui um segundo algoritmo sofisticado daria duas noções de "perto" no
mesmo sistema. A otimização com janelas, turnos e trânsito é da Prioridade 4.

**O que nunca é inventado:**
- **Encomenda sem coordenadas** não é excluída — a morada existe e o motorista
  navega por ela — mas não participa no agrupamento geográfico: entra no fim, por
  capacidade, e o plano diz que foi assim. Atribuir-lhe uma coordenada plausível
  seria pôr no mapa uma entrega que ninguém sabe onde é.
- **Encomenda sem peso** não consome capacidade nem é recusada por isso, e conta
  em `unknown_weight` — o mesmo critério do § 3.33: dizer "não sei" é honesto,
  inventar um peso médio produziria uma recusa (ou uma autorização) sem base.
- **O que não coube fica em `unassigned`, com o motivo nomeado.** Um plano que
  esconde as sobras deixa encomendas paradas sem ninguém saber porquê.

- **Backend (`/v1/routes/dispatch/plan` e `/dispatch/confirm`, RBAC ADMIN):**
  o plano é puro (`planDispatch`) e não toca na base; confirmar cria as rotas
  pelo caminho que já existia, incluindo a verificação de carga e a atribuição
  do § 3.34 — o despacho automático não é uma porta lateral que salta as
  validações do despacho manual.
- **Frontend admin (`/rotas`):** botão que propõe o plano, mostra por motorista
  o que lhe caberia e o que sobrou (com o motivo), e confirma. Sem emojis.

**Critérios de aceitação:** um motorista ocupado não recebe carga; uma encomenda
marcada para o futuro não entra; a soma por motorista nunca passa a capacidade do
veículo; encomendas sem peso não bloqueiam o plano; o que sobra vem nomeado com
motivo; e confirmar produz exatamente as rotas propostas.

---

### 3.39 Dashboard operacional

O painel existia e **mentia**. Carregava a primeira página de encomendas (200) e
contava sobre ela no navegador: numa empresa com mais do que isso, os
indicadores, a distribuição por estado e a lista "Requer Atenção" descreviam uma
amostra e apresentavam-se como o retrato da operação. Um número errado com ar de
autoridade é pior do que número nenhum — leva a decidir com confiança sobre algo
que não é verdade.

**Duas regras governam esta secção:**

1. **Contar é trabalho da base de dados.** Nenhum indicador é calculado sobre uma
   página. As contagens vêm de SQL sobre a empresa inteira, com o mesmo filtro de
   `company_id` do resto do sistema (§ 2.4).
2. **Um painel operacional mostra o que exige uma decisão**, não gráficos. Cada
   linha diz o que está mal, há quanto tempo, e leva ao sítio onde se resolve. Um
   gráfico bonito que ninguém usa é a forma mais cara de não fazer nada.

**As exceções, e porque cada uma está aqui.** Só entram situações que ficaram
paradas à espera de uma pessoa — não estados normais do percurso:

- **Entregas falhadas sem decisão.** Falhou, e ninguém reagendou nem mandou
  devolver. É a fila que cresce em silêncio: a encomenda não está a andar e não
  há nada agendado que a faça andar.
- **Reagendamentos vencidos.** A data combinada passou e a encomenda continua por
  entregar. O cliente ficou à espera num dia que já foi — é a falha que mais
  destrói confiança, e era invisível antes de o § 3.37 pôr a data no pedido.
- **Carga parada no armazém** para lá do limite (§ 3.36). Ocupa espaço que nega
  outra encomenda.
- **Em trânsito há demasiado tempo.** Saiu e não chegou a lado nenhum: ou
  perdeu-se, ou alguém se esqueceu de dar entrada.
- **Transferências com encomendas em falta** (§ 3.36). Já conferidas, com
  divergência por resolver.
- **Clientes acima do limite de crédito** (§ 3.35). Novas encomendas estão a ser
  recusadas — quem atende precisa de saber antes de o cliente telefonar.

**Limiares configuráveis, com defaults defensáveis** (`OPS_STALE_WAREHOUSE_DAYS`
7, `OPS_STALE_TRANSIT_DAYS` 3). São a fronteira entre "está a andar" e "alguém
tem de ir ver", e variam com a operação — fixá-los no código obrigaria a um
deploy para afinar um alarme.

**Severidade calculada, não escrita à mão.** A ordem por que as exceções
aparecem sai de uma função pura: quanto mais tempo parado e quanto mais perto do
cliente final, mais acima. Uma lista por ordem de chegada faz o urgente
desaparecer debaixo do trivial.

- **Backend (`/v1/operations`, RBAC ADMIN/SUPPORT):** `GET /summary` (contagens
  agregadas em SQL) e `GET /exceptions` (as filas acima, cada uma com o seu
  motivo e antiguidade).
- **Frontend admin (`/dashboard`):** os indicadores passam a vir do `/summary`;
  a secção de exceções substitui a antiga "Requer Atenção", que só via a primeira
  página e só conhecia dois estados. Sem emojis.

**Critérios de aceitação:** os números não mudam quando a paginação muda; uma
encomenda falhada e já reagendada **não** aparece como pendente de decisão; um
reagendamento cuja data passou aparece; os limiares respondem ao ambiente; e cada
exceção traz identificador, antiguidade e motivo.

---

### 3.40 Rentabilidade por pedido, rota, cliente e viatura

Saber quanto se fatura é fácil; saber quanto **sobra** é o que decide preços,
contratos e que clientes vale a pena manter. Sem isto, a decisão de dar 20% a um
cliente grande é tomada no escuro — e o cliente grande é precisamente aquele em
que 20% custa dinheiro a sério.

**A regra que governa a secção: um custo que não se mede não se inventa.** Um
relatório de margem que assume um custo por quilómetro produz números confiantes
que vão orientar decisões de preço. Se o número for inventado, a decisão é pior
do que a que se tomava a olho — porque agora tem a autoridade de um relatório.
Por isso **cada custo declara a sua origem** e o relatório declara a sua
cobertura.

**O que é MEDIDO.** O combustível. Entre dois abastecimentos de depósito cheio
sabe-se o custo e sabe-se a distância pelo conta-quilómetros: o custo por km sai
daí, por viatura, sem ninguém o estimar. É a única parcela que o sistema já tem
matéria-prima para calcular.

**O que é CONFIGURADO**, com default zero: manutenção e desgaste por km
(`FLEET_UPKEEP_CENTS_PER_KM`) e o custo de motorista por rota
(`FLEET_DRIVER_COST_PER_ROUTE_CENTS`). Zero por omissão de propósito — assim a
margem começa por mostrar **só o que é real**, e cresce em rigor à medida que a
empresa preenche o que sabe. Um default plausível seria pior: ninguém o mudava e
toda a gente acreditaria nele.

**O que NÃO é calculado:** salários rateados por entrega, amortização, seguros e
estrutura. A folha salarial é mensal e por pessoa (§ 3.16); reparti-la por
entrega exigiria horas trabalhadas por rota, que o sistema não regista. Enquanto
não registar, o relatório diz que a margem é **antes** desses custos, e não
finge.

**Cobertura declarada.** Toda a resposta traz `cost_coverage`: que parcelas
entraram, quais estão a zero por não estarem configuradas, e quantas viaturas têm
custo medido. Uma margem de 40% com o combustível desconhecido não é uma margem
de 40% — é uma margem por cima, e quem lê tem de o ver sem ter de perguntar.

**Como o custo da rota chega ao pedido.** Repartição **igual pelas paradas**. A
alternativa — ponderar por distância — parece mais justa e não é sustentável: o
otimizador guarda a distância **total** da rota, não a de cada perna, e inventar
a repartição por linha reta entre paradas daria um número com aparência de
precisão e sem base. Igual é simples, explicável ao cliente e honesto quanto ao
que se sabe.

**Uma encomenda sem rota não tem custo de transporte atribuído** e é marcada como
tal, em vez de aparecer com margem de 100%. Foi entregue por um caminho que o
sistema não acompanhou; dizê-lo é a resposta certa.

- **Backend (`/v1/profitability`, RBAC ADMIN):** só ADMIN — margem por cliente é
  informação comercial sensível, e quem atende ao balcão não precisa dela para
  fazer o seu trabalho. `GET /orders`, `GET /routes`, `GET /clients`,
  `GET /vehicles`, todos com janela `from`/`to`.
- **Frontend admin (`/relatorios`):** secção de rentabilidade com a cobertura
  visível no topo. Sem emojis.

**Critérios de aceitação:** o custo por km de uma viatura com abastecimentos sai
`measured`; sem abastecimentos sai `unknown` e a margem diz que é parcial; uma
encomenda sem rota vem com `cost_known: false`; o custo de uma rota repartido
pelas paradas soma exatamente o custo da rota; e nenhuma parcela configurada a
zero é apresentada como se fosse medida.

---

### 3.41 Contas a receber por cliente

O § 3.17 já registava contas a receber como lançamentos avulsos, e o § 3.35 já
sabia somar a dívida de um cliente para travar o limite de crédito. Faltava a
pergunta que quem cobra faz todas as semanas: **quem deve, quanto, e há quanto
tempo**. Sem antiguidade, uma dívida de 500 mil vencida há noventa dias é
indistinguível de uma emitida ontem — e é a primeira que decide se a empresa tem
tesouraria no mês seguinte.

**A antiguidade conta-se a partir do VENCIMENTO, não da emissão.** Uma fatura a
30 dias emitida hoje não está vencida; classificá-la pela data de emissão poria
metade da carteira em atraso no dia em que o relatório entrasse. Escalões
`corrente`, `1–30`, `31–60`, `61–90` e `+90` — os que qualquer contabilista
reconhece, e que existem porque a probabilidade de cobrar cai a cada um deles.

**Faturas sem prazo acordado têm escalão próprio.** Uma fatura-recibo é paga no
ato e por isso não leva vencimento (§ 3.35). Se ficou por pagar, é dívida real —
mas a sua idade não é medível contra um prazo que nunca existiu. Vai para
`sem_prazo`, contada no total e fora dos escalões. Inventar-lhe um vencimento
igual à emissão era exatamente o que o § 3.35 recusou fazer.

**Notas de crédito abatem.** Um cliente a quem se creditou uma devolução não
deve o valor devolvido, e um mapa que o ignore manda cobrar dinheiro que já não
existe — e estraga a relação com o cliente mais depressa do que a dívida.

**O que NÃO entra:** faturas anuladas e faturas pagas. Um mapa de dívida com o
que já foi pago é um extrato, e serve outra pergunta.

- **Backend (`/v1/receivables`, RBAC ADMIN):** `GET /` (carteira por cliente com
  escalões e total) e `GET /:clientRefId` (as faturas em aberto desse cliente,
  da mais antiga para a mais recente — é por essa que se começa a telefonar).
  Aproveita `due_date` (§ 3.35) e a mesma soma que o limite de crédito usa, para
  não haver duas definições de "dívida" a divergir.
- **Frontend admin (`/financas`):** carteira com os escalões, ordenada pelo que
  está mais vencido. Sem emojis.

**Critérios de aceitação:** uma fatura a 30 dias emitida hoje aparece como
corrente; passado o vencimento muda de escalão pelo número de dias; uma nota de
crédito reduz o saldo do cliente; faturas pagas e anuladas não aparecem; e uma
fatura sem prazo é contada no total sem entrar nos escalões de atraso.

---

### 3.42 SLA de entrega e ocorrências

Implementa o § 3.26, que descrevia o requisito sem o realizar.

#### O prazo é acordado, nunca deduzido

Um SLA precisa de um **prazo prometido ao cliente** — horas por zona e por nível
de serviço. Isso é política comercial, não dedução técnica, e por isso vive na
zona de tarifação (`sla_hours_normal`, `sla_hours_express`), a preencher pela
empresa.

**O default é nulo, e uma zona sem prazo acordado não tem incumprimento** — tem
`sem_prazo_acordado`. Seria tecnicamente possível derivar um prazo da mediana das
entregas passadas, e seria pior do que não ter nenhum: um SLA medido contra o
próprio desempenho anterior **nunca acusa incumprimento**, porque o alvo persegue
o resultado. Uma operação que piora todos os meses continuaria a cumprir 100% do
seu "SLA". Melhor não ter número do que ter um que mente.

O relógio conta a partir da **criação da encomenda** e para na **entrega**. Uma
encomenda ainda a caminho e já fora do prazo está incumprida agora, e não quando
chegar — é essa a diferença entre um mapa de SLA e um relatório de autópsia.

#### Ocorrências: o que distingue da fila de exceções

A fila do § 3.39 mostra o que está parado; renova-se sozinha e não tem dono. Uma
**ocorrência** é o oposto: alguém fica responsável, há um prazo para resolver, e
o percurso fica registado. Serve o caso em que a resolução leva dias e passa por
várias mãos — um extravio, um dano, uma divergência de COD.

- **Espécies** (§ 3.26): destinatário ausente, morada incorreta, dano, atraso,
  recusa, extravio e divergência de COD.
- **Prioridade** define o prazo interno de resolução, e o prazo é gravado na
  abertura: mudar a prioridade depois não pode reescrever o prazo que já estava a
  correr, ou o cumprimento passa a ser ajustável a posteriori.
- **Ciclo:** `aberta → em_curso → resolvida | cancelada`. Fechar **exige
  motivo** — uma ocorrência que fecha sem explicação não ensina nada a ninguém e
  torna o histórico inútil.
- **O histórico é imutável e append-only**, como o registo de auditoria
  (§ 3.21): cada transição fica com quem, quando e porquê. Sem isso, "esta
  encomenda esteve três semanas parada" não tem resposta.
- **Evidências** são referências e notas, não ficheiros. Guardar imagens aqui
  duplicaria o mecanismo do § 3.28 e o problema de armazenamento com ele; a
  fotografia do dano é a do comprovativo, e o que falta é apontar-lhe.

- **Backend (`/v1/incidents`, RBAC ADMIN/SUPPORT):** quem atende o cliente é
  quem abre a ocorrência — obrigar a passar pelo ADMIN faria a queixa ficar num
  papel. `GET /`, `POST /`, `GET /:id`, `POST /:id/transition`,
  `POST /:id/comment`. `GET /v1/sla/summary` e `GET /v1/sla/breaches`.
- **Frontend admin:** SLA no `/relatorios`; ocorrências com fila própria. Sem
  emojis.

**Critérios de aceitação:** uma zona sem prazo acordado não produz
incumprimentos; uma encomenda entregue dentro do prazo conta como cumprida e uma
ainda em curso já fora do prazo conta como incumprida **agora**; fechar uma
ocorrência sem motivo é recusado; alterar a prioridade não muda o prazo já a
correr; e o histórico de transições não pode ser alterado nem apagado.

---

### 3.43 Desempenho dos motoristas

Implementa o § 3.7, que existia como número e não como medição.

**O que estava errado.** Cada motorista nascia com `punctuality: 100`,
`success_rate: 100`, `customer_rating: 5` e `total_deliveries: 0` — valores
escritos à mão no cadastro e **nunca recalculados**. Um motorista com dez
insucessos continuava a exibir 100% de sucesso. Pior do que não ter indicador:
um número com ar de medição a dizer o contrário da realidade, no ecrã onde se
decide quem fica com as melhores rotas.

**A avaliação do cliente foi REMOVIDA, não corrigida.** Nunca existiu nada no
sistema que pedisse ao destinatário para avaliar a entrega — nem no portal, nem
no POD, nem por mensagem. Os 5,0 eram inteiramente inventados. Um sistema de
avaliação é uma funcionalidade por si (recolha, momento, prevenção de abuso), e
enquanto não existir o campo desaparece. Mostrar `—` é honesto; mostrar 5,0 é
uma mentira que alguém vai usar para promover ou despedir.

**Calculado da fonte, nunca guardado.** Os indicadores derivam das encomendas e
são calculados na leitura. Guardá-los numa coluna criaria um número que envelhece
em silêncio — que é exatamente o defeito que esta secção corrige. `drivers`
mantém a coluna por compatibilidade, mas deixa de ser lida para efeitos de
desempenho.

**Os indicadores, e o que cada um significa:**
- **Entregas** — quantas concluiu. É a base de tudo o resto.
- **Taxa de sucesso** — entregues sobre entregues + insucessos + devolvidas.
  Apenas sobre encomendas **atribuídas a ele** (§ 3.34): sem essa atribuição o
  denominador seria a operação inteira.
- **Sucesso à primeira** — entregues sem reagendamento pelo caminho (§ 3.37). É
  o indicador que distingue um motorista que resolve de um que volta lá três
  vezes, e o único que a taxa de sucesso sozinha esconde.
- **Pontualidade** — entregas dentro do prazo acordado, **só onde há prazo**
  (§ 3.42). Numa operação sem SLA definido vem `null`, não 100%.
- **COD por acertar** — valor cobrado e ainda não entregue à empresa (§ 3.5).
  Não é qualidade de serviço, é exposição de caixa, e por isso aparece separado.

**Um motorista sem entregas não tem taxa nenhuma.** Todas as percentagens vêm
`null` com `sample_size: 0`. Uma taxa de 0% para quem começou ontem é uma
acusação, e uma de 100% para quem fez uma entrega é um elogio sem base.

- **Backend (`/v1/drivers/performance`, RBAC ADMIN/SUPPORT):** ranking e
  `GET /v1/drivers/:id/performance` para o detalhe. Janela `from`/`to`.
- **Frontend admin (`/motoristas`):** os indicadores no detalhe do motorista,
  com `—` onde não há amostra. Sem emojis.

**Critérios de aceitação:** um motorista sem entregas apresenta `null` em todas
as taxas; um insucesso baixa a taxa de sucesso; uma entrega reagendada não conta
como sucesso à primeira; sem prazo acordado a pontualidade é `null`; e não existe
nenhum campo de avaliação do cliente enquanto não houver recolha.

---

### 3.44 Exportação para Excel

O CSV que existia abre no Excel, mas **os números chegam como texto e não somam**
— quem recebe o mapa de dívida tem de reformatar coluna a coluna antes de o
poder usar. E um relatório por ficheiro obriga a abrir seis e a colá-los à mão.
É por isso que se pede Excel e não CSV; não é preferência de formato.

**Escrito de raiz, sem biblioteca.** Um `.xlsx` é um ZIP com meia dúzia de
ficheiros XML. As bibliotecas do costume trazem dezenas de megabytes e uma
superfície de manutenção grande para produzir uma grelha de células — e o
projeto já seguiu este caminho no motor de PDF (§ 3.20) e no gerador de Code128
(§ 3.15). O escritor faz o que os relatórios precisam: várias folhas, cabeçalho a
negrito, larguras de coluna e **números como números**.

**O que deliberadamente não faz:** fórmulas, gráficos e formatação condicional —
decoração que não muda o que se faz com o ficheiro. As datas vão como texto ISO,
legível e ordenável, sem a ambiguidade do calendário de 1900 que o formato
arrasta desde os anos 80.

**Valores em unidades, não em centavos.** O sistema guarda centavos porque é a
única forma de somar dinheiro sem erro; a folha recebe meticais, porque é o que
a pessoa vai somar. A conversão é do exportador — obrigar quem abre a dividir
por cem seria devolver o problema do CSV por outra via.

**Uma exportação vazia continua a ser um ficheiro válido**, com cabeçalhos e sem
linhas. Devolver erro quando não há dados obrigaria quem exporta a distinguir
"correu mal" de "não há nada", e a resposta certa a "quanto me devem?" pode
mesmo ser "nada".

- **Backend (`/v1/exports`, RBAC conforme o relatório de origem):** cada
  exportação **reutiliza o caso de uso do relatório** em vez de repetir a
  consulta — dois caminhos para o mesmo número acabariam a divergir, e o ficheiro
  exportado é justamente o que sai da empresa e vai ser discutido.
- **Frontend admin:** botão de Excel ao lado do de PDF/CSV onde o relatório já
  existe. Sem emojis.

**Critérios de aceitação:** o ficheiro abre num leitor de folhas de cálculo; os
valores monetários somam sem reformatação; um nome com `&` não corrompe o
ficheiro; várias folhas aparecem no mesmo livro; e uma exportação sem dados
produz um ficheiro válido com cabeçalhos.

---

### 3.45 Operação multifilial

Uma transportadora com bases em Maputo, Beira e Nampula tem um problema que a
multiempresa (§ 2.4) não resolve: é **uma** empresa, e o responsável da Beira
não quer percorrer as encomendas de Maputo para encontrar as suas.

**A filial é o armazém.** Uma tabela `branches` nova teria nome, morada, GPS e
código — exatamente o que `warehouses` já tem — e as duas ficariam a divergir à
primeira base criada só num dos sítios. O que falta não é uma entidade; é o
**âmbito**: quem vê o quê, e como se lê a operação repartida por base.

**A filial NÃO é uma fronteira de segurança.** A fronteira é a empresa
(`company_id`), imposta em SQL em todas as leituras. O âmbito de filial é uma
lente sobre os dados da própria empresa, e há-de sempre existir quem veja tudo.
Dizê-lo aqui evita que alguém use a atribuição de filiais para esconder dados
sensíveis de um colega e seja apanhado de surpresa.

**Um utilizador sem filiais atribuídas vê a empresa inteira.** É o contrário do
que a intuição sugere, e é deliberado: no dia da migração ninguém tem filiais
atribuídas, e exigir atribuição trancaria toda a gente fora do sistema de uma
vez. Quem opera numa só base — a esmagadora maioria — nunca precisa de tocar
nisto.

**Origem e localização são coisas diferentes.** Uma encomenda entra por uma
filial (`branch_id`, que nunca muda: é a quem pertence a receita e a
responsabilidade) e está fisicamente noutra à medida que viaja
(`warehouse_id`, que já existe e já muda com as transferências do § 3.36). Um
utilizador da Beira vê a encomenda **se a origem for a sua filial OU se ela
estiver agora no seu armazém**. Sem esse OU, uma transferência a caminho seria
invisível precisamente à base que a tem de receber.

**Encomendas sem filial são visíveis a todos.** As que existem antes desta
migração não têm origem registada, e o armazém onde estão hoje não é a filial
por onde entraram — deduzi-la seria inventar um facto que o sistema nunca
guardou. Ficam a `NULL`, e `NULL` não desaparece de vista.

- **Backend:** `user_branches` (utilizador ↔ armazém, muitos-para-muitos — um
  responsável regional cobre mais do que uma base); `branch_id` em `orders`,
  `drivers` e `fleet_vehicles`. O âmbito é lido da base a cada pedido e não do
  token: gravado no token, retirar uma filial a alguém só faria efeito no
  próximo início de sessão, e uma restrição que demora horas a aplicar-se não é
  uma restrição.
- **Frontend admin:** atribuição de filiais na ficha do utilizador; filtro de
  filial na lista de encomendas; repartição por filial no painel operacional.
  Sem emojis.

**Critérios de aceitação:** um utilizador restrito à Beira não vê encomendas de
Maputo, mas vê as que vêm a caminho do seu armazém; um utilizador sem atribuição
continua a ver tudo; encomendas sem filial nunca desaparecem; retirar uma filial
faz efeito no pedido seguinte, sem novo início de sessão; e o âmbito de filial
nunca deixa passar dados de outra empresa.

---

### 3.46 Previsão do tempo de entrega

"Quando chega?" é a pergunta que o cliente faz, e hoje a resposta é o prazo
prometido (§ 3.42) — que é o que a empresa **disse**, não o que a empresa
**faz**. A previsão responde com o que aconteceu às encomendas parecidas.

**Prevê-se do histórico medido, e só dele.** Nada de fatores inventados nem de
pesos afinados a olho: a duração de cada entrega concluída é um facto que a base
já guarda, e a previsão é a leitura desses factos.

**Sem amostra, não há previsão.** Abaixo de **20 entregas concluídas** no
segmento, a resposta é "sem base para prever", acompanhada da contagem que
falta. Um sistema que responde "24 horas" a partir de três entregas está a
inventar com o aspeto de quem mediu — e a previsão vai ser lida por um cliente
que decide com ela.

**Percentis, nunca média.** Uma encomenda esquecida três semanas num armazém
desloca uma média o suficiente para a tornar inútil, e não desloca a mediana. A
resposta é um **intervalo P50–P90**: metade chega até ao primeiro número, nove em
cada dez até ao segundo.

**Um intervalo, e não um instante.** Um número único lê-se como promessa, e uma
promessa falhada custa mais do que uma estimativa larga.

**Segmenta-se por destino e nível de serviço** — os dois fatores que mudam mesmo
a duração. Não por motorista: uma previsão que muda com o nome de quem entrega
transforma-se numa avaliação da pessoa, feita com uma amostra que nunca foi
recolhida para isso (§ 3.43).

**A escada de recurso pára antes de mentir.** Segmento exato → mesma zona,
qualquer nível de serviço → **sem previsão**. Nunca a média da empresa: aplicar a
Nampula o que se mediu em Maputo é uma afirmação confiante sobre uma rota que
ninguém percorreu.

**Conta-se do registo à entrega**, porque é essa a espera que o cliente vive.
Medir a partir da recolha daria um número melhor e responderia a outra pergunta.

**A comparação com o prometido é o resultado mais valioso.** Quando a zona tem
prazo acordado e o P90 medido o excede, isso aparece dito: prometem-se 24 horas e
entrega-se em 38 em nove de cada dez casos. É a única saída deste módulo que
muda uma decisão de gestão em vez de informar um cliente.

- **Backend (`GET /v1/predictions/delivery-time`, ADMIN; usado também pelo
  rastreio público):** segmentos com `sample_size`, `p50_hours`, `p90_hours`,
  `basis` e, onde exista prazo acordado, o desvio face a ele.
- **Frontend:** no rastreio, uma linha com o intervalo — **ausente**, e não
  vazia, quando não há amostra. Sem emojis.

**Critérios de aceitação:** um segmento com menos de 20 entregas não produz
previsão nenhuma; a mediana não se move quando se acrescenta uma encomenda
absurda; o recurso à zona é assinalado como tal; e uma promessa que a medição
desmente aparece dita, não escondida.

---

### 3.47 Deteção de atrasos e desvios

O painel de exceções (§ 3.39) mostra o que **já falhou**. Isto procura o que
ainda vai a tempo de ser salvo: a encomenda que ainda não está atrasada mas vai
estar, e a rota que deixou de ser cumprida como foi planeada.

**Atraso mede-se contra o que se mediu, não contra um palpite.** Uma encomenda
em curso está atrasada quando ultrapassa o P90 do seu segmento (§ 3.46) ou o
prazo acordado (§ 3.42), o que existir. Sem nenhum dos dois **não se declara
atraso** — chamar atrasada a uma encomenda sem prazo nem histórico é inventar um
incumprimento que ninguém prometeu, e destrói a confiança na lista inteira.

**Prever o atraso antes de ele acontecer é a única coisa que muda alguma.** Uma
encomenda que passou o P50 e ainda não saiu para entrega é sinalizada como *em
risco* — ainda dá para agir. Sinalizada só depois do prazo, a lista é um
relatório de más notícias.

**Parada é diferente de atrasada.** Uma encomenda pode estar dentro do prazo e
parada há quatro dias no mesmo estado; outra pode estar fora do prazo e a andar.
São dois problemas com duas respostas, e um só número esconderia ambos. O tempo
normal de cada estado é medido do histórico, pelas mesmas regras do § 3.46.

**Desvio é de sequência, não de estrada.** A rota é planeada com uma ordem de
paradas (§ 3.2); entregar a sétima antes da segunda é um desvio detetável e
acionável. **O desvio geográfico não é detetado, e isso é dito**: o sistema
guarda a última posição conhecida de cada motorista, não o rasto do percurso —
sem rasto não há como saber se alguém saiu do caminho, e um módulo que
sugerisse o contrário estaria a afirmar uma vigilância que não existe.

**Um desvio de sequência não é uma acusação.** Trânsito cortado, cliente ausente
e uma recolha urgente a meio são motivos legítimos para trocar a ordem. A lista
diz o que aconteceu; não classifica ninguém.

- **Backend (`GET /v1/predictions/risks`, ADMIN e SUPPORT):** encomendas em risco
  e atrasadas, encomendas paradas, e desvios de sequência por rota — cada uma com
  a base do juízo (`p90`, `sla` ou `historico_do_estado`) à vista.
- **Frontend admin:** um bloco no painel operacional, antes das exceções já
  consumadas. Sem emojis.

**Critérios de aceitação:** uma encomenda sem prazo e sem histórico nunca é
declarada atrasada; o risco aparece antes do incumprimento; parada e atrasada são
distinguíveis; a base de cada juízo é visível; e o desvio geográfico é declarado
como não detetado em vez de simulado.

---

### 3.48 Otimização de rotas com janelas e prioridade

O motor do § 3.2 minimiza quilómetros. Uma rota com o mínimo de quilómetros
entrega alegremente às 16h uma encomenda combinada para as 9h–12h — e o cliente
não estava lá. **O que falta não é um algoritmo melhor; é dizer ao algoritmo o
que realmente custa.**

**A janela combinada manda sobre a distância.** Chegar cedo é esperar; chegar
tarde é falhar a entrega, voltar amanhã e pagar a viagem duas vezes. Uma ordem
alguns quilómetros mais longa que cumpre as janelas é mais barata do que a mais
curta que as falha.

**Uma janela impossível é reportada, nunca violada em silêncio.** Se as paradas
não cabem todas nas suas janelas, o motor devolve a melhor ordem que encontrou
**e a lista das que não conseguiu servir a tempo**. Um plano que esconde o
incumprimento faz o motorista descobri-lo à porta do cliente, que é o pior sítio
e a pior hora.

**A prioridade não atropela a janela.** Um expresso entregue às 20h quando a
janela fechou às 12h não é uma entrega prioritária — é uma entrega falhada mais
cedo na lista. A prioridade decide entre paradas igualmente possíveis.

**A velocidade é medida quando há histórico, e assumida quando não há — e a
resposta diz qual dos dois foi.** Converter distância em tempo exige uma
velocidade; sem entregas suficientes na zona, qualquer km/h é um palpite. O
palpite é aceitável, escondê-lo não: o plano é usado para prometer horas a
clientes.

**Continua sem trânsito em tempo real e sem malha viária.** As distâncias são
geodésicas (§ 3.2). Uma cidade com rio pelo meio tem percursos muito mais longos
do que a linha reta sugere, e nenhuma quantidade de otimização o corrige — só
uma Directions API o faria.

- **Backend (`routes-service/src/domain/optimizer.js`):** `optimizeStops` aceita
  `window_start`/`window_end`/`priority` por parada e `departure_at`/`speed_kmh`
  na rota; devolve `arrival_estimates`, `window_violations` e `speed_basis`.
  Sem estes campos, o comportamento é **exatamente** o de hoje.
- **Frontend admin:** as janelas incumpridas aparecem no despacho, antes de a
  rota ser aceite. Sem emojis.

**Critérios de aceitação:** uma rota sem janelas produz o mesmo resultado de
hoje; uma janela que caberia numa ordem diferente passa a ser cumprida; uma
janela impossível vem listada e não silenciada; a prioridade nunca faz falhar
uma janela; e a base da velocidade vem sempre declarada.

---

### 3.49 Modais alcançáveis

Um formulário com muitos campos abria e ficava com o **topo fora do ecrã**, sem
maneira de lá chegar. Não era um problema estético: o cabeçalho e, em alguns
ecrãs, o botão de fechar deixavam de existir para quem estava a olhar.

**É a armadilha clássica do flexbox.** Uma sobreposição `fixed inset-0` com
`align-items: center` centra o painel; quando ele é mais alto do que a janela, o
que sobra sai pelos **dois** lados, e a margem que sobra em cima é negativa —
nenhum scroll a alcança. O modal parece cortado por baixo, e é por cima que está
o que se perdeu.

**A correção é uma regra, não trinta e seis.** `align-items: safe center` centra
enquanto couber e alinha ao topo quando não couber, empurrando todo o
transbordo para baixo, onde o scroll chega. Onde o browser não a suportar, a
declaração é ignorada e fica o comportamento anterior — nunca pior. A regra
apanha as sobreposições pela combinação de classes que o Tailwind gera, em vez
de obrigar cada ecrã a repetir a mesma correção e a esquecer-se dela no ecrã
seguinte.

**Um componente `Modal` partilhado seria melhor** e continua a ser o destino:
trinta e seis sobreposições escritas à mão divergem sempre, e algumas vivem em
ficheiros minificados que não se editam com segurança. A regra global resolve o
defeito hoje sem tocar nesses ficheiros; a migração fica por fazer, e está dito.

**A regra é frágil de uma maneira específica:** continua a existir e a parecer
certa enquanto alguém escreve um modal novo com outro alinhamento, que fica de
fora sem que nada se queixe. Por isso há uma sonda
(`tests/harness/modal-overlays.ts`) que enumera os alinhamentos realmente usados
no código e os confronta com os que o CSS declara tratar.

**Critérios de aceitação:** nenhuma sobreposição fica sem forma de alcançar o
que transborda — ou o painel limita a altura e faz scroll por si, ou o seu
alinhamento está coberto pela regra; e um alinhamento novo que o CSS não trate
faz o teste falhar, nomeando o ficheiro e a linha.

---

### 3.50 Nenhum texto sai de um cartão

`110.500,00 MZN` numa coluna de um sexto saía por cima do cartão do lado. **Ali
não se lê como layout partido — lê-se como o número do vizinho**, que é a pior
maneira de um relatório financeiro falhar: não parece avariado, parece errado.

A regra é do sistema inteiro e tem duas partes, de naturezas diferentes.

**A rede: o cartão garante a quebra.** `overflow-wrap: break-word` na classe do
cartão — e, na app do motorista, que não tem classe própria, no componente. A
propriedade é **herdada**, por isso cobre também as caixas aninhadas lá dentro,
como os escalões de antiguidade do § 3.41, que não são cartões por si. Usa-se
`break-word` e não `anywhere` porque parte a palavra sem alterar o tamanho
mínimo do contentor: não mexe em nenhuma disposição que hoje esteja correta, e
só age quando a alternativa era transbordar.

**O plano: a grelha dá largura que chegue.** A rede impede o desastre, mas
quebrar um montante a meio continua a ser feio. **Máximo de quatro colunas** numa
grelha de indicadores: num ecrã de 1400px, quatro dão cerca de 280px úteis por
cartão, onde `1.234.567,89 MZN` cabe a `text-3xl`; em cinco, deixa de caber. Não
é um número de gosto — é onde a conta muda.

**Sem exceções por página.** A tentação é dispensar a regra onde os cartões só
levam contagens. Uma regra com exceções caso a caso é uma regra que se desfaz, e
a página que hoje conta colaboradores é a que amanhã mostra a massa salarial.

- **Verificação:** `tests/harness/card-overflow.ts` lê o código, confirma que
  cada app declara a garantia e enumera as grelhas de indicadores com colunas a
  mais. **Ignora comentários** — a primeira versão da sonda dava a regra por
  cumprida porque o comentário que a explicava continha a palavra procurada, e
  uma sonda que se satisfaz com a documentação da regra é pior do que não haver
  sonda.

**Critérios de aceitação:** as três aplicações declaram a garantia no cartão;
nenhuma grelha de indicadores passa de quatro colunas; e apagar a garantia de
qualquer uma das apps faz o teste falhar, nomeando-a.

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
- **O ensaio compara origem com restauro, e não só o restauro.** Uma cadeia partida na origem é
  copiada fielmente: o restauro fez o seu trabalho, e reprovar a cópia por isso manda o operador
  procurar no sítio errado. Pior — a partir da primeira quebra, **todas** as cópias seguintes
  reprovariam para sempre, e um controlo permanentemente vermelho deixa de ser lido. Reprova a cópia
  a cadeia que estava íntegra na origem e chega partida ao restauro; a que já vinha partida sai como
  **aviso nomeado** (qual empresa, qual série), porque continua a ser um alarme sério — só que do
  histórico, não da cópia. Sem conseguir ler a origem, o ensaio volta ao critério estrito: um ensaio
  que não sabe comparar não pode ser permissivo. A regra (`compareChains`) é pura e tem testes
  próprios, incluindo o caso que a permissividade podia esconder — uma regressão real ao lado de uma
  quebra antiga.
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

> **Isto descreve o que existe.** O desenho original previa microserviços com
> Kafka e Redis; não foi o que se construiu, e a decisão está registada no
> [ADR-002](../adr/ADR-002-monolito-modular.md).

```
[Portal do Cliente]   [App do Motorista]   [Painel Admin]
     (Next.js)          (Next.js PWA)        (Next.js)
          |                    |                   |
          +--------------------+-------------------+
                               |
                         [Caddy — HTTPS]
                               |
                    ┌──────────────────────┐
                    │      api-gateway     │   UM processo Node.js
                    │  auth · rate limit   │
                    │  contexto de empresa │
                    ├──────────────────────┤
                    │ orders  · routes     │   módulos carregados
                    │ payments · notif.    │   por `require`, não
                    │ tracking-intl        │   por rede
                    └──────────────────────┘
                               |
                        [PostgreSQL — base `track`]

Eventos: em processo, com envelope completo escrito no log estruturado.
Sem broker, sem cache externa, sem segundo armazém de estado.
```

### Serviços e Responsabilidades

Cada um é uma **fronteira de código**, não de processo: vivem em
`backend/*-service` e são carregados pelo gateway. A separação existe para o
código não se emaranhar; atravessá-la custa uma chamada de função, não uma
chamada de rede.

| Módulo | Responsabilidade |
|---|---|
| `orders-service` | CRUD de pedidos, timeline de eventos, sync offline |
| `routes-service` | Otimização de rotas, reotimização dinâmica |
| `payments-service` | Cobranças, webhooks de gateway, conciliação |
| `notifications-service` | FCM push, preferências de notificação |
| `tracking-intl-service` | Polling de APIs externas, normalização de status |

---

## 6. Stack Tecnológica

| Camada | O que existe hoje |
|---|---|
| Portal do cliente / App do motorista | Next.js 14 (a do motorista é PWA instalável) |
| Painel Admin | Next.js 14 |
| Backend | Express + JavaScript (CommonJS), um só processo |
| Base de dados | PostgreSQL 15+, base única `track` |
| Eventos | Em processo, com envelope escrito no log estruturado |
| Autenticação | JWT próprio (`auth.service.js`), papéis em `requireRoles` |
| Mapas | Leaflet + tiles OpenStreetMap; otimização própria (haversine + 2-opt + janelas, § 3.2 e § 3.48) |
| PDF / código de barras / Excel | Motores próprios, sem dependências (§ 3.20, § 3.15, § 3.44) |
| Offline do motorista | IndexedDB (§ 3.29) |
| Observabilidade | Log estruturado próprio + métricas em processo (§ 3.31) |
| Implantação | Docker Compose + Caddy, um servidor |

**Ligado a serviços externos, com adaptador escrito e credenciais por fornecer:**
FCM (push), WhatsApp Cloud API, SMS, Resend (email), 17TRACK, gateways de
pagamento. Todos correm contra simulador enquanto não houver credenciais, e
dizem-no em `/v1/providers`.

**Deliberadamente ausentes:** Redis, Kafka, Kubernetes, Keycloak, Datadog e
Google Maps Platform. Ver [ADR-002](../adr/ADR-002-monolito-modular.md).

<details><summary>Tecnologias previstas no desenho original (não usadas)</summary>

| Camada | Previsto em 2025-07 |
|---|---|
| App Cliente / Motorista | React Native (multiplataforma) |
| Backend | NestJS (Node.js) + TypeScript |
| Cache / Geo realtime | Redis 7+ |
| Mensageria | Kafka (self-hosted) ou AWS SQS/SNS (managed) |
| Mapas / Roteirização | Google Maps Platform (Directions + Route Optimization) |
| Infra | AWS/GCP, Docker + Kubernetes (EKS/GKE) |
| Observabilidade | Datadog ou OpenTelemetry + Grafana |
| Auth | Keycloak ou AWS Cognito (OAuth2/OIDC) |
| Offline local DB | SQLite (app motorista) |

</details>

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

// ComprovativoEntrega — metadados guardados no pedido (§ 3.28).
// As imagens NÃO estão aqui: pesam megabytes e sairiam em cada `SELECT *`.
interface ComprovativoEntrega {
  method: 'signature' | 'photo' | 'signature_photo';
  recipient_name: string;
  has_signature: boolean;                   // há prova guardada?
  has_photo: boolean;
  notes?: string;
  coords?: GeoPoint;
  captured_by?: string;
  captured_at: Date;
}

// ImagensComprovativo — tabela à parte, lida só no detalhe (§ 3.28).
interface ImagensComprovativo {
  pedido_id: string;                        // chave primária
  assinatura?: string;                      // data URL
  foto?: string;                            // data URL
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

// Veiculo — o modal é o vocabulário partilhado por cadastro, frota,
// tarifação e despacho (§ 3.33). MOTO e MOTOTRICICLO são a última milha.
interface Veiculo {
  tipo: 'MOTO' | 'MOTOTRICICLO' | 'CARRO' | 'VAN' | 'CAMINHAO';
  matricula: string;
  capacidade_kg: number;                    // nunca acima do teto do modal
  categoria_carta?: 'A' | 'B' | 'C';        // tem de habilitar o modal
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

### Prioridade 1 — finalizar e estabilizar (§ 3.34)

Nada de novo entra enquanto isto não estiver fechado. Concluído:

- [x] Build de produção sem dependência da rede (fonte e recursos do mapa auto-hospedados; sonda no harness a impedir a regressão)
- [x] ESLint configurado e a passar nos três frontends, com o CI a executá-lo
- [x] Suíte completa a passar contra PostgreSQL real (unitários + integração)
- [x] Percurso ponta a ponta: criar → recolher → despachar → transportar → entregar → apresentar a prova
- [x] Despacho a atribuir a encomenda ao motorista (o defeito que o percurso revelou)
- [x] Migração de raiz verificada contra base vazia; cópia, ensaio de restauro e retenção executados
- [x] App do motorista publicada pela implantação; pilha de deploy parcial assinalada
- [x] Correlação, registo estruturado com PII mascarada, métricas, registo central de erros e alertas acionáveis (§ 3.31)
- [ ] Métricas em falta: jobs atrasados, profundidade da fila offline e webhooks

### Prioridade 2 — operação logística completa

O que já existe está marcado; o que falta é o que a operação real ainda pede.

- [x] Clientes; recolha, expedição e entrega
- [x] Tarifação por **zona, peso, volume, distância, nível de serviço e modal**, com sobretaxa de COD (§ 3.13)
- [x] Armazéns e movimentos; etiquetas e leitura de códigos (§ 3.15)
- [x] Planeamento de rotas e verificação de carga no despacho (§ 3.2, § 3.33)
- [x] Rastreio GPS dos motoristas; POD com foto, assinatura, nome, localização e data (§ 3.28)
- [x] Insucesso, pagamento na entrega e reconciliação de caixa (§ 3.5)
- [x] Manutenção, combustível e documentos da frota (§ 3.18)
- [x] Portal do cliente e app do motorista com funcionamento offline (§ 3.6, § 3.25)
- [x] Contratos por cliente: desconto, tarifa negociada por zona, frete mínimo, prazo de pagamento e limite de crédito, aplicados pelo sistema (§ 3.35)
- [x] Inventário com idade da carga, contagem física e transferência entre filiais com manifesto e conferência (§ 3.36)
- [x] Reagendamento com data acordada e teto de tentativas; devolução ao remetente com prova e COD cancelado (§ 3.37)
- [ ] Ocorrências com SLA e escalonamento (§ 3.26) e logística reversa pedida pelo cliente (§ 3.27) — âmbitos distintos do § 3.37, ainda por implementar
- [x] Despacho automático: propõe a distribuição por motorista respeitando capacidade, disponibilidade e datas reagendadas; confirma pelo caminho validado (§ 3.38)
- [x] Adaptadores reais dos quatro canais escritos e testados contra duplos: push (FCM v1), email (Resend/HTTP), SMS (HTTP) e **WhatsApp** (Cloud API da Meta) — § 3.3
- [ ] **Ativação** dos canais: depende de credenciais e de um domínio verificado, que não são decisão técnica. Enquanto não existirem, os canais ficam simulados e o alerta de "provedores simulados em produção" (§ 3.31) dispara — que é exatamente o que deve acontecer

### Prioridade 3 — controlo empresarial

- [x] Faturação, recibos, impostos e conformidade fiscal (§ 3.14, § 3.19)
- [x] Controlo de caixa dos motoristas (§ 3.5)
- [x] Gestão de utilizadores, funções e permissões (§ 3.32)
- [x] Auditoria de todas as operações (§ 3.21)
- [x] Multiempresa (§ 2.4)
- [x] Relatórios exportáveis em PDF e CSV (§ 3.17, § 3.20)
- [x] Contas a receber e a pagar como lançamentos com vencimento e saldo (§ 3.17)
- [x] Dashboard operacional: indicadores contados em SQL sobre a empresa inteira e fila de exceções ordenada por severidade (§ 3.39). **Corrigiu um painel que contava sobre a primeira página de encomendas e apresentava o resultado como o retrato da operação**
- [x] Rentabilidade por pedido, rota, cliente e viatura, com o combustível MEDIDO dos abastecimentos e a cobertura de custos declarada em cada resposta (§ 3.40)
- [x] Contas a receber por cliente, ligadas às faturas, com antiguidade da dívida por escalões contados a partir do vencimento (§ 3.41)
- [x] SLA de entrega com prazo acordado por zona e ocorrências com dono, prazo e histórico imutável (§ 3.42, implementa o § 3.26)
- [x] Desempenho dos motoristas medido das encomendas, com `null` onde não há amostra e sem a avaliação de cliente que nunca foi recolhida (§ 3.43, implementa o § 3.7)
- [x] Exportação para Excel com escritor próprio de `.xlsx`: várias folhas por livro, valores em meticais que somam sem reformatação, e a ressalva de custos a viajar dentro do ficheiro (§ 3.44)
- [x] Operação multifilial: a filial é o armazém, âmbito por utilizador lido da base a cada pedido, origem distinta da localização atual, e repartição da operação por base (§ 3.45)

### Prioridade 4 — diferenciais avançados

Só depois de a operação estar estável.

- [x] Previsão do horário de entrega a partir do histórico medido: intervalo P50–P90 por destino e nível de serviço, recusa de prever abaixo de 20 entregas, e confronto com o prazo prometido (§ 3.46)
- [x] Otimização de rotas com janelas de entrega e prioridade, com as janelas incumpríveis reportadas em vez de violadas em silêncio e a velocidade sempre declarada como medida ou assumida (§ 3.48). Capacidade já vinha do § 3.33.
  - [ ] Por fazer: trânsito em tempo real e distância pela malha viária — ambos exigem uma Directions API (§ 6); turnos e replaneamento a meio da rota.
- [x] Deteção de atrasos e desvios: risco antes do incumprimento, paragem distinta de atraso, desvio de sequência da rota, e o desvio geográfico declarado como não detetado por não haver rasto de GPS (§ 3.47)

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
