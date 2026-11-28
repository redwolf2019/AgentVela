FROM node:24-alpine AS relay-deps
WORKDIR /repo

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY patches ./patches
COPY apps/relay/package.json apps/relay/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter agent-vela-relay...

COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY packages/shared ./packages/shared
COPY apps/relay ./apps/relay

FROM node:24-alpine AS web-builder
WORKDIR /repo

ENV VP_GIT_HOOKS=0
ENV T3CODE_WEB_SOURCEMAP=0

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY patches ./patches
COPY apps/web/package.json apps/web/package.json
COPY apps/web/deps ./apps/web/deps
COPY packages/client-runtime/package.json packages/client-runtime/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/effect-acp/package.json packages/effect-acp/package.json
COPY packages/issue-tracker-linear/package.json packages/issue-tracker-linear/package.json
COPY packages/provider-acp/package.json packages/provider-acp/package.json
COPY packages/provider-acp-registry/package.json packages/provider-acp-registry/package.json
COPY packages/provider-core/package.json packages/provider-core/package.json
COPY packages/provider-cursor/package.json packages/provider-cursor/package.json
COPY packages/provider-fx/package.json packages/provider-fx/package.json
COPY packages/provider-grok/package.json packages/provider-grok/package.json
COPY packages/provider-kiro/package.json packages/provider-kiro/package.json
COPY packages/provider-muse/package.json packages/provider-muse/package.json
COPY packages/provider-opencode/package.json packages/provider-opencode/package.json
COPY packages/provider-pi/package.json packages/provider-pi/package.json
COPY packages/provider-testing/package.json packages/provider-testing/package.json
COPY packages/secret-provider-core/package.json packages/secret-provider-core/package.json
COPY packages/secret-provider-definitions/package.json packages/secret-provider-definitions/package.json
COPY packages/secret-provider-onepassword/package.json packages/secret-provider-onepassword/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/source-control-azure-devops/package.json packages/source-control-azure-devops/package.json
COPY packages/source-control-bitbucket/package.json packages/source-control-bitbucket/package.json
COPY packages/source-control-core/package.json packages/source-control-core/package.json
COPY packages/source-control-cursor-origin/package.json packages/source-control-cursor-origin/package.json
COPY packages/source-control-definitions/package.json packages/source-control-definitions/package.json
COPY packages/source-control-forgejo/package.json packages/source-control-forgejo/package.json
COPY packages/source-control-gitcafe/package.json packages/source-control-gitcafe/package.json
COPY packages/source-control-github/package.json packages/source-control-github/package.json
COPY packages/source-control-gitlab/package.json packages/source-control-gitlab/package.json
COPY packages/source-control-tanstack-source/package.json packages/source-control-tanstack-source/package.json
COPY packages/source-control-testing/package.json packages/source-control-testing/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts --filter @t3tools/web...

COPY tsconfig.base.json tsconfig.effect.json ./
COPY third-party-licenses.config.json ./
COPY third-party-licenses ./third-party-licenses
COPY scripts/lib ./scripts/lib
COPY assets ./assets
COPY native/libghostty-vt/LICENSE ./native/libghostty-vt/LICENSE
COPY apps/server/package.json apps/server/package.json
COPY apps/server/src/device/deviceToolVersions.json apps/server/src/device/deviceToolVersions.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages ./packages
COPY apps/web ./apps/web

RUN pnpm --filter @t3tools/web build

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV AGENT_VELA_RELAY_BIND=0.0.0.0:8787
ENV AGENT_VELA_RELAY_DATA_DIR=/var/lib/agent-vela-relay
ENV AGENT_VELA_RELAY_SERVE_WEB_UI=true
ENV AGENT_VELA_RELAY_WEB_UI_DIR=/app/apps/web/dist

COPY --from=relay-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=relay-deps --chown=node:node /repo/package.json ./package.json
COPY --from=relay-deps --chown=node:node /repo/tsconfig.base.json ./tsconfig.base.json
COPY --from=relay-deps --chown=node:node /repo/packages/contracts ./packages/contracts
COPY --from=relay-deps --chown=node:node /repo/packages/shared ./packages/shared
COPY --from=relay-deps --chown=node:node /repo/apps/relay ./apps/relay
COPY --from=web-builder --chown=node:node /repo/apps/web/dist ./apps/web/dist

RUN mkdir -p /var/lib/agent-vela-relay && chown -R node:node /var/lib/agent-vela-relay
USER node

EXPOSE 8787
VOLUME ["/var/lib/agent-vela-relay"]

ENTRYPOINT ["node", "--experimental-strip-types", "/app/apps/relay/src/bin.ts"]
CMD ["serve"]
