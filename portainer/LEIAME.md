# Achadinhos no Portainer

Stack: [`achadinhos-stack.yml`](achadinhos-stack.yml). Feito para a VPS com Orion (Swarm + Traefik na rede `DevTabeliao`, `websecure`, `letsencryptresolver`). Domínio: **achadinhos.nexiabr.site**.

## Subir (pelo celular dá)

1. **DNS:** registro **A** `achadinhos` em `nexiabr.site` → IP da VPS. No Cloudflare, nuvem cinza.
2. **Portainer → Stacks → Add stack** → nome `achadinhos` → cole o `achadinhos-stack.yml` → **Deploy the stack**. Não precisa preencher variável nenhuma.
3. Espere 1 a 2 minutos e abra https://achadinhos.nexiabr.site
4. Entre com **admin@admin.com** / **admin123** e **troque a senha em Perfil na hora**.

As imagens (`ghcr.io/sidneyhog/achadinhos-api` e `-web`) são geradas pelo GitHub a cada push no repositório.

## O que o stack faz sozinho

- **Segredos:** `JWT_SECRET`, `APP_SECRET` e `EFI_WEBHOOK_SECRET` são gerados na primeira subida e guardados no volume `achadinhos_achadinhos_dados`. **Não apague esse volume**: o `APP_SECRET` cifra as credenciais das lojas.
- **Banco e Redis próprios**, só na rede interna do stack. Ninguém de fora acessa, nem os outros stacks.
- **Só o site fala com o Traefik.**

## Depois, no painel

- **Planos:** crie um plano ativo para liberar o cadastro de clientes.
- **Configurações → SMTP:** host `mail.2notasrioclaro.com.br`, porta `587`, usuário e senha da conta de e-mail e remetente. A senha fica cifrada no banco.
- **Integrações (EFI):** Client ID, Secret e chave Pix. Para ver o segredo do webhook, abra Portainer → *Containers* → `achadinhos_achadinhos-api` → *Console* e rode `cat /data/segredos/segredos.json`. A URL a cadastrar na EFI é `https://achadinhos.nexiabr.site/api/billing/webhook?hmac=EFI_WEBHOOK_SECRET&ignorar=`.

## Se não abrir

Portainer → *Services* → `achadinhos_achadinhos-api` → *Logs*. No primeiro minuto é normal reiniciar enquanto o banco sobe. Erro 404 ou certificado inválido normalmente é DNS ainda não propagado.

## Atualizar e fazer backup

- **Atualizar:** depois de um push no GitHub, abra o stack no Portainer → **Update the stack** com *Re-pull image and redeploy*.
- **Backup do banco:**

  ```bash
  docker exec $(docker ps -q -f name=achadinhos_achadinhos-db) pg_dump -U achadinhos achadinhos > achadinhos-$(date +%F).sql
  ```

## Opcional

Variáveis que você pode definir no stack para mudar algo: `DOMINIO`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `REDE_VPS`, `CERT_RESOLVER`, `ENTRYPOINT_HTTPS`, `IMAGEM_API`, `IMAGEM_WEB` e `EFI_*`. `JWT_SECRET`, `APP_SECRET` e `EFI_WEBHOOK_SECRET` também podem ser definidos à mão; definidos assim, valem mais que os gerados.

## Como foi testado

Num Swarm local com Traefik 3.6 e rede `DevTabeliao`, sem nenhuma variável definida:

- 5 serviços em 1/1;
- HTTPS no domínio, site e CSP OK;
- login `admin@admin.com` / `admin123` OK;
- webhook: 401 sem segredo e 200 com o segredo gerado;
- API e worker com os mesmos segredos, arquivo com permissão 600;
- outro domínio não chega ao Achadinhos.
