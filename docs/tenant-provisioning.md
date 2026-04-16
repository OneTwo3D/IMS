# Automated Tenant Provisioning

`scripts/provision-ims-tenant.sh` provisions a new IMS tenant end to end:

1. creates a new Proxmox LXC
2. runs the IMS installer inside that container
3. creates or updates `xxx.onetwoinventory.com` in Cloudflare DNS
4. adds either an OpenLiteSpeed or nginx reverse-proxy vhost and issues a Let's Encrypt certificate
5. seeds a default admin user
6. emails the login details to the requested address

## Assumptions

- Proxmox is managed over SSH and exposes `pct`
- the selected proxy host is managed over SSH
- for `PROXY_TYPE=ols`, OpenLiteSpeed uses `/usr/local/lsws/conf/httpd_config.conf`
- for `PROXY_TYPE=ols`, HTTP and HTTPS listeners already exist
- the target git branch is reachable from the new container
- the machine running the script has `ssh`, `scp`, `curl`, `jq`, `dig`, `git`, and `openssl`
- if `POSTGRES_MODE=external`, the machine running the script also needs `psql`

## Required environment variables

A ready-to-copy template is available at `scripts/provision-ims-tenant.env.example`.
If `scripts/provision-ims-tenant.env` exists, the provisioner loads it automatically.

```bash
export PROXMOX_HOST=proxmox.example.internal
export PROXY_TYPE=ols
export PROXY_HOST=proxy.example.internal
export PROXY_PUBLIC_IP=203.0.113.10
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ZONE_ID=...
export LXC_TEMPLATE=local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst
export LXC_STORAGE=local-lvm
export ADMIN_EMAIL=admin@acme.example
export NOTIFICATION_EMAIL=ops@acme.example
export LETSENCRYPT_EMAIL=ops@onetwoinventory.com
export SMTP_HOST=smtp.postmarkapp.com
export SMTP_FROM_EMAIL=ims@onetwoinventory.com
```

`TENANT_SLUG` is optional. If omitted, the provisioner generates a unique funny two-word slug such as `milo-otter` and uses `milo-otter.onetwoinventory.com`.
`LXC_ID` is also optional. If omitted, the provisioner asks Proxmox for the next available container ID.
Use `TENANT_DOMAIN` when you want an explicit full domain instead of `TENANT_SLUG + DOMAIN_SUFFIX`.

## Common optional variables

```bash
export ADMIN_NAME="Acme IMS Admin"
export TENANT_SLUG=acme
export DEFAULT_ADMIN_PASSWORD='set-a-known-password'
export SMTP_PORT=587
export SMTP_USER=...
export SMTP_PASS=...
export SMTP_SECURE=tls
export SMTP_FROM_NAME='One Two Inventory'
export SMTP_REPLY_TO=support@onetwoinventory.com
export GIT_REPO_URL=git@github.com:your-org/onetwoinventory.git
export GIT_BRANCH=main
export APP_PORT=3000
export INSTALL_SSHD=y
export SSH_AUTHORIZED_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... you@example'
export RESUME_ONLY=n
export TENANT_DOMAIN=ims.example.com
export POSTGRES_MODE=external
export DB_HOST=10.0.3.20
export DB_PORT=5432
export DB_ADMIN_USER=postgres
export DB_ADMIN_PASSWORD=...
export REDIS_MODE=disabled
export PROXY_TYPE=nginx
export NGINX_HOST=nginx.example.internal
export NGINX_PUBLIC_IP=203.0.113.11
export LXC_BRIDGE=vmbr0
export LXC_CORES=4
export LXC_MEMORY_MB=4096
export LXC_SWAP_MB=1024
export LXC_DISK_GB=32
export LXC_IP_CIDR=10.0.3.15/24
export PROXY_SSH_USER=root
export OLS_HTTP_LISTENER=Default
export OLS_HTTPS_LISTENER=SSL
export CLOUDFLARE_PROXIED=false
```

To enable shared Redis explicitly:

```bash
export REDIS_MODE=external
export REDIS_HOST=10.0.3.21
export REDIS_PORT=6379
export REDIS_KEY_PREFIX=acme
```

## Run

```bash
cp scripts/provision-ims-tenant.env.example scripts/provision-ims-tenant.env
# edit the file
bash scripts/provision-ims-tenant.sh
```

## Notes

- The installer now runs `npm ci` with dev dependencies because Prisma and the operational bootstrap tooling require them during deployment.
- If you do not set `DEFAULT_ADMIN_PASSWORD`, the provisioner generates one for that run and uses it in the email.
- If `LXC_HOSTNAME` is blank, the container hostname defaults to `TENANT_SLUG`.
- `LXC_IP_CIDR` lets you assign a static container IP instead of using DHCP.
- `RESUME_ONLY=y` skips LXC creation entirely and only reconciles install, DNS, and proxy setup for an already-existing container ID.
- `INSTALL_SSHD=y` installs OpenSSH inside the new LXC. If `SSH_AUTHORIZED_KEY` is set, the installer writes it to `root`'s `authorized_keys` and disables SSH password authentication.
- `POSTGRES_MODE=local` installs PostgreSQL inside the new LXC. `POSTGRES_MODE=external` creates the database and user on the existing PostgreSQL server defined in the env file, then points the new IMS instance at it.
- `REDIS_MODE=disabled` is now the default for single-instance installs.
- `REDIS_MODE=local` installs `redis-server` inside the new LXC and points IMS at `localhost`.
- `REDIS_MODE=external` builds `REDIS_URL` from `REDIS_HOST`/`REDIS_PORT`/`REDIS_DB` if you do not set `REDIS_URL` directly.
- `REDIS_KEY_PREFIX` defaults to `TENANT_SLUG` and is written into the tenant `.env` so Redis-backed features can namespace keys per tenant.
- `PROXY_TYPE=ols` uses the OpenLiteSpeed configuration branch. `PROXY_TYPE=nginx` uses an nginx vhost plus `certbot --nginx`.
- The install step stores `public_app_url` and SMTP settings in the IMS settings table so the fresh instance has its public URL and outbound mail defaults from the start.
- The OpenLiteSpeed automation assumes listener names `Default` and `SSL`. Override them if your host uses different listener names.
