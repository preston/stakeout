# Build from the repository root: docker build -f ui/Dockerfile .
FROM node:26-trixie-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY core/package.json ./core/
COPY server/package.json ./server/
COPY ui/package.json ./ui/
RUN npm ci --ignore-scripts --workspace=@stakeout/core --workspace=@stakeout/ui --include-workspace-root
COPY core ./core
COPY ui ./ui
RUN npm run build:core && npm run build:ui

FROM nginx:stable-alpine
RUN apk add --no-cache jq
ENV STAKEOUT_UI_SERVER_URL=http://localhost:3000 STAKEOUT_UI_TITLE="My Stakeout"
COPY ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/ui/dist/stakeout-ui/browser /usr/share/nginx/html
COPY --chmod=755 ui/docker-entrypoint.sh /docker-entrypoint.d/40-stakeout-configuration.sh
EXPOSE 80
