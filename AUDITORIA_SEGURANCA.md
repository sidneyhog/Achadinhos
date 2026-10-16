# Auditoria de segurança e qualidade — Achadinhos Multivus

Data: 16/10/2026 · Base auditada: zip `Achadinhos-Multivus-main` (commit de origem `df9373f`), importado no commit local `13353c9` ("Baseline"). Todas as correções estão no working tree, **sem commit e sem push**, conforme pedido.

> Este documento é uma conclusão de auditoria técnica, não uma certificação formal de segurança. Nenhum segredo, senha ou dado pessoal real aparece aqui; as credenciais citadas nos testes são descartáveis e foram criadas só para o ambiente isolado.

---

## 1. Resumo executivo

**Status final: APTO COM RESSALVAS** para seguir à homologação. **Ainda não apto para produção**: faltam itens da seção 14.

O sistema é um SaaS multiempresa (API Express + worker de WhatsApp/Telegram + React). O isolamento entre empresas nas consultas SQL está bem feito: todas as rotas de cliente filtram por `company_id` e as consultas são parametrizadas. Os problemas graves estavam em outros pontos:

| # | Risco mais importante encontrado | Severidade | Situação |
|---|---|---|---|
| 1 | **Webhook de pagamento sem autenticação.** Qualquer cliente marcava a própria fatura como paga e ativava até 365 dias de assinatura sem pagar. | P0 | Corrigido e validado |
| 2 | **Uma requisição anônima derrubava a API** (`GET /vitrine/x`). O mesmo acontecia em mais de 30 rotas com handler assíncrono sem tratamento de erro. | P1 | Corrigido e validado |
| 3 | **A conta "Leitura" recebia em texto puro** as credenciais de todas as lojas e o cookie de sessão do Mercado Livre. | P1 | Corrigido e validado |
| 4 | **Envio duplicado de ofertas.** Rodadas do worker se sobrepunham, e o "Buscar agora" rodava em paralelo. Resultado: a mesma oferta saía duas vezes no mesmo grupo, com risco de banimento do número. | P2 | Corrigido. O lock foi validado por teste unitário; o envio real não foi testado (sem WhatsApp) |
| 5 | **`xlsx` 0.18.5 com vulnerabilidades altas** (prototype pollution e ReDoS) processando arquivos enviados pelo cliente. Não existe correção no npm. | P2 | **Pendente**: depende de uma decisão de cadeia de suprimentos |

Antes das correções, a suíte de segurança criada nesta auditoria tinha 2 testes aprovados e 11 reprovados. Depois das correções, os 15 testes (incluindo os de regressão) passaram, assim como os 3 testes unitários. O stack Docker completo (5 containers) subiu nas duas versões, e as telas foram navegadas em um Chromium real sem nenhuma violação da CSP.

---

## 2. Escopo e limitações

**No escopo:** todo o repositório, ou seja, `apps/api` (API, worker, integrações), `apps/web` (React), Dockerfiles, `docker-compose.yml`, `nginx/default.conf`, `instalador/instalar.sh`, `schema.sql`, README e INSTALACAO.

**Limitações (o que não pôde ser verificado de verdade):**

| Limitação | Efeito |
|---|---|
| Sem credenciais de teste de EFI, Mercado Livre, Shopee, Amazon, AliExpress, Awin, Rakuten, Lomadee e Telegram | As integrações foram revisadas por leitura de código. Nenhuma chamada externa foi feita. |
| Sem número de WhatsApp de teste | O envio de ofertas, a extração de participantes e a inclusão em grupos não foram exercitados de ponta a ponta. |
| `semgrep.dev` bloqueado pela rede (HTTP 403) | Os rulesets oficiais (`p/typescript`, `p/secrets` etc.) não rodaram. Usei regras locais escritas para este código (seção 4). |
| Gitleaks, Trivy e Hadolint ausentes | A varredura de segredos foi feita com regex sobre os arquivos versionados. Não houve varredura de CVEs das imagens Docker. |
| Docker Hub com limite (429) e proxy que bloqueia HTTP puro | As imagens-base vieram do espelho `mirror.gcr.io`, retaggeadas. **Só na cópia de teste**, o passo `apt-get` do Dockerfile da API foi removido (a imagem `node:22-bookworm` já traz python3, make e g++, o que foi conferido) e a CA do proxy foi injetada via `--secret`. Os Dockerfiles do repositório não receberam esses ajustes. |
| Histórico Git do projeto original não veio no zip | Não foi possível procurar segredos em commits antigos. |

Nenhum banco real, ambiente de produção ou serviço externo foi tocado. Postgres 16 e Redis 7 rodaram localmente em diretórios descartáveis.

---

## 3. Arquitetura identificada

```
Navegador ──HTTPS──> Nginx da VPS (instalador) ──> container web (Nginx: SPA + proxy)
                                                     ├─ /api/, /vitrine/, /go/ ──> api (Express :4000)
                                                     │                              ├─ Postgres (dados de todas as empresas)
                                                     │                              └─ Redis pub/sub ──> worker (pedidos de grupos/contatos)
                                                     └─ estáticos React
worker (mesma imagem da api): sessões WhatsApp (zapo-js + SQLite em volume), rodada de ofertas a cada 30 s,
                              fila de audiência, lembretes de vencimento, suspensão de teste vencido.
```

- **Stack:** Node 22, TypeScript executado por `tsx` (sem etapa de build), Express 4, pg, ioredis, jsonwebtoken (JWT de 7 dias), bcryptjs, multer, xlsx, nodemailer, zapo-js, axios; React 19, Vite 6, Tailwind 4 e Recharts no frontend.
- **Modelo de dados:** `schema.sql` mais `ALTER`s idempotentes em `db.ts:migrate()`, aplicados na subida da API e do worker. As tabelas principais são companies, users, subscriptions, plans, invoices, payment_events, settings, stores (segredos cifrados com AES-256-GCM), whatsapp_sessions, telegram_bots (token cifrado), groups, offers, posts, contacts, audience_jobs/items, audit_logs, api_keys e coupons.
- **Papéis:** `superadmin` (sem empresa), `owner`, `manager` (opera) e `member` (só leitura, bloqueado no middleware para métodos que não sejam GET).
- **Superfícies públicas:** `/api/plans`, `/api/testimonials`, `/api/auth/register`, `/api/auth/login`, `/api/billing/webhook`, `/vitrine/:tenantId`, `/go/:token` e `/api/v1/offers` (chave de API).
- **Integrações:** EFI (Pix/cartão/boleto, OAuth com certificado PFX), Mercado Livre (scraping e gerador de link com cookie de sessão do cliente), Shopee GraphQL, Amazon PA-API e links colados, AliExpress, Awin, Rakuten, Lomadee/Época, Telegram Bot API, SMTP e WhatsApp (zapo-js).
- **Fluxo crítico de publicação** (`engine/runDeals.ts`): empresa ativa → robô ligado → horário permitido → limites do plano → busca por loja respeitando a cadência por conexão → filtros → deduplicação de 24 h por grupo → envio → registro em `posts` com `click_token` → `/go/:token` conta o clique e redireciona.

---

## 4. Ferramentas e versões

| Ferramenta | Versão | Uso |
|---|---|---|
| Node.js / npm | 22.22.0 / 10.9.4 | Instalação, `tsc`, testes (`node:test` + `tsx`) |
| TypeScript | 5.9 (via lockfile) | `tsc --noEmit` na API e na web |
| Vite | 6.x | Build de produção da web |
| PostgreSQL | 16.15 (local, descartável) | Testes de integração |
| Redis | 7.0.15 (local, descartável) | Testes de integração e lock |
| npm audit | npm 10.9.4 | Dependências |
| Semgrep | 1.181.0, com regras locais (registry bloqueado) | SAST: SQL interpolado, segredos padrão, handlers async, redirect, saídas HTTP, CORS, XFF |
| Docker / Compose | 29.8.2 | Build das imagens e subida do stack completo das duas versões |
| Chromium + playwright-core | 1.50.1 | Navegação real em admin e painel, captura de violações de CSP |
| Servidor SMTP falso (Python, localhost) | — | Validação do nodemailer 10 |

---

## 5. Linha de base (antes de qualquer correção)

| Verificação | Comando | Resultado |
|---|---|---|
| Instalação web | `npm ci` (apps/web) | OK |
| Instalação API | `npm install` (apps/api) | OK, mas **não existe lockfile**: cada build resolve versões diferentes. Avisos de `multer` 1.x descontinuado. |
| Tipagem web | `npx tsc --noEmit` | **Falhou**, 2 erros (`App.tsx:118,121`) |
| Build web | `npm run build` | OK (bundle de 812 kB, aviso de chunk grande) |
| Tipagem API | `npx tsc --noEmit` | **Falhou**, 2 erros (`audience.ts:85`, que revelou um bug real; `session.ts:100`) |
| Lint | — | Não existe configuração de lint no projeto |
| Testes automatizados | — | **Não existe nenhum teste** no projeto |
| npm audit web | `npm audit` | 0 vulnerabilidades |
| npm audit API | `npm audit` | **2 altas**: `nodemailer` ≤10.0.5 (13 advisories) e `xlsx` (2 advisories, sem correção) |
| Semgrep (regras locais) | ver seção 4 | 36 handlers async sem try/catch, 3 segredos com valor padrão, 1 confiança em X-Forwarded-For, 1 CORS `*`, 1 `jwt.verify` sem algoritmos |
| Suíte de segurança criada (`apps/api/test/security.test.ts`) | `node --import tsx --test` | **2/13 aprovados, 11 reprovados** (detalhe na seção 7) |
| Stack Docker original | `docker compose up` (imagens construídas) | Sobe. `GET /vitrine/x` → **502 e reinício do container da API**; webhook sem segredo → **200**; `X-Powered-By: Express` e versão do Nginx expostas; todos os processos rodam como **root** |
| Navegação (Chromium) | `csp.mjs` | Admin carrega, sem erros de console |

---

## 6. Achados

Legenda: **Confirmado** = reproduzido por teste ou execução. **Confirmado (código)** = comprovado por leitura e por tipagem ou teste unitário, mas sem execução real (dependeria de WhatsApp ou de um provedor externo). **Preventivo** = recomendação sem falha demonstrada.

As linhas citadas referem-se ao código original (commit `13353c9`).

### P0 — Crítico

#### SEC-01 · Webhook de cobrança sem autenticação: assinatura grátis (CWE-306, CWE-345 · OWASP API2/API6)
- **Onde:** `apps/api/src/http.ts:1549-1567`.
- **Problema:** `POST /api/billing/webhook` não tinha autenticação. Bastava enviar `{"txid": ...}` de uma fatura pendente para que ela fosse marcada como paga, a assinatura virasse `active` com `current_period_end` de 30 a 365 dias e uma empresa suspensa fosse reativada. O valor pago não era conferido. O `txid` é devolvido ao próprio cliente no checkout (`createPix` retorna `{ txid, qrcode }`).
- **Cenário:** um cliente gera um checkout Pix anual, copia o `txid` da resposta, faz um `curl` no webhook e passa a ter um ano de plano sem pagar.
- **Evidência:** teste `SEC-01 › sem segredo...` na linha de base: `esperado 401/403, veio 200`, e a fatura ficou `paid`. Teste `valor pago diferente...`: `'paid' !== 'pending'`. No stack Docker original, o webhook sem segredo respondeu 200.
- **Impacto:** perda direta de receita e fraude de cobrança em escala.
- **Correção aplicada:**
  - exige `EFI_WEBHOOK_SECRET`, comparado em tempo constante com `?hmac=` (a forma que a EFI documenta para webhook sem mTLS); sem a variável configurada, a rota responde 503;
  - confere o valor pago contra `invoices.amount_cents` e registra `amount_mismatch` quando difere;
  - a baixa é transacional e condicional (`UPDATE ... WHERE status <> 'paid' RETURNING`), então eventos repetidos ou simultâneos não duplicam efeitos;
  - processa todos os itens de `pix[]`;
  - aceita `/api/billing/webhook/pix`, porque a EFI acrescenta `/pix` à URL cadastrada (na versão original isso daria 404; é um defeito provável, não validado contra a EFI real).
  - O instalador gera o segredo, e README e INSTALACAO trazem a URL a cadastrar.
- **Risco de regressão:** instalações existentes precisam definir `EFI_WEBHOOK_SECRET` e recadastrar a URL na EFI. Até isso acontecer, as confirmações automáticas são recusadas, ou seja, o sistema falha fechado. O instalador já cuida disso numa reexecução.
- **Teste:** `SEC-01` (2 casos) e o caso legítimo com segredo, com reenvio idempotente: 3/3 aprovados. No Docker corrigido, o webhook sem segredo responde 401.
- **Pendente (recomendado):** antes de dar baixa, consultar `GET /v2/cob/:txid` na EFI. Isso elimina a dependência exclusiva do segredo, mas exige credenciais de sandbox para validar.

### P1 — Alto

#### SEC-02 · Rejeição assíncrona derruba o processo: DoS sem autenticação (CWE-248, CWE-755 · OWASP API4)
- **Onde:** 36 handlers `async` sem try/catch em `http.ts` (lista do Semgrep: linhas 164-1735), entre eles `/vitrine/:tenantId` (1584), `/api/team/:id` (1652), `/api/notices` (1610) e todas as rotas `/api/admin/*`.
- **Problema:** o Express 4 não captura promessas rejeitadas, e o Node 22 encerra o processo em `unhandledRejection`. Qualquer erro do Postgres (UUID inválido, `NaN` em coluna inteira) ou um `throw` derruba a API inteira.
- **Cenário:** `while true; do curl https://dominio/vitrine/x; done` mantém a API fora do ar. Não é preciso login. Com cadastro aberto, `PATCH /api/team/abc` produz o mesmo efeito.
- **Evidência:** log da linha de base com `error: invalid input syntax for type uuid: "nao-e-uuid"`, seguido do processo encerrado e do `/api/health` sem resposta. No Docker: 502 e `RestartCount=1`. Os 3 testes `SEC-02` reprovaram.
- **Correção:**
  - um wrapper central registrado em `app.get/post/put/patch/delete` encaminha rejeições para o tratador de erro, sem alterar nenhuma rota;
  - `/vitrine` valida o formato do UUID;
  - o tratador converte `22P02`/`22003` em 400 e não devolve mensagens internas em respostas 5xx;
  - erros do axios passam a responder 502. Antes, um 401 da EFI chegava ao painel como 401 e parecia sessão inválida.
- **Risco de regressão:** baixo. Rotas que já tinham try/catch continuam iguais. Mensagens de 5xx sem `status` agora aparecem como "Erro interno" (o detalhe vai para o log).
- **Teste:** `SEC-02` (3 casos) aprovados. No Docker corrigido: vitrine → 404, `RestartCount=0`.

#### SEC-03 · Conta "Leitura" recebe credenciais de lojas e o cookie do ML (CWE-200, CWE-285 · OWASP API3/API5)
- **Onde:** `http.ts:146-158` (`publicStore` devolvia `secrets` decifrados) e `http.ts:677-690` (`mlCookie` em texto puro).
- **Problema:** o mascaramento ("olho para revelar") acontecia só no frontend. Qualquer usuário da empresa, inclusive o papel `member`, recebia Secret da Shopee, Secret Key da Amazon, App Secret da AliExpress, token da Awin, chave da Lomadee e o cookie de sessão logada do Mercado Livre.
- **Evidência:** teste `SEC-03` na linha de base: `segredo da loja vazou para conta de leitura`.
- **Correção:** `member` recebe `secrets: {}` e `mlCookie: ""`, mas `hasSecrets`, `secretKeys` e `mlCookieSet` continuam presentes, então a tela continua sabendo que a credencial existe. Dono e gerente não mudam, porque editam as credenciais.
- **Risco de regressão:** nenhum para owner/manager. O member não pode salvar (o middleware bloqueia).
- **Teste:** `SEC-03` aprovado, e o teste de regressão confirma que o dono ainda vê o segredo.

#### SEC-08 · Segredo do JWT com valor fixo no código (CWE-798, CWE-1188)
- **Onde:** `http.ts:29` (`JWT_SECRET || "achadinhos-dev-jwt"`).
- **Problema:** se `JWT_SECRET` estiver vazio no `.env`, qualquer pessoa forja um token de `superadmin` com o valor público do código. O instalador gera o segredo, mas o `.env` manual do guia depende do operador. Além disso, `jwt.verify` não fixava algoritmo.
- **Correção:** sem `JWT_SECRET` a API não sobe (o teste deu `exit=1` com mensagem clara), e assinatura e verificação ficam fixas em HS256. Sem `APP_SECRET`, a API e o worker também recusam subir; instalações antigas que já cifraram dados com a chave padrão podem usar `ALLOW_DEFAULT_APP_SECRET=true` até migrar. Sem `ADMIN_PASSWORD` (mínimo de 8 caracteres), o super admin não é criado, em vez de nascer com a senha pública `admin123456`. A criação do admin usa `ON CONFLICT`, porque API e worker rodam a migração ao mesmo tempo. Testado: recusa sem `APP_SECRET`; banco novo sem `ADMIN_PASSWORD` fica com 0 super admins.
- **Severidade:** P1 condicionado à configuração errada.

### P2 — Médio

#### SEC-04 · Cadastro não atômico: empresas órfãs criadas por anônimos (CWE-362, CWE-662)
- **Onde:** `http.ts:176-214`.
- **Problema:** o fluxo inseria empresa → usuário → assinatura → settings sem transação. Com um e-mail repetido, a empresa ficava gravada sem dono nem assinatura. Um anônimo podia criar empresas órfãs sem limite. O e-mail também não tinha validação de formato nem de tamanho.
- **Evidência:** teste `SEC-04` na linha de base: `empresa órfã criada (8 !== 7)`; `"nao-e-email"` foi aceito com 201.
- **Correção:** `withTransaction()` em `db.ts`; validação de e-mail (≤254 caracteres) e de tamanho dos campos no cadastro, na equipe, no perfil do admin e na criação de empresa pelo admin.
- **Teste:** os 2 casos aprovados.

#### SEC-05 · Sem limite de tentativas de login e cadastro (CWE-307 · OWASP API4)
- **Evidência:** 15 senhas erradas seguidas responderam todas 401.
- **Correção:** janela deslizante em memória: 10 falhas por IP+conta e 50 por IP a cada 15 min no login; 30 cadastros por IP por hora; o contador zera no login bem-sucedido. O IP vem de `X-Real-IP`, gravado pelo Nginx do container depois de resolver `X-Forwarded-For` só a partir de proxies internos (SEC-13).
- **Limitação:** o limite vale por processo e é perdido no restart (a API roda em um só processo). Atrás de um proxy que não seja o do Compose, é preciso garantir que esse proxy sobrescreva `X-Real-IP`.
- **Teste:** `SEC-05` aprovado (429 dentro de 15 tentativas).

#### SEC-06 · Envio duplicado por rodadas sobrepostas (CWE-362, CWE-799) — Confirmado (código)
- **Onde:** `worker.ts:347-360` (`setInterval(tick, 30_000)` sem trava), `runDeals.ts:198+` e `http.ts:884` ("Buscar agora" chama `runDueDeals` na API).
- **Problema:** uma rodada faz `await delay(5-180 s)` entre envios para até 40 grupos e passa fácil de 30 s, então a rodada seguinte começa em paralelo. As duas leem o mesmo "último envio" e a mesma deduplicação de 24 h antes de a outra gravar em `posts`, e a mesma oferta sai duas vezes no grupo. A fila de audiência tem o mesmo problema (o mesmo contato é incluído ou convidado duas vezes).
- **Correção:** trava de reentrada no `tick` do worker e lock distribuído no Redis (`locks.ts`: `SET NX EX`, renovação automática, liberação por token) por empresa em `runDueDeals` e para `tickAudience`. Sem Redis, o lock vale dentro do processo.
- **Teste:** teste unitário do lock (a segunda rodada é pulada e a chave é liberada ao final). O worker subiu no Docker sem erros. O envio real não foi testado (sem WhatsApp).

#### SEC-12 · Ritmo configurado na fila de audiência era ignorado (defeito funcional) — Confirmado (código e `tsc`)
- **Onde:** `engine/audience.ts:85`, `clampJobPace(job)`.
- **Problema:** a linha do banco vem em snake_case (`interval_seconds`, `per_hour`...), mas a função espera camelCase. Sempre valiam os padrões (300 s, 12/h, 80/dia, lote 1). Quem configurou um ritmo mais lento para proteger o número recebia 80 inclusões por dia.
- **Correção:** `jobPaceOf()` faz o mapeamento, e os tetos da política continuam aplicados.
- **Teste:** 2 testes unitários.

#### SEC-09 · `xlsx` 0.18.5 vulnerável (GHSA-4r6h-8v6p-xvw6 prototype pollution, GHSA-5pgg-2g8v-p4x9 ReDoS) — Confirmado (audit) · **Pendente**
- **Onde:** `http.ts:1219` faz `XLSX.read()` de arquivo enviado por owner ou manager, e qualquer pessoa pode virar owner pelo cadastro aberto.
- **Por que não foi corrigido:** a versão corrigida (≥0.20.2) só existe na CDN da SheetJS, fora do registry npm. Trocar a origem do pacote, ou trocar de biblioteca, é uma decisão de cadeia de suprimentos.
- **Mitigação atual:** limite de 8 MB no upload e acesso só autenticado.
- **Ação:** PLANO, item A-01.

#### SEC-10 · `nodemailer` 7.0.x vulnerável (13 advisories, entre eles DoS quadrático no addressparser) — Corrigido
- **Exposição real:** o worker envia lembretes para `users.email` do dono, valor controlado pelo cliente e sem validação. Um e-mail enorme e malformado podia travar o worker e parar a publicação de todos os clientes.
- **Correção:** atualizado para `nodemailer@10.0.13`, com versão fixada. A 10.1.1 tinha 2 dias de publicação e foi evitada por cautela de cadeia de suprimentos. O e-mail passou a ser validado (SEC-04).
- **Teste:** envio real para um servidor SMTP falso local (`MAIL FROM`, `RCPT TO` e `Subject` corretos) e `npm audit` sem o advisory.

#### SEC-11 · `multer` 1.4.5-lts.2 com CVEs de DoS (CVE-2025-47935, CVE-2025-47944, CVE-2025-48997) — Corrigido
- **Correção:** `multer@2.4.0`, com a mesma API `single()`.
- **Teste:** importação de contatos por arquivo continua criando 2 contatos, e um multipart com nome de campo vazio não derruba a API.

#### SEC-14 · "Buscar agora" nunca publica no WhatsApp (defeito funcional) — Confirmado (código) · **Pendente**
- **Problema:** as sessões vivem só no `Map` do worker (`zapo/session.ts`). Na API, `getLive()` sempre retorna `null`, então `POST /api/deals/run` só publica no Telegram e grava "Ative um grupo na conexão...". A correção pede que a API passe a pedir a rodada ao worker via Redis, o que é uma mudança de arquitetura e de comportamento (PLANO, item A-05).

#### SEC-22 · Builds não reprodutíveis — Corrigido
- **Problema:** a API não tinha `package-lock.json` e os dois Dockerfiles usavam `npm install`. Cada deploy podia instalar versões diferentes das testadas. `apps/api` também não tinha `.dockerignore`, então um `node_modules` local entraria na imagem.
- **Correção:** lockfile da API gerado e versionável, `npm ci` nos dois Dockerfiles e `.dockerignore` em `apps/api`.
- **Teste:** as duas imagens construídas com `npm ci` e o stack funcionando.

#### SEC-24 · Conformidade (LGPD e termos do WhatsApp) — Preventivo · **Decisão humana**
- O sistema extrai telefones de participantes de grupos de terceiros (`/api/contacts/extract`) e inclui essas pessoas em grupos, ou manda convites em massa (`audience`), sem registro de consentimento ou de base legal. Isso traz risco jurídico e de banimento de números. Não é um defeito de código; precisa de avaliação jurídica e de produto.

#### SEC-30 · Sem backup automatizado — Preventivo
- O INSTALACAO documenta um `pg_dump` manual, mas não existe rotina nem teste de restauração. O volume `zapodata` (sessões) também não tem backup.

#### SEC-34 · Instalador apagava arquivos da pasta home e outros projetos (CWE-1188, perda de dados) — Confirmado (código e simulação) · Corrigido
- **Onde:** `instalador/instalar.sh`, pasta padrão `/home/<usuário>` + `rsync -a --delete`.
- **Problema:** a cópia apaga da pasta de destino tudo o que não veio do projeto. Instalando no padrão (`/home/deploy`), sumiam `.ssh/authorized_keys` (perda do acesso SSH desse usuário), `.bashrc` e qualquer outro projeto guardado ali, como Chatwoot ou outros sistemas em Docker numa VPS compartilhada.
- **Correção:**
  - nova pasta padrão: `/home/<usuário>/achadinhos`;
  - recusa pastas de sistema (`/`, `/home`, `/root`, `/opt`...);
  - recusa uma pasta com arquivos que não seja uma instalação anterior do Achadinhos (identificada pelo `.instalador.env`);
  - instalações antigas que estão na home continuam sendo atualizadas, mas sem `--delete`;
  - a pasta `certificados` deixou de ser apagada na reinstalação.
- **Teste:** `bash -n` e uma simulação da validação com pastas falsas. `/`, `/home` e uma home com `.ssh` e outro projeto foram recusadas; uma pasta nova e uma instalação antiga foram aceitas. O instalador não foi executado de verdade (exige uma VPS).

#### SEC-35 · Certificado da EFI inacessível dentro do container (defeito funcional) — Confirmado (código) · Corrigido
- **Problema:** o guia mandava pôr o `.pfx` numa pasta da VPS e apontar `EFI_CERT_PATH` para ela, mas o `docker-compose.yml` não montava essa pasta no container da API. Com isso, `certReady` era sempre falso e as chamadas à EFI em produção não usavam o certificado exigido.
- **Correção:** `./certificados:/certificados:ro` montado no serviço `api`; `EFI_CERT_PATH=/certificados/efi.pfx` documentado; `certificados/` e `*.pfx` incluídos no `.gitignore`.
- **Teste:** `docker compose config` mostra a montagem. A chamada real à EFI não foi testada (sem certificado).

### P3 — Baixo

| ID | Achado | Situação |
|---|---|---|
| SEC-13 | IP de auditoria lido do 1º item de `X-Forwarded-For`, que o cliente controla (CWE-348) | Corrigido (`real_ip` no Nginx do container + `X-Real-IP`) |
| SEC-15 | CSV de contatos sem neutralizar fórmulas (CWE-1236) e vCard com quebra de linha injetável; nomes vêm de participantes de grupo | Corrigido, teste `SEC-15` aprovado |
| SEC-16 | Sem cabeçalhos de segurança, `X-Powered-By: Express`, versão do Nginx exposta | Corrigido: CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, `server_tokens off`. Admin e painel navegados no Chromium sem violação de CSP |
| SEC-17 | Cupom: corrida em `max_uses` e fatura criada antes de validar o método de pagamento | Corrigido (reserva atômica e validação prévia) |
| SEC-18 | `POST /api/groups` aceitava `whatsappId` de outra empresa. Não havia envio cruzado (o `runDeals` filtra por empresa), mas era um dado inconsistente | Corrigido |
| SEC-19 | Auditoria "publish" registrava o total acumulado de todas as empresas da rodada | Corrigido (contagem por empresa) |
| SEC-20 | Erros de tipo: 2 na web e 2 na API; não havia scripts `typecheck`/`test` | Corrigido |
| SEC-21 | JWT de 7 dias no localStorage, sem revogação; logout e troca de senha não invalidam tokens; impersonação gera token de dono de 7 dias sem marca | Pendente (A-07) |
| SEC-23 | CORS `*` (risco baixo, porque a autenticação usa Bearer e não cookie) | Pendente (A-09) |
| SEC-25 | O worker baixa `imageUrl` vinda de APIs de terceiros sem restringir o destino (SSRF limitado, só GET) | Pendente (A-10) |
| SEC-26 | Senha mínima de 6 caracteres; sem MFA para o super admin; senha padrão do admin documentada | Pendente (A-08) |
| SEC-27 | Containers rodam como root; a API não tem healthcheck; a imagem da API tem 1,65 GB (o `apt-get` é redundante na imagem completa) | Pendente (A-11): trocar o usuário exige migrar a permissão dos volumes existentes |
| SEC-28 | Renovação paga redefine `current_period_end = now()+dias`, e quem paga antes perde os dias restantes | Pendente, é regra de negócio (A-12) |
| SEC-29 | Código morto: `deals/extraStores.ts` e `deals/searchShopeePortal.ts` não são importados | Pendente (limpeza) |
| SEC-31 | `askWorker` abre uma conexão Redis por requisição | Pendente |
| SEC-32 | Criação de empresa pelo admin não é transacional | Pendente (a corrida é improvável) |
| SEC-33 | `payment_events.payload` e `audit_logs` sem política de retenção; contatos sem prazo de expurgo | Pendente (LGPD) |

---

## 7. Evidências resumidas

| Teste (`apps/api/test/security.test.ts`) | Linha de base | Após correção |
|---|---|---|
| Cadastro, login, /api/me, lojas do dono | ✔ | ✔ |
| Vitrine com UUID válido → 404 | ✔ | ✔ |
| Webhook legítimo com segredo + reenvio idempotente + rota `/pix` | ✖ (404 em `/pix`) | ✔ |
| SEC-01 webhook sem segredo | ✖ (`veio 200`) | ✔ |
| SEC-01 valor divergente | ✖ (`paid`) | ✔ |
| SEC-02 `/vitrine/nao-e-uuid` | ✖ (API caiu) | ✔ |
| SEC-02 `PATCH /api/team/abc` | ✖ (API caiu) | ✔ |
| SEC-02 super admin em `/api/notices` | ✖ (API caiu) | ✔ |
| SEC-03 member não lê credenciais | ✖ (vazou) | ✔ |
| SEC-04 e-mail repetido não gera órfã | ✖ (8 ≠ 7) | ✔ |
| SEC-04 e-mail inválido recusado | ✖ (201) | ✔ |
| SEC-05 força bruta → 429 | ✖ (15× 401) | ✔ |
| SEC-15 CSV sem fórmula | ✖ | ✔ |
| Importação de contatos (multer 2) | — (criado após o upgrade) | ✔ |
| Multipart malformado não derruba a API | — (criado após o upgrade) | ✔ |
| **Total** | **2/13** | **15/15** |

Testes unitários (`test/units.test.ts`): 3/3. O stack Docker foi comparado nas duas versões; as saídas completas ficaram fora do repositório, nos logs do ambiente de teste.

---

## 8. Correções realizadas (registro de mudanças)

| Arquivo | Mudança | Achado |
|---|---|---|
| `apps/api/src/http.ts` | Webhook autenticado, com conferência de valor, idempotente e rota `/pix`; wrapper de rejeições async; tratador de erro sem vazamento; JWT sem fallback e HS256; `ipOf` via `X-Real-IP`; limitador de login e cadastro; cadastro transacional; validação de e-mail; mascaramento para member; validação de `whatsappId`; CSV/vCard seguros; checkout e cupom atômicos; UUID na vitrine; `x-powered-by` desligado | SEC-01..05, 08, 13, 15, 17, 18 |
| `apps/api/src/db.ts` | `withTransaction()` | SEC-04, SEC-01 |
| `apps/api/src/locks.ts` (novo) | Lock distribuído com renovação | SEC-06 |
| `apps/api/src/engine/runDeals.ts` | Lock por empresa; auditoria por empresa | SEC-06, SEC-19 |
| `apps/api/src/engine/audience.ts` | `jobPaceOf()` | SEC-12 |
| `apps/api/src/worker.ts` | Trava de reentrada do tick; lock da audiência | SEC-06 |
| `apps/api/src/index.ts` | Não sobe sem `JWT_SECRET`; avisos para `APP_SECRET`/`ADMIN_PASSWORD` | SEC-08 |
| `apps/api/src/zapo/session.ts` | Cast de tipo | SEC-20 |
| `apps/api/package.json` + `package-lock.json` (novo) | nodemailer 10.0.13 e multer 2.4.0 (fixados); scripts `typecheck`, `test`, `test:unit` | SEC-10, 11, 20, 22 |
| `apps/api/test/*.test.ts` (novos) | 15 testes de integração e 3 unitários | — |
| `apps/api/Dockerfile`, `Dockerfile.web`, `apps/api/.dockerignore` (novo) | `npm ci` com lockfile | SEC-22 |
| `nginx/default.conf` | Cabeçalhos de segurança, CSP, `real_ip`, `server_tokens off` | SEC-13, 16 |
| `instalador/instalar.sh` | Gera `EFI_WEBHOOK_SECRET` (também em instalação existente) e imprime a URL do webhook | SEC-01 |
| `apps/web/src/Admin.tsx`, `Panel.tsx`, `apps/web/package.json` | Tipos de `onRefresh`; script `typecheck` | SEC-20 |
| `README.md`, `INSTALACAO.md` | `EFI_WEBHOOK_SECRET`, URL do webhook, `JWT_SECRET` obrigatório | SEC-01, 08 |

Nenhuma rota, contrato de resposta ou regra de negócio foi alterada além do que está acima. Únicas mudanças de comportamento visíveis:

- o webhook exige segredo;
- member deixa de receber os valores das credenciais;
- erros 5xx mostram mensagem genérica;
- login e cadastro passam a responder 429 quando o limite estoura;
- a API recusa subir sem `JWT_SECRET`.

---

## 9. Resultados após as correções

| Verificação | Resultado |
|---|---|
| `npm run typecheck` (API) | ✔ 0 erros (eram 2) |
| `npm run typecheck` (web) | ✔ 0 erros (eram 2) |
| `npm run build` (web) | ✔ |
| `npm run test:unit` | ✔ 3/3 |
| Suíte de integração | ✔ 15/15 |
| `npm audit` web | ✔ 0 |
| `npm audit` API | 1 alta restante: `xlsx` (pendente A-01). `nodemailer` resolvido |
| Semgrep local | Restam só achados aceitos: `ADMIN_PASSWORD`/`APP_SECRET` com padrão (A-04), 3 SQL interpolados com nomes de coluna fixos no código (falsos positivos, revisados), CORS (A-09), saídas HTTP para hosts fixos ou de APIs de terceiros (A-10). Os 35 handlers async continuam sinalizados pela regra, mas agora estão protegidos pelo wrapper central (comprovado por SEC-02) |
| Varredura de segredos (regex) | ✔ nada encontrado nos arquivos versionados; nenhum `.env`, `.pfx`, `.pem` ou `.sqlite` no repositório |
| Docker: build das duas imagens com `npm ci` | ✔ |
| Docker: stack completo | ✔ 5 serviços de pé; health 200; login admin OK; webhook sem segredo 401; vitrine inválida 404 sem reinício; worker sem erros; só a porta web publicada, em 127.0.0.1 |
| Chromium: landing, login, telas do admin e 7 telas do painel do cliente | ✔ sem violações de CSP nem erros de console |
| SMTP (nodemailer 10) | ✔ entregue ao servidor falso |
| API sem `JWT_SECRET` | ✔ recusa subir (`exit=1`) |

---

## 10. Testes não executados e por quê

| Teste | Motivo |
|---|---|
| Pagamento real Pix/cartão/boleto no sandbox da EFI, incluindo o formato real do webhook e o sufixo `/pix` | Sem credenciais nem certificado de sandbox |
| Envio de ofertas no WhatsApp, extração de participantes, inclusão em grupos | Sem número de teste. O worker subiu, mas nenhuma sessão foi pareada |
| Envio no Telegram | Sem bot de teste |
| Buscas nas lojas (ML, Shopee, Amazon, AliExpress, Awin, Rakuten, Lomadee) | Sem credenciais. Não foram feitas chamadas a serviços externos |
| Semgrep com rulesets oficiais, Gitleaks, Trivy, Hadolint | Registry bloqueado ou ferramentas ausentes |
| Instalador na VPS Ubuntu (certbot, Nginx do host) | Exige VPS e domínio reais; só a sintaxe foi verificada (`bash -n`) |
| Teste de carga | Fora do escopo seguro deste ambiente |
| Lint | O projeto não tem configuração de lint, e nenhuma foi criada para não impor estilo |

---

## 11. Riscos residuais

1. **`xlsx` vulnerável** processando uploads (SEC-09).
2. **Webhook depende só do segredo compartilhado.** Falta a confirmação via API da EFI. Quem tiver acesso ao `.env` ou ao painel da EFI consegue forjar o evento.
3. **Conformidade LGPD e WhatsApp** do módulo de audiência (SEC-24).
4. **Sessão JWT** sem revogação e guardada no localStorage (SEC-21).
5. **"Buscar agora"** não publica no WhatsApp (SEC-14).
6. **Containers como root**, sem backup automatizado e sem monitoramento.
7. **Limitador em memória**: perdido no restart, e não serve para mais de uma instância da API.
8. **`APP_SECRET` padrão**: uma instalação que já rode sem essa variável cifra credenciais com uma chave pública.

---

## 12. Melhorias recomendadas

**Curto prazo (antes da produção):** os itens A-01 a A-06 do PLANO: trocar o `xlsx`, confirmar o pagamento na EFI, homologar o fluxo de cobrança no sandbox, remover `APP_SECRET`/`ADMIN_PASSWORD` padrão com migração, corrigir o "Buscar agora" e criar o backup diário com teste de restauração.

**Médio prazo:**
- revogação de sessão (`token_version` no usuário) e cookie HttpOnly;
- MFA para o super admin e política de senha;
- usuário não-root nos containers e healthcheck da API;
- CORS restrito;
- allowlist de hosts para download de imagens;
- logs estruturados (pino já é dependência) e alertas;
- testes de integração dos fluxos de publicação com WhatsApp e Telegram simulados;
- CI rodando `typecheck`, testes e `npm audit`.

**Longo prazo:**
- separar o tratador de cada domínio de `http.ts`, que tem 1.750 linhas, em routers. Fazer isso de forma incremental e com testes, porque o risco de regressão de uma refatoração grande sem testes é alto;
- migrações versionadas no lugar de `ALTER`s na subida;
- política de retenção e expurgo de dados;
- revisão jurídica do módulo de audiência;
- imagem slim/distroless com build TypeScript.

---

## 13. Plano de ação priorizado

Está detalhado, com responsáveis sugeridos e critérios de aceite, em [PLANO_CORRECOES.md](PLANO_CORRECOES.md).

---

## 14. Critérios objetivos

**Apto para homologação (estado atual, com as correções aplicadas):**
- [x] Nenhum P0 ou P1 aberto conhecido
- [x] `typecheck` e build sem erros; suíte de segurança 15/15; unitários 3/3
- [x] Stack Docker sobe com `npm ci` e responde
- [ ] `EFI_WEBHOOK_SECRET` definido no ambiente de homologação, com o webhook recadastrado
- [ ] Correções revisadas por um humano e commitadas

**Apto para produção:**
- [ ] A-01: `xlsx` substituído ou atualizado (sem alta no `npm audit --omit=dev`)
- [ ] A-02/A-03: pagamento confirmado na API da EFI, com o fluxo Pix homologado no sandbox (pago, valor divergente, reenvio)
- [ ] A-04: `APP_SECRET` e `ADMIN_PASSWORD` obrigatórios, com a senha padrão do admin removida
- [ ] A-06: backup diário do Postgres e do `zapodata` com restauração testada
- [ ] Publicação real em WhatsApp e Telegram homologada, incluindo a ausência de duplicidade com duas rodadas simultâneas
- [ ] Parecer jurídico sobre o módulo de audiência (SEC-24)
- [ ] CI executando `typecheck`, testes e `npm audit` a cada mudança
