# Achadinhos

SaaS multiempresa para publicar ofertas de afiliado em grupos de WhatsApp e em canais do Telegram. Cada empresa tem a própria conta, as próprias lojas, conexões, grupos e contatos. Uma empresa não lê os dados da outra.

O painel do cliente acompanha a operação do dia: fila de envio, lojas, campanhas, ofertas, publicações, conexões, contatos, links, analytics e configurações. O super admin vê as empresas, os planos e a cobrança.

## Como sobe

O passo a passo completo, com o que cada pergunta do instalador significa e como conferir se subiu, está em [INSTALACAO.md](INSTALACAO.md). Resumo:

Na sua máquina, crie o `.env` na raiz (o modelo está no guia) e rode:

```bash
docker compose up -d --build
```

O site fica em [http://127.0.0.1:8080](http://127.0.0.1:8080). Sem o `.env`, o Compose para porque a API e o worker leem esse arquivo.

Na VPS Ubuntu, com o DNS do domínio já apontando para o IP do servidor:

```bash
git clone https://github.com/Yran-Olv/Achadinhos-Multivus.git
cd Achadinhos-Multivus
sudo bash instalador/instalar.sh
```

| Serviço | Função |
| --- | --- |
| `web` | Site em React (Vite) servido pelo Nginx |
| `api` | API Express na porta interna 4000 |
| `worker` | Sessões de WhatsApp e rodada de ofertas a cada 30 segundos |
| `postgres` | Banco `achadinhos` |
| `redis` | Ponte entre a API e o WhatsApp que está vivo no worker |

O Nginx entrega o site e encaminha `/api/`, `/vitrine/` e `/go/` para a API. O schema é aplicado na subida da API (`CREATE TABLE IF NOT EXISTS`). Colunas novas precisam de `ALTER` explícito.

Para rodar no **Portainer** (stack atrás de um Traefik que já atende outros projetos), use [portainer/achadinhos-stack.yml](portainer/achadinhos-stack.yml) e o passo a passo em [portainer/LEIAME.md](portainer/LEIAME.md).

## Login

Na página inicial, **Entrar** abre `/login`. **Criar conta** abre `/cadastro`. O painel do cliente usa um endereço por tela: `/home`, `/lojas`, `/campanhas`, `/ofertas`, `/publicacoes`, `/conexoes`, `/contatos`, `/links`, `/analytics`, `/automacao`, `/material` e `/configuracoes/envio` (também `geral`, `filtros`, `horarios`, `equipe` e `logs`). A conexão aberta fica em `/conexoes/1/grupos`. O super admin usa `/admin`, `/admin/empresas`, `/admin/planos`, `/admin/configuracoes` e `/admin/perfil`. O voltar do navegador troca de tela.

O login devolve um JWT de 7 dias, guardado no navegador. O papel do usuário decide a tela:

- `superadmin` entra no painel de super admin. Essa conta não pertence a nenhuma empresa.
- `owner` entra no painel da empresa criada no cadastro.

**Sair da conta** encerra a sessão. Empresa com status `blocked` não consegue entrar.

### Super admin local

Na primeira subida, se o e-mail ainda não existir, o sistema cria o super admin com os valores do `.env`:

| Campo | Padrão local |
| --- | --- |
| E-mail | `admin@achadinhos.local` |
| Senha | `ADMIN_PASSWORD` do `.env` (obrigatória, 8 caracteres ou mais; sem ela o super admin não é criado) |
| Nome | Super Admin |
| Papel | `superadmin` |

Troque `ADMIN_EMAIL` e `ADMIN_PASSWORD` antes de usar fora da máquina local. A senha só é gravada na criação. Mudar o `.env` depois não atualiza a senha de um super admin que já existe.

O super admin abre com menu lateral: dashboard, empresas (com busca, filtro e ações), planos, assinaturas, pagamentos, WhatsApp, lojas, cupons, relatórios, logs, auditoria, EFI, configurações e perfil.

- Os cards e os gráficos saem do banco. Sem fatura paga, a receita fica em zero.
- Dá para entrar na empresa como o dono e voltar pelo botão no topo do painel do cliente.
- Suspender, bloquear, cancelar e excluir pedem confirmação. Renovar 30 dias é manual e não cobra na EFI.
- Em Integrações ficam Client ID, Client Secret, chave PIX, ambiente sandbox/produção e o teste de conexão. O certificado PFX continua no servidor, em `EFI_CERT_PATH`.
- O worker suspende a empresa que continua em teste, nunca pagou e passou do prazo configurado. Nos 7, 3 e 1 dias e no dia do vencimento o aviso aparece no painel. Com SMTP gravado em Configurações, o mesmo aviso sai por e-mail para o dono.
- O cadastro pede cidade e estado. O dono cria gerente (opera) ou leitura (só acompanha) em Configurações → Equipe. O limite mensal de publicações trava o robô. A chave de API só nasce se o plano tiver a API marcada, e lê `/api/v1/offers`.
- Depoimentos da landing são os que o super admin publica. Sem nenhum gravado, a seção não aparece.

Excluir a empresa apaga os dados dela em cascata.

### Conta de cliente

O cadastro cria, juntos:

1. a empresa, com um `tenant_id` (UUID) usado na vitrine pública
2. o usuário `owner`
3. a assinatura em `trialing`, com o fim do teste calculado pelos dias do plano
4. a linha de configurações do robô, desligado

A primeira subida não cria plano. O super admin cadastra o nome, o preço e os benefícios em Planos. A página inicial lista só os planos marcados como ativos. Campo vazio de limite significa sem teto. Empresa `suspended` ou `blocked` não publica. O pagamento confirmado reativa uma empresa que estava só suspensa.

## O que o cliente faz no painel

- **Dashboard.** Fila da próxima oferta, com o relógio de cada loja a partir do último envio e do intervalo salvo. **Buscar agora** força uma rodada. **Pausar** desliga o robô da empresa.
- **Lojas.** Credenciais de afiliado. O que é secreto fica criptografado e mascarado, com olho para revelar. Mercado Livre, Shopee, Amazon, AliExpress, Awin, Rakuten e Época entram na busca quando a credencial está salva. Magalu, Shein e Terabyte são só o cartão da credencial: não há busca automática.
- **Campanhas.** Palavra-chave, loja, desconto mínimo e teto de preço. Com o catálogo aleatório do Mercado Livre ligado, o robô ignora essas palavras nessa loja.
- **Ofertas e Publicações.** O que foi encontrado e o que foi enviado.
- **Conexões.** **Nova conexão** escolhe WhatsApp ou Telegram e o nome (por exemplo AchadosSp e AchadoSp). O WhatsApp gera o QR no worker. Dentro da conexão ficam as abas de lojas e de grupos (pausar, ativar, trazer contatos). O Telegram usa o token do BotFather e a lista de chats.
- **Contatos.** Base da empresa: telefone único, nome, origem e etiquetas. Dá para adicionar, importar (CSV, TXT ou XLSX) ou puxar participantes de um grupo da conexão.
- **Links, Analytics, Automação e Material de apoio.** Atalhos, números e o guia do cookie do Mercado Livre.
- **Configurações.** Geral, Envio, Filtros, Horários e Logs. Em Envio, cada loja tem minutos e segundos próprios (mínimo 15 segundos), a pausa entre duas publicações prontas ao mesmo tempo e quantas ofertas saem por vez.

## Como o robô publica

O worker acorda a cada 30 segundos. Uma empresa só entra na rodada quando o robô está ligado, existe WhatsApp conectado ou bot do Telegram, e o horário de Brasília permite.

Para cada loja pronta, ele espera o intervalo daquela loja desde o último envio. A oferta passa pelos filtros de desconto, preço e categoria. O mesmo produto não repete no mesmo grupo por 24 horas. O link publicado é o link de afiliado da loja. O clique público passa por `/go/:token` e soma no contador.

A sessão de WhatsApp vive só no worker. A API pede grupos e contatos por Redis (`achadinhos:wa:req`). Por isso o QR e a lista de grupos dependem do container `worker` estar no ar.

## Páginas públicas

- `/vitrine/:tenantId` mostra as ofertas daquela empresa.
- `/go/:token` registra o clique e redireciona para a loja.

## Variáveis

O arquivo `.env` é lido pela API e pelo worker. O Compose substitui banco e Redis pelos serviços internos.

| Variável | Uso |
| --- | --- |
| `JWT_SECRET` | Assinatura do login. Obrigatória: sem ela a API não sobe. |
| `APP_SECRET` | Criptografia das credenciais de loja e dos tokens. Troque fora do ambiente local. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Super admin criado só se o e-mail ainda não existir. |
| `DATABASE_URL` | Postgres. No Compose aponta para o serviço `postgres`. |
| `REDIS_URL` | Redis. No Compose aponta para o serviço `redis`. |
| `EFI_CLIENT_ID`, `EFI_CLIENT_SECRET`, `EFI_PIX_KEY`, `EFI_CERT_PATH`, `EFI_CERT_PASSWORD` | Cobrança EFI (PIX, cartão e boleto). Vazias, o checkout avisa que a EFI não está configurada. |
| `EFI_SANDBOX` | `true` usa o ambiente de teste da EFI. |
| `EFI_WEBHOOK_SECRET` | Segredo do webhook de pagamento. Sem ele a API recusa as confirmações da EFI. Cadastre na EFI `https://seu-dominio/api/billing/webhook?hmac=<segredo>&ignorar=`. O instalador gera o valor. |

Banco local do Compose: usuário `achadinhos`, senha `achadinhos`, database `achadinhos`.
