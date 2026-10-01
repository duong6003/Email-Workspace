# syntax=docker/dockerfile:1.7
FROM node:22.22.0-alpine AS dependencies
WORKDIR /workspace
RUN corepack enable && corepack install --global pnpm@11.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/scheduler/package.json apps/scheduler/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/runtime-orchestration/package.json packages/runtime-orchestration/package.json
COPY packages/sender-credentials/package.json packages/sender-credentials/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY apps ./apps
COPY packages ./packages
COPY contracts ./contracts
COPY vitest.shared.ts ./vitest.shared.ts
ARG VITE_API_URL=/api/v1
ARG VITE_SOCKET_URL=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SOCKET_URL=$VITE_SOCKET_URL
RUN pnpm --filter @eow/contracts build \
      && pnpm --filter @eow/sender-credentials build \
      && pnpm --filter @eow/web build \
      && pnpm --filter @eow/api build \
      && pnpm --filter @eow/worker build \
      && pnpm --filter @eow/scheduler build

# Self-contained production dependency trees, one per Node runtime. `pnpm deploy`
# resolves the workspace links, so `@eow/sender-credentials` lands inside the
# deployed node_modules instead of pointing back at /workspace. Injecting the
# workspace packages keeps every symlink inside the deploy directory, which is
# what makes the tree relocatable to /app in the runtime stages.
FROM build AS prod-deps
RUN pnpm --config.inject-workspace-packages=true deploy --filter @eow/api --prod /prod/api \
      && pnpm --config.inject-workspace-packages=true deploy --filter @eow/worker --prod /prod/worker \
      && pnpm --config.inject-workspace-packages=true deploy --filter @eow/scheduler --prod /prod/scheduler

FROM node:22.22.0-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /prod/api/node_modules ./apps/api/node_modules
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

FROM node:22.22.0-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /prod/worker/node_modules ./apps/worker/node_modules
COPY --from=build /workspace/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /workspace/apps/worker/dist ./apps/worker/dist
USER node
CMD ["node", "apps/worker/dist/main.js"]

FROM node:22.22.0-alpine AS scheduler
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /prod/scheduler/node_modules ./apps/scheduler/node_modules
COPY --from=build /workspace/apps/scheduler/package.json ./apps/scheduler/package.json
COPY --from=build /workspace/apps/scheduler/dist ./apps/scheduler/dist
USER node
CMD ["node", "apps/scheduler/dist/main.js"]

FROM nginx:1.29-alpine AS web
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
