# Dittoly server image (shared mode). See docs/install.md.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine
# git: git sync to hosts other than GitHub and GitLab (src/git-sync/remote.ts).
RUN apk add --no-cache git
# Modules run in sibling containers (the docker sandbox), started through the host's Docker.
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
# Exported apps carry the runtime as source.
COPY --from=build /app/src/runtime ./src/runtime
COPY --from=build /app/src/export/app-runtime ./src/export/app-runtime
COPY --from=build /app/sandbox-runtime ./sandbox-runtime
COPY --from=build /app/skills ./skills
ENV NODE_ENV=production DITTOLY_MODE=shared DITTOLY_SANDBOX=docker HOST=0.0.0.0 PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "dist/src/main.js"]
