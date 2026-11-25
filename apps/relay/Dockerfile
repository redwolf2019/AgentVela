FROM node:24-alpine AS builder
WORKDIR /repo

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/relay/package.json apps/relay/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/client-runtime/package.json packages/client-runtime/package.json

RUN pnpm install --frozen-lockfile --filter agent-vela-relay... --filter @t3tools/web...

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/shared packages/shared
COPY packages/client-runtime packages/client-runtime
COPY apps/web apps/web
COPY apps/relay apps/relay

RUN pnpm --filter @t3tools/web build

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV AGENT_VELA_RELAY_BIND=0.0.0.0:8787
ENV AGENT_VELA_RELAY_DATA_DIR=/var/lib/agent-vela-relay
ENV AGENT_VELA_RELAY_SERVE_WEB_UI=true
ENV AGENT_VELA_RELAY_WEB_UI_DIR=/app/apps/web/dist

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/tsconfig.base.json ./tsconfig.base.json
COPY --from=builder /repo/packages/contracts ./packages/contracts
COPY --from=builder /repo/packages/shared ./packages/shared
COPY --from=builder /repo/apps/relay ./apps/relay
COPY --from=builder /repo/apps/web/dist ./apps/web/dist

RUN mkdir -p /var/lib/agent-vela-relay && chown -R node:node /var/lib/agent-vela-relay /app
USER node

EXPOSE 8787
VOLUME ["/var/lib/agent-vela-relay"]

ENTRYPOINT ["node", "--experimental-strip-types", "/app/apps/relay/src/bin.ts"]
CMD ["serve"]
