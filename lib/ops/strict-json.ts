/**
 * JSON THAT NAMES NO MEMBER TWICE.
 *
 * JSON.parse keeps the LAST value of a repeated member, so a closed-shape check made on its result never sees the duplicate: an entry with two
 * `expiresAt` members (one expired, one current) reads as the current one, and which of the two a person meant is not knowable. For a file an
 * operator writes and a decision rests on (a written acceptance, an exclusion, a manifest) a repeated member is therefore malformed.
 *
 * `parseJsonNoDuplicates` first scans the text, tracking the member names of EVERY object at EVERY depth (inside arrays too), and throws on a
 * repeat; it then returns JSON.parse's own result, so what is accepted is exactly JSON and the value is exactly what JSON.parse gives.
 *   - A member name is compared by its DECODED value, so `"a"` and `"a"` are one name.
 *   - It is also compared under Unicode NFC, so a name written precomposed and the same name written decomposed are one name (stricter than
 *     JSON, on purpose: two spellings of one name that a reader cannot tell apart are not two members).
 *   - Nesting deeper than MAX_DEPTH is refused.
 * Used for the acceptance file (lib/ops/readiness-gate.ts), the SKU exclusion file and the Qoblex manifest. NOT used for the pack's own reports
 * (written by the pack, bound by a sha256 chain and read back through a closed-shape check), the lock file, or the database settings.
 */

export class DuplicateMemberError extends Error {
  constructor() { super('a JSON object names the same member twice') }
}

const MAX_DEPTH = 64

export function parseJsonNoDuplicates(text: string): unknown {
  let i = 0
  const fail = (): never => { throw new SyntaxError('not JSON') }
  const space = (): void => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i += 1 }
  const string = (): string => {
    const start = i
    i += 1
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (i >= text.length) return fail()
    i += 1
    return JSON.parse(text.slice(start, i)) as string
  }
  const value = (depth: number): void => {
    if (depth > MAX_DEPTH) fail()
    space()
    const c = text[i]
    if (c === '{') {
      i += 1
      const seen = new Set<string>()
      space()
      if (text[i] === '}') { i += 1; return }
      for (;;) {
        space()
        if (text[i] !== '"') fail()
        const name = string().normalize('NFC')
        if (seen.has(name)) throw new DuplicateMemberError()
        seen.add(name)
        space()
        if (text[i] !== ':') fail()
        i += 1
        value(depth + 1)
        space()
        if (text[i] === ',') { i += 1; continue }
        if (text[i] === '}') { i += 1; return }
        fail()
      }
    } else if (c === '[') {
      i += 1
      space()
      if (text[i] === ']') { i += 1; return }
      for (;;) {
        value(depth + 1)
        space()
        if (text[i] === ',') { i += 1; continue }
        if (text[i] === ']') { i += 1; return }
        fail()
      }
    } else if (c === '"') {
      string()
    } else {
      // number, true, false, null: JSON.parse judges them; the scan only needs to find where they end
      const start = i
      while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i += 1
      if (i === start) fail()
    }
  }
  value(0)
  space()
  if (i !== text.length) fail()
  return JSON.parse(text)
}
