# Plano de correções pendentes — Achadinhos Multivus

Complementa o [AUDITORIA_SEGURANCA.md](AUDITORIA_SEGURANCA.md). As correções já feitas (SEC-01 a SEC-06, 08, 10 a 13, 15 a 20 e 22) estão no working tree e **aguardam revisão humana e commit**.

Responsáveis sugeridos: **Back** (backend), **Ops** (infra/DevOps), **Prod** (produto/negócio), **Jur** (jurídico/DPO).

## Antes de qualquer deploy das correções

| # | Ação | Resp. | Critério de aceite |
|---|---|---|---|
| D-1 | Revisar o diff (`git diff 13353c9`) e commitar | Back | PR aprovado por um revisor |
| D-2 | Definir `EFI_WEBHOOK_SECRET` no `.env` de cada ambiente (o instalador faz isso ao ser reexecutado) e recadastrar na EFI a URL `https://DOMINIO/api/billing/webhook?hmac=SEGREDO&ignorar=` | Ops | Um Pix de teste no sandbox muda a fatura para `paid`; um POST sem `hmac` responde 401 |
| D-3 | Conferir se `JWT_SECRET` está preenchido em todos os `.env` (a API não sobe sem ele) | Ops | `docker compose logs api` mostra `Achadinhos API em :4000` |
| D-4 | Rodar `npm ci && npm run typecheck && npm test` em `apps/api`, com `DATABASE_URL` apontando para um banco **descartável** e `ALLOW_TEST_DB=yes` | Back | 15/15 + 3/3 |

## Curto prazo (bloqueia produção)

| # | Achado | Ação | Resp. | Critério de aceite |
|---|---|---|---|---|
| A-01 | SEC-09 `xlsx` vulnerável | Escolher entre (a) `xlsx` ≥0.20.3 pela CDN oficial da SheetJS, com tarball versionado e hash conferido, ou (b) trocar por `exceljs`/parser CSV só para leitura. Manter o limite de 8 MB | Back | `npm audit --omit=dev` sem alta; testes de importação (TXT/CSV/XLSX) passando |
| A-02 | SEC-01 residual | No webhook, antes da baixa, consultar `GET /v2/cob/{txid}` na EFI e exigir `status=CONCLUIDA` e valor igual ao da fatura | Back | Teste com a EFI simulada: evento forjado com segredo válido, mas cobrança não concluída, não ativa a assinatura |
| A-03 | Cobrança | Homologar Pix, cartão e boleto no sandbox, cobrindo pago, valor divergente, evento repetido, expiração e o sufixo `/pix` | Back + Prod | Roteiro executado e registrado |
| A-04 | SEC-08 residual | **Feito em parte:** `APP_SECRET` e `ADMIN_PASSWORD` já são obrigatórios. Falta o script de recifragem para instalações que rodaram sem `APP_SECRET` (hoje elas sobem só com `ALLOW_DEFAULT_APP_SECRET=true`): recifrar `stores.secrets_enc`, `telegram_bots.token_enc`, `settings.ml_cookie_enc` e `platform_settings.*_enc` com a nova chave | Back + Ops | O script roda numa cópia do banco e as credenciais continuam abrindo; depois, remover `ALLOW_DEFAULT_APP_SECRET` |
| A-05 | SEC-14 "Buscar agora" | Fazer a API publicar uma mensagem `achadinhos:deals:run` no Redis e o worker executar `runDueDeals(companyId)` (o lock por empresa já existe) | Back | Clicar em "Buscar agora" com o WhatsApp conectado publica no grupo; dois cliques seguidos não duplicam |
| A-06 | SEC-30 Backup | Rotina diária de `pg_dump` mais cópia do volume `zapodata` para fora da VPS, com retenção de 7/30 dias | Ops | Restauração testada num servidor limpo, com a contagem de empresas, posts e faturas conferida |

## Médio prazo

| # | Achado | Ação | Resp. | Critério de aceite |
|---|---|---|---|---|
| A-07 | SEC-21 Sessão | Coluna `token_version` em `users`, incrementada em logout global, troca de senha e remoção; JWT com `tv`; impersonação com claim `imp` e validade curta (1 h); considerar cookie HttpOnly + SameSite | Back | Depois da troca de senha, o token antigo responde 401 |
| A-08 | SEC-26 Senhas | Mínimo de 10 caracteres, bloqueio de senhas comuns e MFA TOTP para `superadmin`; remover a senha padrão do README | Back + Prod | Teste: senha curta recusada; super admin sem segundo fator não entra |
| A-09 | SEC-23 CORS | `cors({ origin: false })` para `/api/*` (o painel é same-origin) e liberar só `/api/v1/*` se houver consumidor em navegador | Back | Painel funciona; uma origem externa não lê `/api/me` |
| A-10 | SEC-25 SSRF | Baixar imagem só via `https:` e de hosts das lojas (mlstatic, susercontent, alicdn, media-amazon etc.), recusando IPs privados | Back | Teste unitário com `http://127.0.0.1` e `http://redis:6379` recusados |
| A-11 | SEC-27 Containers | `USER node` com `chown` dos volumes numa migração; healthcheck da API; remover o `apt-get` redundante ou usar `node:22-bookworm-slim` + build tools só no estágio de build | Ops | `docker compose exec api id -u` ≠ 0; volumes antigos continuam acessíveis; imagem menor |
| A-12 | SEC-28 Renovação | Decidir se o pagamento antecipado soma ao período restante (`GREATEST(now(), current_period_end) + dias`) | Prod | Regra documentada e testada |
| A-13 | SEC-24 Conformidade | Parecer sobre extração e inclusão de contatos; registrar base legal e opt-out; avaliar os termos do WhatsApp | Jur + Prod | Parecer arquivado; ajustes de produto aprovados |
| A-14 | SEC-33 Retenção | Política de expurgo de `payment_events.payload`, `audit_logs`, `posts` antigos e contatos anonimizados | Jur + Back | Job de expurgo com prazo definido |
| A-15 | Observabilidade | Logs estruturados com pino (já é dependência), sem segredos; alerta quando a API reiniciar ou quando o worker ficar sem rodada há mais de 5 min | Ops | Alerta disparado num teste |
| A-16 | Qualidade | CI (GitHub Actions) com `npm ci`, `typecheck`, `test:unit`, testes de integração com Postgres/Redis de serviço, `npm audit --omit=dev` e lint | Back | Pipeline bloqueando merge vermelho |

## Longo prazo

| # | Ação | Resp. | Critério de aceite |
|---|---|---|---|
| A-17 | Dividir `http.ts` (1.750 linhas) em routers por domínio, um por vez, com testes de contrato antes de cada movimentação | Back | Nenhuma mudança de resposta nos testes de contrato |
| A-18 | Migrações versionadas no lugar dos `ALTER`s na subida | Back | Migração aplicada em uma cópia do banco de produção sem perda |
| A-19 | Limitador de login no Redis, para o caso de mais de uma instância da API | Back | Teste com 2 instâncias |
| A-20 | Remover o código morto `deals/extraStores.ts` e `deals/searchShopeePortal.ts` (ou ligá-los, se forem de produto); reutilizar uma conexão Redis em `askWorker` | Back | `tsc` e testes verdes |
