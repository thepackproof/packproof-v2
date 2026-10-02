# Dedicated research context: docker build -f research/backend.Dockerfile .
# Build-only recipe. No deployment, credentials, signing or publication is configured.
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
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/packages /app/packages
COPY backend/migrations ./migrations
COPY backend/certs ./certs
COPY backend/openapi.json ./openapi.json
COPY config/rnd /app/config/rnd
USER node
EXPOSE 3000
CMD ["node","dist/index.js"]
