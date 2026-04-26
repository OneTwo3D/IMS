export type DecimalLike = number | string | { toString(): string } | null | undefined

export function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0
  return typeof value === 'number' ? value : Number(value.toString())
}
