# Infraestrutura local de desenvolvimento

**Isto não publica a aplicação.** Levanta serviços de apoio em containers para se
desenvolver contra eles. Para pôr o sistema em produção, a pilha é a
`docker-compose.yml` da **raiz** com os ficheiros de `deploy/`, documentada em
[`docs/deploy/PRODUCTION.md`](../../docs/deploy/PRODUCTION.md) — essa publica API,
painel administrativo, portal do cliente e app do motorista, e trata das
migrações no primeiro arranque.

> **Existiu aqui uma segunda pilha de produção** (`docker-compose.prod.yml` e os
> respetivos Dockerfiles). Foi removida. Publicava só a API e o portal do
> cliente — ficava sem painel e sem app do motorista, ou seja, ninguém conseguia
> criar um pedido nem entregar uma encomenda — e mandava correr `--reset-core` no
> primeiro arranque, que **apaga** as tabelas do núcleo, enquanto a pilha
> principal já deteta a base vazia sozinha e não destrói nada. Duas pilhas de
> produção divergem sempre; esta já tinha divergido.

## O que sobe

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

| Serviço | Porta | Usado pelo código? |
|---|---|---|
| `postgres` | 5432 | **Sim** — é a base de todo o sistema |
| `adminer` | 8091 | Só por pessoas, para espreitar a base |
| `redis` | 6379 | **Não** — nenhum módulo se liga |
| `zookeeper` + `kafka` | 2181 / 9092 · 9093 | **Não** — nenhum módulo se liga |
| `kafka-ui` | 8090 | **Não** — só serve o Kafka acima |

A base deste compose chama-se `sistematrack`; o resto do projeto usa `track`
(`PGDATABASE`). Quem o usar tem de acertar o `.env`, ou fica a olhar para uma
base vazia sem perceber porquê.

O `postgres` monta `./init-scripts`, pasta que **não existe** — o Docker cria-a
vazia e não corre nada. Quem esperar que a base venha pronta fica à espera.

O Redis e o Kafka são de um desenho de microserviços que o projeto não seguiu: o
backend é um monólito modular num só processo, com eventos em memória (§ 2 da
spec). Ficam aqui declarados como não usados em vez de darem a impressão de
fazerem parte do sistema. Se ninguém lhes der uso, o passo seguinte é retirá-los
— gastam memória e sugerem uma arquitetura que não existe.

## Para desenvolver sem Docker

É o caminho normal e não precisa de nada disto: basta um PostgreSQL acessível e
as variáveis em `.env` (ver `.env.example` na raiz). Depois:

```bash
npm run migrate:backend   # cria/atualiza o schema
npm run dev               # API em :4000, painel :3010, cliente :3011, motorista :3012
```