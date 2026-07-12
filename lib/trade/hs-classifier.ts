/**
 * AI HS/CN-code classifier service (6igm.1) — IMS-native port of the hs-code-woo classifier.
 *
 * Given a product's name / description / category, propose an 8-digit 2026 EU CN code. A cheap
 * workhorse model (Claude Sonnet 4.6) runs first; ambiguous or non-declarable results escalate
 * to a stronger model (Claude Opus 4.8). When the Claude tier is unavailable (no API key, or an
 * API error), a deterministic keyword fallback (hs-keyword-rules) keeps the product classified.
 *
 * This module only *proposes* a code and validates it against the 2026 CN list (bhdm.3). It does
 * not persist anything or gate a write — confidence banding/flags (6igm.2) and the human approval
 * queue (6igm.3) build on top of it. Proposed codes are never authoritative until approved.
 */
import Anthropic from '@anthropic-ai/sdk'
import { isDeclarableCn8, normalizeCn8 } from '@/lib/trade/cn-validate'
import { classifyByKeyword } from '@/lib/trade/hs-keyword-rules'

// Models: cheap workhorse first, escalate to the stronger model on ambiguity (matches plugin).
export const HS_CLASSIFIER_DEFAULT_MODEL = 'claude-sonnet-4-6'
export const HS_CLASSIFIER_ESCALATE_MODEL = 'claude-opus-4-8'
// Below this self-reported confidence (0-100) we escalate to the stronger model.
export const HS_MODEL_CONFIDENCE_THRESHOLD = 50

export type HsClassifierInput = {
  name: string
  description?: string | null
  categoryPath?: string | null
}

/** One model pass: a proposed code plus the model's own confidence and rationale. */
export type HsProposal = {
  cnCode: string | null
  modelConfidence: number
  reasoning: string
}

export type HsClassificationSource = 'ai-default' | 'ai-escalated' | 'keyword-fallback'

export type HsClassification = {
  /** Proposed CN8 (digits only) or null if the model returned nothing usable. */
  cnCode: string | null
  /** True iff cnCode is a declarable 2026 CN8 (isDeclarableCn8). A false here must block an approval. */
  declarable: boolean
  source: HsClassificationSource
  modelConfidence: number
  reasoning: string
  escalated: boolean
}

/** A single model pass — injectable so the escalation pipeline is testable without the API. */
export type HsModelClassify = (
  input: HsClassifierInput,
  model: string,
  opts: { thinking: boolean },
) => Promise<HsProposal>

export type ClassifyOptions = {
  defaultModel?: string
  escalateModel?: string
  confidenceThreshold?: number
}

/** Escalate only when the default model's proposal is non-declarable or low-confidence. */
export function hsNeedsEscalation(proposal: HsProposal, confidenceThreshold: number): boolean {
  return !isDeclarableCn8(proposal.cnCode) || proposal.modelConfidence < confidenceThreshold
}

/**
 * Pure classify → (escalate) pipeline. `modelClassify` performs one model pass; injecting it
 * keeps this logic unit-testable offline. Returns the finalised classification with the code
 * normalised to canonical 8 digits and validated against the 2026 CN list.
 */
export async function classifyWithEscalation(
  input: HsClassifierInput,
  modelClassify: HsModelClassify,
  opts: ClassifyOptions = {},
): Promise<HsClassification> {
  const defaultModel = opts.defaultModel ?? HS_CLASSIFIER_DEFAULT_MODEL
  const escalateModel = opts.escalateModel ?? HS_CLASSIFIER_ESCALATE_MODEL
  const threshold = opts.confidenceThreshold ?? HS_MODEL_CONFIDENCE_THRESHOLD

  let proposal = await modelClassify(input, defaultModel, { thinking: false })
  let source: HsClassificationSource = 'ai-default'
  let escalated = false

  if (hsNeedsEscalation(proposal, threshold)) {
    // Hard case: re-run on the stronger model with adaptive thinking.
    proposal = await modelClassify(input, escalateModel, { thinking: true })
    source = 'ai-escalated'
    escalated = true
  }

  // Declarability is judged on the RAW proposal (isDeclarableCn8 enforces EXACTLY 8 digits),
  // so an overlong code like "8501109900" is rejected rather than silently truncated to a valid
  // 8-prefix. A declarable code is stored canonicalised; a non-declarable one keeps its full
  // digits so the operator sees the real value in the approval queue (6igm.3).
  const declarable = isDeclarableCn8(proposal.cnCode)
  const cnCode = proposal.cnCode
    ? declarable
      ? normalizeCn8(proposal.cnCode)
      : proposal.cnCode.replace(/\D+/g, '') || null
    : null
  return {
    cnCode,
    declarable,
    source,
    modelConfidence: proposal.modelConfidence,
    reasoning: proposal.reasoning,
    escalated,
  }
}

/** Deterministic keyword classification, used when the Claude tier is unavailable. */
export function classifyByKeywordFallback(input: HsClassifierInput): HsClassification {
  const text = [input.name, input.description, input.categoryPath].filter(Boolean).join(' ')
  const match = classifyByKeyword(text)
  const cnCode = normalizeCn8(match.cnCode) || null
  return {
    cnCode,
    declarable: isDeclarableCn8(cnCode),
    source: 'keyword-fallback',
    // Deterministic rules carry no model confidence; the validator (6igm.2) scores these.
    modelConfidence: 0,
    reasoning: match.matched
      ? `Keyword rule matched: ${match.customsDescription}`
      : 'No keyword match; defaulted to generic 3D-printer component code',
    escalated: false,
  }
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cn_code: { type: 'string', description: 'The 8-digit 2026 EU CN (Combined Nomenclature) code, digits only.' },
    confidence: { type: 'integer', description: 'Your confidence in the code, 0-100.' },
    reasoning: { type: 'string', description: 'One or two sentences justifying the code.' },
  },
  required: ['cn_code', 'confidence', 'reasoning'],
} as const

const SYSTEM_PROMPT =
  'You are a customs classification specialist. Given a product, return its 2026 EU Combined ' +
  'Nomenclature (CN) code as exactly 8 digits, with a short justification and a 0-100 confidence. ' +
  'Classify by the essential character and material of the goods, not the brand or marketing copy. ' +
  'If you are unsure, give your best code and a lower confidence rather than refusing.'

function buildAnthropicClassify(client: Anthropic): HsModelClassify {
  return async (input, model, { thinking }) => {
    const userText = [
      `Name: ${input.name}`,
      input.description ? `Description: ${input.description}` : null,
      input.categoryPath ? `Category: ${input.categoryPath}` : null,
    ]
      .filter(Boolean)
      .join('\n')

    const response = await client.messages.create({
      model,
      // Thinking tokens count against max_tokens, so give the escalation (thinking) pass more
      // headroom for the reasoning plus the schema JSON; keep the workhorse pass lean.
      max_tokens: thinking ? 4096 : 1024,
      system: SYSTEM_PROMPT,
      ...(thinking ? { thinking: { type: 'adaptive' as const } } : {}),
      output_config: { format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
      messages: [{ role: 'user', content: userText }],
    })

    // A refused or truncated response yields no usable code — throw so classifyHsCode falls back
    // to the deterministic keyword rules rather than returning an empty classification.
    if (response.stop_reason === 'refusal') {
      throw new Error(`HS classifier: ${model} refused to classify`)
    }
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
    if (!textBlock?.text) {
      throw new Error(`HS classifier: ${model} returned no text (stop_reason=${response.stop_reason})`)
    }
    const parsed = JSON.parse(textBlock.text) as {
      cn_code?: unknown
      confidence?: unknown
      reasoning?: unknown
    }
    if (typeof parsed.cn_code !== 'string' || parsed.cn_code.trim() === '') {
      throw new Error(`HS classifier: ${model} returned no cn_code`)
    }
    const rawConfidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
    return {
      cnCode: parsed.cn_code,
      modelConfidence: Math.max(0, Math.min(100, Math.round(rawConfidence))),
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    }
  }
}

/**
 * Classify a product's HS/CN code. Uses Claude (Sonnet → Opus escalation) when ANTHROPIC_API_KEY
 * is configured and reachable; otherwise (or on any API error) falls back to deterministic keyword
 * rules so classification never hard-fails. The returned code is validated but NOT authoritative —
 * route it through the approval gate (6igm.3) before writing it to the product.
 */
export async function classifyHsCode(
  input: HsClassifierInput,
  opts: ClassifyOptions = {},
): Promise<HsClassification> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return classifyByKeywordFallback(input)
  }
  try {
    const client = new Anthropic({ apiKey })
    return await classifyWithEscalation(input, buildAnthropicClassify(client), opts)
  } catch (error) {
    // Config errors (bad key, wrong model id, malformed request) are not transient — falling back
    // silently would let production run permanently on keyword rules. Surface a signal, then still
    // fall back so classification never hard-fails. Transient errors (429/5xx/network) fall back quietly.
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError ||
      error instanceof Anthropic.NotFoundError ||
      error instanceof Anthropic.BadRequestError
    ) {
      // eslint-disable-next-line no-console
      console.error('[hs-classifier] Anthropic config error; using keyword fallback:', error.message)
    }
    return classifyByKeywordFallback(input)
  }
}
