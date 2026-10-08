import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import {
  classifyMintsoftRequest,
  MINTSOFT_KNOWN_WRITES,
  MINTSOFT_LOCAL_FAKE_PATH_PREFIX,
  MINTSOFT_READ_ALLOWLIST,
} from '../../lib/connectors/mintsoft/api/read-allowlist.ts'

/**
 * THE MINTSOFT PATH CENSUS (arm e).
 *
 * Mintsoft is classified by (method, path), so a new `/api/...` path in the connector must not be able
 * to appear unclassified: it would be a WRITE by default (held, loud), but nobody would have decided
 * that. This test reads every source file under lib/connectors/mintsoft, extracts every `/api/...` path
 * from its string, template and no-substitution-template literals using the TypeScript parser (comments
 * are not tokens, so they are excluded by construction), and fails unless each one is classified: it
 * matches an allow-listed READ path or a listed KNOWN WRITE. It prints how many it examined.
 *
 * Mutation (recorded in the PR): add a dummy literal `'/api/Dummy/Thing'` to a connector file => red.
 */

const ROOT = join(process.cwd(), 'lib/connectors/mintsoft')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') && !full.endsWith('.d.ts') ? [full] : []
  })
}

type Found = { file: string; path: string }

function extractPaths(file: string): Found[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: Found[] = []
  const record = (text: string) => {
    for (const match of text.matchAll(/\/api\/[A-Za-z0-9/_-]*/g)) {
      const path = match[0].replace(/\/+$/, '')
      if (path.startsWith(MINTSOFT_LOCAL_FAKE_PATH_PREFIX)) continue
      found.push({ file, path })
    }
  }
  const visit = (node: ts.Node) => {
    // A module specifier ('./api/auth') is a file path, not a Mintsoft path.
    const isModuleSpecifier = ts.isStringLiteral(node) && (
      ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)
      || (ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword)
      || (ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent))
    )
    if (isModuleSpecifier) return
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) record(node.text)
    else if (ts.isTemplateExpression(node)) {
      // Substitutions become `1`, so `/api/Order/${id}/Items` reads as `/api/Order/1/Items`.
      record(node.head.text + node.templateSpans.map((span) => `1${span.literal.text}`).join(''))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function isClassified(path: string): boolean {
  return MINTSOFT_READ_ALLOWLIST.some((rule) => rule.pattern.test(path))
    || MINTSOFT_KNOWN_WRITES.some((write) => write.pattern.test(path))
}

test('(e) every /api/... path literal in lib/connectors/mintsoft is classified as a read or a known write', () => {
  const files = sourceFiles(ROOT)
  const found = files.flatMap(extractPaths)
  const distinct = [...new Set(found.map((entry) => entry.path))].sort()
  console.log(`precondition (e): ${files.length} files, ${found.length} path literals, ${distinct.length} distinct paths examined`)
  assert.ok(files.length >= 15, 'the census must be looking at the connector')
  assert.ok(distinct.length >= 15, `the census must find the paths the connector uses (found ${distinct.length})`)
  // The three the hazard is about must be among those it found, or it is not reading what it should.
  for (const mustSee of ['/api/Auth', '/api/Order/1/Cancel', '/api/Order/1/Comments', '/api/Order/Search']) {
    assert.ok(distinct.includes(mustSee), `the census must see ${mustSee}; saw ${distinct.join(', ')}`)
  }

  const unclassified = found.filter((entry) => !isClassified(entry.path))
  assert.deepEqual(
    unclassified.map((entry) => `${entry.file.slice(process.cwd().length + 1)}: ${entry.path}`),
    [],
    'every Mintsoft path must be classified in lib/connectors/mintsoft/api/read-allowlist.ts (a read entry or a known write)',
  )
})

test('the allow-list reads nothing that mutates, and the known writes are never reads', () => {
  // The allow-list must not contain a path that is also a known write for the SAME method.
  const readCases: Array<[string, string]> = [
    ['GET', '/api/Warehouse'], ['GET', '/api/Product/StockLevels'], ['GET', '/api/Product/7'], ['GET', '/api/Product/7/Bundle'],
    ['GET', '/api/Returns'], ['GET', '/api/Order/Search'], ['GET', '/api/Order/List'], ['GET', '/api/Order/Statuses'],
    ['GET', '/api/Order/5'], ['GET', '/api/Order/5/Items'], ['GET', '/api/ASN/List'], ['GET', '/api/ASN/9'],
    [ 'GET', `${MINTSOFT_LOCAL_FAKE_PATH_PREFIX}/api/Warehouse`],
  ]
  for (const [method, path] of readCases) {
    assert.equal(classifyMintsoftRequest(method, path).class, 'read', `${method} ${path}`)
  }
  const writeCases: Array<[string, string]> = [
    ['GET', '/api/Order/5/Cancel'], ['GET', '/api/Order/5/MarkAwaitingConfirmation'], ['POST', '/api/Order/5/Comments'],
    ['POST', '/api/Auth'], ['GET', '/api/Auth'], ['PUT', '/api/Order'], ['POST', '/api/Order/5'], ['DELETE', '/api/Order/5'],
    ['PUT', '/api/Order/5/Items'], ['DELETE', '/api/Order/5/Items/3'], ['PUT', '/api/Product'], ['POST', '/api/Product'],
    ['PUT', '/api/Product/Bundle'], ['PUT', '/api/ASN'], ['DELETE', '/api/ASN/9'], ['POST', '/api/ASN/9'],
    // Anything unknown, or spelled differently, is a write: never a read by accident.
    ['GET', '/api/Unknown/Thing'], ['GET', '/api/order/5'], ['GET', '/api/Order/5/'], ['GET', '//api/Order/5'],
    ['GET', '/api/Order/5%2FCancel'], ['GET', '/api/Order/abc'], ['GET', '/api/Order/Statuses/extra'], ['HEAD', '/api/Warehouse'],
    ['GET', `${MINTSOFT_LOCAL_FAKE_PATH_PREFIX}/api/Order/5/Cancel`], ['', '/api/Warehouse'],
  ]
  for (const [method, path] of writeCases) {
    assert.equal(classifyMintsoftRequest(method, path).class, 'write', `${method || '(none)'} ${path}`)
  }
  console.log(`precondition (classification): ${readCases.length} read cases and ${writeCases.length} write cases asserted`)
})

test('mintsoftRequest is only called from inside the Mintsoft connector, so the census sees every path the connector can send', () => {
  const offenders: string[] = []
  let scanned = 0
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'generated') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(full)) continue
      scanned += 1
      if (full.startsWith(ROOT)) continue
      if (/\bmintsoftRequest\s*[<(]/.test(readFileSync(full, 'utf8'))) offenders.push(full.slice(process.cwd().length + 1))
    }
  }
  walk(join(process.cwd(), 'lib'))
  walk(join(process.cwd(), 'app'))
  console.log(`precondition (callers): ${scanned} files under lib/ and app/ scanned for mintsoftRequest callers outside the connector`)
  assert.ok(scanned > 500)
  assert.deepEqual(offenders, [])
})
