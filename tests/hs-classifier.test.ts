import assert from 'node:assert/strict'
import test from 'node:test'
import * as classifierNs from '../lib/trade/hs-classifier.ts'
import * as keywordNs from '../lib/trade/hs-keyword-rules.ts'

const classifier = 'default' in classifierNs
  ? classifierNs.default as typeof import('../lib/trade/hs-classifier.ts')
  : classifierNs
const keywords = 'default' in keywordNs
  ? keywordNs.default as typeof import('../lib/trade/hs-keyword-rules.ts')
  : keywordNs

type Proposal = classifierNs.HsProposal

// A model stub that returns a preset proposal per model id, recording which models were called.
function stubModel(byModel: Record<string, Proposal>, called: string[] = []) {
  const fn: classifierNs.HsModelClassify = async (_input, model) => {
    called.push(model)
    return byModel[model] ?? { cnCode: null, modelConfidence: 0, reasoning: '' }
  }
  return { fn, called }
}

const INPUT = { name: 'NEMA 17 stepper motor', description: 'For a Voron 3D printer' }

test('hsNeedsEscalation: escalate on non-declarable OR low confidence, not otherwise', () => {
  assert.equal(classifier.hsNeedsEscalation({ cnCode: '85011099', modelConfidence: 90, reasoning: '' }, 50), false)
  assert.equal(classifier.hsNeedsEscalation({ cnCode: '99999999', modelConfidence: 90, reasoning: '' }, 50), true) // not in CN list
  assert.equal(classifier.hsNeedsEscalation({ cnCode: '85011099', modelConfidence: 40, reasoning: '' }, 50), true) // low confidence
  assert.equal(classifier.hsNeedsEscalation({ cnCode: '9020', modelConfidence: 90, reasoning: '' }, 50), true) // malformed
})

test('declarable high-confidence default result does not escalate', async () => {
  const { fn, called } = stubModel({
    'claude-sonnet-4-6': { cnCode: '85011099', modelConfidence: 88, reasoning: 'Electric stepper motor.' },
  })
  const result = await classifier.classifyWithEscalation(INPUT, fn)
  assert.equal(result.cnCode, '85011099')
  assert.equal(result.declarable, true)
  assert.equal(result.source, 'ai-default')
  assert.equal(result.escalated, false)
  assert.deepEqual(called, ['claude-sonnet-4-6'])
})

test('non-declarable default result escalates to the stronger model', async () => {
  const { fn, called } = stubModel({
    'claude-sonnet-4-6': { cnCode: '99999999', modelConfidence: 95, reasoning: 'guess' },
    'claude-opus-4-8': { cnCode: '85011099', modelConfidence: 92, reasoning: 'Electric stepper motor.' },
  })
  const result = await classifier.classifyWithEscalation(INPUT, fn)
  assert.equal(result.source, 'ai-escalated')
  assert.equal(result.escalated, true)
  assert.equal(result.cnCode, '85011099')
  assert.equal(result.declarable, true)
  assert.deepEqual(called, ['claude-sonnet-4-6', 'claude-opus-4-8'])
})

test('low-confidence default result escalates even when declarable', async () => {
  const { fn, called } = stubModel({
    'claude-sonnet-4-6': { cnCode: '85011099', modelConfidence: 30, reasoning: 'unsure' },
    'claude-opus-4-8': { cnCode: '85011099', modelConfidence: 85, reasoning: 'Electric stepper motor.' },
  })
  const result = await classifier.classifyWithEscalation(INPUT, fn)
  assert.equal(result.escalated, true)
  assert.deepEqual(called, ['claude-sonnet-4-6', 'claude-opus-4-8'])
})

test('escalation that stays non-declarable reports declarable:false (approval must block)', async () => {
  const { fn } = stubModel({
    'claude-sonnet-4-6': { cnCode: '99999999', modelConfidence: 95, reasoning: 'guess' },
    'claude-opus-4-8': { cnCode: '00000000', modelConfidence: 95, reasoning: 'still wrong' },
  })
  const result = await classifier.classifyWithEscalation(INPUT, fn)
  assert.equal(result.declarable, false)
  assert.equal(result.escalated, true)
})

test('proposed codes are normalised to canonical 8 digits', async () => {
  const { fn } = stubModel({
    'claude-sonnet-4-6': { cnCode: '8501.10.99', modelConfidence: 90, reasoning: 'ok' },
  })
  const result = await classifier.classifyWithEscalation(INPUT, fn)
  assert.equal(result.cnCode, '85011099')
  assert.equal(result.declarable, true)
})

test('keyword fallback classifies known products and defaults unknown ones', () => {
  const motor = classifier.classifyByKeywordFallback({ name: 'NEMA 17 stepper motor' })
  assert.equal(motor.cnCode, '85011099')
  assert.equal(motor.source, 'keyword-fallback')
  assert.equal(motor.declarable, true)
  assert.equal(motor.modelConfidence, 0)

  const unknown = classifier.classifyByKeywordFallback({ name: 'mysterious widget xyz' })
  assert.equal(unknown.cnCode, keywords.KEYWORD_DEFAULT_CODE)
  assert.equal(unknown.declarable, true)
})

test('classifyByKeyword matches the first rule in order (case-insensitive)', () => {
  assert.deepEqual(keywords.classifyByKeyword('PLA Filament spool').cnCode, '39169090')
  assert.equal(keywords.classifyByKeyword('completely unrelated').matched, false)
})

test('overlong code is rejected as non-declarable, not truncated to a valid 8-prefix', async () => {
  // 8501109900 has a valid 8-digit prefix (85011099) but is 10 digits — must NOT be accepted.
  const { fn } = stubModel({
    'claude-sonnet-4-6': { cnCode: '8501109900', modelConfidence: 95, reasoning: 'overlong' },
    'claude-opus-4-8': { cnCode: '8501109900', modelConfidence: 95, reasoning: 'still overlong' },
  })
  const result = await classifier.classifyWithEscalation(INPUT, fn)
  assert.equal(result.declarable, false)
  assert.equal(result.escalated, true) // raw overlong code fails isDeclarableCn8 -> escalates
  assert.equal(result.cnCode, '8501109900') // full digits preserved, not silently truncated
})

test('a model pass that throws propagates (so classifyHsCode can fall back)', async () => {
  const throwing: classifierNs.HsModelClassify = async () => {
    throw new Error('refusal / no usable code')
  }
  await assert.rejects(() => classifier.classifyWithEscalation(INPUT, throwing))
})

test('classifyHsCode falls back to keyword rules when ANTHROPIC_API_KEY is unset', async () => {
  const saved = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    const result = await classifier.classifyHsCode({ name: 'NEMA 17 stepper motor' })
    assert.equal(result.source, 'keyword-fallback')
    assert.equal(result.cnCode, '85011099')
    assert.equal(result.declarable, true)
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
  }
})
