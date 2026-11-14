import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// pg_advisory_*lock* returns void; Prisma's $queryRaw cannot deserialize a void column and throws at
// runtime ("Failed to deserialize column of type 'void'"). Unit tests that mock $queryRaw never see it,
// so pin the rule at the source: every advisory-lock call goes through $executeRaw.
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'generated' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(p)
  }
  return out
}

test('no pg_advisory lock is taken through $queryRaw (it returns void)', () => {
  const offenders: string[] = []
  for (const root of ['lib', 'app', 'scripts']) {
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8')
      const re = /\$queryRaw(?:Unsafe)?\s*(?:`|\()\s*SELECT\s+pg_advisory_(?:xact_)?lock/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`)
    }
  }
  assert.deepEqual(offenders, [], 'use $executeRaw for pg_advisory_*lock calls')
})
