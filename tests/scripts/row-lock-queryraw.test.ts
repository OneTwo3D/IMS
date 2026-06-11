import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const SOURCE_DIRS = ['app', 'lib']

function executeRawRowLockOffenders(source: string): string[] {
  const offenders: string[] = []
  const executeRawSelectTemplates = /\$executeRaw(?:\([^`]*Prisma\.sql)?`\s*SELECT[^`]*\bFOR\s+UPDATE\b[^`]*`/gi
  const executeRawUnsafeSelectCalls = /\$executeRawUnsafe\s*\(\s*(?:"[^"]*?\bSELECT\b[^"]*?\bFOR\s+UPDATE\b[^"]*"|'[^']*?\bSELECT\b[^']*?\bFOR\s+UPDATE\b[^']*'|`[^`]*?\bSELECT\b[^`]*?\bFOR\s+UPDATE\b[^`]*`)/gi
  const prismaSqlRowLockAssignments = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Prisma\.sql`\s*SELECT[^`]*\bFOR\s+UPDATE\b[^`]*`/gi

  for (const match of source.matchAll(executeRawSelectTemplates)) offenders.push(match[0])
  for (const match of source.matchAll(executeRawUnsafeSelectCalls)) offenders.push(match[0])
  for (const match of source.matchAll(prismaSqlRowLockAssignments)) {
    const variableName = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const executeRawVariableCall = new RegExp(`\\$executeRaw\\s*\\(\\s*${variableName}\\s*\\)`)
    if (executeRawVariableCall.test(source)) offenders.push(match[0])
  }

  return offenders
}

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

  for (const dir of SOURCE_DIRS) {
    for (const file of walk(dir)) {
      const source = readFileSync(file, 'utf8')
      if (executeRawRowLockOffenders(source).length > 0) offenders.push(file)
    }
  }

  assert.deepEqual(offenders, [])
})

test('row-lock executeRaw guard catches known bypass shapes', () => {
  assert.equal(
    executeRawRowLockOffenders('await tx.$executeRaw`select id from products where id = ${id} for update`').length,
    1,
  )
  assert.equal(
    executeRawRowLockOffenders('await tx.$executeRawUnsafe("SELECT id FROM products WHERE id = $1 FOR UPDATE", id)').length,
    1,
  )
  assert.equal(
    executeRawRowLockOffenders('const lock = Prisma.sql`SELECT id FROM products WHERE id = ${id} FOR UPDATE`; await tx.$executeRaw(lock)').length,
    1,
  )
  assert.equal(
    executeRawRowLockOffenders('await tx.$queryRaw`SELECT id FROM products WHERE id = ${id} FOR UPDATE`').length,
    0,
  )
  assert.equal(
    executeRawRowLockOffenders('await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`').length,
    0,
  )
})
