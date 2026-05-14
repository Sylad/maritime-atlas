# Multi-stage build (mirror finance/warhammer/ol pattern, Node 22).
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json ./
RUN npm install --omit=optional

COPY tsconfig.json nest-cli.json ./
COPY src ./src

RUN npm run build

# ─── Runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --omit=optional

COPY --from=builder /app/dist ./dist

EXPOSE 3010

CMD ["node", "dist/main.js"]
