import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { makeScratchRoot } from '../helpers/safe-temp-root'
import ts from 'typescript'

/**
 * THE HOLD COVERS PROCESSES THAT DO NOT USE connectorFetch (scripts/ and the e2e harness).
 *
 * check:connector-fetch-boundaries only scans lib/connectors, lib/shopping.ts and app/api/cron, so a
 * script under scripts/ that calls raw `fetch` is outside it - and one (remove-xero-live-e2e-footprint)
 * sent Xero POST/DELETE with --apply without ever consulting the environment grant (Codex r2).
 *
 * This is a UNIVERSAL check over every .ts/.mjs file under scripts/: every raw `fetch(...)` whose method
 * is not a literal GET (a variable, a shorthand, POST, DELETE ...) must be in a file that calls
 * `outboundWriteRefusal`, except the identity token exchange, which the hold deliberately allows. It
 * prints how many raw fetch calls it examined and how many were mutating.
 */

const ROOTS = ['scripts', 'e2e'].map((dir) => join(process.cwd(), dir))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'test-results' || entry === 'playwright-report') return []
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return files(full)
    return /\.(ts|mjs)$/.test(entry) ? [full] : []
  })
}

type Finding = { where: string; why: string }

/** Requests to THIS application (its own cron and webhook routes) are not requests to a vendor. */
const LOCAL_APP_URL = /^(`\$\{(getAppBaseUrl\(\)|baseUrl)\}\/api\/|'\/api\/)/
const TOKEN_EXCHANGE_URL = /XERO_TOKEN_URL/

function methodOf(options: ts.Expression | undefined): string {
  if (!options) return 'GET'
  if (!ts.isObjectLiteralExpression(options)) return '(unknown shape)'
  let method = 'GET'
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) return '(spread)'
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'method') return '(variable)'
    if (ts.isPropertyAssignment(property)) {
      const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : '(computed)'
      if (key === '(computed)') return '(computed key)'
      if (key === 'method') {
        method = ts.isStringLiteralLike(property.initializer) ? property.initializer.text.toUpperCase() : '(variable)'
      }
    }
  }
  return method
}

function isFetchCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'fetch'
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'fetch') {
    return ts.isIdentifier(expression.expression) && ['globalThis', 'window', 'self', 'global'].includes(expression.expression.text)
  }
  return false
}

function scan(file: string): { examined: number; findings: Finding[] } {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const findings: Finding[] = []
  let examined = 0
  const at = (node: ts.Node) => `${file.slice(process.cwd().length + 1)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isFetchCallee(node.expression)) {
      examined += 1
      const method = methodOf(node.arguments[1])
      const url = node.arguments[0]?.getText(source) ?? ''
      if (method !== 'GET' && !LOCAL_APP_URL.test(url) && !TOKEN_EXCHANGE_URL.test(url)) {
        findings.push({ where: at(node), why: `raw fetch with method ${method} to ${url}: use guardedExternalFetch` })
      }
    } else if (ts.isIdentifier(node) && node.text === 'fetch') {
      // Any reference to `fetch` that is not a direct call, a property name or a declaration name is an alias.
      const parent = node.parent
      const isCallee = ts.isCallExpression(parent) && parent.expression === node
      const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node)
      const isDeclName = (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isImportSpecifier(parent) || ts.isParameter(parent)) && (parent as { name?: ts.Node }).name === node
      const isGlobalMember = ts.isPropertyAccessExpression(parent) && parent.name === node
      if (!isCallee && !isPropertyName && !isDeclName && !isGlobalMember) findings.push({ where: at(node), why: 'fetch used as a value (alias): call it directly so the check can see it' })
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && ['http', 'https'].includes(node.expression.expression.text)
      && ['request', 'get'].includes(node.expression.name.text)) {
      findings.push({ where: at(node), why: 'node http(s).request/get: use guardedExternalFetch' })
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && ['node:http', 'node:https', 'http', 'https', 'undici', 'axios', 'node-fetch'].includes(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (['request', 'get', 'fetch', 'request', 'Agent', 'ProxyAgent'].includes((element.propertyName ?? element.name).text)) {
            findings.push({ where: at(node), why: `named import ${(element.propertyName ?? element.name).text} from ${node.moduleSpecifier.text}` })
          }
        }
      }
      if (['undici', 'axios', 'node-fetch'].includes(node.moduleSpecifier.text)) findings.push({ where: at(node), why: `HTTP client import ${node.moduleSpecifier.text}` })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { examined, findings }
}

test('every non-GET raw fetch under scripts/ and e2e/ goes through guardedExternalFetch (aliases, member calls, unknown option shapes and other HTTP clients are all findings)', () => {
  const all = ROOTS.flatMap(files)
  const results = all.map(scan)
  const examined = results.reduce((sum, r) => sum + r.examined, 0)
  console.log(`precondition (raw fetch): ${all.length} files under scripts/ and e2e/, ${examined} raw fetch calls examined`)
  assert.ok(examined >= 12, 'the scan must see the raw fetch calls that exist')
  assert.deepEqual(
    results.flatMap((r) => r.findings).map((f) => `${f.where} ${f.why}`),
    [],
  )
})

test('the scanner can fail: it flags an alias, a member call, a spread, a quoted method key, an unknown shape and a raw http request', () => {
  // A PRIVATE temp dir outside the source tree: tests that scan the tree run in parallel with this one.
  const scratch = makeScratchRoot('rawfetch-probe-')
  const dir = scratch.root
  const cases: Record<string, string> = {
    alias: "const f = fetch\nawait f('https://api.xero.com/x', { method: 'POST' })",
    member: "await globalThis.fetch('https://shop.example.com/x', { method: 'DELETE' })",
    spread: "const o = {}\nawait fetch('https://shop.example.com/x', { ...o })",
    quoted: "await fetch('https://shop.example.com/x', { 'method': 'PUT' })",
    shape: "const o = { method: 'POST' }\nawait fetch('https://shop.example.com/x', o)",
    http: "import https from 'node:https'\nhttps.request('https://shop.example.com/x')",
  }
  let flagged = 0
  try {
    for (const [name, code] of Object.entries(cases)) {
      const file = join(dir, `${name}.ts`)
      writeFileSync(file, code)
      if (scan(file).findings.length > 0) flagged += 1
      else assert.fail(`the scanner missed the ${name} shape`)
    }
    const clean = join(dir, 'clean.ts')
    writeFileSync(clean, "await fetch('https://shop.example.com/x', { headers: {} })\nawait fetch(`${baseUrl}/api/cron/x`, { method: 'POST' })")
    assert.equal(scan(clean).findings.length, 0, 'the control: a literal GET and a local-app POST are not findings')
  } finally {
    scratch.dispose()
  }
  console.log(`precondition (scanner): ${flagged}/${Object.keys(cases).length} evasion shapes flagged`)
  assert.equal(flagged, Object.keys(cases).length)
})

test('the cleanup script refuses its Xero write before sending when the grant is absent or names another tenant', async () => {
  const { outboundWriteRefusal } = await import('../../lib/security/outbound-write-grant.ts')
  const tenant = '4f7f0c6e-1111-4222-8333-944455556666'
  const attempt = (env: Record<string, string>) => outboundWriteRefusal({
    connectorName: 'Xero', method: 'DELETE', url: 'https://api.xero.com/api.xro/2.0/Invoices/abc', headers: { 'Xero-Tenant-Id': tenant }, env,
  })
  console.log('precondition (cleanup script): the exact request shape the script builds, with grant absent / other tenant / matching')
  assert.equal(attempt({})?.code, 'no_grant')
  assert.equal(attempt({ XERO_WRITE_ALLOWED_TENANT: '99999999-9999-4999-8999-999999999999' })?.code, 'destination_mismatch')
  assert.equal(attempt({ XERO_WRITE_ALLOWED_TENANT: tenant }), null)
  const source = readFileSync(join(process.cwd(), 'scripts', 'remove-xero-live-e2e-footprint.ts'), 'utf8')
  assert.match(source, /await guardedExternalFetch\(requestUrl,/, 'the write is sent through the guarded, redirect-aware transport')
  assert.doesNotMatch(source, /await fetch\(requestUrl/, 'and not through a bare fetch')
})

test('guardedExternalFetch re-checks every hop: a granted write redirected to another origin is refused before its body is sent', async () => {
  const { createServer } = await import('node:http')
  const { guardedExternalFetch } = await import('../../lib/security/guarded-external-fetch.ts')
  const { isOutboundWriteHeldError } = await import('../../lib/security/outbound-write-grant.ts')
  const seen: Record<string, string[]> = { a: [], b: [] }
  const start = (name: 'a' | 'b', redirectTo: () => string | null) => new Promise<{ origin: string; close: () => void }>((resolve) => {
    const server = createServer((req, res) => {
      seen[name].push(`${req.method} ${req.url}`)
      const to = redirectTo()
      if (to) { res.writeHead(307, { location: to }); res.end(); return }
      res.writeHead(200); res.end('{}')
    })
    server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() }))
  })
  let bOrigin = ''
  const b = await start('b', () => null)
  bOrigin = b.origin
  const a = await start('a', () => `${bOrigin}/wp-json/wc/v3/orders/1`)
  try {
    const env = { WC_WRITEBACK_ALLOWED_ORIGIN: a.origin }
    console.log(`precondition (guarded fetch): A=${a.origin} granted and redirects to B=${b.origin}`)
    await assert.rejects(
      guardedExternalFetch(`${a.origin}/wp-json/wc/v3/orders/1`, { method: 'PUT', body: '{}' }, { connectorName: 'WooCommerce', env }),
      (e: unknown) => isOutboundWriteHeldError(e) && e.hop === 1 && e.code === 'destination_mismatch',
    )
    assert.deepEqual(seen, { a: ['PUT /wp-json/wc/v3/orders/1'], b: [] }, 'A got the granted PUT; B received nothing')
    await assert.rejects(
      guardedExternalFetch(`${b.origin}/wp-json/wc/v3/orders/1`, { method: 'DELETE' }, { connectorName: 'WooCommerce', env }),
      (e: unknown) => isOutboundWriteHeldError(e) && e.hop === 0 && e.nothingSent,
    )
    assert.deepEqual(seen.b, [], 'an ungranted origin received nothing at hop 0 either')
    const read = await guardedExternalFetch(`${b.origin}/wp-json/wc/v3/orders`, {}, { connectorName: 'WooCommerce', env: {} })
    assert.equal(read.status, 200, 'reads are never held')
  } finally { a.close(); b.close() }
})
