import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * o3d-psrx — THE SOURCE SCANNER BOTH PAID-PROVENANCE CENSUSES RUN ON.
 *
 * There are two censuses over this repository's source and they answer the two halves of one rule:
 *
 *   paid-provenance-writers.test.ts   every writer of `SalesOrder.paidAt` RECORDS where the belief
 *                                     came from (r2, Codex HIGH).
 *   paid-provenance-readers.test.ts   every reader that decides a reversal SELECTS it (r3, Codex
 *                                     HIGH — the same rule, missed one connector over).
 *
 * They share this file rather than each carrying a copy of the brace analysis, for the reason the
 * branch itself is about: two independently-worded implementations of one rule is how a rule comes to
 * be enforced in one place and absent in the other.
 */

export const WRITE_OPS = ['create', 'createMany', 'update', 'updateMany', 'upsert'] as const
export const READ_OPS = ['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow'] as const

/**
 * Blank out comments and string/template bodies, PRESERVING LENGTH so every index still points at the
 * same character of the original. Brace balance is what the whole analysis rests on, and a `{` inside
 * a comment or a string would wreck it — these files are full of prose containing both.
 */
export function blankNonCode(source: string): string {
  const out = source.split('')
  let i = 0
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const end = source.indexOf('\n', i)
      blank(i, end === -1 ? source.length : end)
      i = end === -1 ? source.length : end
      continue
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      blank(i, end === -1 ? source.length : end + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue }
        if (source[j] === ch) break
        j++
      }
      blank(i + 1, j)
      i = j + 1
      continue
    }
    i++
  }
  return out.join('')
}

/** The balanced span starting at `open` (a `(`, `{` or `[`), inclusive of both delimiters. */
export function balancedFrom(code: string, open: number): string {
  const close = { '(': ')', '{': '}', '[': ']' }[code[open]]
  if (!close) return ''
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const ch = code[i]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return code.slice(open, i + 1)
    }
  }
  return code.slice(open)
}

/**
 * The value of top-level property `key` inside the object literal text `objectText`, as source.
 * Returns null when the key is not present at the TOP level — a nested `data:` belonging to some
 * other model's write must not be picked up as this one's.
 *
 * SHORTHAND COUNTS, and finding out that it did not was this detector's own first bug: `markSalesOrderPaid`
 * writes `data: { paidAt, unregisteredPaidAt: paidAt }`, and a version of this that insisted on a
 * `key:` scored that writer as writing nothing at all — a real writer, silently outside the invariant.
 * A shorthand property reports the string `'<shorthand>'`, which is not null and so counts as present.
 */
export const SHORTHAND = '<shorthand>'

export function topLevelProperty(objectText: string, key: string): string | null {
  let depth = 0
  for (let i = 0; i < objectText.length; i++) {
    const ch = objectText[i]
    if (ch === '{' || ch === '[' || ch === '(') { depth++; continue }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; continue }
    if (depth !== 1) continue
    if (!objectText.startsWith(key, i)) continue
    if (i > 0 && /[\w$]/.test(objectText[i - 1])) continue
    const rest = objectText.slice(i + key.length)
    // `{ paidAt, ... }` / `{ paidAt }` — ES shorthand, the same write with the colon left off.
    if (/^\s*[,}]/.test(rest)) return SHORTHAND
    const after = rest.match(/^\s*:/)
    if (!after) continue
    let j = i + key.length + after[0].length
    while (j < objectText.length && /\s/.test(objectText[j])) j++
    if ('({['.includes(objectText[j])) return balancedFrom(objectText, j)
    // A bare identifier or expression up to the next top-level comma / closing brace.
    let k = j
    let d = 0
    while (k < objectText.length) {
      const c = objectText[k]
      if ('({['.includes(c)) d++
      else if (')}]'.includes(c)) { if (d === 0) break; d-- }
      else if (c === ',' && d === 0) break
      k++
    }
    return objectText.slice(j, k).trim()
  }
  return null
}

export function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

// `process.cwd()` is the repository root under `npm run test:unit` and under a direct tsx run from the
// root. Asserted rather than assumed: a wrong root makes the walk find nothing, and a detector that
// scanned nothing would report a perfectly clean invariant.
export const ROOT = process.cwd()

/** Every production source under app/ and lib/, as [repo-relative path, contents]. */
export function productionSources(): Array<[string, string]> {
  assert.ok(
    statSync(path.join(ROOT, 'lib')).isDirectory() && statSync(path.join(ROOT, 'app')).isDirectory(),
    `expected the repository root, got ${ROOT}`,
  )
  const files = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'lib'))]
  assert.ok(files.length > 500, `expected to scan the whole of app/ and lib/, saw ${files.length} files`)
  return files.map((f) => [path.relative(ROOT, f), readFileSync(f, 'utf8')])
}
