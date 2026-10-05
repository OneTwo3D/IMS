import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

/**
 * CENSUS: NO ERROR OR HOLD TEXT IS WRITTEN INTO A VENDOR-BOUND FREE-TEXT FIELD.
 *
 * The free-text writers are the order comments sent to the WMS (postConflictComment / addOrderComment) and the
 * WooCommerce order notes (wcPost to .../notes). This test finds every call to them, resolves the text argument
 * (one level: a `const` in the same file), and fails if it is built from a caught error, an error/message
 * property, or an identifier that conventionally holds failure text. It prints how many call sites it examined.
 *
 * Mutation (recorded in the PR): make a comment interpolate `${error}` or `${String(e)}` => red.
 */

const FILES = [
  'lib/domain/wms/order-push-sweep.ts',
  'app/actions/sales.ts',
  'lib/connectors/woocommerce/sync/invoice-note.ts',
]
const WRITERS = new Set(['postConflictComment', 'addOrderComment', 'addMintsoftOrderComment'])
const FAILURE_NAME = /^(e|err|error|exception|message|lastError|reason|detail|details|cause|outcome|failure|errorMessage)$/i

type Finding = { where: string; why: string }

function textArgs(call: ts.CallExpression, source: ts.SourceFile): ts.Expression[] | null {
  const callee = call.expression
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
  if (WRITERS.has(name)) return [...call.arguments].slice(1) // (externalOrderId, comment, orderId?) - the comment and what follows
  if (name === 'wcPost') {
    const path = call.arguments[0]?.getText(source) ?? ''
    if (/notes/.test(path)) return [...call.arguments].slice(1)
  }
  return null
}

function identifiersIn(node: ts.Node): ts.Identifier[] {
  const found: ts.Identifier[] = []
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) found.push(n)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

function scan(file: string): { examined: number; findings: Finding[] } {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const declarations = new Map<string, ts.Expression>()
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) declarations.set(n.name.text, n.initializer)
    ts.forEachChild(n, collect)
  }
  collect(source)
  const findings: Finding[] = []
  let examined = 0
  const where = (n: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}`
  const check = (expression: ts.Expression, origin: ts.Node, depth: number) => {
    for (const id of identifiersIn(expression)) {
      const isMemberName = ts.isPropertyAccessExpression(id.parent) && id.parent.name === id
      if (FAILURE_NAME.test(id.text) && !(isMemberName && !/^(message|error)$/i.test(id.text))) {
        findings.push({ where: where(origin), why: `free text built from "${id.text}"` })
      }
      const resolved = declarations.get(id.text)
      if (resolved && depth < 2 && !isMemberName) check(resolved, origin, depth + 1)
    }
  }
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const args = textArgs(n, source)
      if (args) {
        examined += 1
        for (const arg of args) check(arg, n, 0)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(source)
  return { examined, findings }
}

test('no vendor-bound free-text writer is given text derived from a caught error or failure message', () => {
  const results = FILES.map(scan)
  const examined = results.reduce((sum, r) => sum + r.examined, 0)
  console.log(`precondition (text census): ${FILES.length} files, ${examined} free-text writer call sites examined`)
  assert.ok(examined >= 7, `the census must find the writer call sites that exist (found ${examined})`)
  assert.deepEqual(results.flatMap((r) => r.findings).map((f) => `${f.where} ${f.why}`), [])
})

test('the census can fail: a comment built from an error, a message property or a resolved const is flagged', () => {
  const dir = 'tmp-text-census-probe'
  mkdirSync(dir, { recursive: true })
  try {
    const cases: Record<string, string> = {
      direct: "async function f(postConflictComment: any, error: unknown) { await postConflictComment('1', `failed: ${error}`) }",
      member: "async function f(connector: any, e: Error) { await connector.addOrderComment('1', 'x ' + e.message) }",
      viaConst: "async function f(postConflictComment: any, lastError: string) { const c = `see ${lastError}`; await postConflictComment('1', c) }",
    }
    for (const [name, code] of Object.entries(cases)) {
      const file = `${dir}/${name}.ts`
      writeFileSync(file, code)
      assert.ok(scan(file).findings.length > 0, `the census missed the ${name} shape`)
    }
    const clean = `${dir}/clean.ts`
    writeFileSync(clean, "async function f(postConflictComment: any, order: any) { await postConflictComment('1', `IMS: shipping method '${order.shippingService}' did not map`, order.id) }")
    assert.equal(scan(clean).findings.length, 0, 'the control: a fixed comment is clean')
    console.log('precondition (census probe): 3 evasion shapes flagged, 1 clean control passes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
