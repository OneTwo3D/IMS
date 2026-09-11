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
 * o3d-remove-shiphero round 4 (Codex HIGH 3 + HIGH 4) — WHY THIS READS THE REAL PARSE TREE.
 * Round 2 and round 3 hand-rolled the lexing: a character state machine blanked comments,
 * and a regex scraped the id list out of its source. Both were wrong in the same direction,
 * which is the only direction that matters for a guard — BLIND:
 *
 *   - the state machine had no notion of a regex literal or of JSX text, so
 *     `const r = /[//]mintsoft/` and `<div>https://mintsoft</div>` both looked like the
 *     start of a line comment. The connector literal was blanked, the scanner reached the
 *     newline in a normal state, the promised "mis-parse → scan raw" fallback never fired,
 *     and the guard exited 0 with a live literal sitting in a protected generic file;
 *   - the id scraper pulled QUOTED STRINGS out of the `WMS_CONNECTOR_IDS` initializer and
 *     hard-failed only when it found NONE. `['mintsoft', ACME_WMS_ID] as const` yielded one
 *     id, so a registered `acme-wms` literal passed the generic layer undetected — the
 *     precise failure the "derived, not copied" list was introduced to prevent. The ids it
 *     did find were then interpolated into a regex UNESCAPED, so an id like `acme+wms`
 *     parsed fine and then matched nothing.
 *
 * A guard that cannot fail is worse than no guard, because it is believed. So the tokenizer
 * is gone rather than patched. The repo already depends on the TypeScript compiler, and the
 * compiler already knows what a comment, a regex literal, a template span and a JSX text
 * node are:
 *
 *   - WHAT IS SCANNED is every LEAF TOKEN of the real parse tree. Comments are trivia and
 *     are not tokens, so they are excluded by construction rather than by a rule — and
 *     regex literals, JSX text and template chunks are included by construction, because
 *     they are tokens. There are no special cases left to get wrong.
 *   - WHAT IS SCANNED FOR is resolved from the parse tree of `WMS_CONNECTOR_IDS` too. Every
 *     element must be a string literal; an element this guard cannot resolve to one is a
 *     HARD FAILURE, never a silently shorter list.
 *   - HOW IT MATCHES is a case-insensitive substring test, not a regex. Nothing is
 *     interpolated into a pattern, so an id containing `+`, `.`, `(` or `|` matches itself
 *     and only itself.
 *
 * WHAT IS SCANNED THERE, AND WHAT IS NOT. Inside the generic layer the guard reads CODE
 * only: the parse tree's tokens, which excludes comments. A comment has no behaviour — it
 * cannot pin a generic code path to one warehouse — and the doc comments in that layer
 * necessarily narrate which connector a rule was learned from ("Mintsoft's Order/List caps
 * Limit at 100", "ShipHero was removed in …"). Deleting that history to satisfy a grep would
 * make the layer harder to maintain and no more generic. Outside that layer NOTHING is
 * exempt: core flows are scanned raw, comments included, because a core flow has no business
 * naming a warehouse at all.
 * If a file the parser reports ANY syntax diagnostic for is scanned RAW, so a file this guard
 * cannot parse can only make it stricter, never blinder.
 *
 * Per-line waiver: add `// wms-connector-boundary-ok: <ticket-or-date>: <reason>`
 * on the same line as the reference or the line immediately above it.
 *
 * Run via `npm run check:wms-connector-boundary`; invoked by `npm run check:all`.
 * Its can-fail proofs live in tests/scripts/wms-connector-boundary-guard.test.ts.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
const SCAN_ROOTS = ['app', 'lib', 'components']
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
// 'generated' skips app/generated/** (the Prisma client embeds the full schema as
// a string, including model doc-comments that legitimately name connectors).
const SKIPPED_DIRECTORIES = new Set(['.git', '.next', 'node_modules', 'build', 'dist', 'out', 'coverage', 'generated'])

/**
 * Every REGISTERED WMS connector literal, RESOLVED OUT OF the id list itself so a newly
 * registered connector cannot enter the build unscanned. A REMOVED connector's name is
 * deliberately absent: prose that explains why a generic rule exists by naming the
 * connector it came from is history, not a leak.
 */
const WMS_CONNECTOR_IDS_FILE = 'lib/connectors/wms/types.ts'

/** Unwrap `as const`, `satisfies …` and parentheses to reach the array literal underneath. */
function unwrapExpression(node) {
  let current = node
  for (;;) {
    if (ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression
      continue
    }
    if (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current)) {
      current = current.expression
      continue
    }
    return current
  }
}

/**
 * The connector ids, read through the COMPILER rather than scraped with a regex.
 *
 * Every element must resolve to a string literal. An element that does not — an imported
 * constant, a spread, a computed expression — is a HARD FAILURE: the guard would otherwise
 * carry on with a shorter list and report "clean" about the very connector whose id it could
 * not read, which is the o3d-remove-shiphero round 3 defect verbatim.
 */
function readConnectorLiterals() {
  let source
  try {
    source = readFileSync(join(ROOT, WMS_CONNECTOR_IDS_FILE), 'utf8')
  } catch (error) {
    throw new Error(
      `cannot read ${WMS_CONNECTOR_IDS_FILE} to derive the WMS connector literals: ${error.message}`,
    )
  }
  const sourceFile = ts.createSourceFile(
    WMS_CONNECTOR_IDS_FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  )
  const diagnostics = sourceFile.parseDiagnostics ?? []
  if (diagnostics.length > 0) {
    throw new Error(
      `${WMS_CONNECTOR_IDS_FILE} does not parse (${diagnostics.length} syntax diagnostic(s)); `
      + 'this guard resolves what it scans for from that file and will not run on a list it cannot read.',
    )
  }

  let declaration = null
  const findDeclaration = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'WMS_CONNECTOR_IDS') {
      declaration = node
    }
    ts.forEachChild(node, findDeclaration)
  }
  findDeclaration(sourceFile)

  if (!declaration || !declaration.initializer) {
    throw new Error(
      `could not find \`export const WMS_CONNECTOR_IDS = [...] as const\` in ${WMS_CONNECTOR_IDS_FILE}. `
      + 'This guard derives what it scans for from that list; refusing to run with an empty one, because '
      + 'an empty scan passes everything.',
    )
  }

  const initializer = unwrapExpression(declaration.initializer)
  if (!ts.isArrayLiteralExpression(initializer)) {
    throw new Error(
      `\`WMS_CONNECTOR_IDS\` in ${WMS_CONNECTOR_IDS_FILE} is not an array literal `
      + `(got \`${initializer.getText(sourceFile)}\`) — this guard cannot resolve the ids it must scan for.`,
    )
  }

  const ids = initializer.elements.map((element) => {
    if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
      return element.text
    }
    throw new Error(
      `\`WMS_CONNECTOR_IDS\` element \`${element.getText(sourceFile)}\` in ${WMS_CONNECTOR_IDS_FILE} `
      + 'does not resolve to a string literal. This guard refuses to scan for a list it cannot read in '
      + 'full: a short list reports "clean" about precisely the connector whose id it dropped. Write the '
      + 'id as a literal in this array.',
    )
  })
  if (ids.length === 0) {
    throw new Error(`WMS_CONNECTOR_IDS in ${WMS_CONNECTOR_IDS_FILE} resolved to zero ids — refusing to scan for nothing.`)
  }
  for (const id of ids) {
    if (id.trim() === '') {
      throw new Error(`WMS_CONNECTOR_IDS in ${WMS_CONNECTOR_IDS_FILE} contains a blank id — a blank matches every line.`)
    }
  }
  return ids
}

const CONNECTOR_LITERALS = readConnectorLiterals()
const CONNECTOR_LITERALS_LOWER = CONNECTOR_LITERALS.map((id) => id.toLowerCase())
const WAIVER_RE = /wms-connector-boundary-ok:\s*[^:\s]+:\s*\S+/i

/**
 * Every offset in `text` at which a connector literal occurs, case-insensitively.
 *
 * A SUBSTRING SEARCH, DELIBERATELY NOT A REGEX. The previous guard built one pattern by
 * joining the ids with `|`, which made an id containing a regex metacharacter (`acme+wms`,
 * `acme.wms`) match something other than itself — silently, and in the permissive direction.
 * Nothing here is compiled, so an id matches itself and only itself.
 */
function literalOffsets(text) {
  const lower = text.toLowerCase()
  const offsets = []
  for (const literal of CONNECTOR_LITERALS_LOWER) {
    let at = lower.indexOf(literal)
    while (at !== -1) {
      offsets.push(at)
      at = lower.indexOf(literal, at + 1)
    }
  }
  return offsets
}

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
 *
 * NOT HERE ANY MORE, deliberately (o3d-remove-shiphero round 4, Codex HIGH 2):
 * app/actions/wms-sync.ts and app/actions/wms-onboarding.ts. Both were one-arm dispatchers
 * — `connectorId === 'mintsoft' ? … : null` — behind a DTO with a literal `mintsoft:` member
 * the dashboard and the onboarding wizard read by name. The DTO is now keyed BY CONNECTOR
 * and both facades route on `hooks.syncDashboard` / `hooks.onboarding`, so neither file
 * spells a connector id at all. o3d-ph1y is closed.
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
  // o3d-remove-shiphero round 2 — ONE FILE THAT IS CONNECTOR-SPECIFIC DESPITE WHERE IT SITS.
  //
  // A named FILE, never its directory, and listed because its CONTENT is one warehouse's — not
  // because it lives somewhere convenient. Removing the blanket exemptions on lib/domain/wms/ and
  // the wms-* facades is what made it visible in the first place.
  //
  // booked-in-service.ts IS Mintsoft's booked-in webhook processor (it queries
  // `connector: 'mintsoft'` and writes Mintsoft-worded receipts); it is misfiled under
  // lib/domain/wms/ and belongs under lib/connectors/mintsoft/ — tracked in o3d-c79v.
  'lib/domain/wms/booked-in-service.ts',
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
 * The generic WMS layer: scanned for connector literals in CODE, with COMMENTS excluded.
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

function scriptKindFor(relPath) {
  switch (extname(relPath)) {
    case '.tsx': return ts.ScriptKind.TSX
    case '.ts': return ts.ScriptKind.TS
    case '.jsx': return ts.ScriptKind.JSX
    default: return ts.ScriptKind.JS
  }
}

/**
 * The 0-based line numbers on which a connector literal appears in CODE, read off the real
 * parse tree. `null` means "this file could not be parsed cleanly" — the caller then scans it
 * RAW, which is strictly stricter.
 *
 * Only LEAF TOKENS are inspected. That single rule is what replaces the whole hand-rolled
 * tokenizer: comments are trivia and never tokens, so they drop out by construction; regex
 * literals, JSX text and the text chunks of a template literal ARE tokens, so they are scanned
 * by construction. Neither behaviour is a special case any more, which is why neither can be
 * forgotten.
 */
function codeLinesWithLiteral(relPath, source) {
  const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, scriptKindFor(relPath))
  if ((sourceFile.parseDiagnostics ?? []).length > 0) return null

  const lines = new Set()
  const visit = (node) => {
    // A JSDoc block is a COMMENT that the parser happens to model as nodes (and hangs off the
    // declaration it documents). It has no behaviour, so it is excluded here for exactly the
    // reason `//` and `/* */` are — this is the one place the "tokens only" rule needs saying
    // out loud, because these particular comments arrive wearing node kinds.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    const children = node.getChildren(sourceFile)
    if (children.length === 0) {
      // getStart() skips leading trivia, so a comment attached to this token is not read.
      const start = node.getStart(sourceFile)
      const text = source.slice(start, node.getEnd())
      for (const offset of literalOffsets(text)) {
        lines.add(sourceFile.getLineAndCharacterOfPosition(start + offset).line)
      }
      return
    }
    for (const child of children) visit(child)
  }
  visit(sourceFile)
  return lines
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
  // The generic layer is read as CODE; everywhere else, and anywhere the parser reported a
  // syntax diagnostic for, is read whole.
  let matchedLines = isCommentExempt(relPath) ? codeLinesWithLiteral(relPath, source) : null
  if (matchedLines === null) {
    matchedLines = new Set()
    for (let i = 0; i < rawLines.length; i += 1) {
      if (literalOffsets(rawLines[i]).length > 0) matchedLines.add(i)
    }
  }

  const findings = []
  for (const i of [...matchedLines].sort((a, b) => a - b)) {
    const onLine = WAIVER_RE.test(rawLines[i] ?? '')
    const onPrev = i > 0 && WAIVER_RE.test(rawLines[i - 1] ?? '')
    if (onLine || onPrev) continue
    findings.push({ path: relPath, line: i + 1, text: (rawLines[i] ?? '').trim() })
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
