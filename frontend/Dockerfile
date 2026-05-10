# ─── Build stage ──────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install --omit=optional

COPY tsconfig.json tsconfig.app.json angular.json ./
COPY src ./src

RUN npx ng build --configuration production

# ─── Runtime stage ────────────────────────────────────────────────
FROM nginx:alpine AS runtime

COPY --from=builder /app/dist/maritime-frontend/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
