import { getXeroSettings } from './settings'
import { unitDpLineGap, XeroRoundingAccountMissingError } from './write-path'

/**
 * Asked BEFORE any contact or item round trip: is there a unitdp=4 penny to post, and if so is there a Rounding account to post it to?
 * Settings are read only when there is a gap, so a document whose prices Xero keeps exactly never touches them.
 */
export async function resolveUnitDpRoundingAccount(
  lines: ReadonlyArray<{ quantity: number; unitAmount: number }>, what: string,
): Promise<{ ok: true; account: string | null } | { ok: false; error: string }> {
  const gap = unitDpLineGap(lines)
  if (gap.isZero()) return { ok: true, account: null }
  const account = (await getXeroSettings()).xero_rounding_difference_account?.trim() ?? ''
  if (!account) return { ok: false, error: new XeroRoundingAccountMissingError(what, gap.toFixed(2)).message }
  return { ok: true, account }
}
