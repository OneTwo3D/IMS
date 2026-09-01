/**
 * LIFTING ONE SHELL SYMBOL OUT OF A SCRIPT — AND PROVING IT IS THE ONE BASH WOULD RUN (o3d-rn10 r4).
 *
 * Every harness in this directory runs SHIPPED text rather than a re-implementation, which means
 * every harness has to cut that text out of the file. Both cuts used to take the FIRST match:
 * `indexOf('\nname() {\n')` for a function, `lines.find(l => l.startsWith('NAME='))` for a
 * constant. Bash does not work that way. A later definition REPLACES an earlier one, so appending
 *
 *     publish_root_anchored() { return 0; }
 *
 * to scripts/deploy.sh left the byte-identity test comparing install.sh's canonical body against
 * deploy.sh's canonical body — passing — while deploy.sh itself ran the stub. Codex confirmed it
 * in memory: two definitions, `mutatedStillEqual: true`. The behavioural rigs cut the same way, so
 * they would have run the canonical copy too, and measured a function the entrypoint had stopped
 * using.
 *
 * SO UNIQUENESS IS ASSERTED BEFORE ANYTHING IS COMPARED. A comparison over a symbol defined twice
 * is meaningless whichever copy it picks; there is no reading of "these two files carry the same
 * publisher" that survives one of them carrying two publishers.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A LIST OF KEYWORDS ANY MORE (o3d-rn10 r6, Codex MEDIUM — third round on the
 * same guard).
 *
 * The detector was rewritten twice and missed a definition form both times, each time in the same
 * shape: it enumerated the contexts a definition may appear in, and bash accepted one more.
 *
 *   r4  anchored the header to the END of the line, and missed every one-line body
 *       (`publish_root_anchored() { return 0; }`) — the cheapest override there is.
 *   r5  added `;`, `&`, `|`, `(`, `)`, `{`, `}`, `then`, `else`, `do` as things a definition may
 *       follow, and missed `if`, `while`, `until`, `!` and `time`, which Codex then demonstrated:
 *       `if publish_root_anchored() { return 0; }; then :; fi` counted as one and ran as two.
 *
 * Adding those five would have been r6, and it would have missed the next one. Bash's command
 * position is not a set anybody has finished enumerating here: `elif` and `time -p` are two more
 * that no round and no reviewer listed, and both were verified to parse AND to take effect. Worse,
 * every one of those rounds scanned LINE BY LINE, and a backslash-newline inside the header —
 *
 *     publish_root_anchored\
 *     () { return 0; }
 *
 * — parses, installs the override, and cannot be seen by any line-based rule at all, however many
 * keywords it lists. Enumerating an open set is the failure this repository has established it
 * cannot do; the sixth attempt at the list is not the fix.
 *
 * SO NOTHING IS ENUMERATED. Three readings run, and the check fails unless all three agree:
 *
 *   1. A LEXER, not a line scanner. {@link maskShellSource} walks the whole file once and blanks
 *      every byte that is not unquoted shell code — comments, single and double quotes, `$'…'`,
 *      here-document bodies, arithmetic — recursing into `$(…)` and backticks because those are
 *      code again even inside double quotes. Line continuations collapse, so a header split across
 *      lines is one header. Anything it cannot resolve — an unterminated quote, an unterminated
 *      here-document, an unbalanced substitution — THROWS and names the line. It does not guess.
 *
 *   2. A RULE ABOUT WORDS, not about keywords. Over that mask, a definition is `name` followed by
 *      `(` `)`, or the word `function` followed by `name`. No context is consulted, because none is
 *      needed: `name()` unquoted is a function definition wherever it appears and is a SYNTAX ERROR
 *      anywhere else (`echo publish_root_anchored()` does not parse — verified). What decides
 *      whether the match is OUR name is bash's own definition of a word boundary: a word ends only
 *      at a METACHARACTER, so `name` preceded by anything else is the tail of a longer name and is
 *      not ours. That set — blank, tab, newline, `|`, `&`, `;`, `(`, `)`, `<`, `>` — is closed, and
 *      it is the language's, not this file's. `if`, `while`, `until`, `!`, `time`, `elif`, `time -p`
 *      and every form nobody has written down are all caught by it without appearing in it.
 *
 *   3. BASH'S OWN PARSER. `bash --pretty-print` parses the script and deparses its AST WITHOUT
 *      EXECUTING IT (verified: a script whose first line is `echo SIDE_EFFECT_RAN` prints the echo
 *      as text and runs nothing), rendering every definition form — `function name {`, the one-line
 *      bodies, the split header, the ones after `if`/`while`/`elif` — into the single canonical
 *      shape `name () `. Reading 2 over that output must return the SAME COUNT as reading 2 over the
 *      raw source. If they differ, this file's lexer has misread something bash did not, and that
 *      DISAGREEMENT IS A FAILURE — the guard goes red and names both counts rather than picking the
 *      lower one. If bash cannot parse the source at all, that is a failure too.
 *
 * AND WHAT NONE OF THE THREE CAN SEE IS REFUSED OUTRIGHT. `eval 'publish_root_anchored() { return
 * 0; }'` installs the override — verified — and is invisible to the lexer (it is a quoted string),
 * invisible to any command-position rule, and invisible to bash's own parser, which deparses it
 * back out as the string it is. There is no lexical reading of a file that answers "how many times
 * is this defined?" once `eval` is in it. So an `eval` in shell code makes this THROW and name the
 * line, rather than return a count it cannot stand behind. The thirteen tracked scripts contain no
 * `eval` in code — the one occurrence is a comment in install.sh saying the assignment is
 * `printf -v` and deliberately not `eval` — so this refusal costs the repository nothing today and
 * fires the moment that stops being true.
 *
 * WHAT THIS STILL CANNOT READ, STATED RATHER THAN HIDDEN. Two constructs are known to defeat the
 * lexer, and both END IN A REFUSAL OR IN A DEFINITION THAT CANNOT OVERRIDE ANYTHING:
 *
 *   - `$( ( … ) … )`. Bash reads `$((` as arithmetic, fails, and re-reads it as a substitution
 *     containing a subshell. This cannot: it commits to arithmetic and then finds no `))`, so it
 *     THROWS and names the line. `x="$(( echo a ) ; publish_root_anchored() { return 0; })"` is
 *     accepted by bash and refused here — which is the direction that was asked for.
 *   - A `case` pattern's `)` inside `"$( … )"` closes the substitution early here, so shell code
 *     after it is masked as if it were still inside the quotes. A definition in that position is
 *     inside a COMMAND SUBSTITUTION and therefore inside a subshell: it dies with the subshell and
 *     can override nothing in the script that reads it. The same `case` pattern at top level, where
 *     an override WOULD be effective, is read correctly, because there is no substitution to close.
 *
 * And the `function` form is counted wherever the two words stand adjacent in shell code, without
 * asking whether `function` is in command position — asking that is the enumeration this rewrite
 * exists to stop doing. `echo function publish_root_anchored` is therefore counted as a definition.
 * That is a false positive, it makes the guard RED and names the line, and it is the direction a
 * guard against a hidden override must err in. No such line exists in the 13 tracked scripts.
 *
 * THE COST OF FAILING CLOSED IS MEASURED, because a guard that trips on ordinary code gets deleted.
 * All 351 canonical `name() {` definitions across the 13 tracked shell files — 373 (file, symbol)
 * pairs once the non-canonical and nested ones are included — still resolve to exactly one under
 * all three readings; see the census test in install-root-safe-writes.test.ts.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT COUNTS AS AN ASSIGNMENT. A top-level `NAME=`, with or without an `export`, `readonly`,
 * `declare` or `typeset` in front of it. Indented assignments are NOT counted: `local NAME=` and a
 * branch inside a function are ordinary shell, and a rule that banned them would ban the language.
 * The bypass this closes is a second top-level assignment, which is what a pasted copy looks like.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Bash's metacharacters: "a character that, when unquoted, separates words". A word ends HERE and
 * nowhere else, which is the whole of the rule that decides whether a `name()` we found is the
 * `name` we were asked about. It is the language's set, not a list this file maintains.
 */
const METACHARACTERS = ' \t\n|&;()<>'

/**
 * What a collapsed line continuation leaves behind in the mask. It has to be a character that is
 * NOT a metacharacter — a `\`+newline joins a word rather than ending it, so `xxx\<newline>name()`
 * defines `xxxname`, not `name` — while still being allowed between the name and its `()`, because
 * `name\<newline>() { …; }` really does define `name`. Both were verified under bash.
 */
const JOINED = '\u0000'

class ShellLexError extends Error {}

/** Newline offsets of a source, kept so `lineOf` does not re-walk a 350 KiB script per match. */
const NEWLINES = new Map<string, number[]>()

/** The 1-based line number of a byte offset, for error messages. */
function lineOf(source: string, offset: number): number {
  let newlines = NEWLINES.get(source)
  if (newlines === undefined) {
    newlines = []
    for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') newlines.push(i)
    if (NEWLINES.size >= 64) NEWLINES.clear()
    NEWLINES.set(source, newlines)
  }
  let lo = 0
  let hi = newlines.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (newlines[mid] < offset) lo = mid + 1
    else hi = mid
  }
  return lo + 1
}

type Ctx =
  | { t: 'code'; term: 'eof' | 'paren' | 'backtick'; depth: number; opened: number }
  | { t: 'sq'; opened: number }
  | { t: 'dq'; opened: number }
  | { t: 'ansi'; opened: number }
  | { t: 'arith'; depth: number; opened: number }

/**
 * `source` with every byte that is not unquoted shell code replaced by a blank, and every line
 * continuation collapsed to {@link JOINED} — same length as the input, so an offset in the mask is
 * an offset in the file.
 *
 * FAIL-CLOSED: a construct this cannot resolve throws. There is no "assume it closed" path, because
 * assuming it closed is how a definition hides inside the part that was assumed away.
 */
export function maskShellSource(source: string, where = 'the script'): string {
  const out: string[] = new Array(source.length)
  const blank = (i: number): void => { out[i] = source[i] === '\n' ? '\n' : ' ' }
  const stack: Ctx[] = [{ t: 'code', term: 'eof', depth: 0, opened: 0 }]
  /** Pending here-document terminators for the current line, in the order they were opened. */
  let heredocs: Array<{ tag: string; stripTabs: boolean }> = []
  /** True where a `#` would start a comment and a `((` would start arithmetic: at a word boundary. */
  let atWordStart = true
  let i = 0

  const fail = (offset: number, what: string): never => {
    throw new ShellLexError(
      `${where}: line ${lineOf(source, offset)} — ${what}. This scanner refuses to report a `
      + 'definition count for a file it cannot lex, because the part it could not read is exactly '
      + 'where an override would hide.')
  }

  while (i < source.length) {
    const ctx = stack[stack.length - 1]
    const c = source[i]

    if (ctx.t === 'sq') {
      blank(i)
      if (c === "'") stack.pop()
      i += 1
      continue
    }

    if (ctx.t === 'ansi') {
      blank(i)
      if (c === '\\' && i + 1 < source.length) { blank(i + 1); i += 2; continue }
      if (c === "'") stack.pop()
      i += 1
      continue
    }

    if (ctx.t === 'arith') {
      // Arithmetic is not command text: no word can be a function definition inside it, and its
      // `<<` is a shift rather than a here-document. Blanked whole, brackets counted so we leave
      // at the right `))`.
      if (c === '(') { ctx.depth += 1; blank(i); i += 1; continue }
      if (c === ')') {
        if (ctx.depth > 0) { ctx.depth -= 1; blank(i); i += 1; continue }
        if (source[i + 1] === ')') { blank(i); blank(i + 1); stack.pop(); i += 2; continue }
        // A single `)` closing what we entered as `$((` — bash re-reads it as `$( (`; we cannot.
        return fail(ctx.opened, 'an arithmetic expansion that does not close with `))`')
      }
      blank(i)
      i += 1
      continue
    }

    if (ctx.t === 'dq') {
      if (c === '\\' && i + 1 < source.length) { blank(i); blank(i + 1); i += 2; continue }
      if (c === '"') { blank(i); stack.pop(); i += 1; continue }
      if (c === '$' && source[i + 1] === '(' && source[i + 2] === '(') {
        blank(i); blank(i + 1); blank(i + 2)
        stack.push({ t: 'arith', depth: 0, opened: i })
        i += 3
        continue
      }
      if (c === '$' && source[i + 1] === '(') {
        // Code again, even inside the quotes.
        blank(i); out[i + 1] = '('
        stack.push({ t: 'code', term: 'paren', depth: 0, opened: i })
        atWordStart = true
        i += 2
        continue
      }
      if (c === '`') {
        // Blanked, not kept: a backtick opens (or closes) command text, so what follows it starts a
        // WORD. Left in the mask it would sit in front of a `name()` as a non-metacharacter and make
        // the definition read as the tail of a longer name.
        blank(i)
        stack.push({ t: 'code', term: 'backtick', depth: 0, opened: i })
        atWordStart = true
        i += 1
        continue
      }
      blank(i)
      i += 1
      continue
    }

    // ── code ──────────────────────────────────────────────────────────────────────────────────
    if (c === '\\') {
      if (source[i + 1] === '\n') {
        // A continuation JOINS the word: `name\<newline>()` is `name()`.
        out[i] = JOINED; out[i + 1] = JOINED
        i += 2
        continue
      }
      if (i + 1 < source.length) {
        // `\X` is one literal character of ordinary word content — never a metacharacter, never a
        // comment, never a quote. Two word bytes keep the offsets honest.
        out[i] = '_'; out[i + 1] = '_'
        atWordStart = false
        i += 2
        continue
      }
      return fail(i, 'a backslash at end of file')
    }

    if (c === "'") { blank(i); stack.push({ t: 'sq', opened: i }); atWordStart = false; i += 1; continue }
    if (c === '"') { blank(i); stack.push({ t: 'dq', opened: i }); atWordStart = false; i += 1; continue }
    if (c === '$' && source[i + 1] === "'") {
      blank(i); blank(i + 1)
      stack.push({ t: 'ansi', opened: i })
      atWordStart = false
      i += 2
      continue
    }
    if (c === '$' && source[i + 1] === '"') {
      blank(i); blank(i + 1)
      stack.push({ t: 'dq', opened: i })
      atWordStart = false
      i += 2
      continue
    }
    if (c === '$' && source[i + 1] === '(' && source[i + 2] === '(') {
      blank(i); blank(i + 1); blank(i + 2)
      stack.push({ t: 'arith', depth: 0, opened: i })
      atWordStart = false
      i += 3
      continue
    }
    if (c === '(' && source[i + 1] === '(' && atWordStart) {
      blank(i); blank(i + 1)
      stack.push({ t: 'arith', depth: 0, opened: i })
      atWordStart = false
      i += 2
      continue
    }
    if (c === '#' && atWordStart) {
      while (i < source.length && source[i] !== '\n') { blank(i); i += 1 }
      continue
    }
    if (c === '`') {
      blank(i)  // a word boundary, for the reason given where a backtick opens inside double quotes
      if (ctx.t === 'code' && ctx.term === 'backtick') stack.pop()
      else stack.push({ t: 'code', term: 'backtick', depth: 0, opened: i })
      atWordStart = true
      i += 1
      continue
    }
    if (c === '<' && source[i + 1] === '<' && source[i + 2] === '<') {
      // A here-STRING. Its word is ordinary code and it opens no body — but all three `<` have to
      // be consumed here, or the second and third read as a here-document whose delimiter is the
      // word that follows (`<<<"$query"` opened a body waiting for a line reading `$query`, and the
      // whole of deploy.sh vanished into it).
      out[i] = '<'; out[i + 1] = '<'; out[i + 2] = '<'
      atWordStart = true
      i += 3
      continue
    }
    if (c === '<' && source[i + 1] === '<') {
      // A here-document. Its body is data; the delimiter word stays as code, harmlessly.
      out[i] = '<'; out[i + 1] = '<'
      let j = i + 2
      let stripTabs = false
      if (source[j] === '-') { out[j] = '-'; stripTabs = true; j += 1 }
      while (source[j] === ' ' || source[j] === '\t') { out[j] = source[j]; j += 1 }
      let tag = ''
      while (j < source.length && !METACHARACTERS.includes(source[j])) {
        const d = source[j]
        if (d === "'" || d === '"') {
          const close = source.indexOf(d, j + 1)
          if (close === -1) return fail(j, `an unterminated ${d === "'" ? 'single' : 'double'} quote in a here-document delimiter`)
          tag += source.slice(j + 1, close)
          for (let k = j; k <= close; k += 1) out[k] = source[k]
          j = close + 1
          continue
        }
        if (d === '\\') { tag += source[j + 1] ?? ''; out[j] = source[j]; out[j + 1] = source[j + 1]; j += 2; continue }
        tag += d
        out[j] = d
        j += 1
      }
      if (tag === '') return fail(i, 'a here-document with no delimiter word')
      heredocs.push({ tag, stripTabs })
      atWordStart = false
      i = j
      continue
    }
    if (c === '\n') {
      out[i] = '\n'
      i += 1
      // Every here-document opened on this line takes its body now.
      for (const { tag, stripTabs } of heredocs) {
        let closed = false
        while (i < source.length) {
          let lineEnd = source.indexOf('\n', i)
          if (lineEnd === -1) lineEnd = source.length
          const text = source.slice(i, lineEnd)
          for (let k = i; k < lineEnd; k += 1) blank(k)
          if (lineEnd < source.length) out[lineEnd] = '\n'
          i = lineEnd + 1
          if ((stripTabs ? text.replace(/^\t+/, '') : text) === tag) { closed = true; break }
        }
        if (!closed) return fail(source.length - 1, `an unterminated here-document (no line reading \`${tag}\`)`)
      }
      heredocs = []
      atWordStart = true
      continue
    }

    out[i] = c
    if (ctx.t === 'code' && ctx.term === 'paren') {
      if (c === '(') ctx.depth += 1
      else if (c === ')') {
        if (ctx.depth === 0) stack.pop()
        else ctx.depth -= 1
      }
    }
    atWordStart = METACHARACTERS.includes(c)
    i += 1
  }

  const unclosed = stack[stack.length - 1]
  if (stack.length > 1 || (unclosed.t === 'code' && unclosed.term !== 'eof')) {
    const what = unclosed.t === 'sq' ? 'an unterminated single quote'
      : unclosed.t === 'dq' ? 'an unterminated double quote'
        : unclosed.t === 'ansi' ? "an unterminated $'…' quote"
          : unclosed.t === 'arith' ? 'an unterminated arithmetic expansion'
            : unclosed.term === 'backtick' ? 'an unterminated backtick substitution'
              : 'an unterminated $( … ) substitution'
    return fail(unclosed.opened, what)
  }
  if (heredocs.length > 0) return fail(source.length - 1, `an unterminated here-document (no line reading \`${heredocs[0].tag}\`)`)

  return out.join('')
}

/**
 * Offsets in `mask` at which `name` is defined as a function.
 *
 * Two shapes and no third: `name` then `(` `)`, or the word `function` then `name`. Bash has no
 * others. What is NOT consulted is what comes before — `if`, `while`, `until`, `!`, `time`, `elif`,
 * a `;`, a `{`, the start of the file — because `name()` unquoted is a definition WHEREVER it
 * appears and does not parse anywhere else. The only question about the character in front is
 * whether it ends a word, and bash answers that with its metacharacter set.
 */
function definitionOffsets(mask: string, name: string): number[] {
  const n = escapeForRegExp(name)
  const gap = `[${JOINED} \\t]*`
  const parens = `\\(${gap}\\)`
  const shape = new RegExp(
    `(?:function[${JOINED} \\t]+${n}(?:${gap}${parens})?(?=[${JOINED}${escapeForRegExp(METACHARACTERS)}]|$)|${n}${gap}${parens})`,
    'g')
  const found: number[] = []
  for (const match of mask.matchAll(shape)) {
    const start = match.index
    // Ours only if the word starts here. A word ends at a metacharacter and nowhere else, so any
    // other character in front — a letter, a `\`, a collapsed continuation, a `$`, a `!` written
    // without a space — makes this the tail of some LONGER name. Each of those was run under bash:
    // the appended definition takes effect only when the name stands alone.
    if (start === 0 || METACHARACTERS.includes(mask[start - 1])) found.push(start)
  }
  return found
}

/** Offsets in `mask` at which the word `eval` appears in shell code. */
function evalOffsets(mask: string): number[] {
  const found: number[] = []
  for (const match of mask.matchAll(/eval/g)) {
    const start = match.index
    const before = start === 0 ? '\n' : mask[start - 1]
    const after = mask[start + 4] ?? '\n'
    if (METACHARACTERS.includes(before) && METACHARACTERS.includes(after)) found.push(start)
  }
  return found
}

const MASK_CACHE = new Map<string, string>()

/** {@link maskShellSource}, memoised: the census walks 13 scripts once per symbol, not per byte. */
function maskCached(source: string, where: string): string {
  const hit = MASK_CACHE.get(source)
  if (hit !== undefined) return hit
  const mask = maskShellSource(source, where)
  if (MASK_CACHE.size >= 64) MASK_CACHE.clear()
  MASK_CACHE.set(source, mask)
  return mask
}

const DEPARSE_CACHE = new Map<string, string>()

/**
 * `source` as BASH ITSELF parses it, deparsed from the AST — the one reading in this file that is
 * not a re-implementation of bash's grammar.
 *
 * `--pretty-print` parses and prints; it does not run the script. Verified: a file whose first line
 * is `echo SIDE_EFFECT_RAN` comes back with that line printed as source text and nothing executed.
 * Every definition form collapses to the canonical `name () ` here, which is why counting over this
 * output catches a form the lexer above has never heard of.
 */
function bashDeparse(source: string, where: string): string {
  const cached = DEPARSE_CACHE.get(source)
  if (cached !== undefined) return cached
  const dir = mkdtempSync(join(tmpdir(), 'ims-shell-symbol-'))
  try {
    const file = join(dir, 'subject.sh')
    writeFileSync(file, source)
    const run = spawnSync('bash', ['--pretty-print', file], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
    if (run.error) {
      throw new ShellLexError(`${where}: bash could not be run to parse the script (${run.error.message}). `
        + 'This check reads the script with bash\'s own parser as well as its own lexer, and it refuses '
        + 'to report a count from one reading alone.')
    }
    if (run.status !== 0) {
      throw new ShellLexError(`${where}: bash refuses to parse the script (exit ${run.status}):\n${run.stderr}`)
    }
    if (DEPARSE_CACHE.size >= 64) DEPARSE_CACHE.clear()
    DEPARSE_CACHE.set(source, run.stdout)
    return run.stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Every line index at which `source` defines `name` as a function, in any form bash accepts — one
 * entry PER DEFINITION, so two on a single line are two.
 *
 * Throws rather than under-reporting: an unlexable file, an `eval`, or a disagreement with bash's
 * own parse all fail here. See the header for why that direction is the point.
 */
export function shellFunctionDefinitions(source: string, name: string, where = 'the script'): number[] {
  const mask = maskCached(source, where)

  const evals = evalOffsets(mask)
  if (evals.length > 0) {
    throw new ShellLexError(
      `${where}: line ${lineOf(source, evals[0])} runs \`eval\`, and no lexical reading of this file `
      + `can say how many times it defines ${name}(). \`eval 'publish_root_anchored() { return 0; }'\` `
      + 'installs a definition that is a STRING to this scanner, to any command-position rule, and to '
      + "bash's own parser, which deparses it straight back out as the string it is. The count is "
      + 'refused rather than guessed. Rewrite without `eval`, or give this file its own regressions.')
  }

  const offsets = definitionOffsets(mask, name)

  // BASH'S OWN READING OF THE SAME BYTES. Every form — `function name {`, a one-line body, a header
  // split by a backslash-newline, a definition after `if`/`while`/`until`/`!`/`time`/`elif` — comes
  // back as `name () `, so this count is taken WITHOUT any of the grammar above. A disagreement
  // means this file misread something; it is reported, never resolved in favour of the smaller
  // number, because the smaller number is the one an override hides behind.
  const canonical = definitionOffsets(maskCached(bashDeparse(source, where), `${where} (as bash parses it)`), name)
  if (canonical.length !== offsets.length) {
    throw new ShellLexError(
      `${where}: this scanner finds ${offsets.length} definition(s) of ${name}() `
      + `${offsets.length > 0 ? `(lines ${offsets.map((o) => lineOf(source, o)).join(', ')}) ` : ''}`
      + `but bash's own parse of the same bytes contains ${canonical.length}. `
      + 'The two readings must agree before a count is reported: they disagree exactly when this '
      + "file's lexer has missed a form bash accepts, which is the failure this guard has already "
      + 'made three times. Fix the lexer — do not take the lower number.')
  }

  return offsets.map((offset) => lineOf(source, offset) - 1)
}

/** Every line index at which `source` assigns `name` at top level (column 0). */
export function shellConstantAssignments(source: string, name: string): number[] {
  const escaped = escapeForRegExp(name)
  const shape = new RegExp(`^(?:(?:export|readonly|declare|typeset)\\s+(?:-\\w+\\s+)*)?${escaped}=`)
  const found: number[] = []
  source.split('\n').forEach((line, index) => {
    if (shape.test(line)) found.push(index)
  })
  return found
}

/**
 * The text of the one top-level shell function `name`, from `name() {` to the `}` in column 0.
 *
 * Throws if the script defines it a number of times other than once — see the header: the whole
 * point of lifting shipped text is to run what the script runs.
 */
export function shellFunction(source: string, name: string, where = 'the script'): string {
  const definitions = shellFunctionDefinitions(source, name, where)
  assert.notEqual(definitions.length, 0, `${where} must define ${name}()`)
  assert.equal(definitions.length, 1,
    `${where} defines ${name}() ${definitions.length} times, at lines ${definitions.map((l) => l + 1).join(', ')}. `
    + 'Bash runs the LAST one; a harness that lifts the first would measure code the script no longer executes, '
    + 'and a byte-identity comparison over it would pass while the entrypoint ran something else.')
  const lines = source.split('\n')
  assert.equal(lines[definitions[0]], `${name}() {`,
    `${where}: ${name}() must be defined at column 0 in the form \`${name}() {\`, which is what the `
    + `\`}\`-in-column-0 slice can cut. Found: ${JSON.stringify(lines[definitions[0]])}`)
  const start = source.indexOf(`\n${name}() {\n`)
  assert.notEqual(start, -1, `${where} must define ${name}()`)
  const rest = source.slice(start + 1)
  const end = rest.indexOf('\n}\n')
  assert.notEqual(end, -1, `${name}() must be closed by a } in column 0`)
  return rest.slice(0, end + 2)
}

/**
 * The one `NAME="value"` assignment in column 0, lifted rather than re-typed — and asserted to be
 * the only one, for the reason {@link shellFunction} gives.
 */
export function shellConstant(source: string, name: string, where = 'the script'): string {
  const line = shellConstantOptional(source, name, where)
  assert.ok(line, `${where} must define ${name} on one line`)
  return line
}

/** As {@link shellConstant}, but `undefined` when the script does not assign it at all. Still
 *  refuses a second assignment: "some other file defines it" is not "this file defines it twice". */
export function shellConstantOptional(source: string, name: string, where = 'the script'): string | undefined {
  const assignments = shellConstantAssignments(source, name)
  assert.ok(assignments.length <= 1,
    `${where} assigns ${name} ${assignments.length} times, at lines ${assignments.map((l) => l + 1).join(', ')}. `
    + 'Bash keeps the LAST assignment; a harness that lifts the first would run the script with a value '
    + 'the script itself no longer has.')
  if (assignments.length === 0) return undefined
  return source.split('\n')[assignments[0]]
}
