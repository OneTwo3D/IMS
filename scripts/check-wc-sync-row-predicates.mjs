#!/usr/bin/env node

/**
 * Static guard: `shopping_sync_logs` row-family predicates are DEFINED IN ONE PLACE EACH, and
 * nowhere else may hand-write one (o3d-272i).
 *
 * WHAT IT IS DEFENDING. That table holds several unrelated families of row which share
 * `connector`, `direction`, `entityType` and `status` — a WooCommerce refund park, a held sales
 * invoice, a pending-FX queue entry, an admission refusal. Telling them apart is the whole of
 * o3d-xnwu r8 (which added `recordKind`) and of o3d-272i (which found EIGHT hand-written copies of
 * the pre-r8 shape still in the tree, none of them carrying the new column). Every one of those
 * copies was written because the rule had no home, not because anybody disagreed about it.
 *
 * THE RULE, GRAMMATICALLY. A `where`-side object literal that names BOTH `direction:
 * 'FROM_CONNECTOR'` AND `entityType: 'SalesOrder'` is a family predicate, and may exist only inside
 * the one declaration that owns that family. A `data`/`create`/`update` literal carrying the same
 * pairs is a row being WRITTEN, not selected, and is not this guard's business.
 *
 * AND THE SAME RULE IN SQL. `lib/data-retention.ts` deletes from this table with raw SQL and cannot
 * use a Prisma `where` at all, so the predicate has a second renderer
 * (`unresolvedWcOrderRowSql`). A shared TypeScript helper with a hand-written SQL copy beside it is
 * the original defect with better ergonomics, so raw SQL naming this table may not also name the
 * family's discriminating columns or literals.
 *
 * AND THE SAME RULE IN DDL (o3d-272i r2, Codex HIGH). The eight copies this guard was written for
 * were all TypeScript, and the sweep that found them read the TypeScript AST. It could not see the
 * NINTH: `shopping_sync_logs_active_refund_park_uq`, a partial UNIQUE index whose WHERE predicate
 * restated the pre-`recordKind` shape in SQL, inside a migration. That reader OVERRIDES every
 * application-side fix — an index that cannot tell a held sales invoice from a refund park REJECTS
 * the collision whatever the code believes — so it is the most damaging copy of the eight and the
 * only one no `where` object could correct. A migration under prisma/migrations that names this
 * table and TWO OR MORE of the family's discriminating LITERALS is therefore a DDL statement of the
 * rule, and must be named in MIGRATION_OWNERS with a reason.
 *
 * TWO LITERALS, NOT ONE, AND LITERALS RATHER THAN COLUMN NAMES. The init migration defines the
 * `ShoppingSyncDirection` enum, so it contains `FROM_CONNECTOR`; several migrations name
 * `entityType` because it is a column. Neither re-derives anything, and a guard that flagged them
 * would be answered with an allowlist long enough to stop meaning anything. Two of
 * FROM_CONNECTOR / 'SalesOrder' / WC_REFUND_PARK / WC_HELD_SALES_INVOICE in one file that also
 * names the table is a predicate, and today it matches exactly the four files that are one.
 *
 * AND THE SAME RULE READ BACKWARDS (o3d-272i r3, Codex MEDIUM). A family predicate may be NARROWED
 * and may not be NEGATED. `{ NOT: activeRefundParkWhere() }` does not mean "every row this does not
 * admit": Prisma compiles it to a SQL negation of the whole conjunction, and `recordKind` is
 * NULLABLE, so an unstamped row answers UNKNOWN to the predicate AND UNKNOWN to its negation and
 * appears in neither result. The SQL renderer `unresolvedWcOrderRowSql()` was made TOTAL for
 * exactly this reason — it renders `COALESCE((...), FALSE)` — but a Prisma `where` object cannot
 * be: whatever the function returns, `NOT` wraps it, and the `where` language has no COALESCE. So
 * the Prisma side is defended by prohibition rather than repair, and a reader who wants a complement
 * is sent to the renderer that has one. tests/concurrency/refund-park-index-family-scope
 * .concurrent.test.ts executes both readings against a real database and asserts the asymmetry, so
 * this rule is held to a measured fact rather than to a belief about Prisma.
 *
 * WHY THIS IS NOT A PROXIMITY RULE. It reads the TypeScript AST: the pairs must be properties of
 * ONE object literal, and the write/select distinction is the nearest enclosing `where`/`data`
 * property, not "a `data` appears within N lines". Nothing here can be satisfied or triggered by a
 * comment.
 *
 * THE GUARD PROVES IT RAN. Every allowlisted definition must be FOUND — if a rename or a deletion
 * means an owner no longer matches, that is an error, not a quiet pass. A guard whose allowlist has
 * gone stale is a guard that permits everything it was written to forbid.
 *
 * Run via `npm run check:wc-sync-row-predicates`; invoked by `npm run check:all`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import ts from 'typescript'

import { addLocalFunctionAliases, calleeName, importAliases } from './lib/ts-import-aliases.mjs'

const ROOT = process.cwd()
const SCAN_ROOTS = ['app', 'lib', 'components', 'scripts']
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx'])
// 'generated' skips app/generated/**: the Prisma client embeds the whole schema as one string,
// including this table's doc comments.
const SKIPPED_DIRECTORIES = new Set(['.git', '.next', 'node_modules', 'build', 'dist', 'out', 'coverage', 'generated'])

/**
 * The clause pair that makes an object literal a WooCommerce sales-order row predicate. Both must
 * be present, as properties of the SAME literal, with these exact string values.
 */
const FAMILY_CLAUSES = [
  ['direction', 'FROM_CONNECTOR'],
  ['entityType', 'SalesOrder'],
]

/**
 * The one declaration that owns each family predicate. `file::declaration` — the literal has to be
 * inside THAT function or const, so a fifth copy added lower down an owner file fails like any
 * other.
 */
const PREDICATE_OWNERS = [
  // The union: an unresolved WooCommerce row that names an IMS sales order, stated ONCE as literal
  // values that both the Prisma renderer and the SQL renderer read. Behind the order delete guard,
  // the store-rebind guard and the retention exemption.
  'lib/domain/sales/wc-sync-row-families.ts::UNRESOLVED_WC_ORDER_ROW',
  // The refund park, on its own. Read by the recovery inbox, the cross-order guard, the park
  // upsert, the park resolvers and the coupon-correction evidence read — AND, since o3d-272i r2, by
  // the partial unique index's DDL predicate, which is why the literals sit in an object beside the
  // renderer that writes them as SQL rather than inside `activeRefundParkWhere` as they used to.
  'lib/domain/sales/wc-sync-row-families.ts::ACTIVE_REFUND_PARK_ROW',
  // The held sales invoice queue (o3d-k26m.6).
  'lib/connectors/woocommerce/sync/held-sales-invoice.ts::heldSalesInvoiceQueueWhere',
  // The two families written BEFORE an IMS order exists, so they carry no entityId.
  'lib/connectors/woocommerce/sync/order-import.ts::pendingFxQueueWhere',
  'lib/connectors/woocommerce/sync/order-admission.ts::wcAdmissionRefusalQueueWhere',
]

/** The single SQL renderer of the union predicate. */
const SQL_OWNER = 'lib/domain/sales/wc-sync-row-families.ts::unresolvedWcOrderRowSql'

/**
 * Tokens that make a raw SQL string a family predicate rather than an ordinary statement about this
 * table. Deliberately the DISCRIMINATORS only: `status` and `connector` alone appear in legitimate
 * statements about other things, but nothing has a reason to name `entityType`, `recordKind` or any
 * of these literals in SQL except to re-derive a family by hand.
 */
const SQL_FAMILY_TOKENS = [
  'entityType',
  'recordKind',
  'FROM_CONNECTOR',
  'SalesOrder',
  'woocommerce',
  'WC_REFUND_PARK',
  'WC_HELD_SALES_INVOICE',
]

const SQL_TABLE = 'shopping_sync_logs'

/** Where the migrations live, and the extension a DDL reader of this rule is written in. */
const MIGRATIONS_ROOT = 'prisma/migrations'

/**
 * The LITERALS a family predicate is built out of — the values, not the column names. A file that
 * names two or more of these AND the table is stating the rule, not merely touching the table.
 */
const SQL_FAMILY_LITERALS = ['FROM_CONNECTOR', "'SalesOrder'", 'WC_REFUND_PARK', 'WC_HELD_SALES_INVOICE']

/** How many of them make a file a statement of the rule rather than a mention of its parts. */
const SQL_FAMILY_LITERAL_THRESHOLD = 2

/**
 * The migrations that DO state this rule in DDL, and why each is allowed to.
 *
 * An applied migration is immutable — Prisma checksums it — so this list only ever grows, and it
 * grows by a DECISION. Adding a line to it says: this migration writes the family rule into the
 * database, and something holds it to lib/domain/sales/wc-sync-row-families.ts. For the index that
 * is tests/prisma/refund-park-unique-index-record-kind-migration.test.ts (the migration text IS the
 * string the shared module renders) and tests/concurrency/refund-park-index-family-scope
 * .concurrent.test.ts (the SHIPPED predicate and the shared `where` select the same rows).
 */
const MIGRATION_OWNERS = new Map([
  [
    '20260721150000_refund_park_unique_index/migration.sql',
    'Builds the partial unique index, in the pre-recordKind shape. Applied everywhere and therefore '
    + 'immutable; 20260909090000 replaces its predicate.',
  ],
  [
    '20260822120000_shopping_sync_log_record_kind/migration.sql',
    'Adds recordKind and backfills every pre-existing row into one family or the other, so it must '
    + 'name both families by value.',
  ],
  [
    '20260822120000_shopping_sync_log_record_kind/verify.sql',
    'The cutover gate for that backfill: five shapes no legitimate writer produces, each of which '
    + 'has to name the family it is asserting about.',
  ],
  [
    '20260909090000_refund_park_unique_index_record_kind/migration.sql',
    'Rebuilds the index with the refund-park recordKind clause. Its WHERE predicate is the string '
    + 'activeRefundParkIndexPredicateSql() renders, asserted character for character by '
    + 'tests/prisma/refund-park-unique-index-record-kind-migration.test.ts.',
  ],
])

/** Property names whose value is a row being written, not a row being selected. */
const WRITE_POSITIONS = new Set(['data', 'create', 'update'])

/**
 * The functions that RETURN a family predicate. Negating any of them is the o3d-272i r3 defect; see
 * the note at the top of this file. Kept as a list rather than derived from PREDICATE_OWNERS
 * because two of those owners are objects of literals, not `where` builders.
 */
const FAMILY_PREDICATE_FUNCTIONS = new Set([
  'unresolvedWcOrderRowWhere',
  'activeRefundParkWhere',
  'heldSalesInvoiceQueueWhere',
  'pendingFxQueueWhere',
  'wcAdmissionRefusalQueueWhere',
])

/** Prisma's negation key. */
const NEGATION_PROPERTY = 'NOT'

function listFiles(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) listFiles(full, out)
    else if (SCANNED_EXTENSIONS.has(extname(full))) out.push(full)
  }
  return out
}

/** The string a node denotes, seeing through `as const` / `as Foo` and parentheses. */
function stringValue(node) {
  let current = node
  while (current && (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current))) {
    current = current.expression
  }
  if (!current) return null
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return current.text
  return null
}

function propertyName(property) {
  if (!property.name) return null
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text
  return null
}

/** Is this literal a hand-written WooCommerce sales-order family predicate? */
function isFamilyLiteral(node) {
  const seen = new Map()
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = propertyName(property)
    if (name === null) continue
    seen.set(name, stringValue(property.initializer))
  }
  return FAMILY_CLAUSES.every(([name, value]) => seen.get(name) === value)
}

/**
 * SELECT or WRITE. Walks OUT to the nearest property assignment that says which side of a Prisma
 * call this literal is on; `where` (and anything not a write position) is a select.
 */
function isWritePayload(node) {
  let current = node.parent
  while (current) {
    if (ts.isPropertyAssignment(current)) {
      const name = propertyName(current)
      if (name === 'where') return false
      if (name !== null && WRITE_POSITIONS.has(name)) return true
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      const name = current.name.text
      if (/where/i.test(name)) return false
      if (WRITE_POSITIONS.has(name) || /data$/i.test(name)) return true
    }
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) break
    current = current.parent
  }
  return false
}

/** See through `as const` / `satisfies` / parentheses to the expression underneath. */
function unwrap(node) {
  let current = node
  while (
    current
    && (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current))
  ) {
    current = current.expression
  }
  return current
}

/**
 * Prisma's logical combinators. A `where` reached through one of these is the SAME predicate: `{
 * NOT: { AND: [p] } }` and `{ NOT: p }` compile to the same negation, so a detector that reads only
 * the immediate initializer is defeated by typing four characters.
 */
const LOGICAL_PROPERTIES = new Set(['AND', 'OR', 'NOT'])

/**
 * Does this expression CARRY a family predicate — is it a call to one, a spread of one, an array or
 * a logical wrapper containing one, a hand-written copy of one, or a local name bound to any of
 * those?
 *
 * `known` is the set of local identifiers already found to be bound to a family predicate, which is
 * what catches the real spelling: `const REFUND_PARK_WHERE = activeRefundParkWhere()` at module
 * level and `{ NOT: REFUND_PARK_WHERE }` three hundred lines below. `aliases` resolves the name a
 * call actually invokes (see below).
 *
 * THE TWO EVASIONS THIS CLOSES, AND WHY THEY ARE THE SAME MISTAKE TWICE (o3d-272i r4). The first
 * spelling asked `ts.isIdentifier(callee) && FAMILY_PREDICATE_FUNCTIONS.has(callee.text)` — the
 * callee's OWN name — so `import { activeRefundParkWhere as parkWhere }` and `{ NOT: parkWhere() }`
 * passed, and so did a namespace import's `families.activeRefundParkWhere()`. That is verbatim the
 * hole check-fulfillment-requirement-seam.mjs was mutated into revealing earlier on this branch,
 * written a second time in the guard that fixed it. It is fixed here by IMPORTING that guard's
 * resolver rather than writing a third one.
 *
 * The second was structural: only a direct spread was followed out of an object literal, so `{ NOT:
 * { AND: [activeRefundParkWhere()] } }` — an ordinary, valid Prisma spelling — reached the same
 * SQL negation with the detector reporting nothing. Logical wrappers are now followed to any depth.
 *
 * WHY A NEGATED HAND-WRITTEN COPY COUNTS TOO. `{ NOT: { direction: 'FROM_CONNECTOR', entityType:
 * 'SalesOrder', ... } }` is already refused by the hand-written-copy half below, but as a copy. It
 * is also the exact defect this rule is about, and saying so in the negation message is what tells
 * the reader that spreading the owner is not the fix here — not negating is.
 */
function carriesFamilyPredicate(node, known, aliases) {
  const current = unwrap(node)
  if (!current) return false
  if (ts.isCallExpression(current)) {
    const called = calleeName(current, aliases)
    return called !== null && FAMILY_PREDICATE_FUNCTIONS.has(called)
  }
  if (ts.isIdentifier(current)) return known.has(current.text)
  if (ts.isObjectLiteralExpression(current)) {
    if (isFamilyLiteral(current)) return true
    return current.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) return carriesFamilyPredicate(property.expression, known, aliases)
      if (ts.isPropertyAssignment(property) && LOGICAL_PROPERTIES.has(propertyName(property) ?? '')) {
        return carriesFamilyPredicate(property.initializer, known, aliases)
      }
      return false
    })
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.some((element) => carriesFamilyPredicate(element, known, aliases))
  }
  return false
}

/**
 * The local names bound to a family predicate in this file, to a FIXPOINT.
 *
 * It used to be two passes, on the argument that a third level of indirection "would still be
 * caught at the call it was built from" — which is true of a chain of binds and false as soon as one
 * link is a logical wrapper, because a wrapper has no call of its own to be caught at. The loop
 * terminates because `known` only ever grows and is bounded by the file's declarations.
 */
function localFamilyPredicateNames(source, aliases) {
  const known = new Set()
  let changed = true
  while (changed) {
    changed = false
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (!known.has(node.name.text) && carriesFamilyPredicate(node.initializer, known, aliases)) {
          known.add(node.name.text)
          changed = true
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return known
}

/** The nearest named function or variable declaration a node sits inside. */
function enclosingDeclaration(node) {
  let current = node.parent
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) && current.name) return current.name.text
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
    current = current.parent
  }
  return null
}

/**
 * The SQL a template literal actually CONTRIBUTES: its literal spans only, with SQL comments
 * removed.
 *
 * NOT `node.getText()`, which was this guard's first spelling and was wrong twice over. It returns
 * the SOURCE, so `${unresolvedWcOrderRowSql()}` — the correct thing to write — reads as a
 * discriminator by hand, and so does a `-- ...` comment that merely mentions one. A guard that
 * fires on the fix and on prose is a guard that gets suppressed.
 */
function sqlTextOf(node) {
  const spans = ts.isNoSubstitutionTemplateLiteral(node)
    ? [node.text]
    : [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
  return spans
    .join('\n')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

const files = []
for (const root of SCAN_ROOTS) {
  const full = join(ROOT, root)
  try {
    if (statSync(full).isDirectory()) listFiles(full, files)
  } catch {
    // A scan root that does not exist in this checkout is not this guard's business.
  }
}

const violations = []
const ownersSeen = new Set()
let familyLiteralCount = 0
let sqlTemplateCount = 0
let negationCount = 0

for (const file of files) {
  const relativePath = relative(ROOT, file).split(sep).join('/')
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1
  const aliases = addLocalFunctionAliases(source, importAliases(source), FAMILY_PREDICATE_FUNCTIONS)
  const known = localFamilyPredicateNames(source, aliases)

  const visit = (node) => {
    // NARROW IT, DO NOT NEGATE IT (o3d-272i r3). Every `NOT:` in the tree is examined; the ones
    // that carry a family predicate are refused, whatever they are nested in.
    if (ts.isPropertyAssignment(node) && propertyName(node) === NEGATION_PROPERTY) {
      negationCount += 1
      if (carriesFamilyPredicate(node.initializer, known, aliases)) {
        violations.push(
          `${relativePath}:${at(node)}  a shopping_sync_logs family predicate is being NEGATED `
          + `(\`${NEGATION_PROPERTY}:\`). Prisma compiles that to a SQL negation of the whole conjunction, and `
          + '`recordKind` is nullable — so an UNSTAMPED row answers UNKNOWN to the predicate and UNKNOWN to '
          + 'its negation, and is in NEITHER result. It is not "every row the predicate does not admit"; it '
          + 'is that set minus the unstamped rows, silently. Use the total SQL renderer '
          + 'unresolvedWcOrderRowSql() — it renders COALESCE((...), FALSE), so NOT (...) really is its '
          + 'complement — or, if the Prisma form is unavoidable, write the complement explicitly with its own '
          + 'name and its own test and say there what happens to a NULL recordKind.',
        )
      }
    }
    if (ts.isObjectLiteralExpression(node) && isFamilyLiteral(node)) {
      familyLiteralCount += 1
      if (!isWritePayload(node)) {
        const owner = `${relativePath}::${enclosingDeclaration(node) ?? '(top level)'}`
        if (PREDICATE_OWNERS.includes(owner)) ownersSeen.add(owner)
        else {
          violations.push(
            `${relativePath}:${at(node)}  a hand-written shopping_sync_logs family predicate `
            + `(direction FROM_CONNECTOR + entityType SalesOrder) inside \`${enclosingDeclaration(node) ?? '(top level)'}\`. `
            + 'Spread the predicate that owns this family instead — unresolvedWcOrderRowWhere(), '
            + 'activeRefundParkWhere(), heldSalesInvoiceQueueWhere(), pendingFxQueueWhere() or '
            + 'wcAdmissionRefusalQueueWhere() — and add only the clauses that narrow it.',
          )
        }
      }
    }
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = sqlTextOf(node)
      if (text.includes(SQL_TABLE)) {
        sqlTemplateCount += 1
        const named = SQL_FAMILY_TOKENS.filter((token) => text.includes(token))
        if (named.length > 0) {
          const owner = `${relativePath}::${enclosingDeclaration(node) ?? '(top level)'}`
          if (owner === SQL_OWNER) ownersSeen.add(owner)
          else {
            violations.push(
              `${relativePath}:${at(node)}  raw SQL over ${SQL_TABLE} names the family discriminator(s) `
              + `${named.join(', ')} by hand. Interpolate \${unresolvedWcOrderRowSql()} instead, so the SQL `
              + 'spelling and the Prisma spelling cannot drift apart.',
            )
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

// ---------------------------------------------------------------------------
// THE DDL READERS. Same rule, different language, and the one the AST could not reach.
// ---------------------------------------------------------------------------

/** Every .sql under prisma/migrations, as repository-relative paths. */
function listMigrationSql(dir, out) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) listMigrationSql(full, out)
    else if (extname(full) === '.sql') out.push(full)
  }
  return out
}

/** The SQL a file EXECUTES: `--` line comments and `/* *\/` blocks removed. */
function executableSql(source) {
  return source.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

const migrationFiles = listMigrationSql(join(ROOT, MIGRATIONS_ROOT), [])
const migrationOwnersSeen = new Set()
let migrationPredicateCount = 0

for (const file of migrationFiles) {
  const relativePath = relative(join(ROOT, MIGRATIONS_ROOT), file).split(sep).join('/')
  const sql = executableSql(readFileSync(file, 'utf8'))
  if (!sql.includes(SQL_TABLE)) continue
  const named = SQL_FAMILY_LITERALS.filter((literal) => sql.includes(literal))
  if (named.length < SQL_FAMILY_LITERAL_THRESHOLD) continue

  migrationPredicateCount += 1
  if (MIGRATION_OWNERS.has(relativePath)) migrationOwnersSeen.add(relativePath)
  else {
    violations.push(
      `${MIGRATIONS_ROOT}/${relativePath}  states the ${SQL_TABLE} family rule in DDL (names ${named.join(', ')}). `
      + 'The database is a reader of this rule like any other, and a migration cannot call TypeScript — so render '
      + 'the predicate with activeRefundParkIndexPredicateSql() in lib/domain/sales/wc-sync-row-families.ts, paste '
      + 'that exact text into the migration, and add the file to MIGRATION_OWNERS in this script saying what holds '
      + 'the two together. o3d-272i r2: the last hand-written one was built a month before the column that '
      + 'tells these families apart existed, went on refusing held sales invoices from the day that family '
      + 'was added, and no sweep of this repository could see it.',
    )
  }
}

// ---------------------------------------------------------------------------
// PROVE THE WALK REACHED SOMETHING. A guard that scanned nothing, or whose allowlist no longer
// names anything real, passes every file in the repository without reading a line of it.
// ---------------------------------------------------------------------------
const structural = []
if (files.length === 0) structural.push(`scanned 0 files under ${SCAN_ROOTS.join(', ')}`)
if (familyLiteralCount === 0) structural.push('found 0 shopping_sync_logs family literals — the detector matched nothing at all')
if (sqlTemplateCount === 0) structural.push(`found 0 raw SQL templates naming ${SQL_TABLE}`)
// The negation rule has no legitimate occurrence to count — nothing in the tree may negate a family
// predicate — so what is proved instead is that the detector REACHED real `NOT:` properties. A
// traversal that saw none would pass the rule over a repository full of them.
if (negationCount === 0) structural.push(`examined 0 \`${NEGATION_PROPERTY}:\` properties — the negation detector traversed nothing`)
if (migrationFiles.length === 0) structural.push(`scanned 0 .sql files under ${MIGRATIONS_ROOT}`)
if (migrationPredicateCount === 0) structural.push(`found 0 migrations stating the ${SQL_TABLE} family rule — the DDL detector matched nothing at all`)
for (const owner of MIGRATION_OWNERS.keys()) {
  if (!migrationOwnersSeen.has(owner)) structural.push(`allowlisted migration no longer states the rule: ${MIGRATIONS_ROOT}/${owner}`)
}
for (const owner of [...PREDICATE_OWNERS, SQL_OWNER]) {
  if (!ownersSeen.has(owner)) structural.push(`allowlisted definition not found: ${owner}`)
}

if (structural.length > 0) {
  console.error('check:wc-sync-row-predicates could not verify itself:')
  for (const problem of structural) console.error(`  - ${problem}`)
  console.error('\nThe allowlist names the ONE declaration that owns each shopping_sync_logs row family.')
  console.error('If one was renamed or moved, update PREDICATE_OWNERS in this script; if one was deleted,')
  console.error('say where its rule went. An unverified guard is not a guard.')
  process.exit(1)
}

if (violations.length > 0) {
  console.error(`check:wc-sync-row-predicates found ${violations.length} hand-written predicate(s):\n`)
  for (const violation of violations) console.error(`  - ${violation}`)
  console.error('\nWhy this is refused: shopping_sync_logs holds several families that share')
  console.error('connector/direction/entityType/status, and a copy of one family\'s shape does not')
  console.error('follow when that family gains a clause. o3d-xnwu r8 added `recordKind` and left eight')
  console.error('copies behind; o3d-272i removed them and this guard keeps the ninth from being written.')
  process.exit(1)
}

console.log(
  `check:wc-sync-row-predicates OK — ${files.length} files, ${familyLiteralCount} family literal(s), `
  + `${sqlTemplateCount} raw ${SQL_TABLE} statement(s), ${negationCount} \`${NEGATION_PROPERTY}:\` propert(ies) examined and `
  + `none negating a family predicate, all ${PREDICATE_OWNERS.length + 1} owning definitions present; `
  + `${migrationFiles.length} migration .sql file(s), ${migrationPredicateCount} stating the rule in DDL, all `
  + `${MIGRATION_OWNERS.size} accounted for.`,
)
