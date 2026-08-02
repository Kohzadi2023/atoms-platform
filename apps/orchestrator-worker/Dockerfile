FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @atoms/orchestrator-worker... build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build /workspace /workspace
USER node
CMD ["node", "apps/orchestrator-worker/dist/main.js"]
