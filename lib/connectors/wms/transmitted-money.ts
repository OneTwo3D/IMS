/**
 * The ONE rounding the warehouse push payload applies to its shipping, discount and VAT totals.
 *
 * It lives here, outside any connector, so that the payload builder (which SENDS these figures) and the
 * payload total guard (which CHECKS that what is sent adds up) call the same function and cannot diverge.
 * It is deliberately float-based (Math.round on a binary double), exactly as the plugin the payload mirrors
 * behaves: 4.015 is stored as 4.01499999999999968..., so this sends 4.01 where exact decimal half-up would
 * say 4.02. A caller that needs exact arithmetic converts the OUTPUT of this function to Decimal and does its
 * arithmetic on that; it must never re-round the input itself, or it would describe a payload nobody sent.
 */
export const PAYLOAD_TOTALS_DECIMALS = 2

export function roundTransmittedMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
