import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SourceScanTooLargeError,
  assertSourceLimit,
  isSourceScanTooLargeError,
  sourceScanTooLargeMessage,
} from '@/lib/security/source-scan-error'

test('source scan limit helper throws a typed error with operator guidance', () => {
  assert.throws(
    () => assertSourceLimit(101, 100, 'Analytics source rows'),
    (error: unknown) => {
      assert.equal(isSourceScanTooLargeError(error), true)
      assert.equal(error instanceof SourceScanTooLargeError, true)
      assert.equal((error as SourceScanTooLargeError).limit, 100)
      assert.equal((error as SourceScanTooLargeError).rowCount, 101)
      assert.equal(sourceScanTooLargeMessage(error as SourceScanTooLargeError), 'Analytics source rows exceed 100; Narrow the filters and retry.')
      return true
    },
  )
})

test('source scan limit helper accepts rows at the boundary', () => {
  assert.doesNotThrow(() => assertSourceLimit(100, 100, 'Analytics source rows'))
})
