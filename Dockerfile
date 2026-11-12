# Application image (tech design v0.7.11): one image for `migrate`, `app` (serve) and `maintenance` (maintain).
# Non-root, read-only root file system at run time (compose: read_only), writable only on the data volumes and /tmp.

# ---------- build: dependencies and the review UI ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# no install scripts: argon2 loads its bundled prebuilt binary at run time (node-gyp-build)
RUN npm ci --ignore-scripts
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- run ----------
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src ./src
# the in-process parser is imported (and refused without its development switch); the sandbox runs in `parser`
COPY parser ./parser
COPY config/default ./config/default
# demo data (PRD R-DEMO-01): the evaluation directory, configuration and recorded model replies, and the demo emails
COPY eval/directory ./eval/directory
COPY eval/config ./eval/config
COPY eval/replay ./eval/replay
COPY eval/dev ./eval/dev
# data volumes and the parser socket volume start out owned by the application user (a named volume copies this)
RUN mkdir -p /var/lib/trunks/files /var/lib/trunks/state /var/lib/trunks/kyc /run/parser \
  && chown -R 10001:10001 /var/lib/trunks /run/parser
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "--experimental-strip-types", "--no-warnings", "src/main.ts"]
CMD ["serve"]
