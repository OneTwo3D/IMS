import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

/**
 * THE HOLD COVERS PROCESSES THAT DO NOT USE connectorFetch.
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

const ROOT = join(process.cwd(), 'scripts')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return files(full)
    return /\.(ts|mjs)$/.test(entry) ? [full] : []
  })
}

type Call = { file: string; urlText: string; method: string; line: number }

function rawFetchCalls(file: string): Call[] {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const calls: Call[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
      const options = node.arguments[1]
      let method = 'GET'
      if (options && ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'method') method = '(variable)'
          if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'method') {
            method = ts.isStringLiteralLike(property.initializer) ? property.initializer.text.toUpperCase() : '(variable)'
          }
        }
      } else if (options) {
        method = '(variable)'
      }
      calls.push({
        file,
        urlText: node.arguments[0]?.getText(source) ?? '',
        method,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}

test('every mutating raw fetch under scripts/ is in a file that takes the outbound-write decision (or is the identity token exchange)', () => {
  const all = files(ROOT)
  const calls = all.flatMap(rawFetchCalls)
  const mutating = calls.filter((call) => call.method !== 'GET')
  console.log(`precondition (raw fetch): ${all.length} script files, ${calls.length} raw fetch calls, ${mutating.length} not a literal GET`)
  assert.ok(calls.length >= 8, 'the scan must see the raw fetch calls that exist')
  assert.ok(mutating.some((call) => call.file.endsWith('remove-xero-live-e2e-footprint.ts')), 'and the call that motivated it')

  const unguarded = mutating.filter((call) => {
    if (/XERO_TOKEN_URL/.test(call.urlText)) return false
    return !readFileSync(call.file, 'utf8').includes('outboundWriteRefusal(')
  })
  assert.deepEqual(
    unguarded.map((call) => `${call.file.slice(process.cwd().length + 1)}:${call.line} ${call.method} ${call.urlText}`),
    [],
    'a script that sends a mutating request outside connectorFetch must call outboundWriteRefusal before it',
  )
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
  const source = readFileSync(join(ROOT, 'remove-xero-live-e2e-footprint.ts'), 'utf8')
  const guardAt = source.indexOf('outboundWriteRefusal({')
  const fetchAt = source.indexOf('await fetch(requestUrl')
  assert.ok(guardAt > 0 && fetchAt > guardAt, 'the decision is taken before the raw fetch that sends the write')
})
