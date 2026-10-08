/**
 * Strict date parsing for column maps that declare a source date format (for example `ddd, MMM D YYYY` for "Thu, Sep 24 2026").
 *
 * Pure and closed: only the tokens below are understood, a value that does not match the whole format is refused, and a
 * weekday token must agree with the date (a "Thu" on a Friday is a corrupted or hand-edited cell, not a date to guess at).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Longest first, so `DD` is not read as two `D`. */
const TOKENS = ['YYYY', 'MMM', 'ddd', 'DD', 'MM', 'D', 'M'] as const
type Token = (typeof TOKENS)[number]

export const DATE_FORMAT_TOKENS: readonly string[] = TOKENS

function tokenize(format: string): Array<Token | string> {
  const parts: Array<Token | string> = []
  let literal = ''
  for (let i = 0; i < format.length; ) {
    const token = TOKENS.find((candidate) => format.startsWith(candidate, i))
    if (token) {
      if (literal) parts.push(literal)
      literal = ''
      parts.push(token)
      i += token.length
    } else {
      literal += format[i]
      i++
    }
  }
  if (literal) parts.push(literal)
  return parts
}

/** A message when the format itself is unusable, else null. */
export function dateFormatProblem(format: string): string | null {
  if (format.trim() === '') return 'the date format is empty'
  const parts = tokenize(format)
  const tokens = parts.filter((part): part is Token => (TOKENS as readonly string[]).includes(part) && part.length <= 4)
  const count = (names: string[]) => tokens.filter((token) => names.includes(token)).length
  if (count(['YYYY']) !== 1) return `the date format must contain YYYY exactly once (tokens understood: ${TOKENS.join(', ')})`
  if (count(['MMM', 'MM', 'M']) !== 1) return 'the date format must contain exactly one month token (MMM, MM or M)'
  if (count(['D', 'DD']) !== 1) return 'the date format must contain exactly one day token (D or DD)'
  if (count(['ddd']) > 1) return 'the date format may contain ddd at most once'
  return null
}

/** `YYYY-MM-DD`, or null when the value does not match the whole format or is not a real calendar date. */
export function parseDateByFormat(format: string, value: string): string | null {
  const parts = tokenize(format)
  let pattern = '^'
  for (const part of parts) {
    if (part === 'YYYY') pattern += '(\\d{4})'
    else if (part === 'MMM') pattern += '([A-Za-z]{3})'
    else if (part === 'ddd') pattern += '([A-Za-z]{3})'
    else if (part === 'DD' || part === 'MM') pattern += '(\\d{2})'
    else if (part === 'D' || part === 'M') pattern += '(\\d{1,2})'
    else pattern += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  pattern += '$'
  const match = new RegExp(pattern).exec(value)
  if (!match) return null
  let year = 0
  let month = 0
  let day = 0
  let weekday: string | null = null
  let group = 1
  for (const part of parts) {
    if (!(TOKENS as readonly string[]).includes(part)) continue
    const text = match[group++]
    if (part === 'YYYY') year = Number(text)
    else if (part === 'MMM') month = MONTHS.indexOf(text as (typeof MONTHS)[number]) + 1
    else if (part === 'ddd') weekday = text
    else if (part === 'DD' || part === 'D') day = Number(text)
    else month = Number(text)
  }
  if (month < 1 || month > 12 || day < 1) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  if (weekday !== null && WEEKDAYS[date.getUTCDay()] !== weekday) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
