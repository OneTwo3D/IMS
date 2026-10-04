import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { REFUND_TX_OPTIONS } from '@/lib/domain/sales/refund-service'

/**
 * o3d-fpzhm - THE SHARED `REFUND_TX_OPTIONS` OBJECT MUST NEVER BE HANDED TO `$transaction` BY REFERENCE.
 *
 * Prisma's `_transactionWithCallback` stamps `options.newTxId = <outer tx id>` ON THE OBJECT IT IS GIVEN
 * when `$transaction` is called on a transaction client (a nested transaction / savepoint). A Prisma
 * transaction client exposes `$transaction` at runtime, so `runInTransaction(tx, ...)` - which
 * `stageRefundAccountingReversals` calls with the staging transaction - takes that nested path with the
 * module-level constant, which then carries the id of a transaction that has since committed. Every
 * later top-level `$transaction(cb, REFUND_TX_OPTIONS)` is read as "start a transaction nested inside
 * <that id>" and fails with P2028 "A start cannot be executed on a committed transaction" for the rest
 * of the process: refund #2, a WooCommerce replay and an accounting retry all fail.
 *
 * The behaviour itself is proved against a real database in
 * tests/concurrency/refund-relief-never-queued.concurrent.test.ts (several accounted refunds in one
 * process). This file is the cheap, always-on half: the constant is exported unmodified, and the
 * single place that hands it to Prisma passes a COPY. Absence checks, deliberately - a spelling that
 * passes the constant by reference anywhere is the defect, whatever else is also spelled right.
 */

const source = readFileSync(join(process.cwd(), 'lib/domain/sales/refund-service.ts'), 'utf8')

test('[o3d-fpzhm] the exported options carry exactly the two limits and nothing a transaction could have stamped', () => {
  assert.deepEqual(Object.keys(REFUND_TX_OPTIONS).sort(), ['maxWait', 'timeout'])
})

test('[o3d-fpzhm] no $transaction call in refund-service.ts receives REFUND_TX_OPTIONS by reference', () => {
  const sites = [...source.matchAll(/\$transaction\([^;\n]*\)/g)].map((m) => m[0])
  const byReference = sites.filter((site) => /,\s*REFUND_TX_OPTIONS\s*\)/.test(site))
  console.log(`o3d-fpzhm: $transaction call sites inspected: ${sites.length}, passing the shared object by reference: ${byReference.length}`)
  assert.ok(sites.length >= 1, 'PRECONDITION: the scan found the $transaction call site(s) it is about')
  assert.deepEqual(byReference, [], 'a shared options object is stamped with newTxId by Prisma\'s nested-transaction path; pass a copy')
})

test('[o3d-fpzhm] the copy is what is passed (the control: the scan would see a by-reference call)', () => {
  const sites = [...source.matchAll(/\$transaction\([^;\n]*\)/g)].map((m) => m[0])
  assert.ok(sites.some((site) => /\{\s*\.\.\.REFUND_TX_OPTIONS\s*\}/.test(site)), 'runInTransaction passes { ...REFUND_TX_OPTIONS }')
})
