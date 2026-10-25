/** THE CLOSED REASON CODES OF THE VAT DIFFERENCE REPORT. Pure constants (no database, no vendor), so a client component may import them. */

/** The closed list of reasons, in the order a report lists them, each with what it means for the owner. */
export const VAT_DIFFERENCE_REASONS = {
  MISSING_IN_IMS: 'Xero has this tax type as ACTIVE and no active IMS tax rate usable on the side Xero allows (sales for a revenue type, purchases for an expenses type) carries it.',
  MISSING_IN_XERO: 'An active IMS tax rate names a Xero tax type the stored Xero list does not contain.',
  INACTIVE_IN_XERO: 'An active IMS tax rate names a Xero tax type that Xero lists but not as ACTIVE (deleted, archived or pending).',
  IMS_RATE_NO_XERO_TYPE: 'An active IMS tax rate has no Xero tax type, so it has no counterpart in the single rate set.',
  AMBIGUOUS_IMS_MAPPING: 'More than one active IMS tax rate carries the same Xero tax type for the same side (sales or purchases); which one is meant would be a guess.',
  USED_FOR_NOT_ALLOWED_BY_XERO: 'An active IMS tax rate is used on a side (sales or purchases) that its Xero tax type cannot be applied to (Xero CanApplyToRevenue / CanApplyToExpenses), so it does not count as that type being present on that side.',
  XERO_RATE_NOT_STATED: 'Xero states neither an effective nor a display percentage for the tax type an active IMS rate names.',
  PERCENTAGE_MISMATCH_IMS_XERO: 'The IMS percentage (the rate column, or the rate its active components compute) is not the percentage Xero states for the same tax type.',
  MISSING_IN_WOO: 'An active, sales-capable IMS tax rate has no live WooCommerce tax rate mapped to it.',
  WOO_RATE_NO_IMS_MAPPING: 'A WooCommerce tax rate has no IMS tax-rate mapping.',
  WOO_RATE_GONE: 'An IMS mapping names a WooCommerce tax rate the store no longer has.',
  WOO_MAPPED_TO_INACTIVE_IMS_RATE: 'A WooCommerce tax rate is mapped to an IMS tax rate that is no longer active.',
  WOO_MAPPED_TO_NON_SALES_RATE: 'A WooCommerce tax rate is mapped to an IMS tax rate that is not usable for sales (used for purchases only, or its Xero type cannot be applied to revenue).',
  WOO_PERCENTAGE_MISMATCH: 'A mapped WooCommerce tax rate states a different percentage from Xero (the master), or from IMS where Xero states none.',
  WOO_COUNTRY_MISMATCH: 'A mapped WooCommerce tax rate has a different country scope from the IMS tax rate it is mapped to (no country means everywhere, on either side).',
  WOO_CLASS_MISMATCH: 'A mapped WooCommerce tax rate is in a different tax class from the one the mapping recorded (a mapping with no recorded class means the standard class).',
  WOO_COMPOUND_MISMATCH: 'A mapped WooCommerce tax rate differs from the IMS tax rate in whether it is compound.',
  WOO_SHIPPING_NOT_TAXED: 'A mapped WooCommerce tax rate above zero does not apply to shipping. Owner ruling 2026-10-25: shipping always carries the VAT rate of the goods.',
  UNCLASSIFIED_SCHEME: 'The rate cannot be assigned to UK, IOSS, VOEC or other foreign VAT from the data the systems hold (a conflicting or unknown reporting category, a rate with no country and a MOSSSALES report type, or a rate with no country and no mapping; see lib/tax/vat-scheme.ts), so it is listed in the unclassified section instead of being compared under a guessed scheme.',
} as const
export type VatDifferenceReason = keyof typeof VAT_DIFFERENCE_REASONS
export const VAT_DIFFERENCE_REASON_LIST = Object.keys(VAT_DIFFERENCE_REASONS) as VatDifferenceReason[]

