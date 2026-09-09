#!/usr/bin/env node

/**
 * Static guard: WHAT `AccountingSyncLog.status = 'CANCELLED'` IS ALLOWED TO MEAN IS DECIDED IN ONE
 * PLACE, and nowhere else may hand-write it (o3d-f709).
 *
 * WHAT IT IS DEFENDING. `CANCELLED` on that table records that somebody or something ABANDONED the
 * row. Five writers reach it and only one of them knows anything about the ledger: the
 * cross-connector orphan sweep matches `status = PENDING` — provably pre-call — and says so in the
 * same UPDATE. `cancelPendingSalesInvoiceSyncForOrder`, the post-time retirement of a row a worker
 * already held, and both operator settlements (`buildSettlementData` NOT_POSTED and
 * `buildCancelledSaleSettlementData`, the second of which writes a DOCUMENT ID onto the row) do
 * not. The processors POST BEFORE they persist SYNCED and the external id, so an abandoned row may
 * already be in a real ledger with nothing local saying so.
 *
 * Ten readers nonetheless spelt "a cancelled row committed nothing" for themselves, each under a
 * comment asserting it, and the money-path ones turn that into an ADMITTED reversal, a released
 * blocker, or a second payment. `lib/domain/accounting/cancelled-row-evidence.ts` states the rule
 * once, over `cancelledClaimIsResolved`, in the two languages the readers ask it in.
 *
 * ── THE RULE, GRAMMATICALLY (the query half) ────────────────────────────────────────────────────
 *
 * On a Prisma operation whose model is `accountingSyncLog`, a `where`-side `status` clause EXCLUDES
 * CANCELLED — and is therefore a statement about what a cancelled row proves — when it is any of:
 *
 *   • `{ not: 'CANCELLED' }`
 *   • `{ notIn: [ … 'CANCELLED' … ] }`
 *   • `{ in: [ … ] }` that admits EVERY OTHER STATUS — PENDING, PROCESSING, SYNCED and FAILED —
 *     and omits CANCELLED.
 *
 * The third clause is why this is not simply a search for the word. `['PENDING','PROCESSING',
 * 'SYNCED','FAILED']` IS `{ not: 'CANCELLED' }` written out, and it is how two of the six copies
 * were spelt — one of them behind a constant named for something else entirely
 * (`PURCHASE_ORDER_ATTRIBUTION_LIVE_STATUSES`, since DELETED: it turned out to be the round-1 HIGH
 * and not an override at all, see below), and one behind a name that a DIFFERENT constant in this
 * tree also carries with a different body (`LIVE_ACCOUNTING_SYNC_STATUSES` is four statuses in
 * lib/domain/sales/order-delete-guard.ts and two in app/actions/accounting-sync.ts).
 *
 * WHY THE COMPLEMENT AND NOT MERELY "OMITS CANCELLED", which was this guard's first form and which
 * over-reached by a factor of three. A set that omits CANCELLED *and* omits FAILED — the nine
 * `['PENDING','PROCESSING','SYNCED']` sites, `['SYNCED']`, `['SYNCED','FAILED']` — is not making
 * this claim. It is asking "is there live or finished WORK on this row?", and a cancelled row
 * genuinely is not live work: routing those through the shared predicate would make an abandoned
 * row suppress its own re-enqueue, which is a duplicate-post defect in the opposite direction. Only
 * a set that admits every other status is saying "the sole thing that disqualifies a row here is
 * that somebody abandoned it", which is this rule and nothing else.
 *
 * That those sets ALSO read a status as evidence about a document — an operator-asserted SYNCED row
 * is a laundering of its own — is TRUE and is NOT this rule. It has a different carrier
 * (`settlementBasis`, via `isOperatorAssertedSettlement`) and is tracked separately; conflating the
 * two would mean reporting an asserted post as a ledger fact in order to stop reporting an
 * abandoned row as one.
 *
 * ── AND THE SAME RULE IN TYPESCRIPT (the expression half) ───────────────────────────────────────
 *
 * The query half would have missed the site the issue names FIRST. `classifyRegisteredPayment` did
 * not write a `where` at all: it wrote `if (row.status === 'CANCELLED') continue` over rows another
 * function had loaded. So every comparison of a sync-log row's `status` against `'CANCELLED'` is
 * enumerated too, and each must be named in {@link STATUS_COMPARISON_OWNERS} with a reason.
 *
 * IT IS TYPE-AWARE, NOT NAME-AWARE, and that is load-bearing rather than fastidious. `so.status ===
 * 'CANCELLED'`, `po.status === 'CANCELLED'` and `count.status === 'CANCELLED'` are twenty-odd
 * comparisons in the same directories against SalesOrder, PurchaseOrder and StockCount — none of
 * them this rule's business. A syntactic guard would have to allowlist all of them, which is an
 * allowlist long enough to stop meaning anything; the checker separates them exactly, by asking
 * whether the RECEIVER carries `status` plus a column only `AccountingSyncLog` has. Building the
 * program costs about fifteen seconds.
 *
 * ── AND THE SAME RULE IN DDL ────────────────────────────────────────────────────────────────────
 *
 * o3d-272i r2 found that the most damaging copy of a predicate can be the one no `where` object can
 * correct, because an index OVERRIDES every application-side fix. Both partial unique indexes on
 * this table carry `status IN ('PENDING','PROCESSING','SYNCED')`, which is this rule's shape
 * exactly — and here it is DELIBERATE and load-bearing, not a copy to be removed: retiring a row to
 * CANCELLED in order to free the slot is precisely what `buildSettlementData`'s NOT_POSTED branch
 * exists to do. So the DDL half is a CENSUS rather than a prohibition: a migration naming this
 * table with such a predicate must be named in {@link MIGRATION_OWNERS}, with the reason, so a
 * SEVENTH one cannot arrive unremarked.
 *
 * ── WHAT IT CANNOT SEE, SAID PLAINLY ────────────────────────────────────────────────────────────
 *
 *   • A status set assembled at runtime — filtered, concatenated, spread from a call — is read as
 *     unresolvable and skipped rather than guessed at. Constants are resolved same-file, and
 *     cross-file by their imported name where the exporting file declares them as a plain array.
 *   • Raw SQL in TypeScript. `$queryRaw` against this table exists (create-dispatch-record.ts,
 *     money-attempt-provenance.ts) but neither statement carries a status predicate today; if one
 *     ever does, this guard will not see it, and the DDL census above is the nearest thing.
 *   • WHY scripts/lib/ts-import-aliases.mjs IS NOT IMPORTED, although every other guard on this
 *     branch needs it. That module exists to stop an `as` alias switching a NAME-based fence off.
 *     Nothing here is fenced by name: the query half forbids a SHAPE and the expression half
 *     enumerates a SHAPE, and both resolve identifiers through the type checker, which sees through
 *     aliases, namespace imports and `const a = b` chains by construction. There is no name for an
 *     alias to hide.
 *   • A comparison reached through a variable (`const s = row.status; if (s === 'CANCELLED')`) or a
 *     `switch`. Judged rather than waved at: neither is how this claim gets written — every one of
 *     the twelve real sites is a direct comparison or a `where` — and both are how one gets written
 *     by somebody working around a red check, for whom this guard is a message and not a wall.
 *
 * ── THE GUARD PROVES IT RAN ─────────────────────────────────────────────────────────────────────
 *
 * Every owner below must be FOUND, at the stated count. A rename or a deletion that leaves an owner
 * unmatched is an ERROR, not a quiet pass: an allowlist that has gone stale is a guard that permits
 * everything it was written to forbid. It is also what makes a SEVENTH copy in an already-owned
 * file fail — the count, not merely the filename, is the declaration.
 *
 * Run via `npm run check:accounting-cancelled-row-predicates`; invoked by `npm run check:all`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()

/** The module that owns the rule. Nothing else may state it. */
const OWNING_MODULE = 'lib/domain/accounting/cancelled-row-evidence.ts'

/** The exported Prisma predicate every excluding query must route through. */
const SHARED_WHERE = 'MAY_HAVE_REACHED_LEDGER_WHERE'
/** The exported TypeScript predicate every excluding reader must route through. */
const SHARED_PREDICATE = 'mayHaveReachedLedger'

/**
 * QUERY-HALF OVERRIDES: files permitted to exclude CANCELLED from an accountingSyncLog `status`
 * clause without going through {@link SHARED_WHERE}, with the argument for each. `count` is the
 * number of such clauses in the file, so a SEVENTH copy in an owned file is still a failure.
 */
const PREDICATE_OWNERS = new Map([
  ['lib/domain/sales/order-delete-guard.ts', {
    count: 2,
    reason:
      'o3d-v7sy/o3d-anu8: this guard does not read the status ALONE — BOTH queries OR the live set '
      + 'with `externalTransactionId: { not: null }`, so shape (c) (CANCELLED + a document id) still '
      + 'blocks the delete. The CANCELLED-with-no-id case is EXCLUDED ON PURPOSE and the file argues '
      + 'it at length: `buildSettlementData` leaves the column NULL precisely so that an audited '
      + 'NOT_POSTED assertion makes an order deletable again, which is the state o3d-nf9i exists to '
      + 'reach. Routing it through the shared predicate would re-strand every order an operator has '
      + 'settled.\n'
      + '      o3d-f709: "BOTH" is load-bearing and was FALSE when this entry was written. The '
      + 'daily-batch blocker had the status set as its ONLY test, conjoined at the top level of the '
      + 'where — an AND, not an OR — so a CANCELLED DAILY_BATCH_* row carrying the journal id Xero '
      + 'issued matched nothing and the blocker disappeared. Fixed in the same commit as this '
      + 'sentence. Whoever edits either query must re-read BOTH before editing this reason: the '
      + 'count proves the clauses exist, and NOTHING here proves they are still ORed.',
  }],
  ['app/actions/sales.ts', {
    count: 1,
    reason:
      'o3d-anu8: `readPaymentRegistrations` ORs READABLE_REGISTRATION_STATUSES (which resolves to '
      + 'the four-status complement) with `externalTransactionId: { not: null }`, so shape (c) is '
      + 'read, and it hands every row it finds to `registrationLedgerStanding` — the deliberate '
      + 'three-value override recorded against lib/domain/accounting/payment-ledger-hold.ts below. '
      + 'The set is a READ WIDTH for that classifier, not a verdict; narrowing or widening it here '
      + 'without changing the classifier is what this owner entry exists to make visible. FOUND BY '
      + 'THE GUARD ITSELF, after the constant resolver was rebuilt on the checker: the name-map '
      + 'version could not see through the import and reported this file clean.',
  }],
])

/**
 * EXPRESSION-HALF OWNERS: every comparison of a sync-log row's `status` against `'CANCELLED'`
 * outside the owning module, with the reason it is not a hand-written copy of the rule.
 */
const STATUS_COMPARISON_OWNERS = new Map([
  ['app/(dashboard)/sync/xero-client.tsx', {
    count: 1,
    reason: 'DISPLAY. Chooses a badge for a row already fetched; concludes nothing about a ledger.',
  }],
  ['lib/connectors/xero/sync-processor.ts', {
    count: 1,
    reason:
      'o3d-anu8: SPLITS a fetched page into its FAILED and its asserted-CANCELLED halves so the '
      + 'follow-up planner can say what cleared an ambiguity. A bucket label, not a verdict — the '
      + 'planner is the reader, and it weighs the payload, not the status.',
  }],
  ['lib/domain/accounting/cancelled-sale-release.ts', {
    count: 1,
    reason:
      'o3d-psvi: a PRECONDITION, and the opposite polarity to this rule. It refuses to release a row '
      + 'that is NOT cancelled; it draws no conclusion from one that is.',
  }],
  ['lib/domain/accounting/allocated-inventory-debit.ts', {
    count: 1,
    reason:
      'o3d-o97 r5/r6: ALREADY STATES THIS RULE CORRECTLY, in the direction this issue is about. It '
      + 'reads CANCELLED and refuses to clear the debit — "the row was abandoned and not that the '
      + 'ledger was never reached" — so it draws the conservative conclusion the shared predicate '
      + 'draws. Not routed through it because it has no row to hand over: the read selects '
      + '`{ status: true }` alone through an injected client interface, which is also why this site '
      + 'was invisible to two of the three detectors and was found by mutating one in.',
  }],
  ['lib/domain/accounting/payment-ledger-hold.ts', {
    count: 1,
    reason:
      'o3d-anu8 FIXED THIS ONE, and it is the deliberate divergence. `registrationLedgerStanding` '
      + 'answers in three values (HELD / UNDECIDED / NOTHING) for INVOICE_PAYMENT rows only, and '
      + 'argues in place why an ordinary CANCELLED registration reads NOTHING there: its writers are '
      + 'narrower — a PENDING row retired pre-call, or a registration retired after Xero was asked '
      + 'and answered DELETED — and reading them as UNDECIDED would alarm for ever over the reversal '
      + 'that fixed them. It already consults `settlementBasis` and post evidence. Kept as an '
      + 'explicit override of the shared rule rather than folded into it: the two disagree about the '
      + 'unflagged row, on purpose, and merging them would change what deletePayment is allowed to do.\n'
      + '      o3d-f709: the divergence is deliberate; its COVERAGE was not. It recognised two writers '
      + 'of the CANCELLED-with-a-document-id shape and there are three. The cross-connector orphan '
      + 'sweep stamps `abandonedBeforeRemoteCall: true` on the strength of `status = PENDING` alone, '
      + 'and a POSTED row sits at PENDING whenever follow-up work has failed — so that row named a '
      + 'live payment and read NOTHING. It now reads that column too, which is the shared rule\'s own '
      + 'external-id veto (`cancelledClaimIsResolved`) applied where it was missing rather than a '
      + 'fourth reading of the status.',
  }],
  ['lib/domain/accounting/invoice-payment-registration.ts', {
    count: 4,
    reason:
      'CAPACITY ARITHMETIC, not a posting verdict, and it already carries its own carrier for this '
      + 'question: `unresolvedInvoicePaymentAttempts` gates on `couldHaveReachedLedger`, which '
      + '`attemptCouldHaveReachedTheLedger` derives from the PAYLOAD rather than from the status. '
      + 'The three `!== CANCELLED` filters partition the same population that function admits. '
      + 'FLAGGED AS NOT-YET-VERIFIED, not as correct: see o3d-f709\'s follow-up issue.',
  }],
  ['lib/domain/accounting/settlement-status.ts', {
    count: 3,
    reason:
      'DISPLAY AND CLASSIFICATION for the settlement badge. All three already read `settlementBasis` '
      + 'and carry it into the aggregate row they return, which is the column that keeps an asserted '
      + 'settlement from being reported as a ledger-confirmed one.',
  }],
])

/**
 * DDL OWNERS: migrations whose SQL states this rule about `accounting_sync_logs`.
 * A census, not a prohibition — see the header.
 */
const MIGRATION_OWNERS = new Map([
  ['prisma/migrations/20260424214500_accounting_sync_idempotency_key/migration.sql',
    'accounting_sync_logs_idempotency_key_uq. `status IN (PENDING,PROCESSING,SYNCED)` is DELIBERATE: '
    + 'retiring a row to CANCELLED frees the slot, which is exactly what a NOT_POSTED settlement is '
    + 'for (sync-row-settlement.ts states this as a load-bearing side effect).'],
  ['prisma/migrations/20260613020000_followup_sync_unique_index/migration.sql',
    'accounting_sync_logs_followup_live_unique, first form. Same predicate, same reason.'],
  ['prisma/migrations/20260615000000_followup_unique_index_add_credit_note_allocation/migration.sql',
    'The same index rebuilt to add PURCHASE_CREDIT_NOTE_ALLOCATION. Same predicate, same reason.'],
  ['prisma/migrations/20260819120000_followup_live_unique_anchor_scoped/migration.sql',
    'The same index rebuilt anchor-scoped. Same predicate, same reason.'],
])

// ---------------------------------------------------------------------------

const SOURCE_ROOTS = ['app', 'lib', 'scripts', 'components']
/**
 * The four statuses a `status: { in: … }` set must ALL admit before it counts as the complement of
 * CANCELLED — i.e. before it is this rule written out longhand. See the header for why a narrower
 * set (one that drops FAILED as well) is a different question and deliberately out of scope.
 */
const CANCELLED_COMPLEMENT = ['PENDING', 'PROCESSING', 'SYNCED', 'FAILED']

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.next', 'generated'].includes(entry.name)) continue
      walk(p, out)
    } else if (['.ts', '.tsx'].includes(extname(entry.name))) out.push(p)
  }
  return out
}

const failures = []
const seenPredicateFiles = new Map()
const seenComparisonFiles = new Map()

// ── Resolve string-array constants THROUGH THE CHECKER ────────────────────────────────────────
//
// o3d-f709, found by mutation: the first version of this resolver keyed constants by their EXPORTED
// NAME in a tree-wide map, and collapsed a name declared twice to "unresolvable". This tree really
// does declare `LIVE_ACCOUNTING_SYNC_STATUSES` twice with different bodies — four statuses in
// lib/domain/sales/order-delete-guard.ts, two in app/actions/accounting-sync.ts — so importing the
// four-status one into any other file spelt this rule exactly and the guard passed it in silence.
// Ambiguity that widens to "permit" is the degrading-guard shape.
//
// The checker resolves the identifier to the declaration it actually refers to, through the import,
// through an `as` alias, and through a chain of `const A = B`. There is no ambiguity left to
// collapse, so an unresolved set is now a genuine "cannot be read" — and it FAILS CLOSED below
// rather than being skipped.
function declaredArrayValues(symbol, checker, depth = 0) {
  if (!symbol || depth > 8) return null
  let resolved = symbol
  if (resolved.flags & ts.SymbolFlags.Alias) {
    try { resolved = checker.getAliasedSymbol(resolved) } catch { return null }
  }
  for (const declaration of resolved.getDeclarations() ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) continue
    let init = declaration.initializer
    while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
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
        while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression
        if (!ts.isStringLiteral(e)) return null
        values.push(e.text)
      }
      return values
    }
    // `const LIVE_SALES_INVOICE_STATUSES = POSTABLE_ACCOUNTING_SYNC_STATUSES` — a chain, not a body.
    if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) {
      return declaredArrayValues(checker.getSymbolAtLocation(init), checker, depth + 1)
    }
  }
  return null
}

/** The status values a clause admits, or null when it cannot be resolved. */
function resolveStatusList(node, checker) {
  let n = node
  while (ts.isAsExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression
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
      while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression
      if (!ts.isStringLiteral(e)) return null
      out.push(e.text)
    }
    return out
  }
  if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
    return declaredArrayValues(checker.getSymbolAtLocation(n), checker)
  }
  if (ts.isStringLiteral(n)) return [n.text]
  return null
}

/**
 * Does this `status` clause EXCLUDE CANCELLED while still admitting a posted document?
 * Returns a description when it does, null when it does not or cannot be read.
 */
function excludesCancelled(initializer, checker) {
  let n = initializer
  while (ts.isAsExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression
  if (!ts.isObjectLiteralExpression(n)) return null
  for (const prop of n.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null
    if (key === 'not') {
      let v = prop.initializer
      while (ts.isAsExpression(v) || ts.isParenthesizedExpression(v)) v = v.expression
      if (ts.isStringLiteral(v) && v.text === 'CANCELLED') return "status: { not: 'CANCELLED' }"
    } else if (key === 'notIn') {
      const values = resolveStatusList(prop.initializer, checker)
      if (values === null) return 'status: { notIn: … } — the set cannot be read statically'
      if (values.includes('CANCELLED')) return `status: { notIn: ${JSON.stringify(values)} }`
    } else if (key === 'in') {
      const values = resolveStatusList(prop.initializer, checker)
      // FAILS CLOSED. A set this guard cannot read is a set it cannot clear, and the mutation that
      // found this made the set unreadable ON PURPOSE by importing an ambiguously-named constant.
      if (values === null) return 'status: { in: … } — the set cannot be read statically'
      if (!values.includes('CANCELLED') && CANCELLED_COMPLEMENT.every((status) => values.includes(status))) {
        return `status: { in: ${JSON.stringify(values)} } — the complement of CANCELLED, written out`
      }
    }
  }
  return null
}

/** Collect `status` clauses conjoined into a where object, through AND/OR/NOT and arrays. */
function collectStatusClauses(node, out, depth = 0) {
  if (depth > 8) return
  let n = node
  while (ts.isAsExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression
  if (ts.isArrayLiteralExpression(n)) {
    for (const e of n.elements) collectStatusClauses(e, out, depth + 1)
    return
  }
  if (!ts.isObjectLiteralExpression(n)) return
  for (const prop of n.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text
      : ts.isComputedPropertyName(prop.name) && ts.isStringLiteral(prop.name.expression)
        ? prop.name.expression.text
        : null
    if (key === 'status') out.push(prop)
    else if (key === 'AND' || key === 'OR' || key === 'NOT') collectStatusClauses(prop.initializer, out, depth + 1)
  }
}

const PRISMA_OPS = new Set(['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy', 'updateMany', 'update', 'deleteMany', 'delete', 'upsert'])

// ── Expression half: is this receiver an AccountingSyncLog row? ────────────────────────────────
const SYNC_LOG_MARKERS = ['externalTransactionId', 'settlementBasis', 'referenceType', 'attemptRevision',
  'syncedAtDatabaseClock', 'abandonedBeforeRemoteCall', 'processingStartedAt']
const SYNC_STATUSES = new Set(['PENDING', 'PROCESSING', 'SYNCED', 'FAILED', 'CANCELLED'])

/**
 * The model's own field names, READ FROM THE SCHEMA rather than listed here — so this guard cannot
 * drift from the table it is about, and a column added next month is covered without an edit.
 */
function accountingSyncLogColumns() {
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

function main() {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) { console.error('tsconfig.json not found'); process.exit(2) }
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT)
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
  const checker = program.getTypeChecker()

  const inScope = new Set(SOURCE_ROOTS.flatMap((root) => walk(join(ROOT, root))).map((p) => relative(ROOT, p)))

  const isSyncStatusUnion = (t) => {
    if (!t) return false
    const parts = t.isUnion() ? t.types : [t]
    if (parts.length < 2) return false
    return parts.every((p) => typeof p.value === 'string' && SYNC_STATUSES.has(p.value))
  }
  const columns = accountingSyncLogColumns()
  const isSyncLogShaped = (t) => {
    if (!t) return false
    let props
    try { props = checker.getPropertiesOfType(t).map((p) => p.getName()) } catch { return false }
    return props.includes('status') && SYNC_LOG_MARKERS.some((m) => props.includes(m))
  }
  /**
   * THE THIRD DETECTOR, and it exists because a mutation walked past the first two.
   *
   * `lib/domain/accounting/allocated-inventory-debit.ts` reads the row through an INJECTED client
   * interface that declares `{ status: string }`. The status is therefore not the enum union, and
   * the row carries no marker column to recognise it by — so a `journal.status === 'CANCELLED'`
   * added there was invisible to a guard that had just been proved to work.
   *
   * THREE conditions, and dropping any one of them was measured to break it:
   *
   *   the status is typed `string`  — NOT some other model's enum. This is the whole separation.
   *                                   `sale.status` and `order.status` in these same files are
   *                                   `SalesOrderStatus`, whose members are not this table's, and a
   *                                   version of this detector without the clause flagged four of
   *                                   them. A row whose status IS `AccountingSyncStatus` is already
   *                                   caught by the first detector and never reaches here.
   *   every property is a column    — a `SalesOrder` shape typed loosely would still fail on
   *                                   `refundStatus`/`orderNumber`.
   *   the file queries this table   — app/actions/stock-counts.ts compares a `{ status: string }`
   *                                   StockCount and never names `accountingSyncLog`.
   */
  const isUntypedSyncLogShape = (declaredStatusType, receiverType) => {
    if (!declaredStatusType || checker.typeToString(declaredStatusType) !== 'string') return false
    if (!receiverType) return false
    let props
    try { props = checker.getPropertiesOfType(receiverType).map((p) => p.getName()) } catch { return false }
    if (props.length === 0 || !props.includes('status')) return false
    return props.every((name) => columns.has(name))
  }

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    const file = relative(ROOT, sf.fileName)
    if (!inScope.has(file)) continue
    const fileQueriesSyncLogs = sf.text.includes('accountingSyncLog')

    const visit = (node) => {
      // ── QUERY HALF ───────────────────────────────────────────────────────────────────────────
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const op = node.expression.name.text
        const receiver = node.expression.expression
        if (PRISMA_OPS.has(op)
          && ts.isPropertyAccessExpression(receiver)
          && receiver.name.text === 'accountingSyncLog') {
          const arg = node.arguments[0]
          if (arg && ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              if (!ts.isPropertyAssignment(prop)) continue
              if (!ts.isIdentifier(prop.name) || prop.name.text !== 'where') continue
              const clauses = []
              collectStatusClauses(prop.initializer, clauses)
              for (const clause of clauses) {
                const described = excludesCancelled(clause.initializer, checker)
                if (described === null) continue
                const { line } = sf.getLineAndCharacterOfPosition(clause.getStart(sf))
                seenPredicateFiles.set(file, (seenPredicateFiles.get(file) ?? 0) + 1)
                if (file !== OWNING_MODULE && !PREDICATE_OWNERS.has(file)) {
                  failures.push(
                    `${file}:${line + 1} hand-writes what a CANCELLED row proves — ${described}.\n`
                    + `    Route it through \`...${SHARED_WHERE}\` from ${OWNING_MODULE}, or add this file to\n`
                    + '    PREDICATE_OWNERS with the argument for why it must differ.',
                  )
                }
              }
            }
          }
        }
      }

      // ── EXPRESSION HALF ──────────────────────────────────────────────────────────────────────
      if (ts.isBinaryExpression(node)
        && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]
          .includes(node.operatorToken.kind)) {
        for (const [access, literal] of [[node.left, node.right], [node.right, node.left]]) {
          if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'status') continue
          let lit = literal
          while (ts.isAsExpression(lit) || ts.isParenthesizedExpression(lit)) lit = lit.expression
          if (!ts.isStringLiteral(lit) || lit.text !== 'CANCELLED') continue
          // THE DECLARED TYPE OF THE PROPERTY, NOT THE NARROWED TYPE AT THIS EXPRESSION — a second
          // mutation's finding. `journal.status === 'CANCELLED' && journal.status !== 'CANCELLED'`
          // narrows the second occurrence to the literal `"CANCELLED"`, which is neither `string`
          // (so the third detector declined it) nor a union of two or more members (so the first
          // did). Every extra comparison inside an `&&` was therefore invisible, which is exactly
          // the shape a SEVENTH copy takes when it is added next to an owned sixth.
          let declaredStatusType = null
          let receiverType = null
          try {
            receiverType = checker.getTypeAtLocation(access.expression)
            const property = receiverType?.getProperty?.('status')
            declaredStatusType = property ? checker.getTypeOfSymbol(property) : checker.getTypeAtLocation(access)
          } catch { /* unresolvable: not this guard's business */ }
          const recognised = isSyncStatusUnion(declaredStatusType)
            || isSyncLogShaped(receiverType)
            || (fileQueriesSyncLogs && isUntypedSyncLogShape(declaredStatusType, receiverType))
          if (!recognised) continue
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
          seenComparisonFiles.set(file, (seenComparisonFiles.get(file) ?? 0) + 1)
          if (file !== OWNING_MODULE && !STATUS_COMPARISON_OWNERS.has(file)) {
            failures.push(
              `${file}:${line + 1} decides what a CANCELLED sync row means in TypeScript — `
              + `${node.getText().replace(/\s+/g, ' ').slice(0, 80)}.\n`
              + `    Ask \`${SHARED_PREDICATE}(row)\` from ${OWNING_MODULE}, or add this file to\n`
              + '    STATUS_COMPARISON_OWNERS with the argument for why it must differ.',
            )
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }

  // ── THE GUARD PROVES IT RAN: every owner found, at the stated count ───────────────────────────
  for (const [file, owner] of PREDICATE_OWNERS) {
    const found = seenPredicateFiles.get(file) ?? 0
    if (found !== owner.count) {
      failures.push(
        `PREDICATE_OWNERS is stale: ${file} was declared with ${owner.count} CANCELLED-excluding `
        + `clause(s) and ${found} were found.\n`
        + (found > owner.count
          ? '    A NEW hand-written copy was added to an owned file. Route it through the shared '
            + 'predicate, or raise the count with its own argument.'
          : '    The clause was removed or renamed. Drop the owner — a stale allowlist permits '
            + 'everything this guard forbids.'),
      )
    }
  }
  for (const [file, owner] of STATUS_COMPARISON_OWNERS) {
    const found = seenComparisonFiles.get(file) ?? 0
    if (found !== owner.count) {
      failures.push(
        `STATUS_COMPARISON_OWNERS is stale: ${file} was declared with ${owner.count} comparison(s) `
        + `and ${found} were found.\n`
        + (found > owner.count
          ? '    A NEW hand-written comparison was added to an owned file.'
          : '    The comparison was removed or renamed. Drop the owner.'),
      )
    }
  }

  // ── DDL census ───────────────────────────────────────────────────────────────────────────────
  const migrationsRoot = join(ROOT, 'prisma', 'migrations')
  let migrationDirs = []
  try { migrationDirs = readdirSync(migrationsRoot) } catch { migrationDirs = [] }
  const seenMigrations = new Set()
  for (const dir of migrationDirs) {
    const sqlPath = join(migrationsRoot, dir, 'migration.sql')
    let sql
    try {
      if (!statSync(sqlPath).isFile()) continue
      sql = readFileSync(sqlPath, 'utf8')
    } catch { continue }
    if (!sql.includes('accounting_sync_logs')) continue
    // COMMENTS ARE STRIPPED FIRST. Every migration in this tree carries a long prose header, and
    // 20260817090000's header DESCRIBES the index predicate in passing ("status in (PENDING,
    // PROCESSING, SYNCED)") without creating one. A guard that read the prose would have demanded an
    // owner entry for a migration that states nothing, which is enforcement by comment with the
    // polarity reversed.
    const statements = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    // The DDL shape of this rule: a status set that admits SYNCED and omits CANCELLED. Broader than
    // the TypeScript half on purpose — this is a CENSUS, not a prohibition, so a false positive
    // costs one declared line and a false negative costs an index nobody reviewed.
    const statusSets = statements.match(/"?status"?\s+IN\s*\(([^)]*)\)/gi) ?? []
    const states = statusSets.some((set) => /SYNCED/i.test(set) && !/CANCELLED/i.test(set))
    if (!states) continue
    const rel = relative(ROOT, sqlPath)
    seenMigrations.add(rel)
    if (!MIGRATION_OWNERS.has(rel)) {
      failures.push(
        `${rel} states in DDL what a CANCELLED row proves (a status set admitting SYNCED and omitting\n`
        + '    CANCELLED) against accounting_sync_logs. An index OVERRIDES every application-side\n'
        + '    reading of this rule, so it must be named in MIGRATION_OWNERS with its argument.',
      )
    }
  }
  for (const owner of MIGRATION_OWNERS.keys()) {
    if (!seenMigrations.has(owner)) {
      failures.push(
        `MIGRATION_OWNERS is stale: ${owner} no longer contains a CANCELLED-excluding status set.\n`
        + '    Drop the owner, or fix the path — an allowlist nothing matches is not a census.',
      )
    }
  }

  if (failures.length > 0) {
    console.error('\nWhat a CANCELLED AccountingSyncLog row proves is decided in ONE place (o3d-f709).\n')
    for (const failure of failures) console.error(`  ✗ ${failure}\n`)
    console.error(`${failures.length} problem(s). The rule lives in ${OWNING_MODULE}.\n`)
    process.exit(1)
  }
  const queries = [...seenPredicateFiles.values()].reduce((a, b) => a + b, 0)
  const comparisons = [...seenComparisonFiles.values()].reduce((a, b) => a + b, 0)
  console.log(
    `✓ CANCELLED-row evidence: ${queries} query clause(s) and ${comparisons} comparison(s) accounted for, `
    + `${seenMigrations.size} migration(s) censused.`,
  )
}

main()
