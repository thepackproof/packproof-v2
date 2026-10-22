FROM public.ecr.aws/docker/library/node:22-alpine AS build
RUN apk add --no-cache --upgrade 'zlib>=1.3.2-r1'
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/scripts/m2-runtime-privileges.mjs backend/scripts/m2-runtime-privileges.d.mts ./scripts/
COPY packages/evidence-contracts /app/packages/evidence-contracts
RUN npm run build

FROM public.ecr.aws/docker/library/node:22-alpine
WORKDIR /app/backend
ENV NODE_ENV=production
# Alpine's distribution patch fixes CVE-2026-85091 without changing the zlib ABI.
RUN apk add --no-cache --upgrade 'zlib>=1.3.2-r1' ffmpeg util-linux font-dejavu ca-certificates openssl && command -v prlimit && command -v ffprobe && openssl version
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/packages/evidence-contracts /app/packages/evidence-contracts
COPY backend/migrations ./migrations
COPY backend/certs ./certs
# Preserve the existing service's absolute TLS CA binding during this layout change.
COPY backend/certs /app/certs
COPY backend/openapi.json ./openapi.json
COPY backend/partner-openapi.json ./partner-openapi.json
COPY backend/claim-export-openapi.json ./claim-export-openapi.json
COPY backend/envelope-openapi.json ./envelope-openapi.json
COPY backend/rnd-openapi.json ./rnd-openapi.json
COPY config/rnd/research-build.json /app/config/rnd/research-build.json
COPY backend/scripts/onboarding-migrate.mjs ./scripts/onboarding-migrate.mjs
COPY backend/scripts/measurement-migrate.mjs ./scripts/measurement-migrate.mjs
COPY backend/scripts/rnd-migrate.mjs ./scripts/rnd-migrate.mjs
COPY backend/scripts/foundation-migrate.mjs ./scripts/foundation-migrate.mjs
COPY backend/scripts/foundation-migrate-cli.mjs ./scripts/foundation-migrate-cli.mjs
COPY backend/scripts/m2-migrate.mjs ./scripts/m2-migrate.mjs
COPY backend/scripts/m2-migrate-cli.mjs ./scripts/m2-migrate-cli.mjs
COPY backend/scripts/m2-runtime-privileges.mjs ./scripts/m2-runtime-privileges.mjs
COPY backend/scripts/isolated-runtime-entrypoint.mjs ./scripts/isolated-runtime-entrypoint.mjs
COPY backend/scripts/isolated-runtime-role-probe.mjs ./scripts/isolated-runtime-role-probe.mjs
COPY backend/scripts/isolated-runtime-queued-revocation.mjs ./scripts/isolated-runtime-queued-revocation.mjs
COPY backend/scripts/isolated-envelope-acceptance.mjs ./scripts/isolated-envelope-acceptance.mjs
COPY backend/scripts/isolated-recipient-acceptance.mjs ./scripts/isolated-recipient-acceptance.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
