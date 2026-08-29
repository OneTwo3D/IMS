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

## Tuning notes

- **Writable paths**: `ProtectSystem=strict` makes everything read-only except the
  `.next` cache and the uploads dirs listed in the unit. If you relocate uploads
  via `UPLOAD_STORAGE_DIR` / `PUBLIC_UPLOAD_STORAGE_DIR`, update `ReadWritePaths`
  (or add another `StateDirectory`) to match.
- **`StateDirectory` is load-bearing beyond backups**: the crontab reconciliation
  lock lives at `$STATE_DIRECTORY/.crontab-reconcile.lock`
  (`lib/crontab-reconcile-lock.ts`, and the matching `flock` in
  `scripts/install.sh`). systemd creates the directory, owns it to `User=`, and
  adds it to `ReadWritePaths` implicitly, so it is the only path both the
  application and the installer can derive *and* write under
  `ProtectSystem=strict` — a lock beside the app cannot be created at all.
  Dropping `StateDirectory=` from the unit does not fail at deploy time; it fails
  at the first scheduler save, which then refuses and reports that the scheduler
  may be behind.
- **Sandbox validation**: `systemd-analyze security ims-stage` scores the unit;
  aim to keep it in the "OK"/"exposed" range or better.
- Do **not** add `MemoryDenyWriteExecute=true` — it breaks the V8 JIT and the
  process will crash on start.
