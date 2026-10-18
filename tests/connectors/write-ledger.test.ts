import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createWriteLedger, noteRemoteWriteDispatched, runInWriteLedger } from '../../lib/security/write-ledger.ts'

/**
 * THE WRITE LEDGER: what proves a claim sent nothing. Named mutations (each shown red in the PR): k2 the transport stops counting; k3 a read counts;
 * k4 the ledger does not follow the async context.
 */
test('writes are counted, reads are not, and the count follows the async context of the attempt only', async () => {
  const ledger = createWriteLedger()
  const other = createWriteLedger()
  await runInWriteLedger(ledger, async () => {
    noteRemoteWriteDispatched('GET')
    noteRemoteWriteDispatched('head')
    noteRemoteWriteDispatched('PUT')
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 1))
    noteRemoteWriteDispatched('post')
    await runInWriteLedger(other, async () => { noteRemoteWriteDispatched('DELETE') })
  })
  noteRemoteWriteDispatched('PUT')           // outside any ledger: a no-op
  assert.equal(ledger.writes, 2)
  assert.equal(other.writes, 1)
  assert.equal(createWriteLedger().writes, 0)
})

test('the transport counts a write immediately before it dispatches, and the drains give the outbox the proof (structural)', () => {
  const fetchSrc = readFileSync('lib/security/connector-fetch.ts', 'utf8')
  const note = fetchSrc.indexOf('noteRemoteWriteDispatched(method)')
  const send = fetchSrc.indexOf('await sendConnectorRequest(url, method')
  assert.ok(note > 0 && send > note, 'counted before the dispatch')
  for (const file of ['stock-sync-jobs.ts', 'order-completion-jobs.ts', 'order-status-jobs.ts']) {
    const src = readFileSync(`lib/connectors/woocommerce/sync/${file}`, 'utf8')
    assert.ok(src.includes('createWriteLedger()') && src.includes('runInWriteLedger(ledger') && src.includes('noWriteSent: ledger.writes === 0'), `${file} runs the attempt in a ledger and passes the proof`)
  }
  const outbox = readFileSync('lib/domain/integrations/outbox.ts', 'utf8')
  assert.ok(outbox.includes('options.noWriteSent === true'), 'the hold branch withdraws the stamp only on the proof')
})
