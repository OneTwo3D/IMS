/**
 * o3d-j625 r5 (review L-9) — THE MAP, PARSED. `getPaymentAccountMap` returns the setting's JSON STRING;
 * both processors asked `Object.keys(...)` of that string, which counts CHARACTERS, so their "no mapping is
 * configured at all" arm was unreachable for any non-empty string (including `'{}'`). One parser, shared
 * with `lookupPaymentAccount`, so the two readings cannot disagree.
 */
export function parsePaymentAccountMap(mapJson: string): Record<string, string> {
  try {
    const parsed = JSON.parse(mapJson) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}
