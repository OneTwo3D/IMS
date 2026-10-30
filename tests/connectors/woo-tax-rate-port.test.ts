import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { WooTaxRateFields } from '../../lib/connectors/woocommerce/tax-rate-plan.ts'

/**
 * THE TAX-RATE WRITE PORT: which store call each operation makes, with what body, and how the store's answer is judged. wcPost and wcPut are replaced by recorders (the real ones are the
 * transport with the producer hold's last barrier; nothing here reaches a network).
 */

type Call = { fn: 'wcPost' | 'wcPut'; path: string; body: unknown }
const calls: Call[] = []
let nextAnswer: { data?: unknown; error?: string; held?: true } = { data: {} }

mock.module(new URL('../../lib/connectors/woocommerce/api.ts', import.meta.url).href, {
  namedExports: {
    wcPost: async (path: string, body: unknown) => { calls.push({ fn: 'wcPost', path, body }); return nextAnswer },
    wcPut: async (path: string, body: unknown) => { calls.push({ fn: 'wcPut', path, body }); return nextAnswer },
  },
})

const FIELDS: WooTaxRateFields = { name: 'FR VAT', rate: '20.0000', country: 'FR', state: '', class: 'standard', compound: false, shipping: true }

async function port() {
  const { createWooTaxRateWritePort } = await import('../../lib/connectors/woocommerce/tax-rate-port.ts')
  calls.length = 0
  return createWooTaxRateWritePort()
}

test('create: POST /taxes with exactly the planned fields, and a whole-number id back is the new rate', async () => {
  const p = await port()
  nextAnswer = { data: { id: 77 } }
  assert.deepEqual(await p.create(FIELDS), { ok: true, id: '77' })
  assert.deepEqual(calls, [{ fn: 'wcPost', path: '/taxes', body: FIELDS }])
  for (const data of [{ id: 0 }, { id: -3 }, { id: 'abc' }, { id: 1.5 }, {}, null, [], 'x']) {
    nextAnswer = { data }
    const r = await p.create(FIELDS)
    assert.equal(r.ok, false, JSON.stringify(data))
  }
})

test('update: PUT /taxes/{id} with only the changed fields; an id that is not a whole number is refused before any call', async () => {
  const p = await port()
  nextAnswer = { data: { id: 5, rate: '19.0000' } }
  assert.deepEqual(await p.update('5', { rate: '19.0000' }), { ok: true, id: '5' })
  assert.deepEqual(calls, [{ fn: 'wcPut', path: '/taxes/5', body: { rate: '19.0000' } }])
  calls.length = 0
  for (const id of ['', '0', '5/../orders', '5?force=1', 'abc', '-1', '05']) assert.equal((await p.update(id, { rate: '1' })).ok, false, id)
  assert.deepEqual(calls, [], 'a bad id never reaches the transport')
  nextAnswer = { data: 'not a rate' }
  assert.equal((await p.update('5', { rate: '1' })).ok, false)
})

test('remove: POST /taxes/batch with the one id to delete; only a confirmation naming that id with no error is a deletion', async () => {
  const p = await port()
  nextAnswer = { data: { delete: [{ id: 9 }] } }
  assert.deepEqual(await p.remove('9'), { ok: true, id: '9' })
  assert.deepEqual(calls, [{ fn: 'wcPost', path: '/taxes/batch', body: { delete: [9] } }])
  for (const data of [{ delete: [{ id: 8 }] }, { delete: [{ id: 9, error: { code: 'x', message: 'y' } }] }, { delete: [] }, { delete: [{ id: 9 }, { id: 10 }] }, {}, null]) {
    nextAnswer = { data }
    assert.equal((await p.remove('9')).ok, false, JSON.stringify(data))
  }
  calls.length = 0
  assert.equal((await p.remove('9/../x')).ok, false)
  assert.deepEqual(calls, [])
})

test('a store error or a held transport is reported as a failure, the hold marked as held, and nothing is treated as done', async () => {
  const p = await port()
  nextAnswer = { data: null, error: 'WC API POST error: 400 the class does not exist' }
  assert.deepEqual(await p.create(FIELDS), { ok: false, error: 'WC API POST error: 400 the class does not exist' })
  nextAnswer = { data: null, error: 'held notice', held: true }
  assert.deepEqual(await p.create(FIELDS), { ok: false, error: 'held notice', held: true })
  assert.deepEqual(await p.update('5', { rate: '1' }), { ok: false, error: 'held notice', held: true })
  assert.deepEqual(await p.remove('5'), { ok: false, error: 'held notice', held: true })
})
