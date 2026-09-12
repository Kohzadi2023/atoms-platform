FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @atoms/preview-gateway... build
# pnpm 11 needs legacy deploy for this non-injected workspace. This only
# prepares a portable production package; it does not deploy/publish anything.
RUN pnpm --filter @atoms/preview-gateway deploy --prod --legacy /out
RUN node scripts/verify-preview-package.mjs apps/preview-gateway/package.json /out/package.json

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/ /app/
USER node
EXPOSE 3002
CMD ["node", "dist/main.js"]
