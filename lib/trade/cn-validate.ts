/**
 * 2026 EU CN8 customs-code validation — IMS port of the hs-code-woo plugin's
 * `is_declarable_cn8` (includes/hs-validate-core.php). A code is "declarable" only if it is
 * EXACTLY 8 digits and present in the 2026 EU CN list — the same fail-closed rule the plugin
 * uses before it will write/sync a code. IMS applies it before pushing a commodity code to a
 * WMS so a malformed / superseded / absent code is never declared downstream.
 *
 * Reference data: lib/trade/cn-reference/cn2026-codes.json (regenerate with
 * scripts/generate-cn-reference.ts from cn2026.csv — kept in sync with the plugin's list).
 */
import cn2026Codes from './cn-reference/cn2026-codes.json'

// Built once. The JSON is a sorted array of declarable (status=current) 8-digit CN codes.
const CN2026: ReadonlySet<string> = new Set(cn2026Codes as string[])

/** Digits only, first 8 (CN8). Mirrors the plugin's normalize8 (used for display/storage). */
export function normalizeCn8(code: string): string {
  return code.replace(/\D+/g, '').slice(0, 8)
}

/**
 * True only if `code` is a declarable 2026 CN8: EXACTLY 8 digits (not merely the first 8 of a
 * longer string — an overlong input is rejected, not silently truncated) AND present in the
 * 2026 EU CN list. Empty / null / malformed / absent → false.
 */
export function isDeclarableCn8(code: string | null | undefined): boolean {
  if (!code) return false
  const digits = code.replace(/\D+/g, '')
  if (digits.length !== 8) return false
  return CN2026.has(digits)
}

/**
 * Whether the first 8 digits of `code` are present in the 2026 CN list (status "current" vs
 * "absent"). Unlike isDeclarableCn8 this does NOT require the input to be exactly 8 digits —
 * it mirrors the plugin's code_status (normalize8 → membership), used by the confidence
 * validator (6igm.2) where malformed/overlong codes are scored, not hard-rejected.
 */
export function isCurrentCn8(code: string | null | undefined): boolean {
  if (!code) return false
  return CN2026.has(normalizeCn8(code))
}

/** Number of codes in the loaded 2026 reference (for diagnostics / tests). */
export function cn2026CodeCount(): number {
  return CN2026.size
}
