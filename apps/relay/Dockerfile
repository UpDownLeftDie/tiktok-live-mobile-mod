# syntax=docker/dockerfile:1
# Build from repo root:
#   docker build -f apps/relay/Dockerfile -t tiktok-mod-relay .

FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/relay/package.json apps/relay/
RUN pnpm install --filter @tiktok-mod/relay...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/relay apps/relay

RUN pnpm --filter @tiktok-mod/shared build \
 && pnpm --filter @tiktok-mod/relay build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --chown=node:node --from=build \
  /app/packages/shared/package.json packages/shared/package.json
COPY --chown=node:node --from=build \
  /app/packages/shared/dist packages/shared/dist
COPY --chown=node:node --from=build \
  /app/apps/relay/package.json apps/relay/package.json
COPY --chown=node:node --from=build \
  /app/apps/relay/dist apps/relay/dist
COPY --chown=node:node --from=build \
  /app/apps/relay/node_modules apps/relay/node_modules
COPY --chown=node:node --from=build \
  /app/node_modules node_modules

# Point shared package at compiled JS for Node resolution
RUN node -e "const fs=require('fs'); \
const p=JSON.parse(fs.readFileSync( \
'packages/shared/package.json','utf8')); \
p.exports={'.':'./dist/index.js'}; \
p.types='./dist/index.d.ts'; \
fs.writeFileSync('packages/shared/package.json', \
JSON.stringify(p,null,2));" \
 && chown node:node packages/shared/package.json

WORKDIR /app/apps/relay
USER node
CMD ["node", "dist/index.js"]
