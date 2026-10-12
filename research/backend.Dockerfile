# Dedicated research context: docker build -f research/backend.Dockerfile .
# Local research only. No deployment, cloud credentials or publication is configured.
FROM node:22-bookworm-slim AS build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY packages /app/packages
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=development PACKPROOF_ENV=research PACKPROOF_ENVIRONMENT=research \
    PACKPROOF_RND_ENABLED=0 PACKPROOF_RND_KILL_SWITCH=1 \
    PACKPROOF_DISTRIBUTION_AUTHORIZED=false
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -m 700 /research && chown node:node /research
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/packages /app/packages
COPY backend/migrations ./migrations
COPY backend/certs ./certs
COPY backend/openapi.json ./openapi.json
COPY config/rnd /app/config/rnd
COPY scripts/rnd-runtime.mjs /app/scripts/rnd-runtime.mjs
COPY research/container-entry.mjs /app/research/container-entry.mjs
USER node
# The API remains loopback-only inside the container; no public port is exposed.
CMD ["node","/app/research/container-entry.mjs"]
