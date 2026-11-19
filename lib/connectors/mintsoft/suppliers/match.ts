/**
 * SUGGESTING WHICH MINTSOFT SUPPLIER AN IMS SUPPLIER IS (pure; no database, no network).
 *
 * The owner's finding (2026-11-19): most suppliers already exist in Mintsoft with minimal details and names that are not identical, so an
 * exact-name match would miss most of them and creating on a miss would duplicate them. This only ever SUGGESTS: an operator confirms each
 * mapping. The score is 0..100:
 *
 *   base   the similarity of the NORMALISED names (case, accents, punctuation, whitespace and legal suffixes folded away), the larger of a
 *          character-bigram Dice coefficient and a token-set overlap, so "Acme Plastics Limited" and "ACME Plastic Co." agree.
 *   bonus  a shared signal adds to it: the same e-mail (+25), the same VAT number (+30), the account number equal to the supplier code (+20).
 *
 * A shared hard signal alone is enough to surface a pair even when the names are far apart.
 */

/**
 * TRUE legal-form words dropped from the END of a name, compared after punctuation is removed. Deliberately NOT here: region words (eu, uk, us,
 * europe) and the two-letter forms (ag, sa, ab, as, oy, bv, nv, kg, ug, kk, lp). They are short enough to be the distinguishing word of a different
 * entity ("Bambu Lab EU GmbH" is not "Bambu Lab Ltd"), so folding them away made distinct suppliers identical. A pair that differs only there still
 * scores high and is shown to the operator, but it is never an exact fold.
 */
const LEGAL_SUFFIXES = new Set([
  'ltd', 'limited', 'inc', 'incorporated', 'plc', 'llc', 'llp', 'gmbh', 'sas', 'sarl', 'srl', 'spa', 'aps',
  'co', 'company', 'corp', 'corporation', 'pty', 'pvt', 'pte', 'sdn', 'bhd', 'ltda', 'mbh', 'ohg',
])
/** Filler words that carry no identity. */
const FILLER = new Set(['the', 'and', 'of'])

export function foldAccents(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

/** The comparable tokens of a supplier name. */
export function normalizeSupplierNameTokens(name: string): string[] {
  const text = foldAccents(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    // "g.m.b.h." and "l.l.c." read as one token before punctuation is stripped.
    .replace(/\b(?:[a-z]\.){2,}/g, (match) => match.replace(/\./g, ''))
    .replace(/[^a-z0-9\s]/g, ' ')
  let tokens = text.split(/\s+/).filter(Boolean).filter((token) => !FILLER.has(token))
  // Legal suffixes only at the end, repeatedly ("Acme Co Ltd"), and never down to nothing.
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens = tokens.slice(0, -1)
  return tokens
}

export function normalizeSupplierName(name: string): string {
  return normalizeSupplierNameTokens(name).join(' ')
}

function bigrams(value: string): Map<string, number> {
  const compact = value.replace(/\s+/g, '')
  const out = new Map<string, number>()
  if (compact.length < 2) {
    if (compact) out.set(compact, 1)
    return out
  }
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2)
    out.set(gram, (out.get(gram) ?? 0) + 1)
  }
  return out
}

/** Dice coefficient over character bigrams, 0..1. */
export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const left = bigrams(a)
  const right = bigrams(b)
  let overlap = 0
  let total = 0
  for (const count of left.values()) total += count
  for (const count of right.values()) total += count
  for (const [gram, count] of left) overlap += Math.min(count, right.get(gram) ?? 0)
  return total === 0 ? 0 : (2 * overlap) / total
}

/** Token overlap: shared tokens over the smaller token set, where a token also counts when one is a prefix of the other (plastic / plastics). */
export function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const small = a.length <= b.length ? a : b
  const large = a.length <= b.length ? b : a
  const used = new Set<number>()
  let hits = 0
  for (const token of small) {
    const exact = large.findIndex((other, index) => !used.has(index) && other === token)
    if (exact >= 0) { used.add(exact); hits += 1; continue }
    // A prefix match (plastic / plastics) counts as most of a hit, so an identical token always outranks a near one.
    const near = large.findIndex((other, index) => !used.has(index) && token.length >= 4 && other.length >= 4 && (other.startsWith(token) || token.startsWith(other)))
    if (near >= 0) { used.add(near); hits += 0.9 }
  }
  // Penalise a short name that is merely contained in a long one: overlap over the LARGER set, blended with the smaller.
  return (hits / small.length) * 0.6 + (hits / large.length) * 0.4
}

export function supplierNameSimilarity(a: string, b: string): number {
  const tokensA = normalizeSupplierNameTokens(a)
  const tokensB = normalizeSupplierNameTokens(b)
  if (tokensA.length === 0 || tokensB.length === 0) return 0
  const joinedA = tokensA.join(' ')
  const joinedB = tokensB.join(' ')
  if (joinedA === joinedB) return 1
  return Math.max(diceSimilarity(joinedA, joinedB), tokenOverlap(tokensA, tokensB))
}

export const normalizeEmail = (value: string | null | undefined): string | null => {
  const text = (value ?? '').trim().toLowerCase()
  return text.includes('@') ? text : null
}

export const normalizeVat = (value: string | null | undefined): string | null => {
  const text = (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return text.length >= 5 ? text : null
}

export const normalizeCode = (value: string | null | undefined): string | null => {
  const text = (value ?? '').trim().toUpperCase().replace(/\s+/g, '')
  return text.length >= 2 ? text : null
}

export type ImsSupplierForMatch = { id: string; name: string; email: string | null; vatNumber: string | null; accountNumber: string | null }
export type MintsoftSupplierForMatch = { externalId: string; name: string; code: string | null; email: string | null; vatNumber: string | null; active: boolean }

export type SupplierSignal = 'email' | 'vat' | 'code'

export type SupplierSuggestion = {
  externalId: string
  name: string
  score: number
  nameScore: number
  signals: SupplierSignal[]
}

const SIGNAL_BONUS: Record<SupplierSignal, number> = { email: 25, vat: 30, code: 20 }
/** A pair is offered when its score reaches this, or when it shares any hard signal. */
export const SUGGESTION_MIN_SCORE = 55
export const SUGGESTION_LIMIT = 3
/** A cached Mintsoft supplier whose pair score reaches this blocks "create in Mintsoft" unless the operator confirms "create anyway" with a reason. */
export const DUPLICATE_GUARD_MIN_SCORE = 80

export function scoreSupplierPair(ims: ImsSupplierForMatch, remote: MintsoftSupplierForMatch): SupplierSuggestion {
  const nameScore = Math.round(supplierNameSimilarity(ims.name, remote.name) * 100)
  const signals: SupplierSignal[] = []
  const imsEmail = normalizeEmail(ims.email)
  if (imsEmail && imsEmail === normalizeEmail(remote.email)) signals.push('email')
  const imsVat = normalizeVat(ims.vatNumber)
  if (imsVat && imsVat === normalizeVat(remote.vatNumber)) signals.push('vat')
  const imsCode = normalizeCode(ims.accountNumber)
  if (imsCode && imsCode === normalizeCode(remote.code)) signals.push('code')
  const bonus = signals.reduce((sum, signal) => sum + SIGNAL_BONUS[signal], 0)
  return { externalId: remote.externalId, name: remote.name, score: Math.min(100, nameScore + bonus), nameScore, signals }
}

/** The best suggestions for one IMS supplier, best first; ties break on the Mintsoft name then id so the order is stable. */
export function suggestMintsoftSuppliers(ims: ImsSupplierForMatch, remotes: readonly MintsoftSupplierForMatch[], limit = SUGGESTION_LIMIT): SupplierSuggestion[] {
  return remotes
    .map((remote) => scoreSupplierPair(ims, remote))
    .filter((pair) => pair.score >= SUGGESTION_MIN_SCORE || pair.signals.length > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.externalId.localeCompare(b.externalId))
    .slice(0, limit)
}
