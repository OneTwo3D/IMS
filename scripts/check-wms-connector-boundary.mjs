#!/usr/bin/env node

/**
 * Static guard: keeps the 3PL/WMS layer connector-agnostic by blocking any WMS
 * connector literal (`mintsoft`, …) from leaking into code that is supposed to be
 * generic — both the CORE app flows (sales / PO / transfer / stock / onboarding /
 * settings / sync wiring / fulfillment) AND the generic WMS layer itself
 * (lib/domain/wms/, the wms-* server-action facades, lib/cron-jobs/wms.ts,
 * lib/jobs/wms/). Everything there must go through the generic WMS boundary — the
 * WmsConnector contract (lib/connectors/wms/types.ts), the WMS registry, and the
 * connector definition's own wiring — never a connector-specific branch.
 * See docs/wms-connector-boundary.md.
 *
 * o3d-remove-shiphero round 2 (Codex HIGH 3) — WHY THE GENERIC LAYER IS NOW SCANNED.
 * This guard used to allowlist all of `lib/domain/wms/`, `lib/jobs/wms/` and the three
 * `wms-*` facades outright. That is the layer the guard exists to protect, so exempting
 * it meant the only thing it could ever detect was a leak into a file nobody expected to
 * touch a WMS at all — and it is exactly why the Mintsoft-pinned ASN dispatch, the
 * Mintsoft-pinned inbound-delta cursor wiring and the Mintsoft-pinned maintenance recheck
 * all passed it for months. A guard that exempts the thing it protects proves an adjacent
 * property.
 *
 * WHAT IS SCANNED THERE, AND WHAT IS NOT. Inside the generic layer the guard reads CODE
 * only: string/identifier text with comments blanked out (see stripComments). A comment
 * has no behaviour — it cannot pin a generic code path to one warehouse — and the doc
 * comments in that layer necessarily narrate which connector a rule was learned from
 * ("Mintsoft's Order/List caps Limit at 100", "ShipHero was removed in …"). Deleting that
 * history to satisfy a grep would make the layer harder to maintain and no more generic.
 * Outside that layer NOTHING is exempt: core flows are scanned raw, comments included,
 * because a core flow has no business naming a warehouse at all.
 * If the comment tokenizer cannot make sense of a file it scans that file RAW, so a
 * mis-parse can only make this guard stricter, never blinder.
 *
 * THE LITERAL LIST IS DERIVED, NOT COPIED. `CONNECTOR_LITERALS` is parsed out of
 * `WMS_CONNECTOR_IDS` in lib/connectors/wms/types.ts — the single list every registry,
 * type guard and resolver already reads. It used to be a hand-maintained copy, which
 * meant registering a second connector silently added a literal nothing scanned for:
 * the guard would have gone on passing precisely as the abstraction started to matter.
 * A parse that yields nothing is a hard failure, never an empty scan.
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
// 'generated' skips app/generated/** (the Prisma client embeds the full schema as
// a string, including model doc-comments that legitimately name connectors).
const SKIPPED_DIRECTORIES = new Set(['.git', '.next', 'node_modules', 'build', 'dist', 'out', 'coverage', 'generated'])

/**
 * Every REGISTERED WMS connector literal, READ OUT OF the id list itself so a newly
 * registered connector cannot enter the build unscanned. A REMOVED connector's name is
 * deliberately absent: prose that explains why a generic rule exists by naming the
 * connector it came from is history, not a leak.
 */
const WMS_CONNECTOR_IDS_FILE = 'lib/connectors/wms/types.ts'
function readConnectorLiterals() {
  let source
  try {
    source = readFileSync(join(ROOT, WMS_CONNECTOR_IDS_FILE), 'utf8')
  } catch (error) {
    throw new Error(
      `cannot read ${WMS_CONNECTOR_IDS_FILE} to derive the WMS connector literals: ${error.message}`,
    )
  }
  const block = source.match(/export\s+const\s+WMS_CONNECTOR_IDS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/)
  if (!block) {
    throw new Error(
      `could not find \`export const WMS_CONNECTOR_IDS = [...] as const\` in ${WMS_CONNECTOR_IDS_FILE}. `
      + 'This guard derives what it scans for from that list; refusing to run with an empty one, because '
      + 'an empty scan passes everything.',
    )
  }
  const ids = [...block[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2])
  if (ids.length === 0) {
    throw new Error(`WMS_CONNECTOR_IDS in ${WMS_CONNECTOR_IDS_FILE} parsed to zero ids — refusing to scan for nothing.`)
  }
  return ids
}

const CONNECTOR_LITERALS = readConnectorLiterals()
const CONNECTOR_LITERAL_RE = new RegExp(CONNECTOR_LITERALS.join('|'), 'i')
const WAIVER_RE = /wms-connector-boundary-ok:\s*[^:\s]+:\s*\S+/i

/**
 * Paths where a WMS connector literal is legitimately allowed, IN FULL — comments and
 * code alike. A scanned file is exempt when its repo-relative path starts with one.
 *
 * These are the places where naming the connector IS the content:
 *
 * The connector implementation + its per-connector ingress:
 *   lib/connectors/mintsoft/, app/actions/mintsoft-sync.ts, app/api/cron/mintsoft-*,
 *   app/api/webhooks/mintsoft/, app/api/e2e/mintsoft, app/api/export/mintsoft-sync/,
 *   app/api/admin/wms/, lib/cron-jobs/wms-mintsoft.ts,
 *   lib/jobs/wms/process-mintsoft-* (the per-connector inbound-event worker).
 * The DEFINITION SITES of the id itself — a registry that could not spell the id it
 * registers would not be a registry:
 *   lib/connectors/wms/types.ts (WMS_CONNECTOR_IDS), lib/connectors/wms/registry.ts.
 * Per-connector UI panels / connector registry / enable toggle (parallel to woo/xero):
 *   app/(dashboard)/sync/mintsoft-client.tsx, mintsoft-courier-map.tsx,
 *   wms-sync-panel.tsx, sync-dashboard.tsx, app/(dashboard)/settings/system/page.tsx,
 *   components/onboarding/wms-onboarding-connection.tsx,
 *   components/settings/integration-plugins-settings.tsx.
 * Per-connector ops/security probes + cosmetic/plugin registry:
 *   lib/ops/health.ts, lib/ops/rollout-readiness.ts, lib/security/route-auth-policy.ts,
 *   lib/security/public-route-security-policy.ts, lib/integration-plugins.ts,
 *   lib/integration-plugin-keys.ts, lib/integration-connection-test-gate.ts,
 *   lib/settings-store.ts, lib/releases.ts, lib/domain/integrations/outbox-registry.ts.
 * Plugin-enable persistence that enumerates every connector (woo/shopify/xero/qb/wms):
 *   app/actions/onboarding.ts (saveOnboardingPluginState).
 *
 * NOT HERE ANY MORE, deliberately (o3d-remove-shiphero round 2): lib/domain/wms/,
 * lib/jobs/wms/ as a whole, lib/cron-jobs/wms.ts and the three wms-* facades. That is
 * the generic layer. It is scanned — see COMMENT_EXEMPT_PREFIXES for the one narrowing.
 */
const ALLOWLIST = [
  'lib/connectors/mintsoft/',
  'lib/connectors/wms/types.ts',
  'lib/connectors/wms/registry.ts',
  'app/actions/mintsoft-sync.ts',
  'app/api/cron/mintsoft-',
  'app/api/webhooks/mintsoft/',
  'app/api/e2e/mintsoft',
  'app/api/export/mintsoft-sync/',
  'app/api/admin/wms/',
  'lib/cron-jobs/wms-mintsoft.ts',
  'lib/jobs/wms/process-mintsoft-',
  // o3d-remove-shiphero round 2 — THREE FILES THAT ARE CONNECTOR-SPECIFIC DESPITE WHERE THEY SIT.
  //
  // These are named FILES, never their directories, and each is listed because its CONTENT is one
  // warehouse's — not because it lives somewhere convenient. Removing the blanket exemptions on
  // lib/domain/wms/ and the wms-* facades is what made them visible in the first place.
  //
  // booked-in-service.ts IS Mintsoft's booked-in webhook processor (it queries
  // `connector: 'mintsoft'` and writes Mintsoft-worded receipts); it is misfiled under
  // lib/domain/wms/ and belongs under lib/connectors/mintsoft/ — tracked in o3d-vp9m.
  'lib/domain/wms/booked-in-service.ts',
  // wms-sync.ts / wms-onboarding.ts still return a DTO with a literal `mintsoft:` member that the
  // sync dashboard and the onboarding wizard read BY NAME, so the dispatch cannot move onto
  // `hooks` until that UI reads a connector-agnostic shape — tracked in o3d-vp9n. Everything else
  // these two do already routes through the registry.
  'app/actions/wms-sync.ts',
  'app/actions/wms-onboarding.ts',
  'app/(dashboard)/sync/mintsoft-client.tsx',
  'app/(dashboard)/sync/mintsoft-courier-map.tsx',
  'app/(dashboard)/sync/wms-sync-panel.tsx',
  'app/(dashboard)/sync/sync-dashboard.tsx',
  'components/onboarding/wms-onboarding-connection.tsx',
  'components/settings/integration-plugins-settings.tsx',
  'app/(dashboard)/settings/system/page.tsx',
  'lib/domain/integrations/outbox-registry.ts',
  'lib/ops/health.ts',
  'lib/ops/rollout-readiness.ts',
  'lib/security/route-auth-policy.ts',
  'lib/security/public-route-security-policy.ts',
  'lib/integration-plugins.ts',
  // The plugin setting keys, split out of lib/integration-plugins.ts so the full-chain quiesce
  // harness can name them without importing Prisma (o3d-osl8 round 6). Same registry, same reason
  // for the allowance: it IS the id→key map, so it necessarily spells every connector id.
  'lib/integration-plugin-keys.ts',
  'app/actions/onboarding.ts',
  'lib/integration-connection-test-gate.ts',
  'lib/settings-store.ts',
  'lib/releases.ts',
]

/**
 * The generic WMS layer: scanned for connector literals in CODE, with COMMENTS blanked.
 *
 * This is the narrowing that lets the layer be scanned at all rather than exempted at all
 * (which is what it was). The rule it encodes: a comment cannot pin a generic code path to
 * one warehouse, and the doc comments here are the record of WHY each generic rule exists —
 * which is inseparable from the connector whose behaviour taught it. Code is the whole of
 * what this guard is about, and in these paths code is all it reads.
 */
const COMMENT_EXEMPT_PREFIXES = [
  'lib/domain/wms/',
  'lib/connectors/wms/',
  'lib/jobs/wms/',
  'lib/cron-jobs/wms.ts',
  'app/actions/wms-asn.ts',
  'app/actions/wms-sync.ts',
  'app/actions/wms-onboarding.ts',
]

/**
 * Blank out `//` and block comments, preserving every other character's offset (and so
 * every line number), without being fooled by `'…//…'` inside a string literal.
 *
 * FAILS SAFE. TS/TSX has constructs this small tokenizer does not model — a regex literal
 * holding a quote, JSX text holding an apostrophe — and the danger from mis-lexing is
 * BLINDNESS, not noise: one unbalanced quote could swallow the rest of the file as a
 * "string" and hide every leak in it. So any sign of a mis-parse (a single/double-quoted
 * string still open at a newline, or a comment/string still open at EOF) returns null, and
 * the caller scans that file RAW instead. A mis-parse can only make this guard stricter.
 */
function stripComments(source) {
  const out = source.split('')
  let state = 'code'
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const n = source[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { out[i] = ' '; out[i + 1] = ' '; state = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { out[i] = ' '; out[i + 1] = ' '; state = 'block'; i += 2; continue }
      if (c === "'") { state = 'sq'; i += 1; continue }
      if (c === '"') { state = 'dq'; i += 1; continue }
      if (c === '`') { state = 'tpl'; i += 1; continue }
      i += 1
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; i += 1; continue }
      out[i] = ' '
      i += 1
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { out[i] = ' '; out[i + 1] = ' '; state = 'code'; i += 2; continue }
      if (c !== '\n') out[i] = ' '
      i += 1
      continue
    }
    // Inside a string literal.
    if (c === '\\') { i += 2; continue }
    if (c === '\n' && (state === 'sq' || state === 'dq')) return null // unterminated → mis-parse
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code'
      i += 1
      continue
    }
    i += 1
  }
  return state === 'code' ? out.join('') : null
}

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

function matchesPrefix(relPath, entry) {
  // Directory prefix ('…/') or an explicit filename prefix ('…mintsoft-')
  // match by startsWith; everything else is an exact file (or a directory
  // given without a trailing slash) and must match the path or a child of it,
  // so a sibling like `foo.tsx`/`foo-extra/` is NOT exempted by `foo.ts`/`foo`.
  if (entry.endsWith('/') || entry.endsWith('-')) return relPath.startsWith(entry)
  return relPath === entry || relPath.startsWith(`${entry}/`)
}

const isAllowlisted = (relPath) => ALLOWLIST.some((entry) => matchesPrefix(relPath, entry))
const isCommentExempt = (relPath) => COMMENT_EXEMPT_PREFIXES.some((entry) => matchesPrefix(relPath, entry))

function findLeaks(relPath) {
  const source = readFileSync(join(ROOT, relPath), 'utf8')
  const rawLines = source.split(/\r?\n/)
  // The generic layer is read as CODE; everywhere else, and anywhere the tokenizer
  // could not make sense of, is read whole.
  const stripped = isCommentExempt(relPath) ? stripComments(source) : null
  const searchLines = stripped === null ? rawLines : stripped.split(/\r?\n/)
  const findings = []
  for (let i = 0; i < searchLines.length; i += 1) {
    if (!CONNECTOR_LITERAL_RE.test(searchLines[i])) continue
    const onLine = WAIVER_RE.test(rawLines[i])
    const onPrev = i > 0 && WAIVER_RE.test(rawLines[i - 1])
    if (onLine || onPrev) continue
    findings.push({ path: relPath, line: i + 1, text: rawLines[i].trim() })
  }
  return findings
}

const files = SCAN_ROOTS.flatMap((root) => listFiles(root))
  .map((p) => p.split(sep).join('/'))
const findings = files
  .filter((relPath) => !isAllowlisted(relPath))
  .flatMap(findLeaks)

if (findings.length > 0) {
  console.error(`WMS connector boundary violation: a WMS connector literal (${CONNECTOR_LITERALS.join('/')}) is not allowed in core app flows or in the generic WMS layer.`)
  console.error('Route through the generic WMS boundary (WmsConnector contract + the connector definition\'s own wiring). See docs/wms-connector-boundary.md.')
  console.error('If the reference is genuinely connector-specific, add it to the allowlist in this script or add a waiver:')
  console.error('// wms-connector-boundary-ok: <ticket-or-date>: <reason>')
  console.error('')
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line}: ${finding.text}`)
  }
  process.exit(1)
}

console.log(
  `WMS connector boundary clean — scanned ${files.length} files for ${CONNECTOR_LITERALS.join('/')}, `
  + 'no connector-literal leaks outside the allowlist.',
)
