export function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  const raw = value?.trim()
  if (!raw || !/^\d+$/.test(raw)) return fallback
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
