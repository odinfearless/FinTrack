# ---------------------------------------------------------------------------
# FinTrack — imagem do app (API + cliente já construído)
#
# Em dois estágios porque o que constrói o cliente não precisa ir junto: as
# dependências de build do React são centenas de megabytes que a imagem final
# nunca usaria. O que viaja para o segundo estágio é só a pasta `dist`.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS cliente

WORKDIR /app/client
# Só os manifestos primeiro: enquanto eles não mudam, o Docker reaproveita a
# camada do `npm ci` e o build não baixa nada de novo.
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build


FROM node:22-alpine AS app

ENV NODE_ENV=production

WORKDIR /app

# `--omit=dev` deixa de fora o `better-sqlite3`, que é dependência de
# desenvolvimento por causa do migrador. Ele é um módulo nativo: incluí-lo
# exigiria python3, make e g++ dentro da imagem só para um script que roda uma
# vez, na máquina de quem migra.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./server/
COPY --from=cliente /app/client/dist ./client/dist

# O app grava aqui os arquivos de backup das limpezas.
RUN mkdir -p data && chown -R node:node /app

# Sai do root: se algo escapar por um upload, o estrago é do usuário `node`.
USER node

EXPOSE 3333

# Sem `npm start` no meio: assim o Node é o processo 1 e recebe o SIGTERM do
# `docker stop` direto, em vez de o npm engoli-lo e o container morrer no
# timeout de dez segundos.
CMD ["node", "server/index.js"]
