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
 * o3d-remove-shiphero round 8 (Codex HIGH 3) — WHAT THE ROUND-6 FOLD STILL GOT WRONG, AND THE RULE
 * THAT ENDS THE SEQUENCE.
 *
 * Rounds 3 through 7 each closed the spelling that had just been found and each revealed another.
 * Round 8 closed four more, but the interesting one is the first, because it is not a missing
 * feature — it is a WRONG ANSWER:
 *
 *   - ARITHMETIC IS NOT CONCATENATION. Round 6 folded every binary `+` as string concatenation, so
 *     `String.fromCharCode(100+9,100+5,100+10,100+16,100+15,100+11,100+2,100+16)` — which spells a
 *     connector id at runtime — folded its arguments to `1009`, `1005`, … and produced eight
 *     unrelated characters, EXACTLY, with no finding. "Cannot evaluate" is reported; "evaluated,
 *     confidently, to the wrong value" is not, which makes it the worst failure a fold has
 *     available. Folds now carry a `numeric` flag and the `+` rule reads the operand types.
 *   - THE FOLD'S UNIVERSE IS THE REPO, NOT ONE FILE. `import { TAIL } from './ids'; 'mint' + TAIL`
 *     used to fold to `'mint'`, because an unresolvable operand reads as the empty string and the
 *     folder never opened another file. Repo imports (`./`, `../`, `@/`) are now FOLLOWED, through
 *     named and star re-exports, with cycles terminating as a reject. A repo constant it cannot
 *     follow to a value is a FINDING. A PACKAGE import is neither followed nor reported —
 *     node_modules is not scanned at all, so requiring evaluability of it would be a rule this
 *     guard never applies.
 *   - WHAT IT CANNOT EVALUATE, IT REJECTS — and the rule is deliberately not a list of methods.
 *     A CONSTANT this fold has already evaluated, put through an operation it cannot evaluate
 *     (`.replace`, `.padStart`, `.normalize`, whatever is written next), yields an unknown value of
 *     unknown length and is reported. Modelling `.replace` would have closed one member of an
 *     unbounded family; that is the sequence rounds 3–7 kept losing. The receiver must FOLD, so
 *     ordinary code — which transforms runtime DATA, not literals — is untouched. Measured across
 *     956 files when it landed: two findings, both waived in place.
 *   - `Buffer.from(x, 'base64')` is EVALUATED rather than rejected, because `atob` was already
 *     modelled and this is the same operation under another name. An encoding it cannot resolve
 *     makes it a reject, not a pass.
 *
 * WHERE THE LINE SITS, AND WHY. An operand that is a CONSTANT EXPRESSION must be evaluable or it is
 * a finding. An operand that is runtime DATA — a parameter, a call result — reads as the empty
 * string. Rejecting every `+` with a non-constant operand was measured at 3,009 sites across 956
 * files (1,977 with a string literal on one side); a guard that fires on three thousand lines gets
 * allowlisted into silence, which is how you end up with no guard at all.
 *
 * o3d-remove-shiphero round 6 (Codex HIGH 2) — WHY IT EVALUATES EXPRESSIONS, NOT TOKENS.
 * The round-4 rewrite inspects each leaf token INDEPENDENTLY, which is the same blindness one
 * level up: `const id = 'mint' + 'soft'` is two tokens, neither containing the id, and
 * `'\x6dintsoft'` is one token whose SOURCE TEXT is not the id while its VALUE is. Both exited 0
 * with a live connector literal in a protected generic file. So a second, purely ADDITIVE pass
 * folds CONSTANT STRING EXPRESSIONS — concatenation, templates, escapes, in-file consts and enum
 * members, `[...].join()`, `String.fromCharCode`, `atob`/`decodeURIComponent` — and matches the
 * VALUE. What it cannot evaluate it treats conservatively: an unknown operand reads as the empty
 * string (so `'mint' + x + 'soft'` is a finding), and a construct that can glue or mint characters
 * out of pieces the guard cannot see at all is REJECTED on its own (five waivers in this tree).
 * See the block above `scriptKindFor` for the full rule, and docs/wms-connector-boundary.md for
 * the spellings that remain out of reach.
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
import { dirname, extname, join, sep } from 'node:path'
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
 * Per-connector UI panels / connector registry (parallel to woo/xero):
 *   app/(dashboard)/sync/mintsoft-client.tsx, mintsoft-courier-map.tsx,
 *   wms-sync-panel.tsx, sync-dashboard.tsx,
 *   components/onboarding/wms-onboarding-connection.tsx.
 *
 * NOT HERE ANY MORE, deliberately (o3d-m0ad / o3d-remove-shiphero round 8, Codex HIGH 2):
 * components/settings/integration-plugins-settings.tsx and app/(dashboard)/settings/system/page.tsx.
 * The Settings plugin screen used to hard-write five switches, one of them the shipped WMS
 * connector's, with two `as IntegrationPluginState` casts hiding the member a second connector
 * would have been missing — so a registered connector had no toggle and could not be enabled at
 * all. It now renders the registry-derived catalogue
 * (lib/domain/integrations/plugin-catalog.ts) and spells no connector id, which is what lets it be
 * scanned rather than exempted.
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

// ---------------------------------------------------------------------------------------------
// CONSTANT STRING EXPRESSIONS, FOLDED TO THEIR VALUE (o3d-remove-shiphero round 6, Codex HIGH 2)
//
// WHY TOKENS ARE NOT ENOUGH. Round 4 replaced the hand-rolled tokenizer with the real parse tree
// and scanned every LEAF TOKEN. That fixed the blind spots it was aimed at and left one of exactly
// the same shape: a leaf token is inspected ON ITS OWN, so an id assembled out of tokens that
// individually do not contain it is invisible. `const id = 'mint' + 'soft'` is a live connector
// literal in a protected file that the token scan exits 0 on — and so is `'\x6dintsoft'`, whose
// RAW token text (which is what the scan slices out of the source) spells `\x6dintsoft` while its
// VALUE is the id.
//
// WHAT THIS ADDS. A second, purely ADDITIVE pass that evaluates CONSTANT STRING EXPRESSIONS and
// matches their VALUE. It never suppresses a token or raw finding; it can only add lines.
//
// HOW UNKNOWNS ARE TREATED — the conservative direction, stated once:
//
//   - an operand that does not fold contributes the EMPTY STRING and marks the result inexact, so
//     `'mint' + suffix + 'soft'` is a finding. Reading a hole as possibly-empty is the strict
//     reading that is also usable: the alternative (reading it as "some string") makes every
//     concatenation in the repo a finding, since an unknown operand could be the whole id by
//     itself, and a guard that fires on everything gets allowlisted into silence;
//   - a construct that ASSEMBLES A STRING OUT OF PIECES THE GUARD CANNOT SEE AT ALL, where no
//     literal exists anywhere for the token or raw scan to fall back on, is OPAQUE and is reported
//     on its own — `String.fromCharCode(...codes)` mints characters and `parts.join('')` glues
//     fragments out of nothing. That is the "reject what you cannot fold" half, kept narrow enough
//     to stay believed: `String.fromCharCode(byte)` cannot produce eight characters, and
//     `items.join(', ')` cannot glue two non-ids into an id because no id contains `, `.
//
// WHERE A FINDING IS REPORTED. At the line of the LITERAL PIECE that supplied the match, not at
// the line the expression starts on. A folded value is stitched together from pieces scattered
// over many lines (and, through an in-file `const`, over many parts of the file); blaming the
// first line would move findings away from the text that caused them and would silently invalidate
// every per-line waiver already in the tree.
//
// It is a FOLD, not an interpreter. What it cannot evaluate is enumerated in
// docs/wms-connector-boundary.md next to what happens to it.
// ---------------------------------------------------------------------------------------------

/** The shortest id: a construct that cannot produce this many characters cannot produce an id. */
const SHORTEST_ID_LENGTH = Math.min(...CONNECTOR_LITERALS_LOWER.map((id) => id.length))

/**
 * Whether a join separator could GLUE two non-id fragments into an id.
 *
 * `''` can. So can any string an id contains (`-`, under an `acme-wms` build). Nothing else can:
 * an id in the joined result would have to sit wholly inside ONE element, and an element that
 * spells an id either does so as a literal (which the token/raw scan reads) or assembles it itself
 * (which this pass reads at that element's own site).
 */
function separatorCanGlue(separator) {
  if (separator === '') return true
  const lower = separator.toLowerCase()
  return CONNECTOR_LITERALS_LOWER.some((id) => id.includes(lower))
}

function unwrapFoldable(node) {
  let current = node
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression
      continue
    }
    if (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current)) {
      current = current.expression
      continue
    }
    if (typeof ts.isTypeAssertionExpression === 'function' && ts.isTypeAssertionExpression(current)) {
      current = current.expression
      continue
    }
    return current
  }
}

/**
 * A folded value: the ordered PIECES it was stitched from (each remembering the node that supplied
 * it), whether every operand was known, the nodes of any opaque assembly inside it, and whether the
 * value is a NUMBER rather than a string.
 *
 * `numeric` IS LOAD-BEARING, NOT BOOKKEEPING (o3d-remove-shiphero round 8, Codex HIGH 3). Round 6
 * folded every binary `+` as string concatenation, so
 * `String.fromCharCode(100+9,100+5,100+10,100+16,100+15,100+11,100+2,100+16)` — which evaluates to
 * a connector id at runtime — folded its arguments to `1009`, `1005`, … and produced eight
 * unrelated CJK characters, EXACTLY, with no finding. That is the worst failure available to a
 * fold: not "cannot evaluate" (which is reported) but "evaluated, confidently, to the wrong value"
 * (which is not). A `+` between two numbers is arithmetic; a `+` touching a string is
 * concatenation; the fold now knows which it is looking at, so it can only be wrong about a value
 * it has already admitted it does not know.
 */
const foldOf = (text, node) => ({ pieces: [{ text, node }], exact: true, opaque: [], numeric: false })
const foldNumber = (value, node) => ({ pieces: [{ text: String(value), node }], exact: true, opaque: [], numeric: true })
const foldNothing = (exact) => ({ pieces: [], exact, opaque: [], numeric: false })
const foldOpaque = (node) => ({ pieces: [], exact: false, opaque: [node], numeric: false })
const foldText = (folded) => folded.pieces.map((piece) => piece.text).join('')

/** Re-attribute a derived value (a case fold, a decode, a repeat) to the call that produced it. */
function foldDerived(text, node, exact, opaque) {
  return { pieces: [{ text, node }], exact, opaque, numeric: false }
}

/**
 * The binary operators that produce a NUMBER from numbers. `+` is in here AND is the only one that
 * is also string concatenation — which operand types it sees decides which it is.
 */
const ARITHMETIC_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
])

function applyArithmetic(operator, left, right) {
  switch (operator) {
    case ts.SyntaxKind.PlusToken: return left + right
    case ts.SyntaxKind.MinusToken: return left - right
    case ts.SyntaxKind.AsteriskToken: return left * right
    case ts.SyntaxKind.SlashToken: return left / right
    case ts.SyntaxKind.PercentToken: return left % right
    case ts.SyntaxKind.AsteriskAsteriskToken: return left ** right
    case ts.SyntaxKind.AmpersandToken: return left & right
    case ts.SyntaxKind.BarToken: return left | right
    case ts.SyntaxKind.CaretToken: return left ^ right
    case ts.SyntaxKind.LessThanLessThanToken: return left << right
    case ts.SyntaxKind.GreaterThanGreaterThanToken: return left >> right
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: return left >>> right
    default: return Number.NaN
  }
}

/** The NUMBER a fold denotes, or NaN when it denotes a string or is not exactly known. */
function foldNumericValue(folded) {
  if (!folded || !folded.exact || !folded.numeric) return Number.NaN
  return Number(foldText(folded))
}

function concatFolds(parts, exact) {
  const pieces = []
  const opaque = []
  let allKnown = exact
  for (const part of parts) {
    if (!part) { allKnown = false; continue }
    pieces.push(...part.pieces)
    opaque.push(...part.opaque)
    if (!part.exact) allKnown = false
  }
  // Concatenation always yields a STRING, whatever the operands denoted.
  return { pieces, exact: allKnown, opaque, numeric: false }
}

/**
 * THE MODULE BOUNDARY, WHICH USED TO BE A BLIND SPOT (o3d-remove-shiphero round 8, Codex HIGH 3).
 *
 * Round 6's folder was bound to ONE file, and read an operand it could not resolve as the empty
 * string. An imported constant is exactly such an operand, so
 * `import { SOFT } from '@/lib/connectors/mintsoft/ids'; const id = 'mint' + SOFT` folded to
 * `'mint'` — not an id — and the guard exited 0 over a live connector literal in a protected file.
 * Splitting the spelling across two files was all it took, and the second file is usually one where
 * naming the connector is LEGAL (the allowlist), so nothing catches it at the other end either.
 *
 * The fix is not another rule about `+`. It is that the folder's universe is now THE REPO rather
 * than one file: an import of a repo module is FOLLOWED and the exported initializer is folded, so
 * a constant assembled across files evaluates the way the runtime evaluates it. What it still
 * cannot follow inside the repo — a re-export chain it loses, an export that is not a `const`, a
 * file that will not parse — is a FINDING rather than an empty string, because the value is a
 * constant the guard has admitted it cannot evaluate.
 *
 * A BARE specifier (`node:path`, `react`) is NOT followed and is NOT reported. node_modules is not
 * scanned at all — it is in SKIPPED_DIRECTORIES — so reporting a package import here would be the
 * guard demanding of third-party code a property it never checks. The repo is the universe; the
 * boundary of the universe is not a hole in it.
 */
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

/** The repo-relative path an import specifier names, or `null` for a package (non-repo) import. */
function resolveModulePath(fromRelPath, specifier) {
  let base
  if (specifier.startsWith('@/')) base = specifier.slice(2)
  else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = join(dirname(fromRelPath), specifier).split(sep).join('/')
  } else return null
  if (base.startsWith('..')) return null

  const candidates = []
  const stripped = base.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
  candidates.push(base)
  for (const ext of MODULE_EXTENSIONS) candidates.push(`${stripped}${ext}`)
  for (const ext of MODULE_EXTENSIONS) candidates.push(`${stripped}/index${ext}`)
  for (const candidate of candidates) {
    try {
      if (statSync(join(ROOT, candidate)).isFile()) return candidate
    } catch { /* next candidate */ }
  }
  return null
}

/** Parsed source files, memoised: a constant chased through five modules parses each one once. */
const moduleSourceCache = new Map()
function moduleSourceFor(relPath) {
  if (moduleSourceCache.has(relPath)) return moduleSourceCache.get(relPath)
  let parsed = null
  try {
    const source = readFileSync(join(ROOT, relPath), 'utf8')
    const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, scriptKindFor(relPath))
    parsed = (sf.parseDiagnostics ?? []).length > 0 ? null : sf
  } catch {
    parsed = null
  }
  moduleSourceCache.set(relPath, parsed)
  return parsed
}

/** Folders, memoised per file, so a cycle costs nothing and a hot module is parsed once. */
const moduleFolderCache = new Map()
function folderFor(relPath) {
  if (moduleFolderCache.has(relPath)) return moduleFolderCache.get(relPath)
  // Seeded with `null` BEFORE the folder is built: makeConstantFolder can re-enter this for the
  // same file through a cycle, and a half-built folder must read as "cannot resolve", not recurse.
  moduleFolderCache.set(relPath, null)
  const sf = moduleSourceFor(relPath)
  const folder = sf ? makeConstantFolder(sf) : null
  moduleFolderCache.set(relPath, folder)
  return folder
}

/** Modules currently being resolved through, so an import cycle terminates instead of recursing. */
const moduleResolutionStack = new Set()

/**
 * A folder bound to one source file: in-file `const` initializers and enum members resolve, so
 * `const a = 'mint'; const b = 'soft'; const id = a + b` folds the way the runtime evaluates it.
 *
 * A name declared more than once in the file resolves to NOTHING rather than to a guess — the fold
 * must never be confidently wrong about which declaration is live.
 */
function makeConstantFolder(sourceFile) {
  const constInitializers = new Map()
  const enumMembers = new Map()
  const declaredNames = new Set()
  /** Names bound by an import — `path`, `Prisma`. A MODULE, never a local array (see `join`). */
  const importedNames = new Set()

  /** local name -> { specifier, exported } for every value import. `exported` is '*' for a namespace. */
  const importBindings = new Map()
  /** `export { X } from './y'` / `export * from './y'`, so an export this file re-exports resolves. */
  const namedReExports = new Map()
  const starReExports = []
  /** Names this file exports as a `const` — the only export shape a constant fold can follow. */
  const exportedConstNames = new Set()

  const collect = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const specifier = node.moduleSpecifier.text
      // `import type { … }` binds no value; following it would resolve a TYPE alias to whatever
      // const happens to share its name.
      const typeOnlyClause = clause.isTypeOnly === true
      if (clause.name) {
        importedNames.add(clause.name.text)
        if (!typeOnlyClause) importBindings.set(clause.name.text, { specifier, exported: 'default' })
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          importedNames.add(clause.namedBindings.name.text)
          if (!typeOnlyClause) importBindings.set(clause.namedBindings.name.text, { specifier, exported: '*' })
        } else {
          for (const element of clause.namedBindings.elements) {
            importedNames.add(element.name.text)
            if (typeOnlyClause || element.isTypeOnly === true) continue
            importBindings.set(element.name.text, {
              specifier,
              exported: (element.propertyName ?? element.name).text,
            })
          }
        }
      }
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          if (element.isTypeOnly) continue
          namedReExports.set(element.name.text, { specifier, exported: (element.propertyName ?? element.name).text })
        }
      } else if (!node.exportClause) {
        starReExports.push(specifier)
      }
    }
    if (ts.isVariableStatement(node)
      && (node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exportedConstNames.add(declaration.name.text)
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text
      const list = node.parent
      const isConst = list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0
      if (declaredNames.has(name)) constInitializers.set(name, null)
      else {
        declaredNames.add(name)
        constInitializers.set(name, isConst && node.initializer ? node.initializer : null)
      }
    }
    if (ts.isEnumDeclaration(node) && ts.isIdentifier(node.name)) {
      for (const member of node.members) {
        const memberName = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null
        if (memberName && member.initializer) enumMembers.set(`${node.name.text}.${memberName}`, member.initializer)
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(sourceFile)

  const resolving = new Set()

  function fold(node, depth) {
    if (!node || depth > 48) return null
    const current = unwrapFoldable(node)

    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return foldOf(current.text, current)
    if (ts.isNumericLiteral(current)) return foldNumber(Number(current.text), current)
    if (ts.isBigIntLiteral(current)) return foldNumber(Number(current.text.replace(/n$/, '')), current)

    // A NUMBER stays a number through unary +/-/~ (o3d-remove-shiphero round 8). Without this,
    // `String.fromCharCode(-(-109), ...)` folds to nothing and the bound below rescues it only
    // while the argument count is small.
    if (ts.isPrefixUnaryExpression(current)
      && (current.operator === ts.SyntaxKind.MinusToken
        || current.operator === ts.SyntaxKind.PlusToken
        || current.operator === ts.SyntaxKind.TildeToken)) {
      const operand = fold(current.operand, depth + 1)
      const value = foldNumericValue(operand)
      if (!Number.isFinite(value)) return null
      const applied = current.operator === ts.SyntaxKind.MinusToken ? -value
        : current.operator === ts.SyntaxKind.PlusToken ? value : ~value
      return foldNumber(applied, current)
    }

    if (ts.isTemplateExpression(current)) {
      const parts = [foldOf(current.head.text, current.head)]
      let exact = true
      for (const span of current.templateSpans) {
        const part = fold(span.expression, depth + 1)
        if (!part) exact = false
        else parts.push(part)
        parts.push(foldOf(span.literal.text, span.literal))
      }
      return concatFolds(parts, exact)
    }

    if (ts.isBinaryExpression(current)) {
      const operator = current.operatorToken.kind
      // ARITHMETIC, NOT CONCATENATION — the round-8 fix (Codex HIGH 3). `+` is the only operator
      // that is both, and which one it is depends on the OPERAND TYPES, not on the token. Two
      // numbers add; anything touching a string concatenates. Every other arithmetic operator
      // coerces to number unconditionally, so it can never build a string and is folded only when
      // both sides are known numbers (a `-` on an unknown operand is NaN, not an id).
      if (ARITHMETIC_OPERATORS.has(operator)) {
        const left = fold(current.left, depth + 1)
        const right = fold(current.right, depth + 1)
        const leftValue = foldNumericValue(left)
        const rightValue = foldNumericValue(right)
        if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
          const value = applyArithmetic(operator, leftValue, rightValue)
          if (Number.isFinite(value)) return foldNumber(value, current)
          return null
        }
        if (operator !== ts.SyntaxKind.PlusToken) return null
        if (!left && !right) return null
        return concatFolds([left, right], true)
      }
      return null
    }

    if (ts.isIdentifier(current)) {
      const name = current.text
      if (resolving.has(name)) return null
      if (constInitializers.has(name)) {
        const initializer = constInitializers.get(name)
        if (!initializer) return null
        resolving.add(name)
        try {
          return fold(initializer, depth + 1)
        } finally {
          resolving.delete(name)
        }
      }
      const binding = importBindings.get(name)
      if (binding && binding.exported !== '*') return foldImported(binding, current, depth)
      return null
    }

    if (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.expression) && ts.isIdentifier(current.name)) {
      const member = enumMembers.get(`${current.expression.text}.${current.name.text}`)
      if (member) return fold(member, depth + 1)
      // `import * as ids from './ids'; ids.SOFT` — the same cross-module constant, spelled through
      // a namespace. Reached here and not above because the namespace itself is never a string.
      const namespaceBinding = importBindings.get(current.expression.text)
      if (namespaceBinding && namespaceBinding.exported === '*' && !constInitializers.has(current.expression.text)) {
        return foldImported({ specifier: namespaceBinding.specifier, exported: current.name.text }, current, depth)
      }
      return null
    }

    if (ts.isCallExpression(current)) return foldCall(current, depth)
    return null
  }

  function foldCall(node, depth) {
    const callee = unwrapFoldable(node.expression)

    // atob('bWludHNvZnQ=') / decodeURIComponent('%6Dintsoft') — one-argument decoders whose whole
    // job is to turn one literal into a different string.
    if (ts.isIdentifier(callee)
      && (callee.text === 'atob' || callee.text === 'decodeURIComponent' || callee.text === 'unescape')) {
      const arg = node.arguments.length === 1 ? fold(node.arguments[0], depth + 1) : null
      if (!arg || !arg.exact) return null
      try {
        const text = callee.text === 'atob'
          ? Buffer.from(foldText(arg), 'base64').toString('binary')
          : callee.text === 'decodeURIComponent'
            ? decodeURIComponent(foldText(arg))
            : unescape(foldText(arg))
        return foldDerived(text, node, true, [])
      } catch {
        return null
      }
    }

    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return null
    const method = callee.name.text
    const receiver = unwrapFoldable(callee.expression)

    // `Buffer.from('bWludHNvZnQ=', 'base64')` is `atob` under another name, and `atob` has been
    // modelled since round 6 — so this is not one more method, it is the second spelling of one
    // already covered (o3d-remove-shiphero round 8, Codex HIGH 3). It is EXACTLY evaluable when the
    // input and the encoding are both known, and OPAQUE when they are not: a constant put through a
    // transcoding the guard cannot perform is precisely the thing it must not read as empty.
    //
    // The fold carries the BYTES as a latin1 string (`binary: true`) so the `.toString(enc)` that
    // always follows can re-encode them rather than having to guess what the buffer held.
    if (ts.isIdentifier(receiver) && receiver.text === 'Buffer' && method === 'from'
      && !importedNames.has('Buffer')) {
      const input = node.arguments.length >= 1 && !ts.isSpreadElement(node.arguments[0])
        ? fold(node.arguments[0], depth + 1)
        : null
      // A non-constant input is runtime DATA, not a spelling — read as today, i.e. not a finding.
      if (!input || !input.exact || input.numeric) return null
      const encodingFold = node.arguments.length >= 2 ? fold(node.arguments[1], depth + 1) : foldOf('utf8', node)
      const encoding = encodingFold && encodingFold.exact && !encodingFold.numeric ? foldText(encodingFold) : null
      if (encoding === null || !Buffer.isEncoding(encoding)) return foldOpaque(node)
      try {
        const bytes = Buffer.from(foldText(input), encoding).toString('latin1')
        return { pieces: [{ text: bytes, node }], exact: true, opaque: [], numeric: false, binary: true }
      } catch {
        return foldOpaque(node)
      }
    }

    if (method === 'toString') {
      const base = fold(receiver, depth + 1)
      // An INEXACT base is an unknown operand, and an unknown operand reads as the empty string
      // everywhere else in this fold — see the `+` rule. Rejecting here and not there would make
      // `(count + 1).toString()` a finding while `'x' + count` is not, which is the inconsistency
      // that gets a guard allowlisted into silence. The opaque node inside such a base is still
      // reported at its own site, because every sub-expression is folded independently.
      if (!base || !base.exact) return null
      if (!base.binary) return foldDerived(foldText(base), node, true, [])
      const encodingFold = node.arguments.length >= 1 && !ts.isSpreadElement(node.arguments[0])
        ? fold(node.arguments[0], depth + 1)
        : foldOf('utf8', node)
      const encoding = encodingFold && encodingFold.exact && !encodingFold.numeric ? foldText(encodingFold) : null
      if (encoding === null || !Buffer.isEncoding(encoding)) return foldOpaque(node)
      try {
        return foldDerived(Buffer.from(foldText(base), 'latin1').toString(encoding), node, true, [])
      } catch {
        return foldOpaque(node)
      }
    }

    // String.fromCharCode / String.fromCodePoint — the only construct here that mints characters
    // no literal in the file ever shows.
    if (ts.isIdentifier(receiver) && receiver.text === 'String'
      && (method === 'fromCharCode' || method === 'fromCodePoint')) {
      const codes = []
      let exact = true
      let spread = false
      for (const arg of node.arguments) {
        if (ts.isSpreadElement(arg)) { spread = true; exact = false; continue }
        const folded = fold(arg, depth + 1)
        const value = folded && folded.exact ? Number(foldText(folded)) : Number.NaN
        if (!Number.isFinite(value)) { exact = false; continue }
        codes.push(value)
      }
      if (exact) {
        try {
          const text = method === 'fromCharCode' ? String.fromCharCode(...codes) : String.fromCodePoint(...codes)
          return foldDerived(text, node, true, [])
        } catch {
          return foldOpaque(node)
        }
      }
      // Unevaluable — but BOUNDED by the argument count unless a spread widens it. A code point is
      // at most two UTF-16 units, so N arguments cannot produce more than 2N characters.
      const maxLength = spread ? Number.POSITIVE_INFINITY : node.arguments.length * 2
      return maxLength >= SHORTEST_ID_LENGTH ? foldOpaque(node) : foldNothing(false)
    }

    if (method === 'join') {
      // `Array.prototype.join` takes AT MOST ONE argument, and its receiver is an array — never a
      // module. `path.join(a, b, c)` and `Prisma.join(rows)` are different functions that happen to
      // share a name, and reading them as string assembly produced 68 of the 70 findings on the
      // first run of this pass. Noise is how a guard gets allowlisted into silence.
      if (node.arguments.length > 1) return null
      if (ts.isIdentifier(receiver) && importedNames.has(receiver.text)) return null

      const separatorFold = node.arguments.length === 0 ? foldOf(',', node) : fold(node.arguments[0], depth + 1)
      const separator = separatorFold && separatorFold.exact ? foldText(separatorFold) : null

      if (ts.isArrayLiteralExpression(receiver)) {
        if (separator === null) return foldOpaque(node)
        const parts = []
        let exact = true
        receiver.elements.forEach((element, index) => {
          if (index > 0) parts.push(foldOf(separator, node))
          if (ts.isSpreadElement(element)) { exact = false; return }
          const folded = fold(element, depth + 1)
          if (!folded) { exact = false; return }
          parts.push(folded)
        })
        const joined = concatFolds(parts, exact)
        if (!joined.exact && separatorCanGlue(separator)) joined.opaque.push(node)
        return joined
      }
      // The elements are entirely out of view. Only a gluing separator can build an id out of
      // pieces that are not ids; anything else cannot, so it is not reported.
      if (separator !== null && !separatorCanGlue(separator)) return null
      return foldOpaque(node)
    }

    if (method === 'concat') {
      // Buffer.concat returns a Buffer, not a string, and is the only `.concat` in this tree.
      if (ts.isIdentifier(receiver) && importedNames.has(receiver.text)) return null
      if (ts.isIdentifier(receiver) && receiver.text === 'Buffer') return null
      const parts = [fold(receiver, depth + 1)]
      for (const arg of node.arguments) parts.push(ts.isSpreadElement(arg) ? null : fold(arg, depth + 1))
      return concatFolds(parts, true)
    }

    if (method === 'repeat') {
      const base = fold(receiver, depth + 1)
      const count = node.arguments.length === 1 ? fold(node.arguments[0], depth + 1) : null
      if (!base || !base.exact || !count || !count.exact) return null
      const times = Number(foldText(count))
      const unit = foldText(base)
      if (!Number.isInteger(times) || times < 0 || times * unit.length > 4096) return null
      return foldDerived(unit.repeat(times), node, true, [])
    }

    if (method === 'toLowerCase' || method === 'toUpperCase'
      || method === 'trim' || method === 'trimStart' || method === 'trimEnd') {
      const base = fold(receiver, depth + 1)
      if (!base) return null
      const text = foldText(base)
      const applied = method === 'toLowerCase' ? text.toLowerCase()
        : method === 'toUpperCase' ? text.toUpperCase()
          : method === 'trim' ? text.trim()
            : method === 'trimStart' ? text.trimStart() : text.trimEnd()
      return foldDerived(applied, node, base.exact, base.opaque)
    }

    // THE RULE THAT ENDS THE SEQUENCE OF SPELLINGS (o3d-remove-shiphero round 8, Codex HIGH 3).
    //
    // Rounds 3 to 7 each closed the spelling that had just been found and each revealed another:
    // a regex literal, JSX text, `'mint' + 'soft'`, `'\x6dintsoft'`, `.join('')`, `fromCharCode`.
    // `'mintXsoft'.replace('X', '')` is the same shape again, and so is the next one nobody has
    // written down. Modelling `.replace` would close one member of an unbounded family
    // (`.padStart`, `.normalize`, `.split().reverse().join()`, …).
    //
    // So the rule is not about WHICH method. A CONSTANT STRING this guard has already evaluated,
    // put through an operation it cannot evaluate, yields a value it does not know — and an
    // unknown value that could be of any length is a FINDING, not an empty string. The cost is
    // bounded and was measured, not assumed: across the 955 scanned files this fires on nothing
    // that is not already waived, because ordinary code transforms runtime data (whose receiver
    // does not fold and is therefore untouched here), not string literals.
    const constantReceiver = fold(receiver, depth + 1)
    if (constantReceiver && constantReceiver.exact && !constantReceiver.numeric) return foldOpaque(node)

    return null
  }

  /**
   * A constant that lives in ANOTHER repo module, folded there and re-attributed here.
   *
   * Three outcomes, and the middle one is the point:
   *   - a PACKAGE import (`node:path`, `react`) → `null`, read as data. node_modules is not
   *     scanned, so demanding evaluability of it would be a rule the guard never applies;
   *   - a REPO module the guard cannot follow to a constant — missing file, a file that will not
   *     parse, an export that is not a `const`, a re-export chain it loses — → OPAQUE, i.e. a
   *     finding. This is a constant expression whose value the guard has admitted it cannot
   *     evaluate, which is exactly what it must not read as the empty string;
   *   - a repo constant it CAN fold → that value.
   *
   * Re-attributed to the local node: the remote pieces point into another SourceFile, and blaming
   * a line number read out of the wrong file would put the finding — and every waiver that has to
   * suppress it — on an unrelated line.
   */
  function foldImported(binding, node, depth) {
    if (depth > 24) return foldOpaque(node)
    const target = resolveModulePath(sourceFile.fileName, binding.specifier)
    if (target === null) {
      // Not a repo module. Outside the universe this guard scans; see the header above.
      return /^[.@]/.test(binding.specifier) ? foldOpaque(node) : null
    }
    const key = `${target}#${binding.exported}`
    if (moduleResolutionStack.has(key)) return foldOpaque(node)
    moduleResolutionStack.add(key)
    try {
      const folder = folderFor(target)
      if (!folder) return foldOpaque(node)
      const remote = folder.exportFold(binding.exported, depth + 1)
      if (!remote) return foldOpaque(node)
      // BY CONSTRUCTION, NOT BY ENUMERATION (o3d-remove-shiphero round 10, Codex HIGH 3).
      //
      // This used to list the fields it carried across — `exact`, `opaque`, `numeric` — and it
      // listed them BEFORE `binary` existed. So `export const B = Buffer.from('…','base64')` folded
      // correctly in its own module and arrived here as an ordinary string: `B.toString('utf16le')`
      // in the importing file then re-read the latin1 byte spelling as a string, left the
      // interleaved NULs in place, saw no id, and exited 0 over a live connector literal. A flag
      // dropped in transit is the same defect as the blind spot this function was written to close,
      // and an enumerated copy drops the NEXT flag too.
      //
      // So the remote fold is carried WHOLE, and only the two fields that are meaningless outside
      // their own SourceFile are rewritten:
      //   - `pieces` collapses to one piece attributed to the LOCAL node; the remote pieces carry
      //     nodes from another file, and a line number read out of the wrong file puts the finding
      //     (and every waiver that has to suppress it) on an unrelated line;
      //   - `opaque` is re-pointed at the local node for the same reason — preserving whether the
      //     remote had any opaque assembly in it, which is the only part of it that travels.
      // Everything else — `exact`, `numeric`, `binary`, and whatever a later round adds — is the
      // remote's answer and is reproduced unchanged.
      return {
        ...remote,
        pieces: [{ text: foldText(remote), node }],
        opaque: remote.opaque.length > 0 ? [node] : [],
      }
    } finally {
      moduleResolutionStack.delete(key)
    }
  }

  /** The fold of `export const <name> = …` in THIS module, following named/star re-exports. */
  function exportFold(name, depth) {
    if (depth > 24) return null
    if (exportedConstNames.has(name) && constInitializers.get(name)) {
      return fold(constInitializers.get(name), depth + 1)
    }
    const reExport = namedReExports.get(name)
    if (reExport) return foldImported(reExport, sourceFile, depth + 1)
    for (const specifier of starReExports) {
      const folded = foldImported({ specifier, exported: name }, sourceFile, depth + 1)
      if (folded && folded.exact) return folded
    }
    return null
  }

  const folder = (node) => fold(node, 0)
  folder.exportFold = exportFold
  return folder
}

/** Node kinds a constant string expression can START at. Everything else is reached recursively. */
function isFoldCandidate(node) {
  return ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isTemplateExpression(node)
    || ts.isBinaryExpression(node)
    || ts.isCallExpression(node)
    || ts.isPropertyAccessExpression(node)
}

/**
 * Lines carrying a constant string expression whose VALUE contains a connector id, plus the lines
 * of the opaque assembly constructs described above.
 *
 * A match is blamed on the PIECE that supplied it (see the header). JSDoc is skipped for the same
 * reason the token scan skips it: it is a comment that arrives wearing node kinds.
 */
function foldedLinesWithLiteral(sourceFile, source) {
  const lines = new Set()
  const opaqueLines = new Set()
  const fold = makeConstantFolder(sourceFile)
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line

  const blame = (folded) => {
    const text = foldText(folded)
    const offsets = literalOffsets(text)
    if (offsets.length === 0) return
    for (const offset of offsets) {
      let cursor = 0
      let blamed = folded.pieces[0]
      for (const piece of folded.pieces) {
        if (offset < cursor + piece.text.length) { blamed = piece; break }
        cursor += piece.text.length
      }
      if (blamed) lines.add(lineOf(blamed.node))
    }
  }

  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    if (isFoldCandidate(node)) {
      const folded = fold(node)
      if (folded) {
        blame(folded)
        for (const opaqueNode of folded.opaque) {
          const line = lineOf(opaqueNode)
          lines.add(line)
          opaqueLines.add(line)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { lines, opaqueLines }
}

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
function parseCleanly(relPath, source) {
  const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, scriptKindFor(relPath))
  if ((sourceFile.parseDiagnostics ?? []).length > 0) return null
  return sourceFile
}

function codeLinesWithLiteral(sourceFile, source) {
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
  const sourceFile = parseCleanly(relPath, source)
  // The generic layer is read as CODE; everywhere else, and anywhere the parser reported a
  // syntax diagnostic for, is read whole.
  let matchedLines = sourceFile && isCommentExempt(relPath) ? codeLinesWithLiteral(sourceFile, source) : null
  if (matchedLines === null) {
    matchedLines = new Set()
    for (let i = 0; i < rawLines.length; i += 1) {
      if (literalOffsets(rawLines[i]).length > 0) matchedLines.add(i)
    }
  }

  // THE CONSTANT-EXPRESSION FOLD, IN EVERY PATH AND ONLY EVER ADDITIVE (round 6, Codex HIGH 2).
  // Both scans above read TEXT — a token's source slice, or the raw line. A constant expression's
  // VALUE is not its text, so `'mint' + 'soft'` and `'\x6dintsoft'` are invisible to both. This
  // adds the lines whose value spells an id; it removes nothing, so a file it cannot parse or
  // cannot fold keeps everything the scan above found.
  let opaqueLines = new Set()
  if (sourceFile) {
    try {
      const folded = foldedLinesWithLiteral(sourceFile, source)
      for (const line of folded.lines) matchedLines.add(line)
      opaqueLines = folded.opaqueLines
    } catch {
      // A fold that throws must never leave the guard blinder than the scan above already made it.
    }
  }

  const findings = []
  for (const i of [...matchedLines].sort((a, b) => a - b)) {
    const onLine = WAIVER_RE.test(rawLines[i] ?? '')
    const onPrev = i > 0 && WAIVER_RE.test(rawLines[i - 1] ?? '')
    if (onLine || onPrev) continue
    findings.push({
      path: relPath,
      line: i + 1,
      text: (rawLines[i] ?? '').trim(),
      note: opaqueLines.has(i)
        ? 'assembles a string this guard cannot evaluate and cannot bound below the shortest '
          + 'connector id — waive it if it provably cannot spell one'
        : null,
    })
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
    if (finding.note) console.error(`  ↳ ${finding.note}`)
  }
  process.exit(1)
}

console.log(
  `WMS connector boundary clean — scanned ${files.length} files for ${CONNECTOR_LITERALS.join('/')}, `
  + 'no connector-literal leaks outside the allowlist.',
)
