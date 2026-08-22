import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * o3d-0o3y (Codex review of PR #612). The Fulfillable 3PL site moved us from EAR2 (Earith) to MIL1
 * (Mildenhall), Mintsoft warehouse id 5 to 6. Two places still advertised the retired code as a
 * current one: the document-preview sample data (fixed in #612 but with nothing pinning it) and the
 * Prisma schema's warehouse-code comment.
 *
 * The sibling PR in the label-sync repo was framed the same way — the cosmetic tail of this same
 * warehouse move — and turned out to sit on a live defect where the warehouse id never reached the
 * Mintsoft client. This repo was checked for that class and has none; what remains is stale text
 * that reads as fact, so it is pinned as text.
 */

test('the document-preview sample warehouse names the LIVE site, not the retired EAR2', async () => {
  const route = await readFile('app/api/preview/document/route.ts', 'utf8')

  assert.match(route, /Warehouse: Main Warehouse \(MIL1\)/, 'the manufacturing-order sample must show the live code')
  assert.doesNotMatch(route, /EAR2/, 'the retired Earith code must not reappear in preview sample data')
})

test('the Prisma warehouse-code comment does not advertise EAR2 as a current code', async () => {
  const schema = await readFile('prisma/schema.prisma', 'utf8')

  const match = /^\s*code\s+String\s+@unique\s*\/\/(.*)$/m.exec(schema)
  assert.ok(match, 'Warehouse.code must keep its example-codes comment')
  const comment = match[1]

  assert.match(comment, /MIL1/, 'the examples must name the live site')
  assert.ok(
    !/EAR2/.test(comment) || /EAR2[\s\S]*retired/.test(comment),
    'EAR2 may only appear marked as retired — an unqualified example reads as a current warehouse code',
  )
})

test('the migration comment KEEPS EAR2 as the historical record of what it did', async () => {
  // Deliberately distinguished from the two above: a migration describes the database as it was at
  // the time, so rewriting its comment would falsify the record rather than correct it.
  const migration = await readFile(
    'prisma/migrations/20260413180000_fix_manual_order_provenance/migration.sql',
    'utf8',
  )

  assert.match(migration, /EAR2 was accidentally marked isDefault=true/)
})
