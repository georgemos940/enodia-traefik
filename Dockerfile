# Enodia: one small image, no dependencies to install.
FROM node:22-alpine

LABEL org.opencontainers.image.title="Enodia" \
      org.opencontainers.image.description="A dashboard for Traefik: routes, services, live traffic, access logs, certificates and health checks" \
      org.opencontainers.image.source="https://github.com/georgemos940/enodia" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    ENODIA_INSTALL=docker \
    PORT=3000 \
    ENODIA_DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}${ENODIA_BASE_PATH}/healthz" || exit 1

CMD ["node", "server/index.mjs"]
