# SmartTrack — Frontend

Todo o frontend do SmartTrack usa **Next.js 14** (App Router).
Não há React Native — todos os apps são web, responsivos e/ou PWA.

## Projetos

| Projeto | Público | Porta dev | Observações |
|---------|---------|-----------|-------------|
| `client-app/` | Cliente final | `:3001` | Web responsivo, público |
| `driver-app/` | Motorista | `:3002` | PWA com suporte offline (Service Worker + IndexedDB) |
| `admin-panel/` | Admin e suporte | `:3000` | Área interna, requer login |

## Pré-requisitos

- Node.js >= 20
- npm >= 10

## Desenvolvimento

```bash
# Instalar dependências (na raiz do monorepo)
npm install

# Painel Admin
cd frontend/admin-panel && npm run dev    # http://localhost:3000

# App Cliente
cd frontend/client-app  && npm run dev    # http://localhost:3001

# App Motorista (PWA)
cd frontend/driver-app  && npm run dev    # http://localhost:3002
```

## Variáveis de Ambiente

Cada projeto tem seu próprio `.env.local` (nunca commitado).
Copiar `.env.example` como ponto de partida.

```bash
# Variáveis comuns a todos os apps
NEXT_PUBLIC_API_URL=http://localhost:4000   # API Gateway
NEXT_PUBLIC_API_VERSION=v1
```

## Comunicação com Backend

Todos os frontends comunicam **exclusivamente** via HTTP/WebSocket para o `api-gateway`.
Nunca importar código de `backend/` diretamente no frontend.

- **Base URL:** `http://localhost:4000/v1` (dev) / `https://api.smarttrack.co.mz/v1` (prod)
- **Auth:** Bearer JWT no header `Authorization` (ou `httpOnly cookie` no server-side)
- Schemas OpenAPI disponíveis em `../docs/openapi/`

## Regras para Agentes

- Nunca hardcode a URL do backend — sempre `process.env.NEXT_PUBLIC_API_URL`.
- Tokens JWT: **nunca** em `localStorage`. Usar `httpOnly cookie` para SSR ou memory para CSR.
- GPS/Geolocalização: sempre solicitar permissão via `navigator.geolocation` com fallback gracioso.
- App Motorista (`driver-app`): lógica offline em `src/lib/offline/` — ver `.agents/skills/offline-sync-resolver/SKILL.md`.
- Ver `.agents/skills/rbac-enforcement/SKILL.md` para lógica de roles no frontend.

## Stack Frontend

| Recurso | Pacote |
|---------|--------|
| Framework | Next.js 14 (App Router) |
| Linguagem | TypeScript 5 |
| Estilização | CSS Modules + CSS custom properties |
| Charts (admin) | Recharts |
| Formulários | React Hook Form + Zod |
| Datas | date-fns |
| Offline queue | idb (IndexedDB wrapper) |
| Testes | Vitest + Testing Library |
| E2E | Playwright |
