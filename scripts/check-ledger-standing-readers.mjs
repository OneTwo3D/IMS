#!/usr/bin/env node

/**
 * Static guard: WHAT AN `AccountingSyncLog` ROW SAYS ABOUT THE LEDGER IS DECIDED IN ONE PLACE
 * (lib/domain/accounting/ledger-standing.ts), and every other reader of the evidence is DECLARED
 * (o3d-f709 / o3d-vzje / o3d-kof8).
 *
 * WHAT IT IS DEFENDING. `status`, `externalTransactionId` and `settlementBasis` on that table were
 * read as statements about the ledger in some sixty places, each with its own spelling and its own
 * comment asserting it. Three of those claims are false: "a CANCELLED row committed nothing" (seven
 * writers reach CANCELLED, three of which know nothing), "a SYNCED row means the connector posted"
 * (an operator's typed document id lands there too) and "a document id means a document exists"
 * (the same). The module states the truth table once; this guard fails the build on a reader that
 * does not go through it and has not been DECLARED, with a reason and a class.
 *
 * ── WHAT IS A SITE ──────────────────────────────────────────────────────────────────────────────
 *
 *   where-excludes-cancelled  an accountingSyncLog `where` whose `status` clause excludes CANCELLED
 *                             (`{ not }`, `{ notIn }`, or an `{ in }` that admits every other status).
 *   cmp-cancelled             a sync-log row's `.status` compared / switched / set-tested against
 *                             'CANCELLED'.
 *   where-admits-synced       an accountingSyncLog `where` whose `status` clause admits SYNCED.
 *   where-id-not-null         an accountingSyncLog `where` containing `externalTransactionId: { not: null }`.
 *   cmp-synced                a sync-log row's `.status` compared / switched / set-tested against 'SYNCED'.
 *   id-read                   a TRUTHINESS (or null) read of `<x>.externalTransactionId`.
 *   ae-posted-query           an accountingEvent query that admits status POSTED and `select`s columns
 *                             without `postBasis`.
 *   ae-posted-compare         an AccountingEvent-shaped receiver's `.status` compared against 'POSTED'
 *                             when the receiver's type does not carry `postBasis`.
 *
 * Everything INSIDE lib/domain/accounting/ledger-standing.ts is the rule and is exempt. Every other
 * site must be named in scripts/ledger-standing-reader-declarations.mjs.
 *
 * ── DECLARATIONS ARE PER SITE, AND THE CHECK IS UNIVERSAL ───────────────────────────────────────
 *
 * The first form of this guard (check-accounting-cancelled-row-predicates.mjs, o3d-f709 rounds 1-3)
 * keyed its owners PER FILE with a count, and the counts passed while two owners' reasons were false
 * (an AND read as an OR). A per-file count says "N sites exist in this file"; it cannot tell the
 * site that was declared from a different one swapped in beside it. So every declaration is keyed
 *
 *     <file>::<enclosing top-level declaration>::<kind>#<ordinal within that declaration>
 *
 * and the reconciliation is UNIVERSAL in both directions: every site found must be declared, and every
 * declared site must be found. A stale declaration FAILS, so an allowlist can never outlive the code
 * it excused. Moving a site to another function, swapping one kind for another, or deleting one all
 * change a key and fail here.
 *
 * Each declaration carries a CLASS and a reason:
 *
 *   MONEY | RETENTION | GUARD | WORK_SLOT | DISPLAY   the reader is understood and its reading holds.
 *   PENDING_CONVERSION:<bead>                          the reader is known to need converting to the
 *                                                      module and the named bead owns it. A later
 *                                                      slice DELETES the declaration as it converts.
 *
 * A WORK_SLOT declaration on a `where` site must SELECT `settlementBasis` (or select nothing and read
 * the whole row): the work-slot question is "may another posting be raised", and answering it without
 * knowing whether the occupant is an operator's assertion is the laundering this module ends.
 * `where-excludes-cancelled` sites that are ORed with a post-evidence arm record `rescued: true`; the
 * declaration states which, so an OR turned into an AND (the round-1 defect) fails here even though
 * the count did not move.
 *
 * ── THE GUARD PROVES IT RAN ─────────────────────────────────────────────────────────────────────
 *
 * It scans the WHOLE TREE (every .ts/.tsx under app, lib, scripts, components that tsconfig.json
 * includes), never a diff and never a branch. An unreadable or missing tsconfig.json exits 2. A
 * program with FEWER SOURCE FILES THAN A FLOOR, or with ZERO sites of any kind that this tree is
 * known to contain, FAILS with "subject not reached": a guard that scanned nothing and printed
 * nothing red is the guard that passes when its roots are wrong. Counts are PRINTED on every run.
 *
 * ── TYPE-AWARE, NOT NAME-AWARE (carried from the first form, and still load-bearing) ────────────
 *
 * `so.status === 'CANCELLED'` against SalesOrder is none of this rule's business, so the comparison
 * kinds ask whether the RECEIVER carries `status` plus a column only AccountingSyncLog has, follow a
 * REDUCED row shape (an object literal that copies a sync-log status into a `status` property mints
 * a shape, iterated to a fixed point), and resolve identifiers through the type checker - an alias,
 * a `const S = 'SYNCED'` or a namespace import hides nothing. `id-read` is the one kind that is
 * name-based: `externalTransactionId` exists on exactly one model, so any read of it is a read of
 * this table's evidence.
 *
 * ── WHAT IT CANNOT SEE, SAID PLAINLY ────────────────────────────────────────────────────────────
 *   • A status set assembled at runtime is unresolvable; where it matters it FAILS CLOSED (a site).
 *   • Raw SQL in TypeScript. No statement against this table carries a status predicate today.
 *   • A read through a variable: `const s = row.status; if (s === 'SYNCED')`, a destructured
 *     `const { externalTransactionId } = row`, or a bare `string` parameter.
 *   • A presence test hidden in a helper (`hasPostEvidence(row)`, `trimmed(row.id).length > 0`): only
 *     the helper's own read is a site, and it is declared where it is.
 *   • A reduced shape whose signature collides with an unrelated type's is treated as a sync-log row
 *     (the fail-closed direction: a false positive costs one declared line).
 *
 * Run via `npm run check:ledger-standing-readers`; invoked by `npm run check:all`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const ROOT = process.cwd()

/** The module that owns the rule. Nothing in it is a site. */
export const OWNING_MODULE = 'lib/domain/accounting/ledger-standing.ts'

/** Where the per-site declarations live. */
const DECLARATIONS_PATH = 'scripts/ledger-standing-reader-declarations.mjs'

export const SOURCE_ROOTS = ['app', 'lib', 'scripts', 'components']

/**
 * FLOORS. A scan that reaches fewer files than this, or finds fewer sites of a kind this tree is
 * known to contain, has not reached its subject. The numbers are deliberately well below today's
 * measurement (printed on every run) so ordinary churn does not trip them, and far above what an
 * empty or mis-rooted scan produces.
 */
export const MIN_SOURCE_FILES = 800
export const MIN_SITES_BY_KIND = {
  'where-excludes-cancelled': 1,
  'cmp-cancelled': 1,
  'where-admits-synced': 5,
  'where-id-not-null': 3,
  'cmp-synced': 5,
  'id-read': 10,
  'ae-posted-query': 0,
  'ae-posted-compare': 0,
}

export const CLASSES = ['MONEY', 'RETENTION', 'GUARD', 'WORK_SLOT', 'DISPLAY']
const PENDING_RE = /^PENDING_CONVERSION:o3d-[a-z0-9.]+$/

/**
 * The four statuses a `status: { in: … }` set must ALL admit before it counts as the complement of
 * CANCELLED - i.e. before it is that rule written out longhand. A set that drops FAILED as well is
 * asking "is there live or finished WORK here?" and is not making this claim.
 */
const CANCELLED_COMPLEMENT = ['PENDING', 'PROCESSING', 'SYNCED', 'FAILED']

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.next', 'generated', 'archive'].includes(entry.name)) continue
      walk(p, out)
    } else if (['.ts', '.tsx'].includes(extname(entry.name))) out.push(p)
  }
  return out
}

const strip = (n) => {
  let x = n
  while (ts.isAsExpression(x) || ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x)
    || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(x))) x = x.expression
  return x
}

const keyOf = (prop) => (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text
  : ts.isComputedPropertyName(prop.name) && ts.isStringLiteral(prop.name.expression) ? prop.name.expression.text
    : null)

// ── Resolve string-array constants THROUGH THE CHECKER ────────────────────────────────────────
//
// Keyed on the declaration the identifier actually refers to - through the import, an `as` alias and
// a chain of `const A = B` - never on an exported NAME: this tree declares LIVE_ACCOUNTING_SYNC_STATUSES
// twice with different bodies, and a name-keyed map collapsed the ambiguity to "permit".
function declaredArrayValues(symbol, checker, depth = 0) {
  if (!symbol || depth > 8) return null
  let resolved = symbol
  if (resolved.flags & ts.SymbolFlags.Alias) {
    try { resolved = checker.getAliasedSymbol(resolved) } catch { return null }
  }
  for (const declaration of resolved.getDeclarations() ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) continue
    const init = strip(declaration.initializer)
    if (ts.isArrayLiteralExpression(init)) {
      const values = []
      for (const element of init.elements) {
        let e = element
        if (ts.isSpreadElement(e)) {
          const inner = declaredArrayValues(checker.getSymbolAtLocation(e.expression), checker, depth + 1)
          if (inner === null) return null
          values.push(...inner)
          continue
        }
        e = strip(e)
        if (!ts.isStringLiteral(e)) return null
        values.push(e.text)
      }
      return values
    }
    if (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'Set') {
      const arg = init.arguments?.[0]
      return arg ? resolveStatusList(arg, checker) : []
    }
    if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) {
      return declaredArrayValues(checker.getSymbolAtLocation(init), checker, depth + 1)
    }
  }
  return null
}

/** The status values a clause admits, or null when it cannot be resolved. */
export function resolveStatusList(node, checker) {
  const n = strip(node)
  if (ts.isArrayLiteralExpression(n)) {
    const out = []
    for (const element of n.elements) {
      let e = element
      if (ts.isSpreadElement(e)) {
        const inner = resolveStatusList(e.expression, checker)
        if (inner === null) return null
        out.push(...inner)
        continue
      }
      e = strip(e)
      const literal = literalText(e, checker)
      if (literal === null) return null
      out.push(literal)
    }
    return out
  }
  if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
    const viaDeclaration = declaredArrayValues(checker.getSymbolAtLocation(n), checker)
    if (viaDeclaration !== null) return viaDeclaration
    const literal = literalText(n, checker)
    return literal === null ? null : [literal]
  }
  const literal = literalText(n, checker)
  return literal === null ? null : [literal]
}

/** A string literal's text, or the literal type of an identifier (`const S = 'SYNCED'`), or null. */
function literalText(node, checker) {
  const n = strip(node)
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
    try {
      const t = checker.getTypeAtLocation(n)
      if (t && t.isStringLiteral && t.isStringLiteral()) return t.value
    } catch { /* unresolvable */ }
  }
  return null
}

/**
 * The CLAUSE'S ADMITTED SET: which of the five statuses a `status` clause admits, or null when it
 * cannot be read. Equality, `in`, `not`, `notIn` are understood; anything else is null (FAIL CLOSED).
 */
function admittedStatuses(initializer, checker, universe) {
  const n = strip(initializer)
  const direct = literalText(n, checker)
  if (direct !== null) return new Set([direct])
  if (!ts.isObjectLiteralExpression(n)) return null
  let admitted = new Set(universe)
  let understood = false
  for (const prop of n.properties) {
    if (!ts.isPropertyAssignment(prop)) return null
    const key = keyOf(prop)
    if (key === 'in') {
      const values = resolveStatusList(prop.initializer, checker)
      if (values === null) return null
      admitted = new Set([...admitted].filter((s) => values.includes(s)))
      understood = true
    } else if (key === 'notIn') {
      const values = resolveStatusList(prop.initializer, checker)
      if (values === null) return null
      admitted = new Set([...admitted].filter((s) => !values.includes(s)))
      understood = true
    } else if (key === 'not') {
      const values = resolveStatusList(prop.initializer, checker)
      if (values === null) return null
      admitted = new Set([...admitted].filter((s) => !values.includes(s)))
      understood = true
    } else if (key === 'equals') {
      const value = literalText(prop.initializer, checker)
      if (value === null) return null
      admitted = new Set([...admitted].filter((s) => s === value))
      understood = true
    } else return null
  }
  return understood ? admitted : null
}

/**
 * Does this `status` clause EXCLUDE CANCELLED while still admitting a posted document? A description
 * when it does, null when it does not or cannot be read (an unreadable `in`/`notIn` set is reported:
 * it FAILS CLOSED, because the mutation that found this made a set unreadable ON PURPOSE).
 */
function excludesCancelled(initializer, checker) {
  const n = strip(initializer)
  if (!ts.isObjectLiteralExpression(n)) return null
  for (const prop of n.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const key = keyOf(prop)
    if (key === 'not') {
      const v = strip(prop.initializer)
      if (ts.isStringLiteral(v) && v.text === 'CANCELLED') return "status: { not: 'CANCELLED' }"
    } else if (key === 'notIn') {
      const values = resolveStatusList(prop.initializer, checker)
      if (values === null) return 'status: { notIn: … } - the set cannot be read statically'
      if (values.includes('CANCELLED')) return `status: { notIn: ${JSON.stringify(values)} }`
    } else if (key === 'in') {
      const values = resolveStatusList(prop.initializer, checker)
      if (values === null) return 'status: { in: … } - the set cannot be read statically'
      if (!values.includes('CANCELLED') && CANCELLED_COMPLEMENT.every((status) => values.includes(status))) {
        return `status: { in: ${JSON.stringify(values)} } - the complement of CANCELLED, written out`
      }
    }
  }
  return null
}

/**
 * The depth limit exists only so a pathological or generated file cannot exhaust the stack. Reaching
 * it is an UNKNOWN recorded on the shared context and reported as a FAILURE by the caller - never an
 * answer, and never the permissive one (the first form's three inconsistent cutoffs answered "no
 * status restriction" on running out of depth, which let an exclusion be marked rescued).
 */
const MAX_WHERE_DEPTH = 64
function whereWalkContext() { return { truncated: false } }

function restrictsStatus(node, ctx, depth = 0) {
  if (depth > MAX_WHERE_DEPTH) { ctx.truncated = true; return true }
  const n = strip(node)
  if (ts.isArrayLiteralExpression(n)) return n.elements.some((e) => restrictsStatus(e, ctx, depth + 1))
  if (!ts.isObjectLiteralExpression(n)) return false
  for (const prop of n.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    if (keyOf(prop) === 'status') return true
    if (restrictsStatus(prop.initializer, ctx, depth + 1)) return true
  }
  return false
}

function guaranteesPostEvidence(node, ctx, depth = 0) {
  if (depth > MAX_WHERE_DEPTH) { ctx.truncated = true; return false }
  const n = strip(node)
  if (!ts.isObjectLiteralExpression(n)) return false
  for (const prop of n.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const key = keyOf(prop)
    if (key === 'AND' || key === 'OR') {
      const inner = strip(prop.initializer)
      if (!ts.isArrayLiteralExpression(inner)) continue
      const branches = inner.elements
      if (key === 'AND') {
        if (branches.some((e) => guaranteesPostEvidence(e, ctx, depth + 1))) return true
      } else if (branches.length > 0 && branches.every((e) => guaranteesPostEvidence(e, ctx, depth + 1))) {
        return true
      }
      continue
    }
    if (key !== 'externalTransactionId') continue
    const value = strip(prop.initializer)
    if (!ts.isObjectLiteralExpression(value)) continue
    for (const op of value.properties) {
      if (!ts.isPropertyAssignment(op)) continue
      if (keyOf(op) === 'not' && op.initializer.kind === ts.SyntaxKind.NullKeyword) return true
    }
  }
  return false
}

/**
 * Is this element of an `OR` the post-evidence ESCAPE, `{ externalTransactionId: { not: null } }`?
 * It rescues only when it (a) guarantees a non-null document id on its own and (b) places NO
 * restriction on `status` anywhere within it - presence is not alternation (two properties of one
 * object are ANDed by Prisma).
 */
function isPostEvidenceArm(node, ctx) {
  return guaranteesPostEvidence(node, ctx) && !restrictsStatus(node, ctx)
}

/**
 * Collect every `status` property of a `where`, tagged `rescued` when it sits in an `OR` that ALSO
 * offers the post-evidence arm in a DIFFERENT sibling. `rescued` is never inherited into an AND.
 */
export function collectStatusClauses(node, out, depth = 0, rescued = false, ctx = whereWalkContext()) {
  if (depth > MAX_WHERE_DEPTH) { ctx.truncated = true; return }
  const n = strip(node)
  if (ts.isArrayLiteralExpression(n)) {
    for (const e of n.elements) collectStatusClauses(e, out, depth + 1, rescued, ctx)
    return
  }
  if (!ts.isObjectLiteralExpression(n)) return
  for (const prop of n.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const key = keyOf(prop)
    if (key === 'status') out.push({ prop, rescued })
    else if (key === 'AND' || key === 'OR' || key === 'NOT') {
      const inner = strip(prop.initializer)
      if (key === 'OR' && ts.isArrayLiteralExpression(inner)) {
        const arms = inner.elements.map((e) => isPostEvidenceArm(e, ctx))
        inner.elements.forEach((element, i) => {
          collectStatusClauses(element, out, depth + 1, arms.some((isArm, j) => isArm && j !== i), ctx)
        })
        continue
      }
      collectStatusClauses(prop.initializer, out, depth + 1, false, ctx)
    }
  }
}

/** Every `externalTransactionId: { not: null }` property of a `where`, at any depth. */
function collectIdNotNull(node, out, depth = 0, ctx = whereWalkContext()) {
  if (depth > MAX_WHERE_DEPTH) { ctx.truncated = true; return }
  const n = strip(node)
  if (ts.isArrayLiteralExpression(n)) { for (const e of n.elements) collectIdNotNull(e, out, depth + 1, ctx); return }
  if (!ts.isObjectLiteralExpression(n)) return
  for (const prop of n.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const key = keyOf(prop)
    if (key === 'externalTransactionId') {
      const value = strip(prop.initializer)
      if (ts.isObjectLiteralExpression(value)) {
        for (const op of value.properties) {
          if (ts.isPropertyAssignment(op) && keyOf(op) === 'not' && op.initializer.kind === ts.SyntaxKind.NullKeyword) {
            out.push(prop)
          }
        }
      }
    } else if (key === 'AND' || key === 'OR' || key === 'NOT') {
      collectIdNotNull(prop.initializer, out, depth + 1, ctx)
    }
  }
}

const PRISMA_OPS = new Set(['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy', 'updateMany', 'update', 'deleteMany', 'delete', 'upsert'])

// ── Expression half: is this receiver an AccountingSyncLog row? ────────────────────────────────
const SYNC_LOG_MARKERS = ['externalTransactionId', 'settlementBasis', 'referenceType', 'attemptRevision',
  'syncedAtDatabaseClock', 'abandonedBeforeRemoteCall', 'processingStartedAt']
const SYNC_STATUSES = new Set(['PENDING', 'PROCESSING', 'SYNCED', 'FAILED', 'CANCELLED'])
const AE_MARKERS = ['idempotencyKey', 'linesJson', 'externalSystem', 'sourceEntityType']

/** The model's own field names, READ FROM THE SCHEMA so a column added next month is covered. */
export function accountingSyncLogColumns() {
  const schema = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8')
  const start = schema.indexOf('model AccountingSyncLog {')
  if (start < 0) throw new Error('model AccountingSyncLog not found in prisma/schema.prisma')
  const end = schema.indexOf('\n}', start)
  const body = schema.slice(start, end)
  const columns = new Set()
  for (const line of body.split('\n').slice(1)) {
    const match = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s+\S/.exec(line)
    if (match && !line.trimStart().startsWith('@@')) columns.add(match[1])
  }
  if (columns.size < 10) throw new Error(`AccountingSyncLog column scan found only ${columns.size} columns`)
  return columns
}

const MAX_SHAPE_ROUNDS = 8

/** The outermost declaration containing a node: the unit a site's key is scoped to. */
function topLevelDeclName(node, sf) {
  let n = node
  while (n.parent && n.parent !== sf) n = n.parent
  if (ts.isFunctionDeclaration(n)) return n.name?.text ?? '<anonymous>'
  if (ts.isClassDeclaration(n)) {
    const className = n.name?.text ?? '<class>'
    let m = node
    while (m.parent && m.parent !== n) m = m.parent
    const member = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : '<member>'
    return `${className}.${member}`
  }
  if (ts.isVariableStatement(n)) {
    let m = node
    while (m.parent && !ts.isVariableDeclaration(m)) m = m.parent
    if (ts.isVariableDeclaration(m)) return m.name.getText(sf)
    return n.declarationList.declarations.map((d) => d.name.getText(sf)).join('+')
  }
  return '<module>'
}

/** Does this `select` object name `column` (or is there no select, i.e. the whole row)? */
const SELECT_CONSTANTS_WITH = {
  settlementBasis: new Set(['LEDGER_STANDING_SELECT', 'PRIOR_ATTEMPT_SELECT']),
  postBasis: new Set(),
}

function selectsColumn(selectNode, column) {
  if (!selectNode) return true
  const n = strip(selectNode)
  const known = SELECT_CONSTANTS_WITH[column] ?? new Set()
  // A named select constant: trusted only when it is one of the module's own, which spread the
  // columns themselves. Anything else we cannot read FAILS CLOSED (false).
  if (ts.isIdentifier(n)) return known.has(n.text)
  if (!ts.isObjectLiteralExpression(n)) return false
  for (const prop of n.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const e = strip(prop.expression)
      if (ts.isIdentifier(e) && known.has(e.text)) return true
      continue
    }
    if (ts.isShorthandPropertyAssignment(prop)) { if (prop.name.text === column) return true; continue }
    if (ts.isPropertyAssignment(prop) && keyOf(prop) === column) return true
  }
  return false
}

/**
 * The scan itself, over a BUILT PROGRAM rather than over this repository. Separated from {@link main}
 * so every detector can be driven against synthetic sources, and every shape the census learns to
 * see proved on a fixture instead of on whichever real file happens to have it today.
 *
 * Returns `sites` (each with its key), the reduced shapes followed, the number of source files
 * scanned, and `failures` that are about the SCAN itself (a truncated walk, a non-terminating shape
 * fixed point) - never about declarations, which {@link reconcile} owns.
 */
export function scanProgram({ program, checker, inScope, columns, root = ROOT }) {
  const failures = []
  const raw = []

  const isSyncStatusUnion = (t) => {
    if (!t) return false
    const parts = t.isUnion() ? t.types : [t]
    if (parts.length < 2) return false
    return parts.every((p) => typeof p.value === 'string' && SYNC_STATUSES.has(p.value))
  }
  const propsOf = (t) => {
    if (!t) return null
    try { return checker.getPropertiesOfType(t).map((p) => p.getName()) } catch { return null }
  }
  const isSyncLogShaped = (t) => {
    const props = propsOf(t)
    return !!props && props.includes('status') && SYNC_LOG_MARKERS.some((m) => props.includes(m))
  }
  // A loosely-typed row (an injected client interface declaring `{ status: string }`): the status is
  // typed `string`, every property is one of this table's columns, and the file queries the table.
  const isUntypedSyncLogShape = (declaredStatusType, receiverType) => {
    if (!declaredStatusType || checker.typeToString(declaredStatusType) !== 'string') return false
    const props = propsOf(receiverType)
    if (!props || props.length === 0 || !props.includes('status')) return false
    return props.every((name) => columns.has(name))
  }
  const shapeSignature = (t) => {
    const props = propsOf(t)
    if (!props || props.length === 0 || !props.includes('status')) return null
    return [...props].sort().join(',')
  }
  const reducedRowShapes = new Map()

  const files = []
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    const file = relative(root, sf.fileName)
    if (!inScope.has(file)) continue
    files.push({ sf, file, queriesSyncLogs: sf.text.includes('accountingSyncLog') })
  }

  const statusTypesOf = (access) => {
    let declaredStatusType = null
    let receiverType = null
    try {
      receiverType = checker.getTypeAtLocation(access.expression)
      const property = receiverType?.getProperty?.('status')
      declaredStatusType = property ? checker.getTypeOfSymbol(property) : checker.getTypeAtLocation(access)
    } catch { /* unresolvable */ }
    return { declaredStatusType, receiverType }
  }

  // The DECLARED type of the property, not the narrowed one: `x.status === 'A' && x.status !== 'A'`
  // narrows the second occurrence to a literal, which no detector would recognise.
  const readsSyncLogStatus = (access, queriesSyncLogs) => {
    if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'status') return false
    const { declaredStatusType, receiverType } = statusTypesOf(access)
    return isSyncStatusUnion(declaredStatusType)
      || isSyncLogShaped(receiverType)
      || (queriesSyncLogs && isUntypedSyncLogShape(declaredStatusType, receiverType))
      || reducedRowShapes.has(shapeSignature(receiverType))
  }

  // AccountingEvent-shaped receiver whose type does NOT carry postBasis.
  const readsEventStatusWithoutBasis = (access) => {
    if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'status') return false
    const props = propsOf(checker.getTypeAtLocation(access.expression))
    return !!props && props.includes('status') && !props.includes('postBasis')
      && AE_MARKERS.some((m) => props.includes(m))
  }

  // ── PASS 1: WHICH REDUCED SHAPES ARE SYNC-LOG ROWS ────────────────────────────────────────────
  for (let round = 0; round < MAX_SHAPE_ROUNDS; round++) {
    const before = reducedRowShapes.size
    for (const { sf, file, queriesSyncLogs } of files) {
      const seek = (node) => {
        if (ts.isObjectLiteralExpression(node)) {
          for (const prop of node.properties) {
            if (!ts.isPropertyAssignment(prop)) continue
            if (keyOf(prop) !== 'status') continue
            const value = strip(prop.initializer)
            if (!readsSyncLogStatus(value, queriesSyncLogs)) continue
            let signature = null
            try { signature = shapeSignature(checker.getTypeAtLocation(node)) } catch { signature = null }
            if (signature === null || reducedRowShapes.has(signature)) continue
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
            reducedRowShapes.set(signature, `${file}:${line + 1}`)
          }
        }
        ts.forEachChild(node, seek)
      }
      seek(sf)
    }
    if (reducedRowShapes.size === before) break
    if (round === MAX_SHAPE_ROUNDS - 1) {
      failures.push(
        `the reduced-row-shape scan was still finding new shapes after ${MAX_SHAPE_ROUNDS} rounds, so the\n`
        + '    set it judged the sources against is INCOMPLETE. That is an unknown, and an unknown here\n'
        + '    reads as "a reader may be unseen" - raise MAX_SHAPE_ROUNDS and re-run.',
      )
    }
  }

  // ── PASS 2: THE SITES ─────────────────────────────────────────────────────────────────────────
  for (const { sf, file, queriesSyncLogs } of files) {
    const add = (node, kind, detail, extra = {}) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      raw.push({
        file, line: line + 1, pos: node.getStart(sf), kind,
        decl: topLevelDeclName(node, sf),
        detail: detail.replace(/\s+/g, ' ').slice(0, 110),
        ...extra,
      })
    }
    const isLit = (node, text) => literalText(node, checker) === text

    /** A `where` object: the status clauses, the id-not-null properties, whose select it travels with. */
    const examineWhere = (whereInit, argObject, anchor) => {
      const clauses = []
      const ctx = whereWalkContext()
      collectStatusClauses(whereInit, clauses, 0, false, ctx)
      const idClauses = []
      collectIdNotNull(whereInit, idClauses, 0, ctx)
      if (ctx.truncated) {
        const { line } = sf.getLineAndCharacterOfPosition(anchor.getStart(sf))
        failures.push(
          `${file}:${line + 1} has a \`where\` this census could not finish reading (depth > ${MAX_WHERE_DEPTH}).\n`
          + '    UNKNOWN fails CLOSED here on purpose: a walk that gave up used to answer "no status\n'
          + '    restriction", which is the permissive answer.',
        )
      }
      let selectNode = null
      if (argObject) {
        for (const p of argObject.properties) {
          if (ts.isPropertyAssignment(p) && keyOf(p) === 'select') selectNode = p.initializer
        }
      }
      const selectsBasis = selectsColumn(selectNode, 'settlementBasis')
      for (const { prop, rescued } of clauses) {
        const described = excludesCancelled(prop.initializer, checker)
        if (described !== null) add(prop, 'where-excludes-cancelled', described, { rescued, selectsBasis })
        const admitted = admittedStatuses(prop.initializer, checker, [...SYNC_STATUSES])
        if (admitted === null) {
          add(prop, 'where-admits-synced', 'status clause cannot be read statically (fails closed)', { rescued, selectsBasis })
        } else if (admitted.has('SYNCED')) {
          add(prop, 'where-admits-synced', prop.getText(sf), { rescued, selectsBasis })
        }
      }
      for (const prop of idClauses) add(prop, 'where-id-not-null', prop.getText(sf), { selectsBasis })
    }

    const coveredWhereLiterals = new Set()
    /** Mark every object literal under a where root as covered, so a typed-literal pass cannot recount. */
    const coverUnder = (node) => {
      const visit = (n) => { if (ts.isObjectLiteralExpression(n)) coveredWhereLiterals.add(n); ts.forEachChild(n, visit) }
      visit(node)
    }

    const isStatusCompareOp = (kind) => [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(kind)

    const visit = (node) => {
      // ── QUERY HALF: Prisma operations ──────────────────────────────────────────────────────
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const op = node.expression.name.text
        const receiver = node.expression.expression
        // `tx.accountingSyncLog.findMany(...)` AND an injected delegate (`accountingEvent.findFirst(...)`
        // on a parameter): the model is the receiver's own name either way.
        const receiverName = ts.isPropertyAccessExpression(receiver) ? receiver.name.text
          : ts.isIdentifier(receiver) ? receiver.text : null
        if (PRISMA_OPS.has(op) && receiverName !== null) {
          const arg = node.arguments[0]
          const model = receiverName
          if (model === 'accountingSyncLog' && arg && ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              if (!ts.isPropertyAssignment(prop) || keyOf(prop) !== 'where') continue
              coverUnder(prop.initializer)
              examineWhere(prop.initializer, arg, prop)
            }
          }
          if (model === 'accountingEvent' && arg && ts.isObjectLiteralExpression(arg)) {
            let whereInit = null
            let selectNode = null
            for (const prop of arg.properties) {
              if (!ts.isPropertyAssignment(prop)) continue
              if (keyOf(prop) === 'where') whereInit = prop.initializer
              if (keyOf(prop) === 'select') selectNode = prop.initializer
            }
            if (whereInit) {
              const clauses = []
              collectStatusClauses(whereInit, clauses, 0, false, whereWalkContext())
              for (const { prop } of clauses) {
                const admitted = admittedStatuses(prop.initializer, checker, ['PENDING', 'POSTED', 'FAILED', 'VOID', 'SUPERSEDED', 'REVERSED'])
                const admitsPosted = admitted === null || admitted.has('POSTED')
                if (admitsPosted && selectsColumn(selectNode, 'postBasis') === false) {
                  add(prop, 'ae-posted-query', `${model}.${op} where ${prop.getText(sf)} selects no postBasis`)
                }
              }
            }
          }
        }
      }

      // ── comparisons ────────────────────────────────────────────────────────────────────────
      if (ts.isBinaryExpression(node) && isStatusCompareOp(node.operatorToken.kind)) {
        for (const [access, literal] of [[node.left, node.right], [node.right, node.left]]) {
          if (readsSyncLogStatus(access, queriesSyncLogs)) {
            if (isLit(literal, 'CANCELLED')) add(node, 'cmp-cancelled', node.getText(sf))
            if (isLit(literal, 'SYNCED')) add(node, 'cmp-synced', node.getText(sf))
          }
          if (readsEventStatusWithoutBasis(access) && isLit(literal, 'POSTED')) {
            add(node, 'ae-posted-compare', node.getText(sf))
          }
          // id-read: `row.externalTransactionId !== null | undefined | ''`
          const idAccess = strip(access)
          if (ts.isPropertyAccessExpression(idAccess) && idAccess.name.text === 'externalTransactionId') {
            const other = strip(literal)
            if (other.kind === ts.SyntaxKind.NullKeyword
              || (ts.isIdentifier(other) && other.text === 'undefined')
              || (ts.isStringLiteral(other) && other.text === '')) {
              add(node, 'id-read', node.getText(sf))
            }
          }
        }
      }

      // switch over the status
      if (ts.isSwitchStatement(node)) {
        const syncish = readsSyncLogStatus(node.expression, queriesSyncLogs)
        const eventish = readsEventStatusWithoutBasis(node.expression)
        if (syncish || eventish) {
          for (const clause of node.caseBlock.clauses) {
            if (!ts.isCaseClause(clause)) continue
            if (syncish && isLit(clause.expression, 'CANCELLED')) add(clause, 'cmp-cancelled', `switch (${node.expression.getText(sf)}) { case 'CANCELLED'`)
            if (syncish && isLit(clause.expression, 'SYNCED')) add(clause, 'cmp-synced', `switch (${node.expression.getText(sf)}) { case 'SYNCED'`)
            if (eventish && isLit(clause.expression, 'POSTED')) add(clause, 'ae-posted-compare', `switch (${node.expression.getText(sf)}) { case 'POSTED'`)
          }
        }
      }

      // membership of a resolved set: `[…].includes(row.status)`, `SET.has(row.status)`
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['includes', 'has'].includes(node.expression.name.text) && node.arguments.length === 1) {
        const arg0 = node.arguments[0]
        const syncish = readsSyncLogStatus(arg0, queriesSyncLogs)
        const eventish = readsEventStatusWithoutBasis(arg0)
        if (syncish || eventish) {
          const members = resolveStatusList(node.expression.expression, checker)
          if (members !== null) {
            if (syncish && members.includes('CANCELLED')) add(node, 'cmp-cancelled', node.getText(sf))
            if (syncish && members.includes('SYNCED')) add(node, 'cmp-synced', node.getText(sf))
            if (eventish && members.includes('POSTED')) add(node, 'ae-posted-compare', node.getText(sf))
          } else if (syncish) {
            // an unresolvable set tested against a sync-log status: fail closed as the broader kind
            add(node, 'cmp-synced', `${node.getText(sf)} - the set cannot be read statically (fails closed)`)
          }
        }
      }

      // ── id-read: truthiness forms ───────────────────────────────────────────────────────────
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'externalTransactionId') {
        // climb through parentheses / non-null / as to the expression whose value is being tested
        let child = node
        let parent = node.parent
        while (parent && (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent))) {
          child = parent
          parent = parent.parent
        }
        let truthy = false
        if (parent) {
          if ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === child) truthy = true
          else if (ts.isForStatement(parent) && parent.condition === child) truthy = true
          else if (ts.isConditionalExpression(parent) && parent.condition === child) truthy = true
          else if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) truthy = true
          else if (ts.isBinaryExpression(parent)
            && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind)) truthy = true
          else if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'Boolean'
            && parent.arguments[0] === child) truthy = true
          else if (ts.isArrowFunction(parent) && parent.body === child && parent.parent && ts.isCallExpression(parent.parent)
            && ts.isPropertyAccessExpression(parent.parent.expression)
            && ['filter', 'some', 'every', 'find', 'findIndex', 'findLast'].includes(parent.parent.expression.name.text)) truthy = true
        }
        if (truthy) add(node, 'id-read', node.parent.getText(sf))
      }

      ts.forEachChild(node, visit)
    }
    visit(sf)

    // ── a `where` constant typed as AccountingSyncLogWhereInput, outside any Prisma call ─────────
    // (the shared predicates: PRIOR_ATTEMPT_COUNTERPART_EXISTS_OR, UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE, …)
    const visitTyped = (node) => {
      if (ts.isObjectLiteralExpression(node) && !coveredWhereLiterals.has(node)) {
        let contextual = null
        try { contextual = checker.getContextualType(node) } catch { contextual = null }
        const text = contextual ? checker.typeToString(contextual) : ''
        if (/AccountingSyncLogWhereInput/.test(text)) {
          // the OUTERMOST such literal only: nested ones are walked by the examination itself
          let outer = true
          for (let a = node.parent; a; a = a.parent) {
            if (ts.isObjectLiteralExpression(a) && /AccountingSyncLogWhereInput/.test(
              (() => { try { const c = checker.getContextualType(a); return c ? checker.typeToString(c) : '' } catch { return '' } })())) {
              outer = false
              break
            }
          }
          if (outer) {
            coverUnder(node)
            examineWhere(node, null, node)
          }
        }
        // an array of where inputs (`OR: [...]` typed constants) is reached through its elements
      }
      ts.forEachChild(node, visitTyped)
    }
    visitTyped(sf)
  }

  // ── keys: ordinal within (file, declaration, kind), in source order ───────────────────────────
  raw.sort((a, b) => (a.file === b.file ? a.pos - b.pos : a.file < b.file ? -1 : 1))
  const seen = new Map()
  const sites = []
  const dedupe = new Set()
  for (const site of raw) {
    // the same node can be reached by two routes (a typed constant also inside a call); count it once
    const id = `${site.file}:${site.pos}:${site.kind}`
    if (dedupe.has(id)) continue
    dedupe.add(id)
    if (site.file === OWNING_MODULE) continue
    const bucket = `${site.file}::${site.decl}::${site.kind}`
    const ordinal = (seen.get(bucket) ?? 0) + 1
    seen.set(bucket, ordinal)
    sites.push({ ...site, key: `${bucket}#${ordinal}` })
  }

  return { sites, failures, reducedRowShapes, sourceFileCount: files.length }
}

/**
 * Reconcile the sites a scan found against the declarations. UNIVERSAL in both directions: every
 * site must be declared, every declaration must be found. Returns the failures (empty when clean).
 */
export function reconcile(sites, declarations) {
  const failures = []
  const byKey = new Map()
  for (const d of declarations) {
    if (byKey.has(d.key)) failures.push(`declaration ${d.key} appears twice.`)
    byKey.set(d.key, d)
    const cls = d.class
    if (!CLASSES.includes(cls) && !PENDING_RE.test(cls ?? '')) {
      failures.push(`declaration ${d.key} has class "${cls}": it must be one of ${CLASSES.join(', ')} or PENDING_CONVERSION:<bead id>.`)
    }
    if (typeof d.reason !== 'string' || d.reason.trim().length < 12) {
      failures.push(`declaration ${d.key} has no reason (a declaration is an argument, not a mute).`)
    }
  }
  const foundKeys = new Set()
  for (const site of sites) {
    foundKeys.add(site.key)
    const d = byKey.get(site.key)
    if (!d) {
      failures.push(
        `${site.file}:${site.line} is an UNDECLARED ${site.kind} - ${site.detail}\n`
        + `    key: ${site.key}\n`
        + `    Ask the module (${OWNING_MODULE}) - ledgerStanding / mayHaveReachedLedger / workSlotStanding /\n`
        + `    the *_WHERE fragments - or declare this exact site in ${DECLARATIONS_PATH} with a class and a reason.`,
      )
      continue
    }
    if (d.class === 'WORK_SLOT' && /^where-/.test(site.kind) && site.selectsBasis === false) {
      failures.push(
        `${site.file}:${site.line} is declared WORK_SLOT but its query does not select \`settlementBasis\`.\n`
        + '    The work-slot question is "may another posting be raised"; answering it without knowing whether the\n'
        + '    occupant is an operator\'s assertion is the laundering the module ends.',
      )
    }
    if (typeof d.rescued === 'boolean' && site.kind === 'where-excludes-cancelled' && site.rescued !== d.rescued) {
      failures.push(
        `${site.file}:${site.line} was declared rescued:${d.rescued} but was found rescued:${site.rescued}.\n`
        + '    A clause that moved from an OR to an AND still excludes CANCELLED and the count cannot see it.',
      )
    }
  }
  for (const d of declarations) {
    if (!foundKeys.has(d.key)) {
      failures.push(
        `declaration ${d.key} is STALE: no such site exists any more.\n`
        + '    Delete it - an allowlist nothing matches permits everything it was written to forbid.',
      )
    }
  }
  return failures
}

// ── DDL census (carried from the first form) ──────────────────────────────────────────────────────
const MIGRATION_OWNERS = new Map([
  ['prisma/migrations/20260424214500_accounting_sync_idempotency_key/migration.sql',
    'accounting_sync_logs_idempotency_key_uq. `status IN (PENDING,PROCESSING,SYNCED)` is the work-slot predicate '
    + '(WORK_SLOT_STATUSES in ledger-standing.ts states it once in TypeScript).'],
  ['prisma/migrations/20260613020000_followup_sync_unique_index/migration.sql',
    'accounting_sync_logs_followup_live_unique, first form. Same predicate, same reason.'],
  ['prisma/migrations/20260615000000_followup_unique_index_add_credit_note_allocation/migration.sql',
    'The same index rebuilt to add PURCHASE_CREDIT_NOTE_ALLOCATION. Same predicate, same reason.'],
  ['prisma/migrations/20260819120000_followup_live_unique_anchor_scoped/migration.sql',
    'The same index rebuilt anchor-scoped. Same predicate, same reason.'],
])

function censusMigrations(failures) {
  const migrationsRoot = join(ROOT, 'prisma', 'migrations')
  let migrationDirs = []
  try { migrationDirs = readdirSync(migrationsRoot) } catch { migrationDirs = [] }
  const seen = new Set()
  for (const dir of migrationDirs) {
    const sqlPath = join(migrationsRoot, dir, 'migration.sql')
    let sql
    try {
      if (!statSync(sqlPath).isFile()) continue
      sql = readFileSync(sqlPath, 'utf8')
    } catch { continue }
    if (!sql.includes('accounting_sync_logs')) continue
    // Comments are stripped first: several migrations DESCRIBE the index predicate in prose without
    // creating one.
    const statements = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const statusSets = statements.match(/"?status"?\s+IN\s*\(([^)]*)\)/gi) ?? []
    if (!statusSets.some((set) => /SYNCED/i.test(set) && !/CANCELLED/i.test(set))) continue
    const rel = relative(ROOT, sqlPath)
    seen.add(rel)
    if (!MIGRATION_OWNERS.has(rel)) {
      failures.push(
        `${rel} states in DDL a status set admitting SYNCED and omitting CANCELLED against accounting_sync_logs.\n`
        + '    An index OVERRIDES every application-side reading of the rule, so it must be named in MIGRATION_OWNERS.',
      )
    }
  }
  for (const owner of MIGRATION_OWNERS.keys()) {
    if (!seen.has(owner)) {
      failures.push(`MIGRATION_OWNERS is stale: ${owner} no longer contains such a status set. Drop the owner.`)
    }
  }
  return seen.size
}

/** Sites counted per kind. */
export function countByKind(sites) {
  const byKind = {}
  for (const site of sites) byKind[site.kind] = (byKind[site.kind] ?? 0) + 1
  return byKind
}

/**
 * THE GUARD PROVES IT RAN. A scan that reached fewer source files than the floor, or found fewer sites
 * of a kind than this tree is known to contain, has not reached its subject: "subject not reached" is a
 * FAILURE, never a pass. Exported so the tests can feed it an empty scan.
 */
export function floorFailures({ sites, sourceFileCount, minFiles = MIN_SOURCE_FILES, minSites = MIN_SITES_BY_KIND }) {
  const failures = []
  const byKind = countByKind(sites)
  if (sourceFileCount < minFiles) {
    failures.push(
      `subject not reached: the scan saw ${sourceFileCount} source file(s) and the floor is ${minFiles}.\n`
      + `    The scan roots (${SOURCE_ROOTS.join(', ')}) or tsconfig.json's include no longer cover the tree. A guard\n`
      + '    that examined nothing is the guard that passes when its roots are wrong.',
    )
  }
  for (const [kind, floor] of Object.entries(minSites)) {
    if ((byKind[kind] ?? 0) < floor) {
      failures.push(
        `subject not reached: found ${byKind[kind] ?? 0} ${kind} site(s) and this tree is known to contain at least ${floor}.\n`
        + '    The detector for that kind no longer sees what it was written to see.',
      )
    }
  }
  return failures
}

async function main() {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) { console.error('tsconfig.json not found - nothing to scan'); process.exit(2) }
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) { console.error(`tsconfig.json is unreadable: ${ts.flattenDiagnosticMessageText(config.error.messageText, '\n')}`); process.exit(2) }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT)
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
  const checker = program.getTypeChecker()

  const inScope = new Set(SOURCE_ROOTS.flatMap((root) => walk(join(ROOT, root))).map((p) => relative(ROOT, p)))
  const scan = scanProgram({ program, checker, inScope, columns: accountingSyncLogColumns() })
  const failures = [...scan.failures]

  // ── SUBJECT NOT REACHED ──────────────────────────────────────────────────────────────────────
  const byKind = countByKind(scan.sites)
  failures.push(...floorFailures({ sites: scan.sites, sourceFileCount: scan.sourceFileCount }))

  let declarations
  try {
    declarations = (await import(pathToFileURL(join(ROOT, DECLARATIONS_PATH)).href)).DECLARATIONS
  } catch (error) {
    console.error(`cannot read ${DECLARATIONS_PATH}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  if (!Array.isArray(declarations)) { console.error(`${DECLARATIONS_PATH} must export DECLARATIONS as an array`); process.exit(2) }
  failures.push(...reconcile(scan.sites, declarations))
  const migrations = censusMigrations(failures)

  if (failures.length > 0) {
    console.error('\nWhat an AccountingSyncLog row says about the ledger is decided in ONE place (o3d-f709).\n')
    for (const failure of failures) console.error(`  x ${failure}\n`)
    console.error(`${failures.length} problem(s). The rule lives in ${OWNING_MODULE}.\n`)
    process.exit(1)
  }

  const clauses = (byKind['where-excludes-cancelled'] ?? 0) + (byKind['where-admits-synced'] ?? 0) + (byKind['where-id-not-null'] ?? 0)
  const comparisons = (byKind['cmp-cancelled'] ?? 0) + (byKind['cmp-synced'] ?? 0)
  const aeReads = (byKind['ae-posted-query'] ?? 0) + (byKind['ae-posted-compare'] ?? 0)
  const classes = {}
  for (const d of declarations) {
    const c = d.class.startsWith('PENDING_CONVERSION') ? 'PENDING_CONVERSION' : d.class
    classes[c] = (classes[c] ?? 0) + 1
  }
  console.log(
    `OK ledger-standing readers: ${scan.sourceFileCount} source file(s) scanned; ${scan.sites.length} site(s) all declared `
    + `(${clauses} query clause(s), ${comparisons} status comparison(s), ${byKind['id-read'] ?? 0} document-id read(s), `
    + `${aeReads} AccountingEvent POSTED read(s)); ${migrations} migration(s) censused; `
    + `${scan.reducedRowShapes.size} reduced row shape(s) followed.`,
  )
  console.log(`    by kind: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  console.log(`    by class: ${Object.entries(classes).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  for (const [signature, at] of scan.reducedRowShapes) console.log(`    reduced row shape: {${signature}} from ${at}`)
}

/** RUN ONLY WHEN RUN, so the tests can import the detectors and drive them on synthetic sources. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exit(2) })
}
