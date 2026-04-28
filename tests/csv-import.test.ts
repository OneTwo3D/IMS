import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCsvImportPreviewResult,
  getCsvImportMode,
  runCsvImportMutation,
} from '../lib/csv-import.ts'

test('csv import dry-run result exposes the standardized preview shape', () => {
  const result = createCsvImportPreviewResult({
    totalRows: 5,
    created: 2,
    updated: 1,
    errorCount: 2,
    warnings: ['Row 3: optional field ignored'],
    errors: ['Row 4: missing name', 'Row 5: duplicate key'],
  })

  assert.deepEqual(result, {
    preview: true,
    dryRun: true,
    validRows: 3,
    invalidRows: 2,
    warnings: ['Row 3: optional field ignored'],
    errors: ['Row 4: missing name', 'Row 5: duplicate key'],
    proposedChanges: {
      created: 2,
      updated: 1,
      skipped: 2,
    },
    error: undefined,
  })
})

test('csv import mode accepts dry-run aliases', () => {
  const previewForm = new FormData()
  previewForm.set('mode', 'preview')

  const dryRunForm = new FormData()
  dryRunForm.set('mode', 'dry-run')

  const dryRunFlagForm = new FormData()
  dryRunFlagForm.set('dryRun', 'true')

  assert.equal(getCsvImportMode(previewForm), 'preview')
  assert.equal(getCsvImportMode(dryRunForm), 'preview')
  assert.equal(getCsvImportMode(dryRunFlagForm), 'preview')
})

test('csv import mode honors explicit execute over stale dry-run flag', () => {
  const form = new FormData()
  form.set('mode', 'execute')
  form.set('dryRun', 'true')

  assert.equal(getCsvImportMode(form), 'execute')
})

test('csv import mutation guard does not call mutations during dry run', async () => {
  let calls = 0

  const dryRunResult = await runCsvImportMutation('preview', async () => {
    calls++
    return 'mutated'
  })
  const executeResult = await runCsvImportMutation('execute', async () => {
    calls++
    return 'mutated'
  })

  assert.equal(dryRunResult, null)
  assert.equal(executeResult, 'mutated')
  assert.equal(calls, 1)
})
