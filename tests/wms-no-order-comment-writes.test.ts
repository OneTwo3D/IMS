import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

/**
 * IMS WRITES NO COMMENT TO A WAREHOUSE ORDER.
 *
 * The warehouse's staff do not read order comments; only a query raised in their own system reaches them, and the API cannot raise one (owner
 * ruling 2026-11-15). Everything IMS used to say in a comment is an operator task now (lib/domain/wms/operator-tasks.ts), listed on
 * Sync > Exceptions. This scans EVERY .ts/.tsx file under lib/ and app/ and is red if any reference to a comment writer
 * (`addOrderComment`, `addMintsoftOrderComment`, `postConflictComment`) appears outside the connector itself, as a call, an alias, an import or a
 * property read. The connector method is kept (the WmsConnector contract still has it, and the producer census still governs it); nothing in the
 * product calls it.
 *
 * Mutation: add `await connector.addOrderComment(id, 'x', clearance)` to any file under lib/domain or app/: red, with the file and line.
 */

const WRITERS = new Set(['addOrderComment', 'addMintsoftOrderComment', 'postConflictComment'])
/** The connector itself: its contract, its facade and the API function it delegates to. Nothing else. */
const CONNECTOR_FILES = new Set([
  'lib/connectors/wms/types.ts',
  'lib/connectors/mintsoft/index.ts',
  'lib/connectors/mintsoft/api/order-push.ts',
])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'generated' || entry === '.next') return []
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry) ? [full] : []
  })
}

/** Every reference to a comment writer in `text`, as `line:name`. Identifier tokens and string keys (`c['addOrderComment']`); comments are not code. */
export function commentWriterReferences(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && WRITERS.has(n.text)) found.push(`${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}:${n.text}`)
    else if (ts.isStringLiteralLike(n) && WRITERS.has(n.text) && ts.isElementAccessExpression(n.parent)) found.push(`${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}:${n.text}`)
    ts.forEachChild(n, visit)
  }
  visit(source)
  return found
}

test('no code under lib/ or app/ outside the connector references an order-comment writer', () => {
  const root = process.cwd()
  const files = ['lib', 'app'].flatMap((dir) => walk(join(root, dir))).map((full) => full.slice(root.length + 1))
  assert.ok(files.length > 800, `the scan must cover the whole code base, not a list (saw ${files.length})`)
  const offenders: string[] = []
  for (const file of files) {
    if (CONNECTOR_FILES.has(file)) continue
    for (const ref of commentWriterReferences(file, readFileSync(join(root, file), 'utf8'))) offenders.push(`${file}:${ref}`)
  }
  assert.deepEqual(offenders, [], 'IMS must raise an operator task instead of writing a warehouse comment (lib/domain/wms/operator-tasks.ts)')
})

test('the connector files that may mention a writer still exist, and each really does (a rename would otherwise blind the scan)', () => {
  for (const file of CONNECTOR_FILES) assert.ok(commentWriterReferences(file, readFileSync(join(process.cwd(), file), 'utf8')).length > 0, `${file} no longer mentions a comment writer: shrink CONNECTOR_FILES`)
})

test('the scan can fail: a call, an alias, a destructure, an import and a string key are all found; a comment and a longer name are not', () => {
  const cases: Record<string, [string, number]> = {
    call: ['async function f(c: any) { await c.addOrderComment("1", "x", clearance) }', 1],
    bareCall: ['async function f() { await postConflictComment("1", "x") }', 1],
    alias: ['const send = connector.addOrderComment', 1],
    destructure: ['const { addOrderComment: post } = connector', 1],
    importOf: ['import { addMintsoftOrderComment } from "@/lib/connectors/mintsoft/api/order-push"', 1],
    stringKey: ['async function f(c: any) { await c["addOrderComment"]("1", "x") }', 1],
    commentOnly: ['// we used to call addOrderComment( here\nconst x = 1', 0],
    longerName: ['const addOrderCommentary = 1; function postConflictCommentary() {}', 0],
  }
  for (const [name, [code, expected]] of Object.entries(cases)) assert.equal(commentWriterReferences('x.ts', code).length, expected, name)
})
