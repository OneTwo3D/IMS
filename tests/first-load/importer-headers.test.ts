/**
 * Arm (g): the output headers equal the importers' template headers EXACTLY.
 *
 * The header lists in the `/api/export/*` route files are module-private and the routes import the database and the auth
 * layer, so this test reads each route's SOURCE with the TypeScript parser, finds the call to `buildTemplateCsv(...)` that
 * serves `?template=1`, resolves its first argument to the string array it names, and compares THAT with what this tool
 * writes. The array compared is therefore the one the live template builder is handed, not a copy of it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { parseCsv } from '../../lib/csv.ts'
import { IMPORT_TARGETS, type ImporterTarget } from '../../lib/first-load/spec.ts'
import { ds, lot, precondition, product, run, loadFixtureDatasets } from './helpers.ts'

interface Template {
  headers: string[]
  required: string[]
  builderCalls: number
}

function stringArray(node: ts.Expression, decls: Map<string, ts.Expression>): string[] {
  if (ts.isAsExpression(node)) return stringArray(node.expression, decls)
  if (ts.isIdentifier(node)) {
    const target = decls.get(node.text)
    assert.ok(target, `identifier ${node.text} is not a top-level const in the route`)
    return stringArray(target, decls)
  }
  assert.ok(ts.isArrayLiteralExpression(node), `expected an array literal, found ${ts.SyntaxKind[node.kind]}`)
  return node.elements.map((element) => {
    assert.ok(ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element), 'header entries must be string literals')
    return element.text
  })
}

function readTemplate(routePath: string): Template {
  const source = ts.createSourceFile(routePath, readFileSync(path.join(process.cwd(), routePath), 'utf8'), ts.ScriptTarget.Latest, true)
  const decls = new Map<string, ts.Expression>()
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node) && node.parent === source) {
      for (const decl of node.declarationList.declarations) if (ts.isIdentifier(decl.name) && decl.initializer) decls.set(decl.name.text, decl.initializer)
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'buildTemplateCsv') calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(calls.length, 1, `${routePath} must have exactly one buildTemplateCsv call (found ${calls.length})`)
  const [headersArg, requiredArg] = calls[0].arguments
  return { headers: stringArray(headersArg, decls), required: stringArray(requiredArg, decls), builderCalls: calls.length }
}

const TARGETS = Object.keys(IMPORT_TARGETS) as ImporterTarget[]

test('arm (g): each importer target\'s headers equal the list its template builder is handed', (t) => {
  let compared = 0
  for (const target of TARGETS) {
    const spec = IMPORT_TARGETS[target]
    const live = readTemplate(spec.templateRoute)
    assert.deepEqual([...spec.headers], live.headers, `${target}: headers differ from ${spec.templateRoute}`)
    assert.deepEqual([...spec.required], live.required, `${target}: required columns differ from ${spec.templateRoute}`)
    compared += live.headers.length
  }
  precondition(t, 'targets compared', TARGETS.length)
  precondition(t, 'header names compared', compared)
})

test('arm (g): the routes still name the constant the spec says feeds the template builder', (t) => {
  let matched = 0
  for (const target of TARGETS) {
    const spec = IMPORT_TARGETS[target]
    const source = readFileSync(path.join(process.cwd(), spec.templateRoute), 'utf8')
    if (new RegExp(`buildTemplateCsv\\(\\s*${spec.templateConstant}\\b`).test(source)) matched++
  }
  precondition(t, 'routes whose template builder is fed the documented constant', matched)
  assert.equal(matched, TARGETS.length)
})

test('arm (g): the files this tool writes carry exactly those headers (every target, fixture run)', (t) => {
  const result = run(loadFixtureDatasets())
  const written = new Set(result.outputs.map((file) => file.target))
  precondition(t, 'output files', result.outputs.length)
  assert.equal(written.size, TARGETS.length, 'the fixture produces a file for every importer target')
  for (const file of result.outputs) {
    const live = readTemplate(IMPORT_TARGETS[file.target].templateRoute)
    assert.equal(file.content.split('\r\n')[0], live.headers.join(','), file.name)
  }
})

test('arm (g): the importers\' own CSV reader (lib/csv.ts parseCsv) reads the cells the importers look up by template name', (t) => {
  const result = run({
    products: ds('products', [product('A'), product('B', 'BOM')]),
    'recipe-lines': ds('recipe-lines', [{ parentSku: 'B', componentSku: 'A', qty: '2' }]),
    'stock-lots': ds('stock-lots', [lot('A', '3', '1.5')]),
  })
  precondition(t, 'output files', result.outputs.length)
  assert.equal(result.blocking, false)
  const products = parseCsv(result.outputs.find((f) => f.target === 'products')!.content)
  const stock = parseCsv(result.outputs.find((f) => f.target === 'opening-stock')!.content)
  assert.deepEqual(products.map((r) => [r.sku, r.type, r.components]), [['A', 'SIMPLE', ''], ['B', 'BOM', 'A:2']])
  assert.deepEqual(stock.map((r) => [r.sku, r.warehouseCode, r.qty, r.unitCostBase]), [['A', 'MAIN', '3', '1.500000']])
})
