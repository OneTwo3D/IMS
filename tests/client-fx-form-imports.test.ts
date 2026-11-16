import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// The PO / sales-order forms are client components. Everything the new FX pieces import must be client-safe: a path
// from them to the database, Prisma's runtime or the server-side lookup breaks the Turbopack client build (it did on #921).
// A 'use server' module is a boundary (the client only gets a reference to it), so it is not followed.

const ROOT = path.resolve(__dirname, '..')
const ENTRIES = ['components/currencies/use-form-fx-rate.ts', 'components/currencies/fx-rate-field.tsx', 'lib/currencies/form-fx-rate.ts']
const FORBIDDEN = [/^@\/lib\/db(\/|$)/, /^@\/lib\/currencies\/(fx-lookup|fx-select|form-fx-rate-server|fx-source-regime|fx-table-lock)$/, /prisma/i, /^pg$/, /^server-only$/]

function resolve(spec: string): string | null {
  if (!spec.startsWith('@/')) return null
  const base = path.join(ROOT, spec.slice(2))
  for (const c of [base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) if (existsSync(c)) return c
  return null
}

function importsOf(src: string): Array<{ spec: string; typeOnly: boolean }> {
  const out: Array<{ spec: string; typeOnly: boolean }> = []
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/g)) out.push({ spec: m[2], typeOnly: !!m[1] })
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) out.push({ spec: m[1], typeOnly: false })
  return out
}

test('the client FX pieces import no server-only module, directly or through a chain', () => {
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
      const next = resolve(spec)
      if (next) queue.push(next)
    }
  }
  assert.ok(seen.size >= ENTRIES.length)
})
