FROM node:22-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
# Lockfile versionado + npm ci: a imagem instala exatamente as versões auditadas.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV PORT=4000
EXPOSE 4000
CMD ["npx", "tsx", "src/index.ts"]
