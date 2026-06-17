import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Regression guard for onetwo3d-ims-l88l: every PRODUCTION_OUT movement must be
// accompanied by cogs_entries, or the DB outbound evidence guard
// (stock_movements_reporting_evidence_guard) rejects it at commit and the
// manufacturing order can't complete/disassemble. There's no lightweight way to
// exercise the full transaction + DB trigger here, so assert at the source level
// that each PRODUCTION_OUT writer pairs the movement with COGS evidence built
// from the consumed FIFO layers.
test('every manufacturing PRODUCTION_OUT writer creates COGS evidence', () => {
  const source = readFileSync('app/actions/manufacturing.ts', 'utf8')

  const productionOutWriters = source.match(/type:\s*['"]PRODUCTION_OUT['"]/g) ?? []
  const cogsEvidence = source.match(/cogsEntryDataFromConsumed\(/g) ?? []

  assert.ok(productionOutWriters.length >= 2, 'expected at least the assembly + disassembly PRODUCTION_OUT writers')
  assert.equal(
    cogsEvidence.length,
    productionOutWriters.length,
    'each PRODUCTION_OUT writer must map its consumed FIFO layers to cogs_entries via cogsEntryDataFromConsumed',
  )
  assert.match(source, /tx\.cogsEntry\.createMany/, 'PRODUCTION_OUT writers must persist cogs_entries')
})
