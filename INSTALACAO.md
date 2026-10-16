# Como instalar o Achadinhos

Este texto ensina a colocar o sistema no ar. Há dois caminhos. Na sua máquina você testa. Na VPS Ubuntu o site fica no domínio, com HTTPS, para os clientes usarem.

No fim da instalação existem cinco containers:

| Container | O que faz | Quem acessa |
| --- | --- | --- |
| `web` | Entrega o site (React) e encaminha `/api/`, `/vitrine/` e `/go/` para a API | O navegador, pela porta do painel |
| `api` | Login, empresas, planos, cobrança e o restante da API, na porta interna 4000 | Só a rede interna do Docker |
| `worker` | Sessão do WhatsApp e a rodada de ofertas a cada 30 segundos | Só a rede interna do Docker |
| `postgres` | Banco `achadinhos` | Só a rede interna do Docker |
| `redis` | Recados entre a API e o WhatsApp que está vivo no worker | Só a rede interna do Docker |

O banco e o Redis não ficam abertos na internet. Na VPS, o Nginx do servidor recebe o domínio e encaminha para `127.0.0.1` na porta local do painel.

Você precisa do [Docker](https://docs.docker.com/engine/install/) com o plugin Compose (`docker compose version` precisa responder). O código está em [github.com/Yran-Olv/Achadinhos-Multivus](https://github.com/Yran-Olv/Achadinhos-Multivus).

---

## 1. Testar na sua máquina

### 1.1 Baixar o projeto

```bash
git clone https://github.com/Yran-Olv/Achadinhos-Multivus.git
cd Achadinhos-Multivus
```

### 1.2 Criar o arquivo `.env`

O Compose lê esse arquivo na subida. Sem ele, o comando para com erro de `env_file`. Crie `.env` na raiz do projeto, ao lado do `docker-compose.yml`:

```bash
cat > .env <<'EOF'
JWT_SECRET=troque-por-uma-frase-longa-so-sua
APP_SECRET=troque-por-outra-frase-longa-so-sua
ADMIN_EMAIL=admin@achadinhos.local
ADMIN_PASSWORD=admin123456
POSTGRES_PASSWORD=achadinhos
WEB_BIND=127.0.0.1
WEB_PORT=8080
EFI_CLIENT_ID=
EFI_CLIENT_SECRET=
EFI_PIX_KEY=
EFI_CERT_PATH=
EFI_CERT_PASSWORD=
EFI_SANDBOX=true
EOF
```

O que cada linha faz:

| Variável | Para que serve |
| --- | --- |
| `JWT_SECRET` | Assina o login. Quem tiver esse valor consegue forjar sessão. Use uma frase longa e única. |
| `APP_SECRET` | Criptografa credencial de loja e token. Se você trocar depois, o que já foi salvo deixa de abrir. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Conta de super admin. Só vale na criação. Se esse e-mail já existir no banco, mudar o `.env` não troca a senha. |
| `POSTGRES_PASSWORD` | Senha do Postgres. O Compose monta a `DATABASE_URL` com ela. Na máquina local, `achadinhos` basta. |
| `WEB_BIND` | `127.0.0.1` faz o site existir só nesta máquina. `0.0.0.0` abre a porta na rede. |
| `WEB_PORT` | Porta do site neste computador. O padrão é `8080` porque a 80 costuma já estar ocupada. |
| `EFI_*` | Cobrança PIX, cartão e boleto. Vazias, o checkout avisa que a EFI não está configurada. `EFI_SANDBOX=true` usa o ambiente de teste. |

### 1.3 Subir

```bash
docker compose up -d --build
```

`--build` monta as imagens da API e do site. Na primeira vez isso baixa Node, Nginx, Postgres e Redis e instala as dependências. Pode levar alguns minutos. `-d` devolve o terminal quando os containers estão criados. A API ainda espera o Postgres ficar saudável e aplica o schema (`CREATE TABLE IF NOT EXISTS` e os `ALTER` que já existem no código).

Acompanhe até os cinco serviços ficarem `running` (o Postgres, `healthy`):

```bash
docker compose ps
```

Se `api` ou `worker` reiniciar sem parar, leia o motivo:

```bash
docker compose logs api --tail 80
docker compose logs worker --tail 80
```

### 1.4 Entrar

Abra [http://127.0.0.1:8080](http://127.0.0.1:8080). Se você mudou `WEB_PORT`, use essa porta.

**Entrar** usa o e-mail e a senha do `.env`. Com o exemplo acima: `admin@achadinhos.local` e `admin123456`. Esse usuário cai no Super Admin (`/admin`). Ele não pertence a nenhuma empresa.

**Criar conta** abre o cadastro de cliente. O cadastro só oferece plano depois que o super admin gravar pelo menos um plano ativo em **Planos**.

Para parar sem apagar o banco:

```bash
docker compose stop
```

Para subir de novo, `docker compose up -d`. `docker compose down` para os containers e tira a rede. O volume `pgdata` continua. `docker compose down -v` apaga o banco e as sessões de WhatsApp.

---

## 2. Instalar na VPS Ubuntu

O arquivo `instalador/instalar.sh` faz esta instalação. Ele exige Ubuntu e `sudo`.

### 2.1 O que preparar antes do script

1. Uma VPS Ubuntu com acesso SSH. Entre como root ou como um usuário que possa usar `sudo`.
2. Um domínio seu, por exemplo `painel.suaempresa.com`.
3. Um registro DNS do tipo **A** desse domínio apontando para o IP público da VPS. O Let's Encrypt só emite certificado quando esse registro já responde. Confira na sua máquina, trocando o domínio:

```bash
dig +short painel.suaempresa.com
```

A linha que voltar precisa ser o IP da VPS. Se voltar vazio ou outro IP, espere a propagação ou corrija o DNS antes de pedir o certificado.

4. No firewall do provedor da VPS, libere a porta **22** (SSH), a **80** (HTTP, usada pelo certificado) e a **443** (HTTPS). O script não liga o `ufw` sozinho, para não fechar o SSH. Se o `ufw` já estiver ativo, ele libera as portas HTTP e HTTPS que você escolher.

### 2.2 Copiar o código para a VPS

Na VPS:

```bash
git clone https://github.com/Yran-Olv/Achadinhos-Multivus.git
cd Achadinhos-Multivus
sudo bash instalador/instalar.sh
```

Se o `git` ainda não existir: `sudo apt-get update && sudo apt-get install -y git`.

Rode o script a partir da pasta do projeto. Ele descobre sozinho de onde foi chamado e copia os arquivos para a pasta de instalação. A cópia ignora `node_modules`, `dist`, `.git` e `.env`.

### 2.3 O que responder em cada pergunta

O script pergunta e espera Enter ou um texto. Este é um exemplo completo. Os valores entre colchetes são o padrão: Enter aceita aquele valor.

```text
Usuário do sistema que vai ser dono da instalação [deploy]:
```

Enter cria (ou reaproveita) o usuário Linux `deploy`, com home `/home/deploy`, e coloca esse usuário no grupo `docker`. Outro nome vale se for minúsculo e começar com letra. Esse usuário é o dono dos arquivos. Os containers continuam sendo gerenciados pelo Docker.

```text
Pasta da instalação (Enter usa /home/deploy) [/home/deploy]:
```

Enter instala em `/home/deploy`. O caminho precisa ser absoluto, por exemplo `/opt/achadinhos`. É nessa pasta que ficam o código, o `.env` e o `docker-compose.yml` usados no dia a dia.

```text
Domínio (ex.: painel.suaempresa.com):
```

Digite o domínio, sem `https://` e sem barra. Exemplo: `painel.suaempresa.com`. O script recusa texto que não pareça um domínio.

```text
E-mail para o aviso de vencimento do certificado [admin@painel.suaempresa.com]:
```

O Let's Encrypt manda o aviso de renovação para esse e-mail. Pode ser o seu e-mail pessoal.

Na **primeira** instalação, ainda pede a conta do painel:

```text
E-mail do super admin [admin@painel.suaempresa.com]:
Senha do super admin (mínimo 6 caracteres):
```

A senha não aparece enquanto você digita. Mínimo de 6 caracteres. Anote os dois: é com eles que você entra em `/login`.

Se a pasta já tiver `.env`, o script avisa e **mantém** segredos e senha. Não pergunta de novo o super admin.

Em seguida vêm as portas.

- Se o Nginx da VPS já escuta 80 e 443 (há outros sites), o script não pede essas duas. Ele acrescenta este domínio nesse Nginx.
- Se 80 e 443 estiverem livres, ele sugere essas portas. Enter aceita. Se a porta sugerida estiver ocupada, ele oferece a próxima livre. HTTP e HTTPS precisam ser portas diferentes.
- A última porta é a do painel, só dentro da VPS. A sugestão é `8080`. O navegador do cliente não usa essa porta. O Nginx público encaminha o domínio para `127.0.0.1:8080`.

```text
EFI em sandbox? (sim/nao) [sim]:
```

Enter deixa a cobrança no ambiente de teste da EFI. Responda `nao` só quando for cobrar de verdade. Dá para mudar depois em **Integrações** e no `.env` (`EFI_SANDBOX=false`).

```text
Continuar? (sim/nao) [sim]:
```

`sim` começa a instalação. Qualquer outra resposta encerra sem mudar o servidor.

### 2.4 O que o script faz depois do sim

Nesta ordem:

1. Instala `curl`, Nginx, Certbot e OpenSSL, se faltarem.
2. Instala o Docker pelo script oficial, se o comando `docker` ainda não existir, e liga o serviço.
3. Cria o usuário Linux, se ele não existir, e coloca no grupo `docker`.
4. Copia o projeto para a pasta escolhida.
5. Na primeira vez, gera `JWT_SECRET`, `APP_SECRET` e `POSTGRES_PASSWORD` com `openssl rand` e grava o `.env` com permissão `600`. Só o dono lê esse arquivo. Uma segunda execução não troca esses três valores.
6. Sobe os containers com `docker compose up -d --build` dentro da pasta de instalação.
7. Grava o site do Nginx em `/etc/nginx/sites-available/achadinhos.conf`, ativa o link e recarrega o Nginx.
8. Se a porta HTTP for **80** e ainda não houver certificado desse domínio, pede o certificado ao Let's Encrypt. Com HTTPS na 443, o Certbot também configura o redirect. Com HTTPS em outra porta, o script grava o Nginx com o certificado na porta que você escolheu.
9. Se o `ufw` já estiver ligado, libera as portas HTTP e HTTPS escolhidas.

No final aparece uma destas frases:

- `Pronto. Abra https://painel.suaempresa.com` — certificado emitido.
- `O painel responde em http://painel.suaempresa.com` — o site subiu, o certificado não. A causa mais comum é o DNS ainda não apontar para esta VPS, ou a porta HTTP não ser a 80. Corrija o DNS e rode o script de novo. Ele não troca a senha do banco nem do super admin.

O Let's Encrypt só emite certificado quando a porta HTTP escolhida é a **80** e ela está acessível na internet. Em outra porta HTTP, o site fica só em HTTP.

### 2.5 Conferir se subiu

Na pasta de instalação (`/home/deploy`, se você aceitou o padrão):

```bash
cd /home/deploy
sudo docker compose ps
```

Os cinco serviços precisam estar de pé. Abra o endereço que o script imprimiu. Em **Entrar**, use o e-mail e a senha do super admin que você digitou.

A senha também está em `ADMIN_PASSWORD` dentro do `.env` dessa pasta. Leia com:

```bash
sudo grep '^ADMIN_EMAIL=\|^ADMIN_PASSWORD=' /home/deploy/.env
```

Troque a senha em **Perfil** no primeiro acesso. Mudar `ADMIN_PASSWORD` no `.env` depois que o usuário já foi criado não altera a senha do banco.

### 2.6 Primeiro uso no painel

O sistema sobe sem plano. Sem plano ativo, a página inicial não oferece assinatura e o cadastro de cliente não tem o que escolher.

1. Entre como super admin.
2. Em **Planos**, grave nome, preço e benefícios e deixe o plano ativo.
3. Em **Configurações**, grave o SMTP se o aviso de vencimento for sair por e-mail. Sem SMTP, o aviso aparece só no painel.
4. A cobrança real ainda pede a EFI. Em **Integrações**, grave Client ID, Client Secret e a chave PIX, e rode o teste de conexão. O arquivo `.pfx` fica no servidor. O caminho dele entra em `EFI_CERT_PATH` no `.env`, e a senha do arquivo em `EFI_CERT_PASSWORD`. Exemplo, com o arquivo em `/home/deploy/certificados/efi.pfx`:

```bash
sudo mkdir -p /home/deploy/certificados
sudo cp /caminho/do/arquivo.pfx /home/deploy/certificados/efi.pfx
sudo chown deploy:deploy /home/deploy/certificados/efi.pfx
sudo chmod 600 /home/deploy/certificados/efi.pfx
```

Edite o `.env` e preencha `EFI_CERT_PATH=/home/deploy/certificados/efi.pfx`. Com cobrança real, `EFI_SANDBOX=false`. Reinicie API e worker para eles lerem o arquivo:

```bash
cd /home/deploy
sudo docker compose up -d
```

O webhook para cadastrar na EFI é `https://seu-dominio/api/billing/webhook`.

---

## 3. Atualizar uma instalação que já existe

Na VPS, busque o código novo e rode o instalador outra vez. A segunda execução mantém o `.env` (senha do banco, segredos e super admin) e sobe as imagens de novo.

```bash
cd Achadinhos-Multivus
git pull
sudo bash instalador/instalar.sh
```

Responda as mesmas portas de antes. Se o código novo já estiver na pasta de instalação e você só quiser reconstruir os containers:

```bash
cd /home/deploy
sudo docker compose up -d --build
```

Não apague o `.env` na cópia. Sem ele, a API não acha o banco e o Compose pode recriar a senha padrão `achadinhos`, que não abre um volume Postgres já inicializado com outra senha.

Na máquina local, o equivalente é `git pull` e `docker compose up -d --build` na pasta do projeto.

---

## 4. Quando algo não abre

**A página não carrega.** Veja se o container `web` está `running` e se a porta local escuta:

```bash
sudo ss -ltnp | grep 8080
sudo docker compose logs web --tail 40
```

Troque `8080` pela `WEB_PORT` do `.env`.

**O login volta erro ou a API não responde.** O Nginx do container encaminha `/api/` para o hostname `api`. Se o container `api` reinicia, o site abre e o login falha.

```bash
sudo docker compose logs api --tail 80
```

Um erro de senha do Postgres nessa log significa que `POSTGRES_PASSWORD` no `.env` não é a senha com que o volume foi criado. A senha do volume é a da primeira subida.

**O certificado não saiu.** Rode `dig +short seu-dominio` e compare com o IP da VPS. A porta 80 precisa chegar nesta máquina. Depois rode o instalador de novo.

**O QR do WhatsApp não aparece.** A sessão vive só no `worker`. Confira `sudo docker compose logs worker --tail 80`. API e worker compartilham o volume `zapodata`.

---

## 5. Onde ficam os dados

| Lugar | O que guarda |
| --- | --- |
| `/home/deploy/.env` | Senhas e segredos. Permissão 600. |
| `/home/deploy/.instalador.env` | Domínio, portas e e-mail do certificado escolhidos na última execução. |
| Volume Docker `pgdata` | Empresas, usuários, planos, ofertas e o restante do banco. |
| Volume Docker `zapodata` | Sessão do WhatsApp. Apagar este volume pede QR de novo. |

O instalador não faz backup. Antes de uma atualização grande, grave uma cópia do banco a partir da pasta de instalação:

```bash
cd /home/deploy
sudo docker compose exec -T postgres pg_dump -U achadinhos achadinhos > backup-$(date +%F).sql
```

Para restaurar essa cópia num banco vazio:

```bash
sudo docker compose exec -T postgres psql -U achadinhos achadinhos < backup-AAAA-MM-DD.sql
```

Apagar o volume (`docker compose down -v`) apaga empresas, usuários e sessões de WhatsApp. Não há como desfazer sem um backup.
