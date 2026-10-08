import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

/**
 * CENSUS, FAILING CLOSED: NO ERROR OR HOLD TEXT IS WRITTEN INTO A DESTINATION-BOUND FREE-TEXT FIELD.
 *
 * Transports never modify a request body, so the guarantee that a destination is never sent a hold text (which
 * would let it echo a verbatim, validly-referenced text back) is that no code builds destination free text from a
 * caught error. This test enforces it over EVERY .ts/.tsx file under lib/ and app/ - not a fixed file list - so a
 * new writer in a new file is inspected too.
 *
 * Detectors, all AST-based, resolving a text argument through one level of `const`:
 *  A. a CALL to a vendor free-text writer, found by name: postConflictComment, addOrderComment,
 *     addMintsoftOrderComment (the WMS comment writers; the contract is WmsConnector.addOrderComment), and wcPost
 *     to an order `notes` path (a WooCommerce order note);
 *     Aliases of a writer are followed one level (`const f = addOrderComment`, `const { addOrderComment: f } = c`);
 *  B. an object-literal property (including a shorthand `{ note }` and a literal-computed key `['note']`), or an
 *     assignment `payload.note = value` / `payload['note'] = value`, whose key is a destination free-text field - Narration, Reference, Comments,
 *     Comment, Notes, Note, note, comment, narration, reference, Description (as sent to Xero/Mintsoft/WooCommerce
 *     payload builders) - in a file under lib/connectors/.
 *
 * A finding is a text built from a caught error / error message / failure-named identifier (error, err, e,
 * message, reason, detail, lastError, cause...). A finding is acceptable only if it is in ALLOWED, which is
 * SHRINK-ONLY: an entry that no longer matches any finding fails the test, and each carries a justification.
 *
 * WHAT IT DOES NOT COVER, stated plainly: it is a syntactic census, not a data-flow analysis. It does not follow
 * text through helper functions or closures, through object spreads, or through computed keys that are not
 * literals. Those shapes need symbol-level analysis (filed as a follow-up); the claim made in the docs is limited
 * to what this test covers.
 *
 * Mutation (recorded in the PR): add a new file under lib/ that writes `${String(error)}` into a comment => red.
 */

const ROOTS = ['lib', 'app']
const WRITER_FUNCTIONS = new Set(['postConflictComment', 'addOrderComment', 'addMintsoftOrderComment'])
const FREE_TEXT_KEYS = new Set(['Narration', 'narration', 'Reference', 'reference', 'Comments', 'Comment', 'comment', 'Notes', 'Note', 'note', 'Description'])
const FAILURE_NAME = /^(e|err|error|exception|message|lastError|reason|detail|details|cause|outcome|failure|errorMessage)$/i

/** shrink-only: `file | key-or-writer | identifier` -> why this is not a destination payload built from failure text. */
const ALLOWED: Record<string, string> = {}

type Finding = { id: string; where: string; why: string }

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'generated' || entry === '.next') return []
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry) ? [full] : []
  })
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

export function scanFile(file: string, text: string): { callSites: number; properties: number; findings: Finding[] } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const declarations = new Map<string, ts.Expression>()
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) declarations.set(n.name.text, n.initializer)
    ts.forEachChild(n, collect)
  }
  collect(source)

  // Writer aliases, one level: `const f = addOrderComment` and `const { addOrderComment: f } = connector`.
  const writerNames = new Set(WRITER_FUNCTIONS)
  const aliasScan = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name) && ts.isIdentifier(n.initializer) && WRITER_FUNCTIONS.has(n.initializer.text)) writerNames.add(n.name.text)
      if (ts.isIdentifier(n.name) && ts.isPropertyAccessExpression(n.initializer) && WRITER_FUNCTIONS.has(n.initializer.name.text)) writerNames.add(n.name.text)
      if (ts.isObjectBindingPattern(n.name)) {
        for (const element of n.name.elements) {
          const source = (element.propertyName ?? element.name) as ts.Node
          if (ts.isIdentifier(source) && WRITER_FUNCTIONS.has(source.text) && ts.isIdentifier(element.name)) writerNames.add(element.name.text)
        }
      }
    }
    ts.forEachChild(n, aliasScan)
  }
  aliasScan(source)

  const findings: Finding[] = []
  let callSites = 0
  let properties = 0
  const where = (n: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}`

  const check = (expression: ts.Expression, origin: ts.Node, label: string, depth: number) => {
    for (const id of identifiersIn(expression)) {
      const parent = id.parent
      const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === id
      const isPropertyKey = ts.isPropertyAssignment(parent) && parent.name === id
      if (isPropertyKey) continue
      // `x.message` / `x.error` are failure text wherever they appear; other member names are just fields.
      const failure = FAILURE_NAME.test(id.text) && (!isMemberName || /^(message|error|lastError|errorMessage)$/i.test(id.text))
      if (failure) findings.push({ id: `${file} | ${label} | ${id.text}`, where: where(origin), why: `free text built from "${id.text}"` })
      const resolved = declarations.get(id.text)
      if (resolved && depth < 2 && !isMemberName) check(resolved, origin, label, depth + 1)
    }
  }

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      const isNote = name === 'wcPost' && /notes/.test(n.arguments[0]?.getText(source) ?? '')
      if (writerNames.has(name) || isNote) {
        callSites += 1
        for (const arg of [...n.arguments].slice(1)) check(arg, n, name, 0)
      }
    }
    if (file.startsWith('lib/connectors/')) {
      const literalKey = (name: ts.PropertyName | ts.Expression): string => {
        if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
        if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text
        return ''
      }
      if (ts.isPropertyAssignment(n)) {
        const key = literalKey(n.name)
        if (FREE_TEXT_KEYS.has(key)) { properties += 1; check(n.initializer, n, key, 0) }
      } else if (ts.isShorthandPropertyAssignment(n)) {
        if (FREE_TEXT_KEYS.has(n.name.text)) { properties += 1; check(n.name, n, n.name.text, 0) }
      } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = n.left
        const key = ts.isPropertyAccessExpression(target) ? target.name.text
          : ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression) ? target.argumentExpression.text : ''
        if (FREE_TEXT_KEYS.has(key)) { properties += 1; check(n.right, n, key, 0) }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(source)
  return { callSites, properties, findings }
}

test('no destination free-text writer anywhere under lib/ or app/ is given text derived from a caught error or failure message', () => {
  const files = ROOTS.flatMap((root) => walk(join(process.cwd(), root))).map((full) => full.slice(process.cwd().length + 1))
  let callSites = 0
  let properties = 0
  const findings: Finding[] = []
  for (const file of files) {
    const result = scanFile(file, readFileSync(join(process.cwd(), file), 'utf8'))
    callSites += result.callSites
    properties += result.properties
    findings.push(...result.findings)
  }
  console.log(`precondition (text census): ${files.length} files under lib/ and app/, ${callSites} writer call sites and ${properties} free-text payload properties examined`)
  assert.ok(files.length > 800, 'the census must be scanning the whole code base, not a list')
  assert.ok(callSites >= 7, `the known writer call sites must be found (found ${callSites})`)
  assert.ok(properties >= 5, `the payload free-text properties must be found (found ${properties})`)

  const unexplained = findings.filter((f) => !(f.id in ALLOWED))
  assert.deepEqual(unexplained.map((f) => `${f.where} ${f.why} [${f.id}]`), [])
  const stale = Object.keys(ALLOWED).filter((id) => !findings.some((f) => f.id === id))
  assert.deepEqual(stale, [], 'ALLOWED is shrink-only: an entry that no longer matches a finding must be deleted')
  for (const [id, why] of Object.entries(ALLOWED)) assert.ok(why.length >= 30, `${id} needs a real justification`)
})

test('the census can fail: it flags a new file, an alias const, a member message, and a payload property built from an error; a fixed text is clean', () => {
  const probe = (code: string, file = 'lib/connectors/probe.ts') => scanFile(file, code)
  const cases: Record<string, string> = {
    newFileDirect: "async function f(postConflictComment: any, error: unknown) { await postConflictComment('1', `failed: ${String(error)}`) }",
    member: "async function f(c: any, e: Error) { await c.addOrderComment('1', 'x ' + e.message) }",
    viaConst: "async function f(postConflictComment: any, lastError: string) { const c = `see ${lastError}`; await postConflictComment('1', c) }",
    wcNote: "async function f(wcPost: any, err: unknown) { await wcPost('orders/1/notes', { note: String(err) }) }",
    payloadProperty: "function f(reason: string) { return { Narration: `posted: ${reason}`, Reference: 'x' } }",
    aliasConst: "async function f(addOrderComment: any, error: unknown) { const send = addOrderComment; await send('1', String(error)) }",
    aliasDestructure: "async function f(c: any, error: unknown) { const { addOrderComment: post } = c; await post('1', `x ${error}`) }",
    assignment: "function f(error: unknown) { const payload: Record<string, string> = {}; payload.Comment = String(error); return payload }",
    elementAssignment: "function f(err: unknown) { const payload: Record<string, string> = {}; payload['note'] = `${err}`; return payload }",
    shorthand: "function f(reason: string) { const note = `why ${reason}`; return { note } }",
    computedLiteralKey: "function f(reason: string) { return { ['Narration']: `posted ${reason}` } }",
  }
  console.log(`precondition (census probe): ${Object.keys(cases).length} evasion shapes, 3 clean controls`)
  for (const [name, code] of Object.entries(cases)) {
    assert.ok(probe(code).findings.length > 0, `the census missed the ${name} shape`)
  }
  assert.equal(probe("async function f(postConflictComment: any, order: any) { await postConflictComment('1', `IMS: method '${order.shippingService}' did not map`, order.id) }").findings.length, 0)
  assert.equal(probe("function f(order: any) { return { Narration: `Order ${order.number}`, Reference: order.number } }").findings.length, 0)
  assert.equal(probe("function f(order: any) { const note = `Order ${order.number}`; const p: Record<string, string> = {}; p.Comment = note; return { note } }").findings.length, 0)
})

test('a NEW file with a failing writer is found by the whole-tree scan (it does not depend on a file list)', () => {
  const dir = join(process.cwd(), 'lib', 'zz-text-census-probe')
  mkdirSync(dir, { recursive: true })
  try {
    const file = join(dir, 'writer.ts')
    writeFileSync(file, "export async function w(postConflictComment: (a: string, b: string) => Promise<void>, error: unknown) { await postConflictComment('1', `boom ${String(error)}`) }\n")
    const files = ROOTS.flatMap((root) => walk(join(process.cwd(), root))).map((full) => full.slice(process.cwd().length + 1))
    assert.ok(files.includes('lib/zz-text-census-probe/writer.ts'), 'the scan lists the new file')
    const findings = files.flatMap((f) => scanFile(f, readFileSync(join(process.cwd(), f), 'utf8')).findings)
    assert.ok(findings.some((f) => f.where.startsWith('lib/zz-text-census-probe/writer.ts')), 'and flags it')
    console.log('precondition (new file): a fresh lib/zz-text-census-probe/writer.ts was written, scanned and flagged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
