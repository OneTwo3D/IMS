/** THE CLOSED REASON CODES OF THE VAT DIFFERENCE REPORT. Pure constants (no database, no vendor), so a client component may import them. */

/** The closed list of reasons, in the order a report lists them, each with what it means for the owner. */
export const VAT_DIFFERENCE_REASONS = {
  MISSING_IN_IMS: 'Xero has this tax type as ACTIVE and no active IMS tax rate carries it.',
  MISSING_IN_XERO: 'An active IMS tax rate names a Xero tax type the stored Xero list does not contain.',
  INACTIVE_IN_XERO: 'An active IMS tax rate names a Xero tax type that Xero lists but not as ACTIVE (deleted, archived or pending).',
  IMS_RATE_NO_XERO_TYPE: 'An active IMS tax rate has no Xero tax type, so it has no counterpart in the single rate set.',
  AMBIGUOUS_IMS_MAPPING: 'More than one active IMS tax rate carries the same Xero tax type for the same side (sales or purchases); which one is meant would be a guess.',
  XERO_RATE_NOT_STATED: 'Xero states neither an effective nor a display percentage for the tax type an active IMS rate names.',
  PERCENTAGE_MISMATCH_IMS_XERO: 'The IMS percentage (the rate column, or the rate its active components compute) is not the percentage Xero states for the same tax type.',
  MISSING_IN_WOO: 'An active, sales-capable IMS tax rate has no live WooCommerce tax rate mapped to it.',
  WOO_RATE_NO_IMS_MAPPING: 'A WooCommerce tax rate has no IMS tax-rate mapping.',
  WOO_RATE_GONE: 'An IMS mapping names a WooCommerce tax rate the store no longer has.',
  WOO_MAPPED_TO_INACTIVE_IMS_RATE: 'A WooCommerce tax rate is mapped to an IMS tax rate that is no longer active.',
  WOO_PERCENTAGE_MISMATCH: 'A mapped WooCommerce tax rate states a different percentage from Xero (the master), or from IMS where Xero states none.',
  WOO_COUNTRY_MISMATCH: 'A mapped WooCommerce tax rate has a different country from the IMS tax rate it is mapped to (IMS rates with no country apply everywhere and are not judged).',
  WOO_CLASS_MISMATCH: 'A mapped WooCommerce tax rate is in a different tax class from the one the mapping recorded.',
  WOO_COMPOUND_MISMATCH: 'A mapped WooCommerce tax rate differs from the IMS tax rate in whether it is compound.',
  WOO_SHIPPING_NOT_TAXED: 'A mapped WooCommerce tax rate above zero does not apply to shipping.',
  WOO_REGIONAL_SCOPE: 'A WooCommerce tax rate is limited to a state, postcode or city, which IMS tax rates (country only) cannot express.',
} as const
export type VatDifferenceReason = keyof typeof VAT_DIFFERENCE_REASONS
export const VAT_DIFFERENCE_REASON_LIST = Object.keys(VAT_DIFFERENCE_REASONS) as VatDifferenceReason[]

