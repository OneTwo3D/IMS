import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

/**
 * FAIL-CLOSED CENSUS OF EVERY WRITER OF AN ORDER ALLOCATION, A SHIPMENT LINE OR A SHIPMENT (its existence and status).
 *
 * The part of an order a warehouse is sent is derived from those rows (lib/domain/wms/mixed-scope.ts). If a writer changes them and the warehouse order is
 * not told, Mintsoft keeps a stale line set for ever. So every writer must call `markWmsScopeDirtyInTx` in the transaction it writes in, and this scan makes
 * that a property of the code base instead of a habit: it finds every write through the Prisma client (orderAllocation / shipmentLine / shipment, any write
 * method) and every raw SQL write to their tables, and requires a `markWmsScopeDirtyInTx` call in the same function (or an enclosing one).
 *
 * A writer that cannot change what is sent is listed below WITH ITS REASON. The list is exact: an entry no writer matches fails, so it cannot outlive the
 * code it excused. Adding a writer means calling the marker, or (rarely) adding an entry that says why not.
 */
const cwd = new URL('..', import.meta.url).pathname
const WRITE_METHODS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'])
const MODELS = new Set(['orderAllocation', 'shipmentLine', 'shipment'])
const RAW_TABLES = /\b(order_allocations|shipment_lines|shipments)\b/
const RAW_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i

/** `file::function` -> why this writer cannot change the part of the order the warehouse is sent. */
const EXEMPT: Record<string, string> = {
  'app/actions/reset.ts::clearTransactionScope': 'wipes every table in a factory reset (the push links go with it), so no warehouse order is left to go stale',
  'app/actions/allocation.ts::updateShipmentTracking': 'writes the tracking number and service of a SHIPPED shipment only; no quantity, warehouse or status moves',
  'lib/connectors/xero/daily-sync.ts::runGroupB': 'stamps accounting journal references and cost amounts on shipments and shipment lines; no quantity, warehouse or status moves',
  'lib/connectors/xero/daily-sync.ts::runDailyBatchSync': 'stamps the accounting batch amount on allocation rows; no quantity or warehouse moves',
  'lib/cost-layers.ts::refreshShipmentCogsForCostLayerChange': 'rewrites the COGS amount of a shipment after a landed-cost revaluation; no quantity, warehouse or status moves',
  'lib/domain/erasure/erase-personal-data.ts::eraseOrdersPersonalDataInTx': 'nulls the tracking number of an erased order\'s shipments; the warehouse order is never amended for an erased order',
  'lib/domain/sales/allocation-service.ts::runAllocation': 'the one unmarked write here only re-stamps fulfillmentGraphVersion on rows of an UNCHANGED allocation set (the changed-set branch marks the scope dirty)',
  'lib/domain/sales/allocation-service.ts::refileAccountedRecordsForScope': 'rewrites the cost-layer snapshot carried on an allocation row; the quantity and warehouse are untouched',
  'lib/domain/sales/allocation-service.ts::resetAllocationAccountingIfStaged': 'clears the cost-layer snapshot and posted basis on allocation rows; the quantity and warehouse are untouched',
}

type Site = { key: string; file: string; line: number; marked: boolean }

function functionName(node: ts.Node): string {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text
    current = current.parent
  }
  return '<module>'
}

function isMarkerStatement(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement)) return false
  let expression: ts.Expression = statement.expression
  if (ts.isAwaitExpression(expression)) expression = expression.expression
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'markWmsScopeDirtyInTx'
}

/**
 * The marker must be a STATEMENT of a block the write is nested in (the write's own block, or any block above it up to its function): a marker inside a
 * different branch (`if (a) { mark } else { write }`) does not excuse the write, and neither does a marker in a sibling function.
 */
function markedAbove(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isBlock(current) && current.statements.some(isMarkerStatement)) return true
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current) || ts.isMethodDeclaration(current)) {
      // An expression-bodied arrow has no block; stop at the function boundary either way.
      return false
    }
    current = current.parent
  }
  return false
}

function scan(): Site[] {
  const files = execFileSync('git', ['ls-files', '--', 'app', 'lib', ':!app/generated', ':!*.test.ts'], { encoding: 'utf8', cwd }).split('\n').filter((f) => /\.(ts|tsx)$/.test(f))
  const sites: Site[] = []
  for (const file of files) {
    const text = readFileSync(`${cwd}${file}`, 'utf8')
    if (!/(orderAllocation|shipmentLine|shipment\b|order_allocations|shipment_lines)/.test(text)) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        const target = node.expression.expression
        if (WRITE_METHODS.has(method) && ts.isPropertyAccessExpression(target) && MODELS.has(target.name.text)) {
          sites.push({ key: `${file}::${functionName(node)}`, file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, marked: markedAbove(node) })
        }
      }
      // Raw SQL: a tagged template or a $executeRaw* call whose text writes to the tables.
      if (ts.isTaggedTemplateExpression(node) && /\$(executeRaw|queryRaw)/.test(node.tag.getText())) {
        const sql = node.template.getText()
        if (RAW_TABLES.test(sql) && RAW_WRITE.test(sql) && !/\bSELECT\b[^;]*\bFOR UPDATE\b/i.test(sql.replace(/\n/g, ' ')) ) {
          sites.push({ key: `${file}::${functionName(node)}`, file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, marked: markedAbove(node) })
        }
      }
      // The unsafe raw forms take a plain string: scan the call's text.
      if (ts.isCallExpression(node) && /\$(executeRawUnsafe|queryRawUnsafe)$/.test(node.expression.getText())) {
        const sql = node.arguments.map((arg) => arg.getText()).join(' ')
        if (RAW_TABLES.test(sql) && RAW_WRITE.test(sql)) {
          sites.push({ key: `${file}::${functionName(node)}`, file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, marked: markedAbove(node) })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return sites
}

test('every writer of an order allocation, a shipment line or a shipment marks the warehouse scope dirty (or is exempt, with its reason)', () => {
  const sites = scan()
  assert.ok(sites.length >= 20, `the scan found ${sites.length} writer sites: the scanner is broken, not the code base`)
  const unmarked = sites.filter((site) => !site.marked && !(site.key in EXEMPT))
  assert.deepEqual(unmarked.map((site) => `${site.key} (${site.file}:${site.line})`), [], 'these writers do not call markWmsScopeDirtyInTx: a mixed-warehouse order would keep a stale part at the warehouse')
})

test('every exemption still excuses a live unmarked writer', () => {
  const sites = scan()
  const live = new Set(sites.filter((site) => !site.marked).map((site) => site.key))
  assert.deepEqual(Object.keys(EXEMPT).filter((key) => !live.has(key)), [], 'a dead exemption: remove it')
})

test('the census reads real call shapes (a synthetic writer without the marker is caught)', () => {
  const source = ts.createSourceFile('x.ts', 'async function w(tx){ await tx.orderAllocation.deleteMany({ where: {} }) }', ts.ScriptTarget.Latest, true)
  let hits = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && WRITE_METHODS.has(node.expression.name.text)) {
      const target = node.expression.expression
      if (ts.isPropertyAccessExpression(target) && MODELS.has(target.name.text) && !markedAbove(node)) hits += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(hits, 1)
})
