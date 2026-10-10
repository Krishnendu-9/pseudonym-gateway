# The Pseudonym gateway as a container image (ADR-046). Multi-stage: the
# build tools never reach the image that runs. What it contains is checked
# on the built image, not assumed from this file: scripts/docker-smoke.ts,
# run by CI.
#
# Run it with the core dump limit at zero, or the start-up guard refuses to
# start (ADR-016), and publish the port on loopback unless the network in
# front of it is meant to reach it:
#   docker run --init --ulimit core=0 -p 127.0.0.1:3000:3000 \
#     -e PSEUDONYM_MODEL=... -e PSEUDONYM_PROVIDER_BASE_URL=... pseudonym-gateway

# Debian 12 (glibc), not Alpine: onnxruntime-node ships only a glibc build
# and fails to load on musl (checked by loading it, ADR-046). Bookworm is
# also where the name model's spans were reproduced (ADR-036, L2). Pinned by
# digest, like the CI actions and the model files: the tag alone can move.
# Bump procedure: ADR-046.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
WORKDIR /app
# onnxruntime-node's install script would otherwise download CUDA 12
# libraries from NuGet on linux/x64 (273 MB, ADR-036 run #4); the CPU
# runtime is in the package.
ENV ONNXRUNTIME_NODE_INSTALL=skip

# Compile src/ only (tsconfig.build.json), with every dependency.
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production dependencies only. The optional ones (the person-name runtime,
# about 300 MB) are kept, so that names can be switched on by mounting the
# model, without another image (ADR-046).
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM base AS runtime
# No NODE_ENV: the start-up guard (ADR-016) runs unless
# PSEUDONYM_DISABLE_HARDENING=true, whatever NODE_ENV says, because
# --env-file overrides anything set here and the image cannot defend itself
# (ADR-047). HOST=0.0.0.0: the loopback default would make the gateway
# unreachable from outside the container, so inside it the default's
# protection is gone and the network boundary is what limits who can reach
# it (ADR-046).
# ORT_DISABLE_TELEMETRY: ONNX Runtime's Linux build sends Microsoft
# telemetry by default; the gateway forces it off in code before the name
# thread starts (name-worker.ts), and it is declared here so that the image
# says so too (ADR-046).
ENV HOST=0.0.0.0 \
    PORT=3000 \
    ORT_DISABLE_TELEMETRY=1
# package.json for "type": "module"; root owns every file, and the process
# runs as the image's unprivileged "node" user, so it cannot change its own
# code.
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
USER node
EXPOSE 3000
# GET /health never calls the provider (server.ts). No curl in the slim
# image, so Node's fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# --disable-sigusr1: on Linux, SIGUSR1 would start the inspector; the guard
# refuses to start without it (ADR-016).
CMD ["node", "--disable-sigusr1", "dist/src/main.js"]
