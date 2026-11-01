# syntax=docker/dockerfile:1.7
#
# Production-shaped container image for IMS. Two public targets:
#
#   runtime  (default, last)  the Next.js standalone server, non-root, no full node_modules
#   migrate                   the Prisma CLI + prisma/ + prisma.config.ts; runs `prisma migrate deploy`
#
# Build:  docker build --target runtime -t ims .      docker build --target migrate -t ims-migrate .
#
# NO SECRETS ARE EVER BAKED IN. The repository is public; there is no ENV/ARG here that carries a
# credential. DATABASE_URL, AUTH_SECRET, SETTINGS_ENCRYPTION_KEY, CRON_SECRET and every connector
# credential are supplied as environment variables when the container starts. See deploy/README.md,
# "Container image".

# Major-version pin. Keep in step with package.json "engines" (>=22.11.0) and the Node version the
# CI workflows use (22).
ARG NODE_MAJOR=22

FROM node:${NODE_MAJOR}-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1

# --------------------------------------------------------------------------------------------
# deps: the full dependency tree (dev dependencies included: the build needs tsc types, tailwind,
# prisma). Only package.json/package-lock.json/.npmrc are copied so this layer is cached until the
# lockfile changes.
# --------------------------------------------------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci

# --------------------------------------------------------------------------------------------
# build: prisma generate + next build, with the opt-in standalone output enabled for this stage only.
# --------------------------------------------------------------------------------------------
FROM base AS build
WORKDIR /app
ENV NEXT_OUTPUT=standalone
# Browser error-tracking settings are inlined into the client bundle at build time. Empty (the default)
# leaves the browser SDK off; pass --build-arg to enable it (server-side SENTRY_* stay runtime env).
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=
ARG NEXT_PUBLIC_SENTRY_RELEASE=
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT \
    NEXT_PUBLIC_SENTRY_RELEASE=$NEXT_PUBLIC_SENTRY_RELEASE
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate --schema prisma/schema.prisma
# `next build` evaluates route modules; some read DATABASE_URL at import time. The value below is a
# dummy that exists only for this single command (it is not an ENV/ARG, so it is in neither the
# image config nor any later stage) and nothing connects to it during the build.
RUN NODE_OPTIONS=--max-old-space-size=4096 \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    npm run build \
 && test -f .next/standalone/server.js
# Scripts that server code starts as child processes through `npm run` / tsx (the image has neither a scripts/ tree nor
# tsx): bundle each into ONE self-contained file with esbuild (already installed as a tsx dependency). Where
# <cwd>/dist-scripts/<file> exists, lib/ops/readiness-gate-collect.ts runs `node <file>` instead of `npm run <script>`.
#   /api/cron/reconciliation-pack  -> reconcile:pack      (scripts/reconciliation-pack.ts)
#   the pack's liveness child      -> read-sync:status    (scripts/read-sync-status.ts)
#   (not a child) host cron setup  -> render-managed-crontab (scripts/render-managed-crontab.ts)
# Everything is bundled (including the `next/*` modules the shared code imports): Node's ESM resolver cannot load an
# extensionless `next/server` from the traced standalone node_modules. Only the optional @opentelemetry/api, which
# Next's tracer falls back from inside a try/catch, stays external.
RUN node_modules/.bin/esbuild scripts/reconciliation-pack.ts scripts/read-sync-status.ts scripts/render-managed-crontab.ts \
      --bundle --platform=node --target=node22 --format=esm --tsconfig=tsconfig.json \
      --outdir=dist-scripts --out-extension:.js=.mjs \
      --external:@opentelemetry/api \
      --banner:js="import{createRequire as __cr}from'node:module';import{fileURLToPath as __fu}from'node:url';import{dirname as __dn}from'node:path';const require=__cr(import.meta.url);const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);" \
      --log-level=warning \
 && test -s dist-scripts/reconciliation-pack.mjs && test -s dist-scripts/read-sync-status.mjs && test -s dist-scripts/render-managed-crontab.mjs
# Files Next's file tracing cannot see (dynamic paths). pdfkit reads its built-in font metrics with
# `fs.readFileSync(__dirname + '/data/<font>.afm')`; make sure the data directory is in the
# standalone tree whether or not tracing picked it up. sharp's native binaries (@img/sharp-*) are
# traced as an external package; the smoke test and `find` below assert they are present.
RUN mkdir -p .next/standalone/node_modules/pdfkit/js/data \
 && cp -a node_modules/pdfkit/js/data/. .next/standalone/node_modules/pdfkit/js/data/ \
 && find .next/standalone/node_modules/@img -maxdepth 1 -name 'sharp-linux-*' | grep -q .

# --------------------------------------------------------------------------------------------
# migrate: Prisma CLI only. A fresh, minimal npm tree pinned to the versions in package.json
# (not the whole app node_modules). `prisma migrate deploy` reads prisma.config.ts, which imports
# `dotenv` and `prisma/config`, and takes DATABASE_URL from the environment.
# --------------------------------------------------------------------------------------------
FROM base AS migrate-deps
WORKDIR /opt/prisma
# Install exact versions of prisma and dotenv as pinned in package-lock.json's top-level package.
COPY package-lock.json /tmp/app-package-lock.json
RUN --mount=type=cache,target=/root/.npm \
    PRISMA_V="$(node -p "require('/tmp/app-package-lock.json').packages['node_modules/prisma'].version")" \
 && DOTENV_V="$(node -p "require('/tmp/app-package-lock.json').packages['node_modules/dotenv'].version")" \
 && npm init -y >/dev/null \
 && npm install --no-audit --no-fund --legacy-peer-deps "prisma@${PRISMA_V}" "dotenv@${DOTENV_V}"

FROM base AS migrate
# The Prisma schema engine links against OpenSSL, which the slim base does not ship.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1001 ims \
 && useradd --uid 1001 --gid ims --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ims
WORKDIR /opt/prisma
COPY --from=migrate-deps --chown=1001:1001 /opt/prisma/node_modules ./node_modules
COPY --chown=1001:1001 prisma ./prisma
COPY --chown=1001:1001 prisma.config.ts package.json ./
ENV NODE_ENV=production \
    HOME=/tmp \
    PATH=/opt/prisma/node_modules/.bin:$PATH
USER 1001:1001
# DATABASE_URL (and optionally SHADOW_DATABASE_URL, unused by `migrate deploy`) come from the environment.
CMD ["prisma", "migrate", "deploy", "--config", "prisma.config.ts"]

# --------------------------------------------------------------------------------------------
# runtime: the standalone server. Intentionally has no full node_modules: .next/standalone carries
# the traced subset it needs (including pg and @prisma/adapter-pg, which are pure JS; Prisma 7 has
# no query-engine binary). Defined last so a plain `docker build .` produces this image.
# --------------------------------------------------------------------------------------------
FROM base AS runtime
# PostgreSQL 17 client tools from the PGDG repository (bookworm's own client is 15, and pg_dump must be at least the
# server's major version; production runs 17). Needed at run time: the backup routes run `pg_dump` and the restore
# route runs `psql`. curl and gnupg are used only to fetch and install the signing key and are purged again.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y --auto-remove curl gnupg \
 && rm -rf /var/lib/apt/lists/* \
 && pg_dump --version | grep -q ' 17\.' \
 && groupadd --gid 1001 ims \
 && useradd --uid 1001 --gid ims --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ims \
 && install -d -o ims -g ims -m 0750 \
      /app \
      /var/lib/onetwoinventory \
      /var/lib/onetwoinventory/backups \
      /var/lib/onetwoinventory/uploads \
      /var/lib/onetwoinventory/public-uploads \
      /var/lib/onetwoinventory/invoice-pdfs
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HOME=/tmp \
    BACKUP_DIR=/var/lib/onetwoinventory/backups \
    UPLOAD_STORAGE_DIR=/var/lib/onetwoinventory/uploads \
    PUBLIC_UPLOAD_STORAGE_DIR=/var/lib/onetwoinventory/public-uploads \
    INVOICE_PDF_STORAGE_DIR=/var/lib/onetwoinventory/invoice-pdfs

# Standalone server + its traced node_modules (server.js, package.json, .next/server, node_modules).
COPY --from=build --chown=1001:1001 /app/.next/standalone ./
# Not part of standalone output by design: static assets and public files.
COPY --from=build --chown=1001:1001 /app/.next/static ./.next/static
COPY --from=build --chown=1001:1001 /app/public ./public
# Read from disk at request time via process.cwd() (dynamic paths tracing cannot see):
#   app/actions/help.ts                         -> help-docs/
#   app/api/woocommerce/helper-plugin/route.ts  -> lib/connectors/woocommerce/wp-plugin/
COPY --from=build --chown=1001:1001 /app/help-docs ./help-docs
COPY --from=build --chown=1001:1001 /app/lib/connectors/woocommerce/wp-plugin ./lib/connectors/woocommerce/wp-plugin
# The bundled scripts that server code starts as children (see the build stage). /app itself is owned by `ims`: the
# reconciliation pack refuses to run unless the running uid is root or owns the checkout root, and here that is /app.
COPY --from=build --chown=1001:1001 /app/dist-scripts ./dist-scripts
# Next writes its image/fetch cache under .next/cache.
RUN install -d -o ims -g ims /app/.next/cache

USER 1001:1001
EXPOSE 3000
VOLUME ["/var/lib/onetwoinventory"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login',{redirect:'manual'}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
