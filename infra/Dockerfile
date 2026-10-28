# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57

# 1. Dependencies: only package manifests, so this layer is cached until they change.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

# 2. Build the Next.js app.
FROM deps AS build
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build

# 3. Runtime: no build caches, no tests, no compiler inputs beyond what tsx (worker/mailbox) loads at run time.
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY prompts ./prompts
COPY fixtures/context.json ./fixtures/context.json
COPY fixtures/scale ./fixtures/scale
COPY fixtures/pdf ./fixtures/pdf
COPY fixtures/emails ./fixtures/emails
COPY --from=build /app/apps/web/.next ./apps/web/.next
RUN rm -rf apps/web/.next/cache \
 && mkdir -p /app/runtime/storage /app/runtime/mailbox-state && chown -R node:node /app/runtime /app/apps/web/.next
USER node
EXPOSE 3087
# Liveness only (no database): the worker and mailbox override this in Compose.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3087/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["npm","run","start"]
