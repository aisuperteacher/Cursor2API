FROM oven/bun:1.3.9 AS build

WORKDIR /src

COPY worker ./worker
COPY sidecar ./sidecar

# Bundle application code for the Node runtime. We intentionally do not use
# `bun build --compile` here: the sidecar relies on node:http socket lifecycle
# events to cancel upstream SDK runs when a streaming client disconnects, and
# those events must use Node's native HTTP implementation at runtime.
RUN mkdir -p /out \
  && bun build sidecar/server-entry.ts \
    --target=node \
    --format=esm \
    --outfile /out/api-for-cursor.mjs

FROM node:22-bookworm-slim AS web

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.client.config.ts ./
COPY src ./src
COPY public ./public

RUN npm run build:client

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin api \
  && mkdir -p /var/lib/api-for-cursor \
  && chown api:api /var/lib/api-for-cursor

COPY --from=build /out/api-for-cursor.mjs /usr/local/lib/api-for-cursor.mjs
COPY --from=web /src/dist/client /opt/api-for-cursor/public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=6718 \
    STATIC_DIR=/opt/api-for-cursor/public

EXPOSE 6718
VOLUME ["/var/lib/api-for-cursor"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=12 \
  CMD curl --fail --silent http://127.0.0.1:6718/health > /dev/null || exit 1

USER api

ENTRYPOINT ["node", "/usr/local/lib/api-for-cursor.mjs"]
