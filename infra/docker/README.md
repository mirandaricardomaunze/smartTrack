# Deploy em produção (VPS + Docker)

Publica o **app do cliente** + **backend** + **PostgreSQL** atrás do **Caddy** (HTTPS
automático). Um único servidor, tudo em containers.

## Componentes
| Serviço | Imagem | Papel |
|---|---|---|
| `caddy` | `caddy:2-alpine` | Reverse proxy + HTTPS (Let's Encrypt), portas 80/443 |
| `client` | `Dockerfile.client` | App do cliente (Next.js standalone) |
| `backend` | `Dockerfile.backend` | Monólito modular (API `/v1`) |
| `postgres` | `postgres:15-alpine` | Base de dados (volume persistente) |

## Pré-requisitos
- Um VPS com Docker + Docker Compose e as portas **80/443** abertas.
- Dois registos DNS a apontar para o IP do servidor:
  - `cliente.seu-dominio.mz` → site do cliente
  - `api.seu-dominio.mz` → API

## Passos
1. **Configurar o ambiente** (segredos ficam fora do git):
   ```bash
   cp infra/docker/.env.prod.example infra/docker/.env.prod
   # editar infra/docker/.env.prod:
   #   SITE_DOMAIN, API_DOMAIN, NEXT_PUBLIC_API_URL
   #   PGUSER, PGPASSWORD (openssl rand -base64 24)
   #   JWT_SECRET (openssl rand -hex 32)
   #   CORS_ORIGIN=https://cliente.seu-dominio.mz
   #   TRACK17_API_KEY (opcional — sem ela, rastreio intl usa simulador)
   ```

2. **Construir e subir** (a partir da raiz do repositório):
   ```bash
   docker compose --env-file infra/docker/.env.prod \
     -f infra/docker/docker-compose.prod.yml up -d --build
   ```

3. **Criar o schema** (só no primeiro arranque, base vazia):
   ```bash
   docker compose --env-file infra/docker/.env.prod \
     -f infra/docker/docker-compose.prod.yml \
     run --rm backend npm run migrate -- --reset-core
   ```
   Nas migrações seguintes usa `npm run migrate` **sem** `--reset-core`
   (idempotente; `--reset-core` recria as tabelas do núcleo e **apaga** dados).

4. **Verificar**:
   ```bash
   curl https://api.seu-dominio.mz/health          # {"status":"ok",...}
   # abrir https://cliente.seu-dominio.mz no browser e rastrear um código
   docker compose -f infra/docker/docker-compose.prod.yml logs -f backend
   # o log deve indicar: "(produção)", "contas de demonstração DESLIGADAS", "CORS restrito"
   ```

## Notas de segurança (já aplicadas no código)
- `NODE_ENV=production` **exige** `JWT_SECRET` (arranque falha sem ele).
- Contas de demonstração (admin123/…) **desligadas** em produção.
- CORS restrito a `CORS_ORIGIN`; rate limit em `/v1/auth` e global.
- O `NEXT_PUBLIC_API_URL` é embutido no **build** do cliente — rebuild se mudar o domínio.

## Atualizar (novo deploy)
```bash
git pull
docker compose --env-file infra/docker/.env.prod \
  -f infra/docker/docker-compose.prod.yml up -d --build
```

## Alternativas
- **Vercel (cliente) + Render/Railway (backend+Postgres):** mais simples, sem gerir servidor.
  Aponta `NEXT_PUBLIC_API_URL` para a API pública e define as mesmas variáveis de ambiente.
