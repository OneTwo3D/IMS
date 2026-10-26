# Deployment — systemd units

## Units

| Unit | Purpose | Status |
|------|---------|--------|
| `systemd/ims-stage.service` | Production build (`next start`) as a non-root, loopback-only, sandboxed service | **Current** |
| `systemd/ims-stage-dev.service` | `next dev` as root on `0.0.0.0` | **Deprecated — do not run on any internet-facing host** (see `onetwo3d-ims-k0ei` / `dg42`) |

The dev unit ran the Next.js development server as **root**, in `NODE_ENV=development`,
bound to `0.0.0.0` behind the public staging hostname. Dev mode leaks stack traces
and source to clients, is not DoS-hardened, and a dev-cache corruption took staging
fully down during the security review. `ims-stage.service` replaces it.

## One-time migration to `ims-stage.service`

1. **Create the service user** (no login shell, no home):
   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin ims
   ```

2. **Relocate the app out of `/root`** (a non-root user cannot read under `/root`):
   ```bash
   sudo mkdir -p /opt/ims
   sudo git clone git@github.com:OneTwo3D/IMS.git /opt/ims/IMS   # or move existing tree
   sudo ln -s /opt/ims/IMS/onetwo3d-ims /opt/ims/onetwo3d-ims    # if using the subdir layout
   sudo chown -R ims:ims /opt/ims
   ```

3. **Install deps and build a production bundle** (as the service user):
   ```bash
   sudo -u ims bash -lc 'cd /opt/ims/onetwo3d-ims && npm ci && npm run build'
   ```
   `next start` requires the `.next` build output; the unit's `ExecStartPre`
   asserts it exists and refuses to start otherwise.

4. **Environment**: place the real `.env` at `/opt/ims/onetwo3d-ims/.env`, owned
   `ims:ims`, mode `600`. It must set a strong `AUTH_SECRET`
   (`openssl rand -base64 32` — see `onetwo3d-ims-ey8j`) and
   `SETTINGS_ENCRYPTION_KEY`. `BACKUP_DIR` is pointed at the managed
   `StateDirectory` by the unit. Xero tokens are encrypted in Postgres, not on
   disk, so nothing under `StateDirectory` needs to be scoped around them
   (o3d-esha).

5. **Confirm the reverse proxy** terminates TLS for the public hostname and
   forwards to `127.0.0.1:3000`. The app no longer listens on `0.0.0.0`.

6. **Cut over**:
   ```bash
   sudo systemctl disable --now ims-stage-dev
   sudo cp deploy/systemd/ims-stage.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now ims-stage
   sudo systemctl status ims-stage
   ```

7. **Verify** login and `/api/health` recover after a restart:
   ```bash
   sudo systemctl restart ims-stage
   curl -sf http://127.0.0.1:3000/api/health && echo OK
   ```

## Redeploying after code changes

```bash
sudo -u ims bash -lc 'cd /opt/ims/onetwo3d-ims && git pull && npm ci && npm run build'
sudo systemctl restart ims-stage
```

The `restart` is not optional and `start` will not do: a running process is not
replaced by a `start`, so a rebuilt tree with the old process still up leaves
that process on whatever crontab lock path the *old* build derived — while
anything that reconciles the crontab afterwards (a scheduler save, or
`scripts/install.sh`) locks the new one. Two locks that do not exclude each
other silently lose one side's managed block. A hand-deploy must not skip it.

`scripts/install.sh` reaches the same end by a different route and needs no
`restart` of its own: it **stops** the service before the migration and refuses
to continue while the port is still bound, so its later `start` acts on a
stopped unit. It then *proves* the result rather than assuming it — it fetches
`/_next/static/<BUILD_ID>/`, a route only the process whose own build id is that
one serves, and aborts before the crontab section if anything else answers.
Nothing here does that for you, which is why the `restart` above is the whole
guarantee.

## Tuning notes

- **Writable paths**: `ProtectSystem=strict` makes everything read-only except the
  `.next` cache and the uploads dirs listed in the unit. If you relocate uploads
  via `UPLOAD_STORAGE_DIR` / `PUBLIC_UPLOAD_STORAGE_DIR`, update `ReadWritePaths`
  (or add another `StateDirectory`) to match.
- **`StateDirectory` is load-bearing beyond backups**: the crontab reconciliation
  lock lives at `$STATE_DIRECTORY/locks/.crontab-reconcile.lock`
  (`lib/crontab-reconcile-lock.ts`, and the matching `flock` in
  `scripts/install.sh`). The `locks/` directory and the file in it are
  `root:root` on an installed host — the service opens the lock read-only,
  because `flock(2)` ignores the access mode, and so nothing root writes there
  sits on a path the service user could replace with a symlink. systemd creates the directory, owns it to `User=`, and
  adds it to `ReadWritePaths` implicitly, so it is the only path both the
  application and the installer can derive *and* write under
  `ProtectSystem=strict` — a lock beside the app cannot be created at all.
  Dropping `StateDirectory=` from the unit does not fail at deploy time; it fails
  at the first scheduler save, which then refuses and reports that the scheduler
  may be behind.
- **The Scheduler needs the `crontab` group, and `NoNewPrivileges` can stay**:
  `/usr/bin/crontab` is setgid `crontab` and the spool is `drwx-wx--T root:crontab`,
  so the binary reaches the spool only through that group. `NoNewPrivileges=true`
  makes the kernel ignore setuid/setgid bits on exec, so without help the service
  user runs `crontab` as plain `User=`/`Group=` and gets `Permission denied` on
  both `crontab -l` and `crontab -`. The unit therefore carries
  `SupplementaryGroups=crontab` and `ReadWritePaths=/var/spool/cron/crontabs`.
  A supplementary group is *granted* by systemd before the exec rather than
  *gained* by it, which is why `NoNewPrivileges=true` stays — it is not the thing
  being relaxed. What is conceded is that the service can create files in the
  shared cron spool; it still cannot read or replace another user's crontab (no
  `r` on the directory, and it is sticky), and Debian cron refuses a spool file
  whose owner does not match the user it is named for. Remove both lines on an
  install that does not use Settings → System → Scheduler and let
  `scripts/install.sh` own the crontab instead.
- **Sandbox validation**: `systemd-analyze security ims-stage` scores the unit;
  aim to keep it in the "OK"/"exposed" range or better.
- Do **not** add `MemoryDenyWriteExecute=true` — it breaks the V8 JIT and the
  process will crash on start.

## Container image

A CI-built, production-shaped image of IMS. It is built by `.github/workflows/image.yml`
from the repo-root `Dockerfile` and published to GHCR on every push to `development` and
`main` (pull requests build and smoke-test but never push). Nothing about the existing
`next start` unit or the stage host changes: `next.config.ts` only emits a standalone
bundle when `NEXT_OUTPUT=standalone`, and only the Dockerfile's build stage sets it.

| Image | Dockerfile target | Tags |
|-------|-------------------|------|
| `ghcr.io/onetwo3d/ims` | `runtime` (default) | `<full-git-sha>`, `development` or `main` |
| `ghcr.io/onetwo3d/ims-migrate` | `migrate` | `<full-git-sha>`, `development` or `main` |

Deploy by the full-SHA tag; the moving tags exist for convenience only.

### What is in each target

- **`runtime`**: Next.js standalone server (`node server.js`) on `0.0.0.0:3000`, running as
  non-root uid/gid 1001 `ims`, base `node:22-bookworm-slim`. It does **not** carry the full
  `node_modules`: only what Next's file tracing put in `.next/standalone`. Prisma 7 has no
  query-engine binary, and `pg` / `@prisma/adapter-pg` are pure JS, so nothing native is needed
  for the database. `HEALTHCHECK` is `GET /login` expecting 200 (done with `node`; there is no
  `curl`). Persistent state lives under `/var/lib/onetwoinventory/{backups,uploads,public-uploads,invoice-pdfs}`
  (a declared `VOLUME`, pre-owned by uid 1001; the matching `*_DIR` variables default to these).
- **`migrate`**: the Prisma CLI (version taken from `package-lock.json`), `dotenv`, `prisma/`
  and `prisma.config.ts`, plus `openssl` for the schema engine. Its default command is
  `prisma migrate deploy`. Run it against the target database **before** starting the new
  runtime image.

Copied into `runtime` by hand because tracing cannot see them (dynamic paths):

| Path | Why |
|------|-----|
| `.next/static`, `public/` | By design not part of standalone output |
| `help-docs/` | `app/actions/help.ts` reads it via `process.cwd()` |
| `lib/connectors/woocommerce/wp-plugin/` | `app/api/woocommerce/helper-plugin/route.ts` serves it via `process.cwd()` |
| `node_modules/pdfkit/js/data/` | pdfkit reads its built-in font metrics with `__dirname + '/data/*.afm'` |
| `dist-scripts/*.mjs` | Built in the build stage with esbuild (see below); not traced because they are started as child processes |

The build stage also asserts that `@img/sharp-linux-*` (sharp's native binary) was traced into
the bundle. `public/uploads` is deliberately excluded (see `.dockerignore`): uploads are
runtime state, supplied through the volume above.

### External programs the server starts

Every `child_process` call in `app/` and `lib/` was checked:

| Program | Used by | In the image? |
|---------|---------|---------------|
| `pg_dump` | manual backup (`/api/backup/create`) and scheduled backup (`/api/cron/backup`) | Yes: `postgresql-client-17` from the PGDG apt repository (bookworm's own client is 15 and `pg_dump` must be at least the server's version; production runs 17). The build fails if `pg_dump --version` is not 17. |
| `psql` | backup restore (`/api/backup/restore`) | Yes, same package |
| `flock` | the crontab/reconcile lock helper | Yes: `util-linux`, part of the base image |
| `crontab` | in-app Scheduler reconciliation (`lib/crontab-reconcile*.ts`) | No: there is no cron daemon in the container. Schedule the cron endpoints externally with `CRON_SECRET` |
| file scanner (for example `clamscan`) | `lib/security/file-scan.ts`, only when `FILE_SCAN_COMMAND` / `FILE_SCAN_COMMAND_ARGV` is configured | No: none is configured by default. Deployments that enable upload scanning must supply the scanner (a derived image or a sidecar) |
| `git` | `lib/ops/build-identity.ts`, used only by the operator readiness-gate commands | No: those commands are not run from the container |
| `npm` / `tsx` | the readiness-gate commands, and the reconciliation pack child (below) | No: replaced by pre-bundled scripts where the server needs them |

### Scripts the server starts as children

`/api/cron/reconciliation-pack` normally runs `npm run reconcile:pack` (`tsx scripts/reconciliation-pack.ts`), and that
command in turn runs `npm run read-sync:status`. The image has no `scripts/` tree and no `tsx`, so the build stage bundles those
two entry points with esbuild into self-contained files, `/app/dist-scripts/reconciliation-pack.mjs` and
`/app/dist-scripts/read-sync-status.mjs`. `lib/ops/readiness-gate-collect.ts` (`bundledScriptPath`) runs `node <bundle>` when
`<cwd>/dist-scripts/<file>` exists for one of those two scripts, and `npm run <script>` otherwise, so the stage host and
checkouts are unchanged. `/app` is owned by the `ims` user because the pack only runs when the running uid is root or owns the
checkout root. Its reports go to `/var/tmp/ims-reconciliation-pack-reports` inside the container (not a declared volume;
mount one there to keep them). The container smoke test runs the pack through the cron route.

### Cron runs on the host, not in the container

The container never runs its own scheduler: it has no cron daemon and no `crontab` binary, and a blue/green deploy briefly runs two
containers, which would fire every job twice. The host's cron calls the cron endpoints with `CRON_SECRET`; installing it is the
host's responsibility. The in-app Scheduler's "Save & Apply" therefore has nothing to write to.

**Production layout: one file, `/etc/cron.d/onetwo3d-ims`.** The rendered block is installed directly as the file host cron reads
(cron.d layout, with a user field), and the IMS container mounts that same host file read-only, so the state the status reader sees
IS the installed cron config; there is no separate copy. Requirements for the file: owned by `root:root`, mode `0644`, and a name
with no dots (cron ignores `cron.d` files whose names contain a dot; the reader refuses such a name too).

The read-sync status and the reconciliation pack need to know that the host really schedules the jobs, because an unreadable
scheduler makes every reconciliation item inconclusive. They read the cron text from a file when told to:

| Variable | Meaning |
|----------|---------|
| `IMS_SCHEDULER_CRONTAB_FILE` | Absolute path, inside the container, of the installed host file. Set: the file is the only source, and a missing, unreadable, oversized or relative-path file is a failure (the scheduler reads as unreadable), never an empty crontab. Unset: `crontab -l` is used exactly as before (stage hosts, checkouts). |
| `IMS_SCHEDULER_CRONTAB_FORMAT` | `cron.d` for production: the file is read as cron reads it, `m h dom mon dow USER command`. The user field is removed before the managed block is checked; a job line with no valid user field is dropped (cron would run the first word of the command as the user), so it reads as unscheduled; a file name cron would ignore is refused, and so is a file cron itself would ignore (not a regular file with one link, not owned by root, or writable by group or others; the container sees the host's own owner and mode bits through the mount). `user` (the default) is the text `crontab -l` prints and is for stage hosts and checkouts. |

The block must be the one the in-app scheduler writes (`# --- OTI CRON START ---` ... `END`), byte for byte, because a job counts as
scheduled only if the exact generated lines are present. The image ships the generator, so the file can be produced without a
checkout. It reads the SAVED scheduler settings (which jobs are enabled and their schedules, from Settings > System > Scheduler)
from the database with the app's own reader, so it needs `DATABASE_URL`; a job with no saved row uses its registry default, exactly
as the in-app writer does. The output starts with a comment line saying where the values came from.

Install (render to a temporary file, validate it, then install it atomically):

```bash
tmp=$(mktemp) && docker run --rm --network <db-network> -e DATABASE_URL --entrypoint node ghcr.io/onetwo3d/ims:<sha> \
  /app/dist-scripts/render-managed-crontab.mjs --format cron.d --cron-user root \
  --base-url http://127.0.0.1:3000 --secret-file /etc/ims/cron.env --log-path /var/log/ims/cron.log > "$tmp" \
  && [ "$(grep -c '^# --- OTI CRON \(START\|END\) ---$' "$tmp")" = 2 ] \
  && install -m 0644 -o root -g root "$tmp" /etc/cron.d/onetwo3d-ims && rm -f "$tmp"
```

Mount the DIRECTORY, not the file: `install` replaces the file (a new inode), and a single-file bind mount keeps pointing at the old
one. Mounting `/etc/cron.d` read-only at, say, `/host-cron.d` and setting
`IMS_SCHEDULER_CRONTAB_FILE=/host-cron.d/onetwo3d-ims` `IMS_SCHEDULER_CRONTAB_FORMAT=cron.d` sees every reinstall at once.

**In container mode, Save only records the settings.** The Scheduler page's Save & Apply (and every other save that used to rewrite
the crontab) cannot change host cron: it commits the settings, runs no `crontab`, and reports a warning, never a success: "Host cron
update pending: the host must re-render and install /etc/cron.d/onetwo3d-ims". The page also shows whether host cron is "in sync" or
"out of date (N jobs differ)" by comparing the saved settings with the mounted file. The host applies a change by re-rendering and
installing the file with the command below. A later deployment task will add a host timer that does this automatically every few
minutes when the rendered output changes; until that exists, it is manual. Container mode is `IMS_SCHEDULER_CRONTAB_FILE` set together
with `IMS_SCHEDULER_CRONTAB_FORMAT=cron.d`; on a stage host (the `user` layout, `crontab -l`) Save & Apply still rewrites the crontab as
before. Schedules are validated against the real cron field ranges (minute 0-59, hour 0-23, day of month 1-31, month 1-12, day of week 0-7; `*`, lists, ranges and steps, no names or macros): Save refuses an invalid one, the renderer refuses to render a saved one (naming the job and field), and the reader treats an installed line with one as unreadable, because cron silently ignores such a line.
The same drift check is available from the image: `docker exec <ims> node /app/dist-scripts/render-managed-crontab.mjs --check`
(exit 0 in sync, 1 out of date).

**Re-render and reinstall after ANY scheduler change in Settings (a job switched on or off, a schedule edited), and after every
deploy** (a new image can register new jobs), using the command above. Until you do, host cron keeps firing the old schedule and the
status reader reports the changed jobs as unscheduled. `--defaults-only` renders every job on at its registry default WITHOUT reading
the database (for a host that has no database yet); its output says `DEFAULTS ONLY` on the first line and will drift from Settings
as soon as anything is saved. For a stage host or any account crontab, omit `--format` (the `user` layout, the text `crontab -l`
prints) and install it with `crontab`.

Each rendered line reads `CRON_SECRET=` from the secret file named by `--secret-file` when it fires. Requirements for that file on
the host:

- path: the one passed to `--secret-file` (convention: `/etc/ims/cron.env`), containing a line `CRON_SECRET=<the app's CRON_SECRET>`;
- mode `0600`, owned by the account whose crontab (or `cron.d` entry) runs the jobs;
- check, run as that account: `test -r /etc/ims/cron.env && grep -q '^CRON_SECRET=.\{32,\}' /etc/ims/cron.env && echo ok`.

A missing or unreadable file does not send an unauthenticated request: the job sends nothing, `grep` reports the error on stderr
(cron mails it) and the job log gets `cron-auth: CRON_SECRET is missing or unusable ... was not run`. The job's exit status is still
0, so watch the job log (or the Read-Sync Liveness Alarm), not the exit status. The container smoke test executes a rendered line
with the secret file present (the backup runs) and absent (it is refused with that output), and runs a real Debian cron daemon
over the installed `/etc/cron.d/onetwo3d-ims` (a saved every-minute schedule) and asserts the daemon fired the job and the endpoint
completed it.

Not available inside the container: the in-app Scheduler's `crontab` reconciliation (see above).

### Required runtime environment

All supplied at `docker run` / compose time. The image contains no secrets and no `.env`.

| Variable | Notes |
|----------|-------|
| `DATABASE_URL` | PostgreSQL connection string (also needed by the `migrate` image) |
| `AUTH_SECRET` | Session signing secret |
| `AUTH_URL`, `NEXT_PUBLIC_APP_URL` | Public origin; the two must share an origin |
| `SETTINGS_ENCRYPTION_KEY` | AES-256 key (32 raw bytes, base64 of 32 bytes, or 64 hex chars) |
| `CRON_SECRET` | At least 32 characters; the server refuses to start in production without it |

Everything else in `.env.example` is optional and applies as it does elsewhere. Connector
credentials (WooCommerce, Mintsoft, Xero) are normally entered in the app and stored encrypted in
Postgres. A fresh install should also set `PRODUCER_HOLD_ENFORCED_DESTINATIONS=all` until the
connectors are deliberately released (see `lib/security/producer-seam.ts`); the outbound-write
hold already refuses every write by default.

### Smoke test

```bash
docker build --target migrate -t ims-migrate:local .
docker build --target runtime -t ims:local .
scripts/container-smoke.sh ims:local ims-migrate:local
```

The script starts `postgres:17` on a private network, runs the migrate image against it, starts
the runtime image with the minimal environment above (throwaway generated secrets, no connector
credentials, `PRODUCER_HOLD_ENFORCED_DESTINATIONS=all`), and polls `http://127.0.0.1:3000/login`
for 90 s (`SMOKE_PORT`, `SMOKE_TIMEOUT_S` override). Once `/login` answers 200 it also runs a scheduled backup through
`/api/cron/backup` (asserting a non-empty `pg_dump` file in the backup directory and restoring it with the image's `psql` into a
scratch database), and the reconciliation pack through `/api/cron/reconciliation-pack` (asserting the child ran and ended with a
closed outcome, not a start failure); it needs `jq` on the host. It exits 0 only if all of that holds, always removes
what it created, and prints the runtime container's logs on failure. CI also runs it against
`busybox:latest` and requires that run to fail, so the test cannot pass vacuously.

### Secrets are never baked in

The repository is public. `.dockerignore` keeps `.env*`, key material, `.git`, tests, docs,
archives and upload/backup directories out of the build context, and the Dockerfile has no
secret-bearing `ENV` or `ARG`. The one placeholder `DATABASE_URL` used during `next build` is an
inline dummy on that single `RUN` and is not present in the image.
