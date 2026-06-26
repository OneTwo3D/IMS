#!/usr/bin/env node

/**
 * Static guard: keeps the 3PL/WMS layer connector-agnostic by blocking the
 * `mintsoft` literal from leaking into core app flows. Core flows (sales / PO /
 * transfer / stock / onboarding / settings / sync wiring / fulfillment) must go
 * through the generic WMS boundary — the WmsConnector contract
 * (lib/connectors/wms/types.ts), the WMS registry, and the dispatch facades
 * (app/actions/wms-asn.ts, wms-sync.ts, wms-onboarding.ts) — never a
 * connector-specific branch. See docs/wms-connector-boundary.md.
 *
 * It scans app/**, lib/**, components/** for `mintsoft`/`Mintsoft` and reports
 * any reference that is NOT in an allowlisted path. Allowlisted paths are the
 * legitimate homes for the literal: the Mintsoft connector itself, its
 * per-connector ingress endpoints, the WMS dispatch facades / registry / panels
 * that resolve the active connector, the UI connector registry, and a few
 * cosmetic/plugin-registry files.
 *
 * Per-line waiver: add `// wms-connector-boundary-ok: <ticket-or-date>: <reason>`
 * on the same line as the reference or the line immediately above it.
 *
 * Run via `npm run check:wms-connector-boundary`; invoked by `npm run check:all`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'

const ROOT = process.cwd()
const SCAN_ROOTS = ['app', 'lib', 'components']
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIPPED_DIRECTORIES = new Set(['.git', '.next', 'node_modules', 'build', 'dist', 'out', 'coverage'])
const MINTSOFT_RE = /mintsoft/i
const WAIVER_RE = /wms-connector-boundary-ok:\s*[^:\s]+:\s*\S+/i

/**
 * Paths where the `mintsoft` literal is legitimately allowed. A scanned file is
 * exempt when its repo-relative path starts with any of these prefixes.
 *
 * Connector implementation + per-connector ingress (the literal IS the point):
 *   lib/connectors/mintsoft/, app/actions/mintsoft-sync.ts, app/api/cron/mintsoft-*,
 *   app/api/webhooks/mintsoft/, app/api/e2e/mintsoft, app/api/export/mintsoft-sync/,
 *   app/api/admin/wms/, lib/cron-jobs/wms-mintsoft.ts, lib/connectors/mintsoft webhook/jobs.
 * WMS boundary that resolves/dispatches to the active connector:
 *   lib/connectors/wms/, lib/cron-jobs/wms.ts, app/actions/wms-asn.ts|wms-sync.ts|wms-onboarding.ts,
 *   app/(dashboard)/sync/wms-sync-panel.tsx|mintsoft-client.tsx,
 *   components/onboarding/wms-onboarding-connection.tsx,
 *   lib/domain/wms/, lib/jobs/wms/, lib/domain/integrations/outbox-registry.ts.
 * UI connector registry / per-connector enable toggle (parallel to woo/shopify/xero):
 *   app/(dashboard)/sync/sync-dashboard.tsx, app/(dashboard)/settings/system/page.tsx,
 *   components/settings/integration-plugins-settings.tsx.
 * Per-connector ops/security probes + cosmetic/plugin registry:
 *   lib/ops/health.ts, lib/ops/rollout-readiness.ts, lib/security/route-auth-policy.ts,
 *   lib/security/public-route-security-policy.ts, lib/integration-plugins.ts,
 *   lib/integration-connection-test-gate.ts, lib/settings-store.ts, lib/releases.ts.
 * Plugin-enable persistence that enumerates every connector (woo/shopify/xero/qb/wms):
 *   app/actions/onboarding.ts (saveOnboardingPluginState).
 */
const ALLOWLIST = [
  'lib/connectors/mintsoft/',
  'lib/connectors/wms/',
  'app/actions/mintsoft-sync.ts',
  'app/actions/wms-asn.ts',
  'app/actions/wms-sync.ts',
  'app/actions/wms-onboarding.ts',
  'app/api/cron/mintsoft-',
  'app/api/webhooks/mintsoft/',
  'app/api/e2e/mintsoft',
  'app/api/export/mintsoft-sync/',
  'app/api/admin/wms/',
  'lib/cron-jobs/wms-mintsoft.ts',
  'lib/cron-jobs/wms.ts',
  'app/(dashboard)/sync/mintsoft-client.tsx',
  'app/(dashboard)/sync/mintsoft-courier-map.tsx',
  'app/(dashboard)/sync/wms-sync-panel.tsx',
  'app/(dashboard)/sync/sync-dashboard.tsx',
  'components/onboarding/wms-onboarding-connection.tsx',
  'components/settings/integration-plugins-settings.tsx',
  'app/(dashboard)/settings/system/page.tsx',
  'lib/domain/wms/',
  'lib/jobs/wms/',
  'lib/domain/integrations/outbox-registry.ts',
  'lib/ops/health.ts',
  'lib/ops/rollout-readiness.ts',
  'lib/security/route-auth-policy.ts',
  'lib/security/public-route-security-policy.ts',
  'lib/integration-plugins.ts',
  'app/actions/onboarding.ts',
  'lib/integration-connection-test-gate.ts',
  'lib/settings-store.ts',
  'lib/releases.ts',
]

function isScannedFile(file) {
  if (!SCANNED_EXTENSIONS.has(extname(file))) return false
  return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
}

function listFiles(path) {
  const fullPath = join(ROOT, path)
  let stats
  try {
    stats = statSync(fullPath)
  } catch {
    return []
  }
  if (stats.isFile()) return isScannedFile(fullPath) ? [path] : []
  if (!stats.isDirectory()) return []

  const files = []
  for (const entry of readdirSync(fullPath)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue
    files.push(...listFiles(join(path, entry)))
  }
  return files
}

function isAllowlisted(relPath) {
  return ALLOWLIST.some((entry) => {
    // Directory prefix ('…/') or an explicit filename prefix ('…mintsoft-')
    // match by startsWith; everything else is an exact file (or a directory
    // given without a trailing slash) and must match the path or a child of it,
    // so a sibling like `foo.tsx`/`foo-extra/` is NOT exempted by `foo.ts`/`foo`.
    if (entry.endsWith('/') || entry.endsWith('-')) return relPath.startsWith(entry)
    return relPath === entry || relPath.startsWith(`${entry}/`)
  })
}

function findLeaks(relPath) {
  const lines = readFileSync(join(ROOT, relPath), 'utf8').split(/\r?\n/)
  const findings = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!MINTSOFT_RE.test(lines[i])) continue
    const onLine = WAIVER_RE.test(lines[i])
    const onPrev = i > 0 && WAIVER_RE.test(lines[i - 1])
    if (onLine || onPrev) continue
    findings.push({ path: relPath, line: i + 1, text: lines[i].trim() })
  }
  return findings
}

const files = SCAN_ROOTS.flatMap((root) => listFiles(root))
  .map((p) => p.split(sep).join('/'))
const findings = files
  .filter((relPath) => !isAllowlisted(relPath))
  .flatMap(findLeaks)

if (findings.length > 0) {
  console.error('WMS connector boundary violation: the `mintsoft` literal is not allowed in core app flows.')
  console.error('Route through the generic WMS boundary (WmsConnector contract + wms-* facades). See docs/wms-connector-boundary.md.')
  console.error('If the reference is genuinely connector-specific, add it to the allowlist in this script or add a waiver:')
  console.error('// wms-connector-boundary-ok: <ticket-or-date>: <reason>')
  console.error('')
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line}: ${finding.text}`)
  }
  process.exit(1)
}

console.log(`WMS connector boundary clean — scanned ${files.length} files, no mintsoft leaks outside the allowlist.`)
