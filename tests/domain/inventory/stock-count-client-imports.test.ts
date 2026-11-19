import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// The stock counts page is a client component. Everything it imports, value imports through any chain, must be client-safe: a path to the
// database, Prisma's runtime (lib/domain/math/decimal pulls it in) or a node:* module breaks the Turbopack client build ("the chunking context does
// not support external modules (request: node:module)"; it did on #981). A 'use server' module is a boundary (the client only gets a reference),
// so it is not followed. Type-only imports are erased and not followed.

const ROOT = path.resolve(__dirname, '../../..')
const ENTRIES = [
  'app/(dashboard)/stock-control/stock-counts/stock-counts-client.tsx',
  'app/(dashboard)/stock-control/stock-counts/product-picker-dialog.tsx',
  'lib/domain/inventory/stock-count-triage.ts',
  'lib/domain/inventory/stock-count-plan.ts',
]
const FORBIDDEN = [
  /^@\/lib\/db(\/|$)/, /prisma/i, /^pg$/, /^server-only$/, /^node:/, /^(fs|path|crypto|module|child_process)$/,
  /^@\/lib\/domain\/math\/decimal$/, /^@\/lib\/settings-store$/, /^@\/lib\/auth(\/|$)/, /^@\/lib\/activity-log$/,
]

function resolve(fromFile: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(ROOT, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(fromFile), spec) : null
  if (!base) return null
  for (const c of [base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) if (existsSync(c)) return c
  return null
}

function importsOf(src: string): Array<{ spec: string; typeOnly: boolean }> {
  const out: Array<{ spec: string; typeOnly: boolean }> = []
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/g)) out.push({ spec: m[2]!, typeOnly: !!m[1] })
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) out.push({ spec: m[1]!, typeOnly: false })
  return out
}

test('the stock counts client pieces import no server-only module, directly or through a chain', () => {
  const seen = new Set<string>()
  const queue = ENTRIES.map((e) => path.join(ROOT, e))
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const src = readFileSync(file, 'utf8')
    if (/^\s*['"]use server['"]/.test(src)) continue
    for (const { spec, typeOnly } of importsOf(src)) {
      if (typeOnly) continue
      for (const f of FORBIDDEN) assert.ok(!f.test(spec), `${path.relative(ROOT, file)} imports ${spec}`)
      const next = resolve(file, spec)
      if (next) queue.push(next)
    }
  }
  assert.ok(seen.size >= ENTRIES.length)
})
