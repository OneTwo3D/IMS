import { deserializeSettingValue, getSettingValue } from '@/lib/settings-store'
import { logActivityInTransaction } from '@/lib/activity-log'
import { hasPermission, type Permission } from '@/lib/permissions'
import { computeLineMargin } from '@/lib/domain/purchasing/line-margin'
import { loadListPriceFacts, type ListPriceFacts, type ListPriceFactsClient } from '@/lib/domain/purchasing/list-price-facts'
import type { DecimalInput } from '@/lib/domain/math/decimal'
import { MARGIN_BLOCK_ERROR_PREFIX } from '@/lib/domain/purchasing/margin-threshold-constants'
import {
  MARGIN_THRESHOLD_SETTING_KEY,
  assessLineAgainstMinimum,
  decideThreshold,
  hasAnyMarginThreshold,
  parseMarginThresholdSettings,
  resolveMinimumMarginPct,
  type LineThresholdAssessment,
  type MarginThresholdSettings,
  type ThresholdDecision,
} from '@/lib/domain/purchasing/margin-threshold'

/**
 * SERVER-SIDE ENFORCEMENT of the PO minimum gross margin (o3d-hqvrp.380). INTERNAL ONLY.
 *
 * The client's preview is advice; this is the gate. It recomputes every line's margin from what the
 * SERVER is about to store (the stored net unit cost in base currency) against the product's own list
 * price, so nothing the browser sends can make a line look better than it is.
 *
 * Two phases, so no read runs on the pooled client from inside a transaction:
 *   1. `loadMarginGuardContext(productIds)` before the transaction: the setting and the price facts.
 *      It returns null when no threshold is configured, and then nothing below does anything.
 *   2. `assessGuardLines` / `decideGuard` / `recordMarginOverride`: pure, or on the caller's `tx`.
 */

export type MarginGuardContext = {
  settings: MarginThresholdSettings
  facts: Map<string, ListPriceFacts>
}

export async function loadMarginGuardContext(productIds: readonly string[]): Promise<MarginGuardContext | null> {
  const settings = parseMarginThresholdSettings(await getSettingValue(MARGIN_THRESHOLD_SETTING_KEY))
  if (!hasAnyMarginThreshold(settings)) return null
  return { settings, facts: await loadListPriceFacts(productIds) }
}

type ReloadClient = ListPriceFactsClient & {
  setting: { findUnique: (args: { where: { key: string }; select: { value: true } }) => Promise<{ value: string } | null> }
}

/**
 * Read the threshold setting and the line products' price facts THROUGH THE TRANSACTION, after the caller has taken the PO row lock,
 * so the decision is made on values committed at that moment: the setting, the list price and its VAT-inclusive flag, the category
 * chain, the product's tax category, the company country and the tax-rate rows the sales VAT rate comes from. Nothing is carried over from
 * a read made before the lock. Null when no threshold is set now (the setting is read first, so a removed threshold never costs a refusal).
 */
export async function loadMarginGuardContextUnderLock(
  tx: ReloadClient,
  productIds: readonly string[],
): Promise<MarginGuardContext | null> {
  const row = await tx.setting.findUnique({ where: { key: MARGIN_THRESHOLD_SETTING_KEY }, select: { value: true } })
  const settings = parseMarginThresholdSettings(row ? deserializeSettingValue(MARGIN_THRESHOLD_SETTING_KEY, row.value) : null)
  if (!hasAnyMarginThreshold(settings)) return null
  return { settings, facts: await loadListPriceFacts(productIds, tx) }
}

export type GuardLine = {
  productId: string
  /** The server's net unit cost per STOCK unit in base currency (post-discount, ex-VAT), as stored. */
  unitCostBase: DecimalInput
}

export type GuardLineAssessment = LineThresholdAssessment & { productId: string; sku: string }

export function assessGuardLines(ctx: MarginGuardContext, lines: readonly GuardLine[]): GuardLineAssessment[] {
  return lines.map((line) => {
    const f = ctx.facts.get(line.productId)
    if (!f) {
      // A product with no facts has no price to compare with: unknown, never blocked.
      return { productId: line.productId, sku: line.productId, state: 'unknown' as const, minPct: null, source: null, marginPct: null }
    }
    const margin = computeLineMargin({
      qty: 1,
      unitCost: line.unitCostBase,
      discount: '',
      purchaseUnitFactor: 1,
      taxRate: 0,
      pricesIncludeVat: false,
      fxRate: 1,
      salesPrice: f.salesPrice,
      salesPriceTaxInclusive: f.salesPriceTaxInclusive,
      salesVatRate: f.salesVatRate,
    })
    const minimum = resolveMinimumMarginPct(ctx.settings, { productId: f.productId, parentId: f.parentId, categoryChain: f.categoryChain })
    return { productId: f.productId, sku: f.sku, ...assessLineAgainstMinimum(margin, minimum) }
  })
}

export type GuardOutcome =
  | { kind: 'proceed'; override: null }
  | { kind: 'proceed'; override: { note: string; below: GuardLineAssessment[] } }
  | { kind: 'refused'; message: string }

const OVERRIDE_PERMISSION: Permission = 'inventory.prices'

/**
 * Apply the policy. `warn` never refuses. `block` refuses unless a valid note arrives from a user who may
 * see (and so may override) margins. A refusal names the SKUs; the percentages appear only for a user
 * holding `inventory.prices`, the permission that already guards cost and price figures.
 */
export function decideGuard(
  ctx: MarginGuardContext | null,
  assessments: readonly GuardLineAssessment[],
  opts: { role: string; overrideNote: unknown; verb: 'save' | 'send' },
): GuardOutcome {
  if (!ctx) return { kind: 'proceed', override: null }
  const mayOverride = hasPermission(opts.role, OVERRIDE_PERMISSION)
  const decision: ThresholdDecision = decideThreshold(ctx.settings.mode, assessments, mayOverride ? opts.overrideNote : null)
  const below = assessments.filter((a) => a.state === 'below')
  if (decision.kind === 'clear' || decision.kind === 'warn') return { kind: 'proceed', override: null }
  if (decision.kind === 'overridden') return { kind: 'proceed', override: { note: decision.note, below } }
  const list = below
    .map((a) => (mayOverride ? `${a.sku} (${a.marginPct}% against a minimum of ${a.minPct}%)` : a.sku))
    .join(', ')
  const how = mayOverride
    ? `Enter an override note to ${opts.verb} it anyway; the note is recorded on the order.`
    : 'Ask someone with price access to review it.'
  return {
    kind: 'refused',
    message: `${MARGIN_BLOCK_ERROR_PREFIX}: ${below.length} line${below.length === 1 ? ' is' : 's are'} below the minimum gross margin: ${list}. ${how}`,
  }
}

type ActivityTx = Parameters<typeof logActivityInTransaction>[0]

/** Record an accepted override on the PO, in the caller's transaction: a failed write aborts the save or send. */
export async function recordMarginOverride(
  tx: ActivityTx,
  args: {
    poId: string
    reference: string
    userId: string | null
    verb: 'save' | 'send'
    note: string
    below: readonly GuardLineAssessment[]
  },
): Promise<void> {
  await logActivityInTransaction(tx, {
    entityType: 'PURCHASE_ORDER',
    entityId: args.poId,
    action: 'margin_override',
    tag: 'purchase',
    level: 'WARNING',
    userId: args.userId,
    description: `PO ${args.reference}: minimum margin overridden to ${args.verb} (${args.below.length} line${args.below.length === 1 ? '' : 's'} below). Note: ${args.note}`,
    metadata: {
      reference: args.reference,
      verb: args.verb,
      overriddenByUserId: args.userId,
      overriddenAt: new Date().toISOString(),
      note: args.note,
      lines: args.below.map((b) => ({ productId: b.productId, sku: b.sku, marginPct: b.marginPct, minPct: b.minPct, source: b.source })),
    },
  })
}

/** Thrown inside a transaction to roll it back on a block; the action catches it and returns the message. */
export class MarginBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarginBlockedError'
  }
}
