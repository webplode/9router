ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS deps
# Native optional deps (better-sqlite3) + Tailwind/lightningcss platform binaries for multi-arch builds.
RUN apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci

FROM deps AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Reuse webpack/next cache across builds (big win on rebuilds; per-platform still separate).
RUN --mount=type=cache,target=/app/.next/cache \
  npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
COPY --from=builder /app/src/mitm ./src/mitm
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
COPY --from=builder /app/node_modules/next ./node_modules/next

RUN mkdir -p /app/data /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

RUN apk --no-cache upgrade && apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh && \
  chown -R node:node /app

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]