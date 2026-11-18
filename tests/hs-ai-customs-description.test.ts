import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAnthropicClassify,
  classifyByKeywordFallback,
  classifyWithEscalation,
  type HsModelClassify,
  type HsProposal,
} from '@/lib/trade/hs-classifier'
import {
  CUSTOMS_DESCRIPTION_MAX,
  isUnusableCustomsDescription,
  resolveProposedCustomsDescription,
} from '@/lib/trade/customs-description'

const INPUT = { name: 'NEMA 17 stepper motor', description: 'For a Voron 3D printer' }

function fakeClient(payload: Record<string, unknown>) {
  const calls: unknown[] = []
  const client = {
    messages: {
      create: async (args: unknown) => {
        calls.push(args)
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] }
      },
    },
  }
  return { client: client as never, calls }
}

const stub = (byModel: Record<string, HsProposal>): HsModelClassify => async (_i, model) => byModel[model]

test('schema requests customs_description and the prompt states the rules (no network: fake client)', async () => {
  const { client, calls } = fakeClient({ cn_code: '85011099', confidence: 90, reasoning: 'r', customs_description: 'electric stepper motor' })
  const result = await buildAnthropicClassify(client)(INPUT, 'm', { thinking: false })
  assert.equal(result.customsDescription, 'electric stepper motor')
  const args = calls[0] as { system: string; output_config: { format: { schema: { required: string[]; properties: Record<string, unknown> } } } }
  assert.ok(args.output_config.format.schema.required.includes('customs_description'))
  assert.ok('customs_description' in args.output_config.format.schema.properties)
  assert.match(args.system, /article \+ key attribute/)
  assert.match(args.system, /35 characters/)
})

test('parse without the field tolerated (null)', async () => {
  const { client } = fakeClient({ cn_code: '85011099', confidence: 90, reasoning: 'r' })
  const result = await buildAnthropicClassify(client)(INPUT, 'm', { thinking: false })
  assert.equal(result.customsDescription, null)
})

test('parse clamps an over-long model description to 35 chars', async () => {
  const long = 'precision brass nozzle for high temperature 3D printer hotend extruder assembly'
  const { client } = fakeClient({ cn_code: '85011099', confidence: 90, reasoning: 'r', customs_description: long })
  const result = await buildAnthropicClassify(client)(INPUT, 'm', { thinking: false })
  assert.ok((result.customsDescription ?? '').length <= CUSTOMS_DESCRIPTION_MAX)
  assert.ok(long.startsWith(result.customsDescription ?? 'x'))
})

test('pipeline keeps a good AI description', async () => {
  const r = await classifyWithEscalation(INPUT, stub({
    'claude-sonnet-4-6': { cnCode: '85011099', modelConfidence: 90, reasoning: '', customsDescription: 'stepper motor, NEMA 17' },
  }))
  assert.equal(r.customsDescription, 'stepper motor, NEMA 17')
})

test('brand-only / stop-word-only / blank output is rejected and falls back to the keyword rule', async () => {
  for (const bad of ['Voron', 'parts', 'accessories for the', '', null, undefined]) {
    const r = await classifyWithEscalation({ name: 'Voron stepper motor' }, stub({
      'claude-sonnet-4-6': { cnCode: '85011099', modelConfidence: 90, reasoning: '', customsDescription: bad },
    }))
    assert.equal(r.customsDescription, 'electric stepper motor', `input ${String(bad)}`)
  }
})

test('rejected AI description with no keyword match yields null (never brand-only)', async () => {
  const r = await classifyWithEscalation({ name: 'Zzyzx widget' }, stub({
    'claude-sonnet-4-6': { cnCode: '85011099', modelConfidence: 90, reasoning: '', customsDescription: 'Zzyzx' },
  }))
  assert.equal(r.customsDescription, null)
})

test('isUnusableCustomsDescription', () => {
  assert.equal(isUnusableCustomsDescription('Voron', 'Voron stepper motor'), true)
  assert.equal(isUnusableCustomsDescription('Parts', 'x y'), true)
  assert.equal(isUnusableCustomsDescription('brass nozzle', 'Voron brass nozzle'), false)
})

test('escalation path: description comes from the escalated pass', async () => {
  const called: string[] = []
  const fn: HsModelClassify = async (_i, model) => {
    called.push(model)
    return model === 'claude-sonnet-4-6'
      ? { cnCode: '99999999', modelConfidence: 90, reasoning: '', customsDescription: 'weak guess' }
      : { cnCode: '85011099', modelConfidence: 92, reasoning: '', customsDescription: 'electric stepper motor, NEMA 17' }
  }
  const r = await classifyWithEscalation(INPUT, fn)
  assert.equal(r.escalated, true)
  assert.equal(r.customsDescription, 'electric stepper motor, NEMA 17')
  assert.equal(called.length, 2)
})

test('keyword fallback carries the rule description; unmatched gives null', () => {
  assert.equal(classifyByKeywordFallback({ name: 'Cooling fan 5015' }).customsDescription, 'cooling fan for 3D printer')
  assert.equal(classifyByKeywordFallback({ name: 'Zzyzx widget' }).customsDescription, null)
})

test('resolveProposedCustomsDescription: existing operator/Woo value is never overwritten', () => {
  assert.equal(resolveProposedCustomsDescription('operator text', 'AI text'), 'operator text')
  assert.equal(resolveProposedCustomsDescription(null, 'AI text'), 'AI text')
  assert.equal(resolveProposedCustomsDescription('  ', 'AI text'), 'AI text')
  assert.equal(resolveProposedCustomsDescription(null, null), null)
})

// ---- proposal record (db + classifier mocked) ----
type Row = Record<string, unknown>
const state: { product: Row; created: Row | null } = { product: {}, created: null }

mock.module('@/lib/db', {
  namedExports: {
    db: {
      product: { findUnique: async () => state.product },
      hsCodeProposal: {
        findFirst: async () => null,
        create: async ({ data }: { data: Row }) => {
          state.created = data
          return data
        },
      },
    },
  },
})
mock.module('@/lib/trade/hs-classifier', {
  namedExports: {
    classifyHsCode: async () => ({
      cnCode: '85011099', declarable: true, source: 'ai-default', modelConfidence: 90, reasoning: 'r',
      escalated: false, customsDescription: 'electric stepper motor',
    }),
  },
})

async function propose(customsDescription: string | null) {
  state.product = {
    id: 'p1', name: 'Stepper motor', description: null, customsDescription,
    type: 'SIMPLE', lifecycleStatus: 'ACTIVE', category: null,
  }
  state.created = null
  const { upsertHsCodeProposal } = await import('@/lib/trade/hs-proposal-service')
  await upsertHsCodeProposal('p1')
  return state.created as Row | null
}

test('proposal record carries the AI description when the product has none', async () => {
  const rec = await propose(null)
  assert.equal(rec?.proposedCustomsDescription, 'electric stepper motor')
})

test('proposal record keeps an operator-set description over the AI one', async () => {
  const rec = await propose('operator motor')
  assert.equal(rec?.proposedCustomsDescription, 'operator motor')
})
