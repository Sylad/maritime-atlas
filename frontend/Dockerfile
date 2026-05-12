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
# Phase C.5 (2026-05-12) : cache local des tiles fond de carte CARTO.
# Le fichier doit être lu AVANT default.conf (qui utilise proxy_cache
# `carto_cache`) — le préfixe `0-` garantit l'ordre alphabétique.
COPY nginx-cache.conf /etc/nginx/conf.d/0-cache.conf

# Cache dir pour les tiles (LRU, capé à 2 GB) + cache WMS externes (4 GB).
RUN mkdir -p /var/cache/nginx/carto /var/cache/nginx/wms && \
    chown -R nginx:nginx /var/cache/nginx/carto /var/cache/nginx/wms

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
