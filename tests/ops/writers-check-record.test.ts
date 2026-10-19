import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateWritersCheck, type WritersCheckReport } from '../../lib/ops/writers-check'
import { runWritersCheckRecord } from '../../lib/ops/writers-check-record'
import { WRITERS_CHECK_RECORD_ACTION } from '../../lib/security/writers-check-constants'

function report(settings: Map<string, string> | null): WritersCheckReport {
  return evaluateWritersCheck({
    env: { XERO_WRITE_ALLOWED_TENANT: 'tenant-1', XERO_WRITES_LIVE_FROM: '2026-10-10T00:00:00Z' }, now: new Date('2026-10-20T00:00:00Z'), windowDays: 14,
    settings, cronEnabled: {}, pluginEnabled: { woocommerce: true, mintsoft: true, xero: true },
    evidence: Object.fromEntries(['MINTSOFT_ORDER_ID', 'MINTSOFT_OTHER_META', 'XEROOM_MARKER', 'XERO_FOREIGN_NUMBER'].map((k) => [k, { counted: 0, total: 0, unpaid: 0, floor: 'x' }])),
    evidenceUnrecorded: 0,
  })
}

test('the record is written for every verdict; only ok is a good run', async () => {
  const logged: Array<{ action: string; level?: string }> = []
  const log = async (params: { action: string; level?: string }) => { logged.push(params); return true }
  const ok = await runWritersCheckRecord({ build: async () => report(new Map([['xero_sync_enabled', 'false']])), log: log as never })
  assert.deepEqual([ok.status, ok.verdict, ok.exitCode], ['RECORDED', 'ok', 0])
  const bad = await runWritersCheckRecord({ build: async () => report(new Map([['xero_sync_enabled', 'true']])), log: log as never })
  assert.deepEqual([bad.status, bad.verdict, bad.exitCode], ['FAILED', 'double-claim', 1])
  assert.deepEqual(logged.map((entry) => [entry.action, entry.level]), [[WRITERS_CHECK_RECORD_ACTION, 'INFO'], [WRITERS_CHECK_RECORD_ACTION, 'ERROR']])
})

test('a record that cannot be written, or a check that throws, is a failed run and never a silent one', async () => {
  const unwritable = await runWritersCheckRecord({ build: async () => report(new Map()), log: (async () => false) as never })
  assert.equal(unwritable.status, 'FAILED')
  assert.match(unwritable.reason ?? '', /could not be written/)
  const thrown = await runWritersCheckRecord({ build: async () => { throw new Error('boom: secret-detail') }, log: (async () => true) as never })
  assert.equal(thrown.status, 'FAILED')
  assert.ok(!JSON.stringify(thrown).includes('secret-detail'))
})
