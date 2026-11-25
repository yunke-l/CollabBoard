FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile
COPY . .

FROM build AS web-build
RUN pnpm --filter @collabboard/web build

FROM build AS api-build
RUN pnpm --filter @collabboard/api build \
    && pnpm --filter @collabboard/api deploy --prod --legacy /release

FROM node:24-bookworm-slim AS api
WORKDIR /app
COPY --from=api-build /release/ ./
RUN mkdir /state && chown node:node /state && chmod 700 /state
USER node
CMD ["sh", "-ec", "node dist/platform/database/migrate.js && node dist/platform/database/seed.js && exec node dist/main.js"]

FROM caddy:2-alpine AS gateway
COPY --from=web-build /workspace/apps/web/dist/ /srv/board/
COPY infra/aws/Caddyfile /etc/caddy/Caddyfile
