import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const SOURCE_DIRS = ['app', 'lib']

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'node_modules') continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      walk(path, files)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(path)
    }
  }
  return files
}

test('SELECT FOR UPDATE row locks use queryRaw, not executeRaw', () => {
  const offenders: string[] = []
  const executeRawSelectTemplates = /\$executeRaw(?:\([^`]*Prisma\.sql)?`SELECT[^`]*`/g

  for (const dir of SOURCE_DIRS) {
    for (const file of walk(dir)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(executeRawSelectTemplates)) {
        if (/\bFOR\s+UPDATE\b/i.test(match[0])) offenders.push(file)
      }
    }
  }

  assert.deepEqual(offenders, [])
})
