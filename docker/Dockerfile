# Piomio: one image with the hub, web UI, security console, built-in plugins,
# Claude Code + Codex CLIs and a Chromium for the browser plugin.
# Build from the repo root:  docker build -f docker/Dockerfile -t piomio .

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --no-audit --no-fund && npm run build

# The hub's own Tailscale node (access from anywhere, packages/tailnet): a static binary for this image's architecture.
FROM golang:1.27-bookworm AS tailnet
# The image pins its own Go; the module may ask for a newer patch release, which Go then fetches.
ENV GOTOOLCHAIN=auto
WORKDIR /src
COPY packages/tailnet/go.mod packages/tailnet/go.sum ./
RUN go mod download
COPY packages/tailnet/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/piomio-tailnet .

FROM node:24-bookworm-slim AS runtime-base
# CI passes the week (.github/workflows/docker.yml): a new value fetches everything below anew instead of
# taking it from the build cache, so the system packages, CLIs and Chromium stay current.
ARG REFRESH=
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      git sudo ca-certificates curl tini xvfb iptables procps ripgrep jq less openssh-client \
      fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Harness CLIs used as brains (they run as the unprivileged "agent" user).
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code @openai/codex && npm cache clean --force

# Users: hub = piomio; brain CLIs = agent (shares the piomio group for workspaces); other plugins = plugin.
RUN groupadd -r piomio && useradd -r -m -d /home/piomio -g piomio -s /bin/bash piomio \
    && groupadd -r agent && useradd -r -M -d /data/home/agent -g agent -G piomio -s /bin/bash agent \
    && groupadd -r plugin && useradd -r -M -d /data/home/plugin -g plugin -s /usr/sbin/nologin plugin
# Chromium for the browser plugin; keep the version in sync with playwright in package-lock.json.
ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium && chmod -R a+rX /ms-playwright \
    && npm cache clean --force && rm -rf /var/lib/apt/lists/*

COPY docker/sudoers /etc/sudoers.d/piomio
RUN chmod 0440 /etc/sudoers.d/piomio && visudo -c

FROM runtime-base
# Links the published image (ghcr.io) to the repository.
LABEL org.opencontainers.image.source="https://github.com/legostin/piomio" \
      org.opencontainers.image.description="Piomio: a self-hosted team of personal agents" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build --chown=root:root /app /app
COPY --from=tailnet /out/piomio-tailnet /usr/local/bin/piomio-tailnet
WORKDIR /app
COPY docker/entrypoint.sh /usr/local/bin/piomio-entrypoint
RUN chmod 0755 /usr/local/bin/piomio-entrypoint

ENV NODE_ENV=production \
    PIOMIO_APP_ROOT=/app \
    PIOMIO_DATA_DIR=/data \
    PIOMIO_HOST=0.0.0.0 \
    PIOMIO_PORT=8080 \
    PIOMIO_CONSOLE_PORT=8081 \
    PIOMIO_ISOLATION=users \
    PIOMIO_TAILNET_BIN=/usr/local/bin/piomio-tailnet \
    DISPLAY=:99 \
    DISABLE_AUTOUPDATER=1 \
    LANG=C.UTF-8

VOLUME /data
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD curl -fsS http://127.0.0.1:8080/api/auth/state >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/piomio-entrypoint"]
CMD ["start"]
