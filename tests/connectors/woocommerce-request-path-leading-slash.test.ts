import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * EVERY WOOCOMMERCE REQUEST PATH STARTS WITH A SLASH.
 *
 * The transport builds its URL as `${storeUrl}/wp-json/wc/v3${path}` (lib/connectors/woocommerce/api.ts), so a path written as
 * `orders/12/notes` becomes `/wp-json/wc/v3orders/12/notes`, a route that does not exist. The caller then sees a 404-class failure
 * that reads like a store problem; the invoice note and the invoice-document marker both did exactly that. This scan reads every
 * call of the four transport functions in lib/ and app/ whose first argument is a string or template literal, and refuses one
 * that does not begin with `/`. A path held in a variable is not literal and is out of its reach.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const CALL = /\bwc(?:Fetch|Post|Put|Delete)\s*\(\s*(`|'|")([^`'"]*)/g

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'generated' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

/** The literal first argument of each transport call in one source, with its line. */
export function literalWcPaths(source: string): Array<{ line: number; literal: string }> {
  const found: Array<{ line: number; literal: string }> = []
  let m: RegExpExecArray | null
  CALL.lastIndex = 0
  while ((m = CALL.exec(source)) !== null) {
    found.push({ line: source.slice(0, m.index).split('\n').length, literal: m[2]! })
  }
  return found
}

test('the scan reads a literal path and tells a bare one from a rooted one', () => {
  assert.deepEqual(literalWcPaths('await wcPost(`orders/${id}/notes`, {})').map((f) => f.literal), ['orders/${id}/notes'])
  assert.deepEqual(literalWcPaths("wcFetch('/orders/1')").map((f) => f.literal), ['/orders/1'])
  assert.deepEqual(literalWcPaths('wcPut(path, body)'), [])
})

test('every literal WooCommerce request path in lib/ and app/ begins with a slash', () => {
  const bare: string[] = []
  let seen = 0
  for (const top of ['lib', 'app']) {
    for (const file of walk(path.join(ROOT, top))) {
      const source = readFileSync(file, 'utf8')
      if (!/\bwc(?:Fetch|Post|Put|Delete)\s*\(/.test(source)) continue
      for (const { line, literal } of literalWcPaths(source)) {
        seen++
        if (!literal.startsWith('/')) bare.push(`${path.relative(ROOT, file)}:${line} ${literal}`)
      }
    }
  }
  assert.ok(seen > 10, `the scan found ${seen} literal paths; it is reading nothing`)
  assert.deepEqual(bare, [], `these paths would be appended to /wp-json/wc/v3 with no slash:\n${bare.join('\n')}`)
})
