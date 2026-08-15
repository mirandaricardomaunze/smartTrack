# ADR-002: Monólito modular, num só processo

**Status:** Accepted
**Date:** 2026-08
**Substitui:** [ADR-001](ADR-001-stack.md), que passa a `Superseded`

---

## Contexto

O ADR-001 desenhou uma stack de microserviços: NestJS, React Native, Redis para
geolocalização, Kafka para desacoplamento, AWS/K8s. Não foi isso que se
construiu — e a distância não é um desvio de execução, é uma decisão tomada
muitas vezes ao longo do caminho e nunca registada.

Este ADR regista o que existe e porquê, para deixar de haver dois documentos a
descrever sistemas diferentes. **Um registo de arquitetura que descreve algo que
não existe é pior do que não haver registo:** quem chega de novo confia nele,
provisiona Kafka, procura o serviço de geolocalização em Redis, e perde uma
semana antes de perceber que nada disso está lá.

## Decisão

**Um monólito modular, num só processo Node.js, com PostgreSQL e mais nada.**

| Camada | O que existe | O que o ADR-001 previa |
|---|---|---|
| Backend | Express + JavaScript CommonJS, um processo | NestJS + TypeScript, microserviços |
| Módulos | `backend/*-service` carregados pelo `api-gateway` | Serviços autónomos em rede |
| Apps | Três Next.js (painel, cliente, motorista PWA) | React Native (iOS + Android) |
| Base de dados | PostgreSQL, base única `track` | PostgreSQL + Redis |
| Eventos | Em processo, escritos no log estruturado | Kafka / AWS SQS |
| Implantação | Docker Compose + Caddy, um servidor | AWS / Kubernetes |

## Justificativas

**Um processo, porque a operação é uma só.** Um pedido é criado, recolhido,
despachado, transportado e entregue — e cada passo lê e escreve as mesmas
encomendas. Repartir isso por serviços em rede troca uma transação por uma saga
distribuída, e passa a haver estados intermédios que só existem por causa da
arquitetura. A separação em `*-service` mantém-se como fronteira de **código**;
não é fronteira de processo.

**Sem Redis.** A geolocalização que o ADR-001 lhe destinava é uma linha por
motorista, atualizada de poucos em poucos minutos. Cabe numa tabela. Um segundo
armazém com o seu próprio ciclo de vida, a sua própria perda de dados e o seu
próprio modo de falhar, para guardar quatro linhas, não se paga.

**Sem Kafka.** O desacoplamento que ele traz resolve um problema que este
sistema não tem: não há equipas a publicar umas para as outras nem consumidores
independentes. Os eventos financeiros continuam a ser emitidos com envelope
completo (`correlation_id`, `timestamp`, `schema_version`) e escritos no log —
o que serve auditoria e depuração. Se um dia houver um consumidor externo, é
esse envelope que se liga a um produtor real; até lá, o broker seria um
componente a manter em produção sem nada do outro lado.

**Next.js e não React Native.** A app do motorista é uma PWA: instala-se sem
loja, atualiza-se com um deploy, e funciona offline com IndexedDB (§ 3.29). Para
uma frota que se equipa com telemóveis Android baratos, não passar pela Play
Store é uma vantagem operacional, não uma limitação técnica aceite.

**JavaScript e não TypeScript no backend.** É a decisão mais discutível deste
documento e não foi tomada de propósito — o código começou assim e converter
dezenas de milhares de linhas nunca chegou a ser o trabalho mais valioso. Os
tipos partilhados existem em TS (`backend/shared/types`) e os testes são `.ts`,
o que apanha parte do que o TypeScript apanharia. Fica registado como dívida,
não como virtude.

**Sem bibliotecas para o que se escreve numa página.** O motor de PDF (§ 3.20),
o gerador de Code128 (§ 3.15) e o escritor de `.xlsx` (§ 3.44) são próprios. Um
`.xlsx` é um ZIP com meia dúzia de XML; as bibliotecas do costume trazem dezenas
de megabytes e uma superfície de manutenção grande para produzir uma grelha de
células.

## Consequências

**Positivas**
- Um `npm run dev` levanta tudo; um `docker compose up` publica tudo.
- Transações reais onde a operação as exige, sem sagas nem compensações.
- Uma base de dados para copiar, restaurar e verificar (§ 4).
- Menos peças em produção é menos coisas a falhar às três da manhã.

**Negativas / Riscos**
- **Escala vertical.** Tudo cresce junto: não se escala só o rastreio público.
  O teto realista é uma empresa de logística nacional, não uma plataforma
  continental.
- **Falha conjunta.** Um erro que derrube o processo derruba a API inteira. O
  `/health` verifica a base e devolve 503 quando ela cai (§ 3.31), mas não há
  isolamento entre módulos.
- **A fronteira de código depende de disciplina.** Nada impede tecnicamente um
  módulo de chamar o repositório de outro. As revisões é que o impedem.
- **Backend em JS.** Sem verificação de tipos no maior corpo de código.

## Revisão

Rever se: houver um consumidor externo real dos eventos (aí o Kafka passa a
resolver um problema que existe); se um módulo precisar de escalar
separadamente dos outros de forma medida — medida, não prevista; ou se a equipa
crescer ao ponto de várias pessoas colidirem no mesmo processo.

Nenhuma destas condições se verifica hoje, e nenhuma se resolve antecipando-a.
