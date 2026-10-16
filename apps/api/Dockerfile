FROM node:22-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY . .
ENV PORT=4000
EXPOSE 4000
CMD ["npx", "tsx", "src/index.ts"]
