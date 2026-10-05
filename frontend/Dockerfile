# Frontend SPA. Build context: repo root (see docker-compose.yml).
#
# Stage 1 builds the Vite bundle; stage 2 serves it with nginx, which also proxies /api to the
# backend container (the production equivalent of the Vite dev proxy).

FROM node:24-alpine AS build
WORKDIR /app/frontend

# VITE_* values are baked into the bundle at build time — changing them needs a rebuild.
ARG VITE_AUTH_ENABLED=false
ARG VITE_AZURE_CLIENT_ID=
ARG VITE_AZURE_TENANT_ID=common
ENV VITE_AUTH_ENABLED=$VITE_AUTH_ENABLED \
    VITE_AZURE_CLIENT_ID=$VITE_AZURE_CLIENT_ID \
    VITE_AZURE_TENANT_ID=$VITE_AZURE_TENANT_ID

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
