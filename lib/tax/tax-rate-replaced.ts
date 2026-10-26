/**
 * A TAX RATE A RE-KEY REPLACED IS READ-ONLY (lib/tax/tax-rekey.ts sets TaxRate.replacedById on the row it deactivates).
 *
 * The retired row still carries the other organisation's custom code (for example TAX005 = "CY VAT" in the Demo numbering, while the live TAX005 is "BG VAT"). Reactivating it, or editing its
 * code, percentage or components, would put that code back into circulation under its old meaning: writers accept an active row, and the enqueue guard cannot tell a CY document from a BG
 * one by the code alone. So every editor of a rate row first takes the row lock (FOR NO KEY UPDATE) and refuses when the row is replaced.
 *
 * THE SAME LOCK serialises editors with the re-key apply, which locks every active rate and component row the same way before it builds the plan it copies from: an editor that got the lock first
 * commits before the apply plans (the apply then sees the edited row, its digest differs from the operator's, and it refuses); an editor that arrives after the apply waits for its commit and
 * then finds the row replaced. Either way a replacement is never built from a row that is being edited.
 */
export class TaxRateReplacedError extends Error {
  readonly taxRateId: string
  readonly replacedById: string
  constructor(taxRateId: string, replacedById: string) {
    super(`Tax rate ${taxRateId} was replaced by a tax re-key (by ${replacedById}) and is read-only: it cannot be reactivated or have its code, percentage or components changed. Edit the replacement instead.`)
    this.name = 'TaxRateReplacedError'
    this.taxRateId = taxRateId
    this.replacedById = replacedById
  }
}

type Tx = {
  $queryRaw?: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
  taxRate: { findUnique(args: { where: { id: string }; select: { replacedById: true } }): Promise<{ replacedById?: string | null } | null> }
}

/** What an edit changes, for the one case a replaced row may still take: being switched off. */
export type TaxRateEditShape = { active?: boolean } & Record<string, unknown>

/**
 * Lock the row for the edit (to the caller's commit) and refuse when it is replaced. Call it first thing in the editing transaction. A replaced row may still be set inactive (a no-op in
 * effect); anything else on it is refused. A client without raw access (a structural double) is not locked, but is still checked.
 */
export async function lockTaxRateForEdit(tx: unknown, id: string, edit: TaxRateEditShape): Promise<void> {
  const t = tx as Tx
  if (typeof t.$queryRaw === 'function') await t.$queryRaw`SELECT id FROM tax_rates WHERE id = ${id} FOR NO KEY UPDATE`
  const row = await t.taxRate.findUnique({ where: { id }, select: { replacedById: true } })
  const replacedById = row?.replacedById ?? null
  if (replacedById === null) return
  const onlySwitchOff = edit.active === false && Object.keys(edit).every((key) => key === 'active' || edit[key] === undefined)
  if (!onlySwitchOff) throw new TaxRateReplacedError(id, replacedById)
}
