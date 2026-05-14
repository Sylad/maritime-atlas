# ─── Build stage ─────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json ./
RUN npm install --omit=optional

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ─── Runtime stage ───────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

COPY package.json ./
RUN npm install --omit=optional --omit=dev

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

CMD ["node", "dist/main.js"]
