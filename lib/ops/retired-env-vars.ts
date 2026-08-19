// Environment variables that were once documented as controls but that no code
// reads (o3d-tj6v, o3d-esha). Removing them from .env.example / CLAUDE.md /
// docs/installation.md / scripts/install.sh stops NEW operators being misled,
// but every host already provisioned by scripts/install.sh still has these
// lines in its .env and no way to tell that setting them does nothing. Naming
// them here turns a silent no-op into a statement the operator can act on.
//
// Each value says where the real control lives. Values are never echoed: some
// of these (REDIS_PASSWORD, XERO_CLIENT_SECRET, SMTP_PASSWORD) hold secrets.
//
// This file is deliberately the ONLY place these names appear in TypeScript,
// and scripts/check-documented-env-vars.mjs excludes it from its read scan.
// Every name here is by definition read by nothing; letting the guard count
// these mentions as reads would blind it to exactly the defect it exists for.
//
// AND THAT EXCLUSION IS WHY A NAME HERE IS A PERMANENT EXEMPTION, not a note. A variable
// listed here is invisible to the guard for ever: nothing will tell you when it becomes
// read again. XERO_TENANT_ID was on this list and had to LEAVE it, because o3d-9tbz (merged)
// made it live as a single-organisation form of XERO_ALLOWED_TENANT_IDS. Adding a name here
// to silence the guard is therefore not a fix — it is an exemption, and the fix is almost
// always to stop DOCUMENTING the variable (or, as with XERO_TOKEN_PATH, to stop the installer
// WRITING it).
export const RETIRED_ENV_VARS: Readonly<Record<string, string>> = {
  WC_SYNC_STATUSES: 'The order status filter is the wc_sync_order_statuses setting, edited in Settings -> Sync -> WooCommerce.',
  WC_USE_WEBHOOKS: 'There is no webhooks-or-polling switch: webhook events are accepted whenever a WooCommerce webhook secret is configured, and the wc-reconcile cron polls regardless.',
  WC_POLL_INTERVAL_MINUTES: 'The polling cadence is the wc-reconcile cron schedule, edited in Settings -> Cron.',
  XERO_CLIENT_ID: 'The Xero OAuth client id is the xero_client_id setting, entered in Settings -> Integrations -> Xero.',
  XERO_CLIENT_SECRET: 'The Xero OAuth client secret is the xero_client_secret setting, entered in Settings -> Integrations -> Xero. Remove this copy: it is a credential in a file nothing opens.',
  XERO_TOKEN_PATH: 'Xero access and refresh tokens are stored encrypted in Postgres. There is no token file, so do not scope backups or incident response around this path.',
  FX_BASE_CURRENCY: 'The base currency is Organisation.baseCurrency, set once in Settings -> Company.',
  UPLOAD_MAX_SIZE_MB: 'Upload size caps are per-kind constants in code (10 MB CSV import, 2 MB avatar, 5 MB logo, 20 MB supplier invoice); lowering this value never restricted anything.',
  PDF_TEMP_DIR: 'Generated PDFs are never written to disk; lib/pdf.ts buffers them in memory.',
  UPLOAD_TEMP_DIR: 'Temporary upload and scan paths come from os.tmpdir().',
  LOG_LEVEL: 'There is no logger module and no log configuration: output is plain console.* at fixed severity, so this cannot raise or lower verbosity.',
  LOG_FORMAT: 'There is no logger module and no log configuration; log output format is not configurable.',
  SMTP_PASSWORD: 'The SMTP password variable is spelled SMTP_PASS, and it is an install-time seed only — runtime mail settings live in Settings -> Email.',
}
