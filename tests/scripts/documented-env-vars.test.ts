import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  collectDocumentedKeys,
  collectReadKeys,
  evaluateEnvVarDocumentation,
  extractEnvAccessKeys,
  extractEnvFileKeys,
  extractMarkdownTableKeys,
  extractReadKeys,
  extractSettingEnvFallbackKeys,
  extractShellEnvHeredocKeys,
  isOperatorFacingFile,
  loadAllowlist,
} from '../../scripts/check-documented-env-vars.mjs'

import { RETIRED_ENV_VARS } from '@/lib/ops/retired-env-vars'

const EMPTY_ALLOWLIST = { documentedButUnread: {}, undocumentedReads: {} }

function documentedMap(entries: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(entries))
}

// ---------------------------------------------------------------------------
// The defect the guard exists to catch
// ---------------------------------------------------------------------------

test('guard fails on a documented environment variable that nothing reads, naming every source', () => {
  const documented = documentedMap({
    WC_SYNC_STATUSES: ['.env.example', 'CLAUDE.md', 'scripts/install.sh'],
    DATABASE_URL: ['.env.example'],
  })
  const read = new Set(['DATABASE_URL'])

  const { failures } = evaluateEnvVarDocumentation(documented, read, EMPTY_ALLOWLIST)

  assert.deepEqual(failures, [
    { name: 'WC_SYNC_STATUSES', sources: ['.env.example', 'CLAUDE.md', 'scripts/install.sh'] },
  ])
})

test('guard would have caught o3d-tj6v from the documentation as it stood', () => {
  // Verbatim: .env.example:121, the CLAUDE.md WooCommerce table row, and the
  // install.sh .env heredoc, as they were before o3d-tj6v deleted them.
  const envExample = [
    '# WooCommerce order status that triggers sync into IMS (comma-separated)',
    '# Default: processing. Other options: on-hold, completed',
    'WC_SYNC_STATUSES=processing',
  ].join('\n')
  const claudeMd = [
    '| Variable | Required | Description | Example |',
    '|----------|----------|-------------|---------|',
    '| `WC_SYNC_STATUSES` | No | Order statuses to sync (comma-separated) | `processing` (default: on-hold, completed) |',
  ].join('\n')
  const installSh = [
    'cat > "${APP_DIR}/.env" <<EOF',
    'WC_WEBHOOK_SECRET=${WC_WEBHOOK_SECRET}',
    'WC_SYNC_STATUSES=processing',
    'EOF',
  ].join('\n')

  assert.ok(extractEnvFileKeys(envExample).has('WC_SYNC_STATUSES'))
  assert.ok(extractMarkdownTableKeys(claudeMd).has('WC_SYNC_STATUSES'))
  assert.ok(extractShellEnvHeredocKeys(installSh).has('WC_SYNC_STATUSES'))

  // The real control was the DB setting; no code mentioned the variable at all.
  const read = extractReadKeys(`
    const statusesSetting = await db.setting.findUnique({ where: { key: 'wc_sync_order_statuses' } })
  `)
  assert.equal(read.has('WC_SYNC_STATUSES'), false)
})

// ---------------------------------------------------------------------------
// False positives are the failure mode: a prior guard fired on `psql` and
// `prisma migrate` picked out of doc comments.
// ---------------------------------------------------------------------------

test('documentation extraction ignores prose, commands and inline code spans', () => {
  const prose = [
    'Restore the database with `psql` and then run `prisma migrate deploy`.',
    'Run `npm run check:all` before opening a PR. See DATABASE_URL notes above.',
    '- Check query performance: `PRISMA_SLOW_QUERY_THRESHOLD_MS=500 npm run dev`',
    '> `WC_SYNC_STATUSES`, `WC_USE_WEBHOOKS` and `WC_POLL_INTERVAL_MINUTES` were documented here',
    '> and read by nothing.',
    'Set NODE_ENV=production in your shell before running the migration.',
  ].join('\n')

  assert.deepEqual([...extractMarkdownTableKeys(prose)], [])
  assert.deepEqual([...extractEnvFileKeys(prose)], [])
  assert.deepEqual([...extractShellEnvHeredocKeys(prose)], [])
})

test('markdown extraction reads the first table cell only, not descriptions', () => {
  const table = [
    '| Variable | Required | Description | Example |',
    '|----------|----------|-------------|---------|',
    '| `SMTP_PASS` | No | SMTP password (spelled `SMTP_PASS`, not `SMTP_PASSWORD`) | app password |',
    '| `NODE_ENV` | Yes | Runtime environment. Set with `NODE_ENV=production` | `production` |',
  ].join('\n')

  const keys = extractMarkdownTableKeys(table)

  assert.deepEqual([...keys].sort(), ['NODE_ENV', 'SMTP_PASS'])
  // The correction "not SMTP_PASSWORD" documents the WRONG name; treating it as
  // documentation of SMTP_PASSWORD would re-raise the defect it just fixed.
  assert.equal(keys.has('SMTP_PASSWORD'), false)
})

test('markdown extraction ignores tables that are not environment variables', () => {
  const table = [
    '| Method | Path | Purpose |',
    '|--------|------|---------|',
    '| `POST` | `/api/cron/fx-rates` | Fetch FX |',
    '| `GET` | `/api/health` | Liveness |',
    '| `SQL` | n/a | raw query |',
  ].join('\n')

  assert.deepEqual([...extractMarkdownTableKeys(table)], [])
})

test('a commented-out .env assignment is a deprecation note, not documentation', () => {
  const text = [
    '# Xero tokens are stored in the database. This legacy path is no longer used.',
    '# XERO_TOKEN_PATH=/var/lib/onetwoinventory/xero-token.json',
    '# CSP_MODE=report-only',
    'DATABASE_URL=postgresql://user:pass@localhost:5432/ims',
  ].join('\n')

  assert.deepEqual([...extractEnvFileKeys(text)], ['DATABASE_URL'])
})

test('installer prompts and shell locals are not documentation; only the .env heredoc is', () => {
  const installSh = [
    'prompt APP_DOMAIN "Public domain" ""',
    'INTERNAL_TEMP_DIR=/tmp/build',
    'cat > "${APP_DIR}/.env" <<EOF',
    'NODE_ENV=production',
    'DATABASE_URL=${DATABASE_URL}',
    'EOF',
    'AFTER_HEREDOC=not-documentation',
  ].join('\n')

  assert.deepEqual([...extractShellEnvHeredocKeys(installSh)].sort(), ['DATABASE_URL', 'NODE_ENV'])
})

// ---------------------------------------------------------------------------
// Read detection: generous on purpose, because reads hide behind indirection
// ---------------------------------------------------------------------------

test('read detection sees the indirect access patterns this codebase actually uses', () => {
  const code = `
    const MINTSOFT_USE_BULK_ASN_LOOKUP_ENV = 'MINTSOFT_USE_BULK_ASN_LOOKUP'
    const raw = env[MINTSOFT_USE_BULK_ASN_LOOKUP_ENV]
    const ttl = env.INVOICE_PDF_TOKEN_TTL_SECONDS
    const ips = parseEnvList('TRUSTED_PROXY_IPS')
    const url = process.env['DATABASE_URL']
    const mode = process.env.FILE_SCAN_MODE
  `

  const keys = extractReadKeys(code)

  for (const name of [
    'MINTSOFT_USE_BULK_ASN_LOOKUP',
    'INVOICE_PDF_TOKEN_TTL_SECONDS',
    'TRUSTED_PROXY_IPS',
    'DATABASE_URL',
    'FILE_SCAN_MODE',
  ]) {
    assert.ok(keys.has(name), `${name} should be detected as read`)
  }
})

test('read detection ignores mentions that appear only in comments', () => {
  const code = [
    '/**',
    ' * WC_SYNC_STATUSES used to be documented here.',
    ' */',
    '// LOG_FORMAT is not read by anything.',
    "const url = process.env.DATABASE_URL",
  ].join('\n')

  const keys = extractReadKeys(code)

  assert.equal(keys.has('WC_SYNC_STATUSES'), false)
  assert.equal(keys.has('LOG_FORMAT'), false)
  assert.ok(keys.has('DATABASE_URL'))
})

// ---------------------------------------------------------------------------
// ...but generous must stop short of "merely NAMED counts as read", or the
// guard passes on exactly the defect it exists to catch.
// ---------------------------------------------------------------------------

test('a TRAILING comment mention is not a read', () => {
  // The o3d-esha sweep left comments like this in the files the guard scans, so
  // re-documenting any of these variables would have passed the check on the
  // strength of the note explaining that nothing reads them.
  const code = [
    'const port = 587 // SMTP_PORT is an install-time seed, not a runtime input',
    'const level = 3 /* LOG_LEVEL is read by nothing */',
    'const mode = process.env.FILE_SCAN_MODE',
  ].join('\n')

  const keys = extractReadKeys(code)

  assert.equal(keys.has('SMTP_PORT'), false)
  assert.equal(keys.has('LOG_LEVEL'), false)
  assert.ok(keys.has('FILE_SCAN_MODE'))
})

test('stripping a trailing comment does not mangle a URL inside a string', () => {
  // This is why trailing comments used to be left alone: a line-based strip cuts
  // `https://` in half, and mangling a line can only DELETE a real read — which
  // is a false positive, the failure mode this guard cannot afford.
  const code = [
    "const base = 'https://store.example/wp-json' // WC_STORE_URL is a seed",
    "const key = parseEnvList('TRUSTED_PROXY_IPS')",
  ].join('\n')

  const keys = extractReadKeys(code)

  assert.ok(keys.has('TRUSTED_PROXY_IPS'), 'the read after the URL line survives')
  assert.equal(keys.has('WC_STORE_URL'), false)
})

test('a name buried in a longer string is not a read; a string that IS the name is', () => {
  const code = [
    "throw new Error('UPLOAD_MAX_SIZE_MB was documented and read by nothing')",
    "const ips = parseEnvList('TRUSTED_PROXY_IPS')",
    "const MODE_ENV = 'MINTSOFT_AUTH_MODE'",
  ].join('\n')

  const keys = extractReadKeys(code)

  // No read can arrive with the name glued into a sentence: every indirect read
  // in this codebase passes the exact name and nothing else.
  assert.equal(keys.has('UPLOAD_MAX_SIZE_MB'), false)
  assert.ok(keys.has('TRUSTED_PROXY_IPS'))
  assert.ok(keys.has('MINTSOFT_AUTH_MODE'))
})

test('a regex containing a backtick does not swallow the reads that follow it', () => {
  // Every guard added here has to answer for its own false positives. A quote
  // inside a regex literal is ordinary code, but to a scanner that does not know
  // it is in a regex it opens a literal — and a BACKTICK opens one that does not
  // end at the newline, so it blanks everything up to the next backtick in the
  // file and deletes every read in between.
  const code = [
    "const plain = value.replace(/`/g, '')",
    'const url = process.env.DATABASE_URL',
    "const dir = process.env['BACKUP_DIR']",
    'const label = `store: ${plain}`',
  ].join('\n')

  const keys = extractReadKeys(code)

  assert.ok(keys.has('DATABASE_URL'))
  assert.ok(keys.has('BACKUP_DIR'))
})

test('an apostrophe in JSX text does not blank the reads after it', () => {
  // The scanner cannot know a quote opened a string until it finds the closing
  // one. An apostrophe in prose never gets a partner, so the blanking has to be
  // undone rather than left in place — otherwise the rest of the line is gone.
  const code = "const el = <p>Don't forget to set DATABASE_URL and BACKUP_DIR</p>"

  const keys = extractReadKeys(code)

  assert.ok(keys.has('DATABASE_URL'))
  assert.ok(keys.has('BACKUP_DIR'))
})

test('a template literal with a substitution is scanned as code, not swallowed', () => {
  const code = [
    'const sql = `select value from settings where key = ${KEY_COLUMN}`',
    'const secret = process.env.CRON_SECRET',
  ].join('\n')

  const keys = extractReadKeys(code)

  assert.ok(keys.has('KEY_COLUMN'), 'the substitution is code')
  assert.ok(keys.has('CRON_SECRET'), 'the line after the template still reads')
})

test('the inverse report sees SETTING_ENV_FALLBACKS entries, which literal matching cannot', () => {
  const settingsStore = `
    export const SETTING_ENV_FALLBACKS: Partial<Record<string, string>> = {
      mintsoft_api_key: 'MINTSOFT_API_KEY',
      wc_url: 'WC_STORE_URL',
    }
    export const SENSITIVE_SETTING_KEYS = new Set(['mintsoft_api_key'])
  `

  // getEnvFallback reads process.env[envKey] through a variable, so the literal
  // access matcher finds nothing at all here.
  assert.deepEqual([...extractEnvAccessKeys(settingsStore)], [])
  assert.deepEqual([...extractSettingEnvFallbackKeys(settingsStore)].sort(), ['MINTSOFT_API_KEY', 'WC_STORE_URL'])
})

test('the inverse report covers the operator-facing surface, not the test harness', () => {
  assert.equal(isOperatorFacingFile('lib/mailer.ts'), true)
  assert.equal(isOperatorFacingFile('scripts/provision-instance.mjs'), true)
  assert.equal(isOperatorFacingFile('tests/scripts/documented-env-vars.test.ts'), false)
  assert.equal(isOperatorFacingFile('e2e/full-chain/harness/ims.ts'), false)
  assert.equal(isOperatorFacingFile('scripts/check-documented-env-vars.mjs'), false)
  assert.equal(isOperatorFacingFile('playwright.full-chain.config.ts'), false)
})

test('the inverse report names read-but-undocumented variables without failing the check', () => {
  const documented = documentedMap({ DATABASE_URL: ['.env.example'] })
  const read = new Set(['DATABASE_URL', 'MINTSOFT_API_KEY'])

  const { failures, warnings } = evaluateEnvVarDocumentation(documented, read, EMPTY_ALLOWLIST, read)

  assert.deepEqual(failures, [])
  assert.deepEqual(warnings, [{ name: 'MINTSOFT_API_KEY' }])
})

// ---------------------------------------------------------------------------
// Allowlist: a suppression must be a decision someone wrote down
// ---------------------------------------------------------------------------

test('allowlist suppresses a documented-but-unread variable', () => {
  const documented = documentedMap({ APP_PORT: ['scripts/install.sh'] })

  const { failures } = evaluateEnvVarDocumentation(documented, new Set(), {
    documentedButUnread: { APP_PORT: 'Consumed by scripts/update.sh and the installer, not by application code.' },
    undocumentedReads: {},
  })

  assert.deepEqual(failures, [])
})

test('an allowlist entry that is no longer documented, or is now read, fails as stale', () => {
  const allowlist = {
    documentedButUnread: {
      GONE_FROM_DOCS: 'This variable was deleted from every documentation source months ago.',
      NOW_WIRED_UP: 'This variable was unread when the exemption was written down here.',
    },
    undocumentedReads: {},
  }
  const documented = documentedMap({ NOW_WIRED_UP: ['.env.example'] })

  const { staleAllowlistEntries } = evaluateEnvVarDocumentation(documented, new Set(['NOW_WIRED_UP']), allowlist)

  assert.deepEqual(staleAllowlistEntries.map((entry) => entry.name), ['GONE_FROM_DOCS', 'NOW_WIRED_UP'])
})

test('an allowlist entry without a substantive reason is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-env-allowlist-'))
  try {
    await mkdir(path.join(root, 'scripts'), { recursive: true })
    const file = path.join(root, 'scripts/documented-env-var-allowlist.json')

    await writeFile(file, JSON.stringify({ documentedButUnread: { APP_PORT: 'shell only' } }))
    assert.throws(() => loadAllowlist(root), /APP_PORT needs a reason of at least 24 characters/)

    await writeFile(file, JSON.stringify({
      documentedButUnread: { APP_PORT: 'Consumed by scripts/update.sh and the installer, not by application code.' },
    }))
    assert.deepEqual(Object.keys(loadAllowlist(root).documentedButUnread), ['APP_PORT'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The guard against blinding the guard
// ---------------------------------------------------------------------------

test('lib/ops/retired-env-vars.ts is excluded from the read scan', () => {
  const { read } = collectReadKeys()

  // Every name in the retired list is by definition read by nothing. If that
  // file were scanned, its own mentions would register as reads and the guard
  // would pass forever on any variable someone re-documented.
  const leaked = Object.keys(RETIRED_ENV_VARS).filter((name) => read.has(name))
  assert.deepEqual(leaked, [])
})

test('the repository currently has no documented environment variable that nothing reads', () => {
  const documented = collectDocumentedKeys()
  const { read, envAccessed } = collectReadKeys()
  const { failures, staleAllowlistEntries } = evaluateEnvVarDocumentation(
    documented,
    read,
    loadAllowlist(),
    envAccessed,
  )

  assert.deepEqual(failures.map((failure) => failure.name), [])
  assert.deepEqual(staleAllowlistEntries.map((entry) => entry.name), [])
  assert.ok(documented.size > 50, 'documentation extraction should find the whole env surface')
})
