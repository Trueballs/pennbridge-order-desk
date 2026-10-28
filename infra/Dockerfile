FROM node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY prompts ./prompts
COPY fixtures/context.json ./fixtures/context.json
COPY fixtures/scale ./fixtures/scale
COPY fixtures/pdf ./fixtures/pdf
COPY fixtures/emails ./fixtures/emails
RUN npm run build
RUN mkdir -p /app/runtime/storage /app/runtime/mailbox-state && chown -R node:node /app/runtime
USER node
EXPOSE 3087
CMD ["npm","run","start"]
