/**
 * NUMBERING PATTERNS: THE GRAMMAR, ITS VALIDATION AND ITS RENDERING. PURE.
 *
 * A pattern is literal text with tokens in braces:
 *
 *   {YYYY}    four-digit year            {YY}     two-digit year
 *   {MM}      two-digit month            {DD}     two-digit day of the month
 *   {SEQ}     the counter, written exactly as it is: NO padding, ever
 *   {SEQ:n}   the counter, zero-padded to n digits (1 to 12); a longer number is never truncated
 *   {RAND:n}  n random upper-case letters and digits (1 to 8), for documents that are not numbered in sequence
 *
 * THERE IS NO IMPLICIT PADDING. `{SEQ}` prints 7, not 0007: the sibling system's August 2022 fix removed
 * automatic leading zeros because padded numbers confused customers who move between it and the accounting
 * system and the storefront. Padding is something an operator asks for, with the width written down.
 *
 * {DD} and {RAND:n} exist so that the numbers IMS has always minted (`SO-20261117-A7X2`) are expressible as a
 * pattern; the pattern a document type starts with is the one that reproduces them byte for byte.
 *
 * A pattern must contain {SEQ} or {RAND:n}, otherwise every document would get the same number. Literal text is
 * limited to letters, digits and `- _ . / #`: these numbers travel to the accounting system, the warehouse and the
 * storefront, and a comma, a quote or a space is read as syntax by some of them.
 */

export const SEQ_MAX_PAD = 12
export const RAND_MAX_LEN = 8
export const PATTERN_MAX_LENGTH = 60

export type PatternSegment =
  | { kind: 'lit'; text: string }
  | { kind: 'year4' }
  | { kind: 'year2' }
  | { kind: 'month' }
  | { kind: 'day' }
  | { kind: 'seq'; pad: number }
  | { kind: 'rand'; len: number }

/** How often the counter starts again: with the finest date token the pattern carries. */
export type CounterScope = 'none' | 'year' | 'month' | 'day'

export type ParsedPattern = {
  segments: PatternSegment[]
  usesSeq: boolean
  usesRand: boolean
  scope: CounterScope
}

export type PatternParse = { ok: true; parsed: ParsedPattern } | { ok: false; error: string }

const LITERAL_RE = /^[A-Za-z0-9\-_./#]+$/

export function summarise(segments: PatternSegment[]): ParsedPattern {
  const usesSeq = segments.some((s) => s.kind === 'seq')
  const usesRand = segments.some((s) => s.kind === 'rand')
  let scope: CounterScope = 'none'
  if (segments.some((s) => s.kind === 'year4' || s.kind === 'year2')) scope = 'year'
  if (segments.some((s) => s.kind === 'month')) scope = 'month'
  if (segments.some((s) => s.kind === 'day')) scope = 'day'
  return { segments, usesSeq, usesRand, scope }
}

export function parsePattern(pattern: string): PatternParse {
  if (typeof pattern !== 'string' || pattern.length === 0) return { ok: false, error: 'The pattern is empty.' }
  if (pattern.length > PATTERN_MAX_LENGTH) return { ok: false, error: `The pattern is longer than ${PATTERN_MAX_LENGTH} characters.` }
  const segments: PatternSegment[] = []
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) return { ok: false, error: 'A "{" has no closing "}".' }
      const token = pattern.slice(i + 1, end)
      const seg = parseToken(token)
      if (typeof seg === 'string') return { ok: false, error: seg }
      segments.push(seg)
      i = end + 1
      continue
    }
    if (ch === '}') return { ok: false, error: 'A "}" has no opening "{".' }
    let j = i
    while (j < pattern.length && pattern[j] !== '{' && pattern[j] !== '}') j++
    const text = pattern.slice(i, j)
    if (!LITERAL_RE.test(text)) {
      return { ok: false, error: `The text "${text}" holds a character that is not allowed: use letters, digits and - _ . / # only.` }
    }
    segments.push({ kind: 'lit', text })
    i = j
  }
  if (segments.filter((s) => s.kind === 'seq').length > 1) return { ok: false, error: 'A pattern may hold {SEQ} only once.' }
  const parsed = summarise(segments)
  if (!parsed.usesSeq && !parsed.usesRand) {
    return { ok: false, error: 'The pattern needs {SEQ} (or {SEQ:n}) so that every document gets a different number.' }
  }
  return { ok: true, parsed }
}

function parseToken(token: string): PatternSegment | string {
  switch (token) {
    case 'YYYY': return { kind: 'year4' }
    case 'YY': return { kind: 'year2' }
    case 'MM': return { kind: 'month' }
    case 'DD': return { kind: 'day' }
    case 'SEQ': return { kind: 'seq', pad: 0 }
    default: break
  }
  const sized = /^(SEQ|RAND):(\d+)$/.exec(token)
  if (sized) {
    const n = Number.parseInt(sized[2]!, 10)
    if (sized[1] === 'SEQ') {
      if (n < 1 || n > SEQ_MAX_PAD) return `{SEQ:${sized[2]}} must be between {SEQ:1} and {SEQ:${SEQ_MAX_PAD}}; leave the width out for no padding.`
      return { kind: 'seq', pad: n }
    }
    if (n < 1 || n > RAND_MAX_LEN) return `{RAND:${sized[2]}} must be between {RAND:1} and {RAND:${RAND_MAX_LEN}}.`
    return { kind: 'rand', len: n }
  }
  return `"{${token}}" is not a token. The tokens are {YYYY} {YY} {MM} {DD} {SEQ} {SEQ:n} {RAND:n}.`
}

export type DateBasis = 'utc' | 'local'

function dateParts(date: Date, basis: DateBasis): { y: number; m: number; d: number } {
  return basis === 'utc'
    ? { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() }
    : { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }
}

const two = (n: number): string => String(n).padStart(2, '0')

/**
 * The key a counter period is known by: the date tokens the pattern carries, rendered. Two dates with the same key
 * share one counter; a date with another key starts a counter of its own. '' when the pattern has no date token
 * (one counter for ever).
 */
export function scopeKeyFor(parsed: ParsedPattern, date: Date, basis: DateBasis): string {
  const { y, m, d } = dateParts(date, basis)
  const parts: string[] = []
  for (const s of parsed.segments) {
    if (s.kind === 'year4') parts.push(String(y))
    else if (s.kind === 'year2') parts.push(two(y % 100))
    else if (s.kind === 'month') parts.push(two(m))
    else if (s.kind === 'day') parts.push(two(d))
  }
  return parts.join('-')
}

export const RAND_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function randomText(len: number, rng: () => number): string {
  let out = ''
  for (let i = 0; i < len; i++) out += RAND_ALPHABET[Math.min(RAND_ALPHABET.length - 1, Math.floor(rng() * RAND_ALPHABET.length))]
  return out
}

export function renderSeq(seq: number, pad: number): string {
  return pad > 0 ? String(seq).padStart(pad, '0') : String(seq)
}

export function renderPattern(
  parsed: ParsedPattern,
  input: { date: Date; basis: DateBasis; seq?: number; rng?: () => number },
): string {
  const { y, m, d } = dateParts(input.date, input.basis)
  const rng = input.rng ?? Math.random
  let out = ''
  for (const s of parsed.segments) {
    switch (s.kind) {
      case 'lit': out += s.text; break
      case 'year4': out += String(y); break
      case 'year2': out += two(y % 100); break
      case 'month': out += two(m); break
      case 'day': out += two(d); break
      case 'seq': out += renderSeq(input.seq ?? 0, s.pad); break
      case 'rand': out += randomText(s.len, rng); break
    }
  }
  return out
}

/**
 * A regular expression that matches the numbers this pattern produced inside ONE counter period (`scopeKey` as
 * `scopeKeyFor` gives it), capturing the counter. Used to find the highest counter already used, whatever the
 * pattern is: it is how a counter is seeded and how a reset is refused. Returns null for a pattern with no {SEQ}.
 */
export function seqMatcherFor(parsed: ParsedPattern, scopeKey: string): RegExp | null {
  if (!parsed.usesSeq) return null
  const keyParts = scopeKey === '' ? [] : scopeKey.split('-')
  let k = 0
  let source = '^'
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\/#-]/g, '\\$&')
  for (const s of parsed.segments) {
    switch (s.kind) {
      case 'lit': source += esc(s.text); break
      case 'year4': case 'year2': case 'month': case 'day': source += esc(keyParts[k++] ?? ''); break
      case 'seq': source += '(\\d+)'; break
      case 'rand': source += `[0-9A-Z]{${s.len}}`; break
    }
  }
  return new RegExp(`${source}$`)
}

/** The literal text a number of this pattern and period starts with, up to the counter: lets a query narrow its scan. */
export function literalPrefixFor(parsed: ParsedPattern, scopeKey: string): string {
  const keyParts = scopeKey === '' ? [] : scopeKey.split('-')
  let k = 0
  let out = ''
  for (const s of parsed.segments) {
    if (s.kind === 'lit') out += s.text
    else if (s.kind === 'year4' || s.kind === 'year2' || s.kind === 'month' || s.kind === 'day') out += keyParts[k++] ?? ''
    else break
  }
  return out
}
