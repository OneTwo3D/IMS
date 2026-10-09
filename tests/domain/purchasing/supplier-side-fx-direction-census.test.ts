import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { creditNoteBaseForGate } from '@/lib/domain/purchasing/cancellation-service'

/**
 * SUPPLIER-SIDE EXCHANGE RATES DIVIDE. `fxRateToBase` is foreign units per ONE base unit, so foreign -> base is
 * `foreign / rate`. This census scans the supplier-side (purchasing / AP / returns / landed cost) sources for any
 * expression that multiplies by a rate, and also proves the scan CAN find one (positive control).
 *
 * Sites reviewed and deliberately outside the scan:
 *  - lib/domain/sales/*: SALES side, base -> foreign, so `base * rate` is the correct direction there.
 *  - lib/domain/manufacturing/manufacturing-action-inputs.ts: `amountForeign.mul(fxRate)` on production-order cost
 *    lines has the same shape as the defect; a separate production-order decision (tracked in its own issue).
 */

const MULTIPLIES_BY_RATE = /(\*\s*(Number\()?[\w.?]*[fF]xRate\w*\)?|\.mul\(\s*[\w.?]*[fF]xRate\w*\s*\)|multiplyMoney\([^)]*[fF]xRate\w*)/

function sourceFiles(): string[] {
  const dirs = ['lib/domain/purchasing']
  const files = ['app/actions/purchase-orders.ts']
  for (const dir of dirs) {
    try {
      for (const name of readdirSync(dir)) if (name.endsWith('.ts')) files.push(join(dir, name))
    } catch { /* directory may not exist */ }
  }
  return files
}

test('census positive control: the scan finds a multiplying expression', () => {
  for (const sample of ['x = Number(cn.amountForeign) * Number(cn.fxRateToBase)', 'a.mul(fxRateToBase)', 'multiplyMoney(finalForeign, targetBill.fxRateToBase)', 'amount * fxRate']) {
    assert.match(sample, MULTIPLIES_BY_RATE, sample)
  }
  assert.doesNotMatch('amountForeign.div(fxRate)', MULTIPLIES_BY_RATE)
})

test('census: no supplier-side source multiplies a foreign amount by an exchange rate', () => {
  const files = sourceFiles()
  const offenders: string[] = []
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) return
      if (MULTIPLIES_BY_RATE.test(text)) offenders.push(`${file}:${index + 1}: ${text.trim()}`)
    })
  }
  console.log(`census PRECONDITION: scanned ${files.length} files, offenders=${offenders.length}`)
  assert.ok(files.length >= 5, 'the scan really covered the purchasing sources')
  assert.deepEqual(offenders, [])
})

test('cancellation gate: a legacy credit note whose stored base was multiplied is recomputed by division; an unusable rate falls back to the stored base', () => {
  const legacy = creditNoteBaseForGate({ amountBase: '117.0000', amountForeign: '100.0000', fxRateToBase: '1.17000000' })
  console.log(`gate PRECONDITION: stored base 117.0000, foreign 100, rate 1.17 -> gate uses ${legacy}`)
  assert.equal(legacy, 85.4701)
  assert.equal(creditNoteBaseForGate({ amountBase: '7.5', amountForeign: '10', fxRateToBase: '0' }), 7.5)
})
