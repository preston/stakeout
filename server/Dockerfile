# Build from the repository root: docker build -f server/Dockerfile .
FROM node:26-trixie-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY core/package.json ./core/
COPY server/package.json ./server/
COPY ui/package.json ./ui/
RUN npm ci --ignore-scripts --workspace=@stakeout/core --workspace=@stakeout/server --include-workspace-root
COPY core ./core
COPY server ./server
ENV STAKEOUT_SERVER_DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN npm run build:core && npm run build:server \
    && npm prune --omit=dev --ignore-scripts --workspace=@stakeout/core --workspace=@stakeout/server --include-workspace-root \
    && mkdir -p server/node_modules

FROM node:26-trixie-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/core/package.json ./core/
COPY --from=builder /app/core/dist ./core/dist
COPY --from=builder /app/server/package.json /app/server/prisma.config.ts ./server/
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/dist ./server/dist
# Node 26 also runs the source-based administrative and Prisma seed commands.
COPY --from=builder /app/server/src ./server/src
COPY --from=builder /app/server/prisma ./server/prisma
COPY --from=builder /app/server/bin ./server/bin
WORKDIR /app/server
EXPOSE 3000
CMD ["node", "dist/index.js"]
