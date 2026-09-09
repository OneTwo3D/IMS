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
  // upsert, the park resolvers and the coupon-correction evidence read.
  'lib/domain/sales/refund-park-recovery.ts::activeRefundParkWhere',
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

/** Property names whose value is a row being written, not a row being selected. */
const WRITE_POSITIONS = new Set(['data', 'create', 'update'])

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

for (const file of files) {
  const relativePath = relative(ROOT, file).split(sep).join('/')
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1

  const visit = (node) => {
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
// PROVE THE WALK REACHED SOMETHING. A guard that scanned nothing, or whose allowlist no longer
// names anything real, passes every file in the repository without reading a line of it.
// ---------------------------------------------------------------------------
const structural = []
if (files.length === 0) structural.push(`scanned 0 files under ${SCAN_ROOTS.join(', ')}`)
if (familyLiteralCount === 0) structural.push('found 0 shopping_sync_logs family literals — the detector matched nothing at all')
if (sqlTemplateCount === 0) structural.push(`found 0 raw SQL templates naming ${SQL_TABLE}`)
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
  + `${sqlTemplateCount} raw ${SQL_TABLE} statement(s), all ${PREDICATE_OWNERS.length + 1} owning definitions present.`,
)
