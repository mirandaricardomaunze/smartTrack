# Guia de Produção — sistemaTrack

Deploy num VPS Linux com **Docker + Caddy** (HTTPS automático). O backend é um
monólito modular (um processo, uma base `track`); os frontends são Next.js.

Spec ref: `docs/spec/especificacao-tecnica-v1.md` §2.4 (multiempresa), §4 (segurança), §6 (stack).

---

## 1. Pré-requisitos

- VPS com Docker + Docker Compose (`docker compose version`).
- Um domínio e **3 subdomínios** com registos DNS `A` a apontar para o IP do VPS:
  - `api.exemplo.com`  → API
  - `admin.exemplo.com` → painel administrativo
  - `app.exemplo.com`  → site público do cliente

---

## 2. Configuração (`.env`)

```bash
cp .env.example .env
```

Preencha **obrigatoriamente**:

| Variável | Notas |
|---|---|
| `JWT_SECRET` | **Obrigatório**. `openssl rand -hex 48`. Sem ele, o backend recusa arrancar em produção. |
| `PGPASSWORD` / `POSTGRES_PASSWORD` | Mesma senha forte para a base. |
| `CORS_ORIGIN` | `https://admin.exemplo.com,https://app.exemplo.com` |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | Conta dona da plataforma (>= 8 car.). |
| `NEXT_PUBLIC_API_URL` | `https://api.exemplo.com` (inlined no build dos frontends). |
| `DOMAIN_API` / `DOMAIN_ADMIN` / `DOMAIN_APP` | Os subdomínios acima. |
| `ACME_EMAIL` | Email para os certificados TLS (Let's Encrypt). |

Opcionais (ficam **simulados** enquanto não definir as chaves):
`TRACK17_API_KEY` (rastreio real), `SMS_API_URL`/`SMS_API_KEY`, `EMAIL_API_URL`/`EMAIL_API_KEY`.
Faturação: `INVOICE_ISSUER_*`, `INVOICE_TAX_RATE_PCT` (default 16). Tarifação: `PRICING_*`.
RH (§ 3.16): `HR_TIMEZONE_OFFSET_MINUTES` (120 = UTC+2) e `HR_SHIFT_*` — turno de omissão de quem
não tem turno atribuído; o horário real vem de `hr_shifts`.
Fiscal (§ 3.19): `FISCAL_DEFAULT_SERIES`, `FISCAL_SOFTWARE_VERSION`, `FISCAL_SAFT_*` e
`FISCAL_SOFTWARE_CERTIFICATE` — **deixe a 0 enquanto a AT não atribuir número**; esse valor sai
impresso nos documentos e no ficheiro SAF-T, e declarar uma certificação inexistente é o pior
resultado possível numa inspeção. Antes de faturar a sério: confirme `INVOICE_ISSUER_TAXID` (9
dígitos, valida no arranque da emissão) e valide o mapa de IVA de um mês com o contabilista.
Subscrições (§ 2.5): `SAAS_DEFAULT_PLAN` (default `starter` — plano da avaliação no auto-registo) e
`SAAS_PAST_DUE_GRACE_DAYS` (default 7 — dias com fatura por pagar antes de bloquear as escritas).
A cobrança por carteira móvel (M-Pesa/eMola) está **simulada**: nenhum valor é debitado enquanto o
adaptador real não entrar em `infrastructure/billing.gateway.js`. A via manual (transferência
confirmada pelo SUPERADMIN em `/empresas`) já é real e é a recomendada para faturar em produção.

---

## 3. Arrancar

```bash
docker compose build
docker compose up -d
```

- No **primeiro arranque**, o backend corre `bootstrap-migrate.js`: como a base está
  vazia, cria o núcleo (orders, drivers, warehouses, **companies**, `company_id`, …) e
  as tabelas dos módulos. Em arranques seguintes, **não recria nada** (dados preservados).
- O Caddy emite os certificados TLS automaticamente (aguarde ~1 min no 1º arranque).

Criar o **SUPERADMIN** da plataforma (as contas de demonstração estão desligadas em produção):

```bash
docker compose exec backend node backend/api-gateway/scripts/seed-superadmin.js
```

---

## 4. Fluxo multiempresa (SaaS)

- Cada empresa regista-se em `https://admin.exemplo.com/registar-empresa` (cria empresa + 1º ADMIN).
- O **SUPERADMIN** entra no painel e gere as empresas em **/empresas** (suspender/reativar).
  Uma empresa suspensa **bloqueia o login** dos seus utilizadores.
- O site público do cliente (`app.exemplo.com`) rastreia por código — os códigos são
  globais únicos e resolvem a empresa automaticamente.

---

## 5. Checklist de segurança (spec § 4)

- [ ] `NODE_ENV=production` (desliga contas de demonstração; exige `JWT_SECRET`).
- [ ] `JWT_SECRET` forte e único; **nunca** commitado.
- [ ] `CORS_ORIGIN` restrito aos domínios reais (sem `*`).
- [ ] Senhas fortes da base; a base **não** exposta publicamente (rede `internal`).
- [ ] HTTPS em todos os domínios (Caddy trata).
- [ ] `SUPERADMIN_PASSWORD` forte; trocar após o 1º acesso.
- [ ] Rate limits revistos (`RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`, `COMPANY_REGISTER_RATE_LIMIT_MAX`).
- [ ] `.env` fora do controlo de versões (já ignorado; `.dockerignore` não o envia).

---

## 6. Atualizações (redeploy)

```bash
git pull
docker compose build
docker compose up -d
```

As migrações dos módulos são **idempotentes** e correm no arranque; o núcleo **não** é
recriado (os dados persistem). Novas colunas de núcleo são adicionadas por `ALTER … IF NOT
EXISTS` nos migrates dos módulos/serviço — nunca destrutivo.

> Recriação total do núcleo (**apaga dados operacionais**) — só em ambientes descartáveis:
> `docker compose exec backend npm --prefix backend/api-gateway run migrate:reset`

---

## 7. Backups

Não use `pg_dump` à mão: os scripts do projeto escrevem também um **manifesto** (SHA-256 e contagem
de linhas) e sabem **ensaiar o restauro**, validando as cadeias de hash do arquivo fiscal — o que um
dump solto não faz. Ver **Cópias de segurança**, no fim deste guia.

---

## 8. Observabilidade (base)

- Logs: `docker compose logs -f backend` (auditoria de eventos com hash, arranque, provedores).
- Saúde: `GET https://api.exemplo.com/health`.
- O arranque anuncia o modo dos provedores (17TRACK/SMS/email **simulado** vs **real**) e
  o estado do CORS/contas de demonstração.


---

## Cópias de segurança

A base de dados guarda o arquivo fiscal dos seus clientes. Trate as cópias como parte do serviço, não
como uma tarefa de manutenção.

### Primeira configuração

```bash
# 1. Onde ficam as cópias (fora da pasta do projeto)
export BACKUP_DIR=/var/backups/sistematrack

# 2. Como saem da máquina — escolha o seu comando; {file} é substituído
export BACKUP_UPLOAD_CMD='rclone copy {file} remoto:sistematrack-backups'
# ou:  aws s3 cp {file} s3://o-seu-bucket/sistematrack/
# ou:  scp {file} backup@outro-servidor:/backups/

# 3. Quantas guardar
export BACKUP_KEEP_DAILY=7 BACKUP_KEEP_WEEKLY=4 BACKUP_KEEP_MONTHLY=6
```

### Rotina

```bash
cd backend/api-gateway

npm run backup          # copia + manifesto + retenção + envio para fora
npm run backup:plan     # mostra o que a retenção guardaria/apagaria, sem tocar em nada
npm run backup:verify   # ENSAIO: restaura para base descartável e valida as cadeias
```

Agende no anfitrião (a cópia precisa do `pg_dump` e do acesso à base):

```cron
# cópia diária às 02:15
15 2 * * *  cd /opt/sistematrack/backend/api-gateway && npm run backup >> /var/log/sistematrack-backup.log 2>&1
# ensaio de restauro semanal, domingo às 03:30
30 3 * * 0  cd /opt/sistematrack/backend/api-gateway && npm run backup:verify >> /var/log/sistematrack-backup.log 2>&1
```

Com Docker Compose, a base está no volume `db-data`; corra os comandos a partir do anfitrião com as
variáveis `PG*` a apontar para o contentor, ou execute-os dentro do serviço `backend`
(`docker compose exec backend npm run backup`), montando `BACKUP_DIR` num volume que exista fora do
contentor.

### Recuperar

```bash
# 1. Restaure SEMPRE primeiro para uma base nova
npm run restore -- sistematrack-track-20260805T021500Z.dump --into=track_recuperada

# 2. Confirme as cadeias na base recuperada
BACKUP_VERIFY_DB=track_recuperada npm run backup:verify -- sistematrack-track-20260805T021500Z.dump

# 3. Só depois, se for isso que quer, escreva por cima da base em uso
npm run restore -- sistematrack-track-20260805T021500Z.dump --into=track --force
```

**O que verificar antes de considerar o sistema recuperado:** o ensaio deve dizer "Contagens
conferem", "Cadeia fiscal íntegra" e "Cadeia de auditoria íntegra". Se disser que uma cadeia está
partida, guarde o relatório: significa que os documentos foram alterados fora do sistema.
