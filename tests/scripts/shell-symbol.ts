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
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AND THE SAME THING FOR THE CONSTANT, WHICH WAS STILL A LINE ANCHOR (o3d-1dk9).
 *
 * The rewrite above made the FUNCTION half airtight and left the CONSTANT half exactly as it was:
 * a per-line regex, `^(?:export|readonly|declare|typeset\s+…)?NAME=`. So the whole of the argument
 * against enumerating command positions applied unanswered to the other symbol kind. Appending
 *
 *     true; PUBLISH_STAGE_DIRNAME="../../attacker"
 *
 * to scripts/deploy.sh was not caught, because the line does not START with the name. Verified
 * under a real bash: that is the value the script publishes through, while `shellConstant()` went
 * on returning install.sh's value and the parity comparison went on passing — the same vacuity, on
 * the constant that aims every publication's staging directory.
 *
 * WHAT COUNTS AS AN ASSIGNMENT NOW. `NAME=` or `NAME+=` where `NAME` STARTS A WORD in shell code,
 * at any indentation and in any command position, and NOT inside a function body. Three things
 * follow from writing it that way rather than as a line rule:
 *
 *   - Nothing in front is enumerated. `export NAME=`, `readonly NAME=`, `declare -r NAME=` and
 *     every prefix nobody has listed are caught by the word rule alone, exactly as `if`, `elif` and
 *     `time -p` are caught for a definition. What is excluded is excluded by the same rule:
 *     `$NAME=`, `${NAME}` and `x_NAME=` all have a non-metacharacter in front, so the name is the
 *     tail of something longer and is not ours.
 *   - It reads the MASK, so a `NAME=` inside a comment, a quoted string, a here-document body or an
 *     embedded awk program is not an assignment. It never was one; the line rule counted some of
 *     them.
 *   - "TOP LEVEL" MEANS SCOPE, NOT COLUMN 0. That is the distinction the old anchor was reaching
 *     for and could not express: it excluded `local NAME=` because such a line is INDENTED, which
 *     is a fact about layout, and it excluded `true; NAME=` for the same reason, which is a bypass.
 *     A body's extent is found with the mask in hand — see {@link braceGroupExtent} — so an
 *     indented `local NAME=` stays uncounted because it is inside a function, and a `true; NAME=`
 *     at script scope is counted because it is at script scope. Both were run under a real bash to
 *     establish which value bash takes BEFORE either was required of this scanner.
 *
 * A SCOPE THAT CANNOT BE DETERMINED IS REFUSED, NAMED — the same answer the definition scanner
 * gives. A function body may be any compound command: `f() ( … )`, `f() if …; fi` and
 * `f() for …; done` all parse, and the extent of a subshell body cannot be delimited by counting
 * parentheses once a `case` pattern's `)` is inside it — that would end the body EARLY and move an
 * assignment out of function scope without saying so. So only a `{ … }` group is measured and
 * every other body form throws and names its line. None of the 13 tracked scripts uses one: all 373
 * bodies are brace groups.
 *
 * BASH CROSS-CHECKS IT, AND HERE IS EXACTLY HOW FAR THAT GOES. `--pretty-print` does not label a
 * command with its scope, so it cannot be asked "is this assignment top level?" directly. What it
 * does do is render EVERY function body as a `{ … }` group at a fresh word boundary — `f() ( … )`,
 * `f() if …; fi` and `function f { … }` all come back as `f () \n{ \n … \n}` (verified) — so the
 * nesting in its output is bash's own rather than the author's layout. The same two rules are read
 * over that output, and both the NUMBER OF BODIES and the number of script-scope assignments must
 * match the raw reading or the guard goes red naming both. That catches a body this file failed to
 * find or delimited differently from bash, which is the failure this guard has actually had. It is
 * a second reading of the same question, not an oracle for it: a construct BOTH readings misread
 * alike is not caught by it, and this file says so rather than implying the parser settled it.
 *
 * WHAT THIS STILL CANNOT ANSWER, STATED RATHER THAN HIDDEN:
 *
 *   - AN UNQUOTED BRACE USED AS AN ORDINARY WORD. `echo }` inside a body ends it early here (an
 *     over-count, so the guard goes red) and `echo {` extends it to the end of the file (a refusal,
 *     since it never closes). Only a MATCHED spurious pair would move an assignment out of sight,
 *     and bash's deparse reproduces such a pair rather than resolving it. No brace is used that way
 *     in the 13 scripts.
 *   - AN ASSIGNMENT INSIDE A FUNCTION THAT REACHES THE GLOBAL — `declare -g NAME=` or a plain
 *     `NAME=` in a function that is then CALLED. Whether it takes effect depends on whether the
 *     function runs before the value is read, which is a dataflow question and not a lexical one.
 *     Scope is where this stops; it counts what executes at script scope.
 *   - A SOURCED FILE. `. lib.sh` may assign the name, and this reads one file. That is why the
 *     callers look the constant up in the entrypoint AND in scripts/lib/db-fence-protected.sh.
 *
 * AND TWO THINGS IT COUNTS THAT BASH DOES NOT TAKE, which is the direction to err in. A COMMAND
 * PREFIX — `NAME=x cmd` — assigns only in that command's environment, and a top-level SUBSHELL —
 * `( NAME=x )` — dies with the subshell; both were verified to leave the script's value unchanged,
 * and both are counted here. Each is a false positive that makes the guard RED and names the line,
 * never one that hides a second assignment. Neither appears in the 13 tracked scripts.
 *
 * AND THE COST OF FAILING CLOSED IS MEASURED AGAIN, because it was measured for the definitions and
 * the same guard gets deleted the first time it fires on ordinary code. Across the 13 tracked
 * scripts: 373 function bodies, all brace groups, and bash's parse of the same files contains 373
 * too; 45 (file, constant) pairs over the 20 publication constants, every one of them resolving to
 * EXACTLY ONE script-scope assignment under both readings, with no refusal anywhere. See the
 * constant census in install-root-safe-writes.test.ts.
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

/** True where a word ENDS: at a metacharacter, or at the end of the input. */
function endsWord(ch: string | undefined): boolean {
  return ch === undefined || METACHARACTERS.includes(ch)
}

/**
 * The `[start, end)` offsets of the brace group that begins at or after `from`.
 *
 * A `{` and a `}` are RESERVED WORDS, not metacharacters, so they delimit a group only where they
 * stand as a word of their own — which is the same word rule {@link definitionOffsets} uses, and
 * the reason `${VAR}`, `{a,b}` and `find … {} \;` are all passed over rather than counted: in each
 * of them the brace is glued to another character on one side or the other.
 *
 * REFUSES, NAMED, rather than guessing. A function body may be ANY compound command — `f() ( … )`,
 * `f() if …; fi`, `f() for …; done` are all legal and were all verified to parse — and a subshell
 * body cannot be delimited by counting parentheses once a `case` pattern's `)` is inside it, which
 * would end the body EARLY and silently. So only a brace group is measured; every other body form
 * throws and names its line. None of the 13 tracked scripts uses one (measured: 0 of 373 bodies).
 */
function braceGroupExtent(mask: string, from: number, where: string): [number, number] {
  let start = from
  while (start < mask.length && `${JOINED} \t\n`.includes(mask[start])) start += 1
  if (mask[start] !== '{' || !endsWord(mask[start + 1])) {
    throw new ShellLexError(
      `${where}: line ${lineOf(mask, Math.min(start, mask.length - 1))} — a function body this scanner cannot `
      + `delimit (it begins ${JSON.stringify(mask.slice(start, start + 24))}, not with a \`{\` group). `
      + 'A body may be any compound command, and the extent of a subshell or an `if`/`for` body is '
      + 'not a question a word-level lexer answers; ending it in the wrong place would move an '
      + 'assignment in or out of function scope without saying so. The extent is refused rather '
      + 'than guessed. Write the body as `{ … }`, or give this file its own regressions.')
  }
  let depth = 0
  for (let j = start; j < mask.length; j += 1) {
    const c = mask[j]
    if (c !== '{' && c !== '}') continue
    const opensWord = j === start || METACHARACTERS.includes(mask[j - 1])
    if (!opensWord || !endsWord(mask[j + 1])) continue
    if (c === '{') depth += 1
    else {
      depth -= 1
      if (depth === 0) return [start, j + 1]
    }
  }
  throw new ShellLexError(
    `${where}: line ${lineOf(mask, start)} — a function body opened by \`{\` that this scanner never `
    + 'sees closed by a `}` standing as its own word. The extent is refused rather than assumed to '
    + 'run to the end of the file.')
}

/**
 * `[start, end)` of every function BODY in `mask` — the regions in which an assignment is NOT at
 * script scope.
 *
 * The headers are found the way {@link definitionOffsets} finds them, with the name left open
 * instead of fixed: a word then `(` `)`, or the word `function` then a name. The one character bash
 * itself excludes from that word is `=` — `x=() { echo hi; }` is a SYNTAX ERROR, not a definition
 * (verified) — and excluding it is what keeps an ordinary `arr=()` from being read as a function
 * whose body cannot be found.
 */
function functionBodyRanges(mask: string, where: string): Array<[number, number]> {
  const meta = escapeForRegExp(METACHARACTERS)
  const gap = `[${JOINED} \\t]*`
  const ranges: Array<[number, number]> = []
  const seen = new Set<number>()
  const take = (from: number): void => {
    const extent = braceGroupExtent(mask, from, where)
    // `function name ()` matches both sweeps below and is ONE body, not two.
    if (seen.has(extent[0])) return
    seen.add(extent[0])
    ranges.push(extent)
  }

  for (const match of mask.matchAll(new RegExp(`[^${meta}${JOINED}=]+${gap}\\(${gap}\\)`, 'g'))) {
    const start = match.index
    if (start !== 0 && !METACHARACTERS.includes(mask[start - 1])) continue
    take(start + match[0].length)
  }

  for (const match of mask.matchAll(new RegExp(`(?:^|[${meta}])function[${JOINED} \\t]+`, 'g'))) {
    let at = match.index + match[0].length
    while (at < mask.length && !METACHARACTERS.includes(mask[at])) at += 1
    let after = at
    while (after < mask.length && `${JOINED} \t`.includes(mask[after])) after += 1
    if (mask[after] !== '(') { take(at); continue }
    after += 1
    while (after < mask.length && `${JOINED} \t`.includes(mask[after])) after += 1
    if (mask[after] !== ')') {
      throw new ShellLexError(
        `${where}: line ${lineOf(mask, at)} — a \`function\` header whose \`(\` this scanner does not see closed by \`)\`.`)
    }
    take(after + 1)
  }

  return ranges
}

/**
 * Offsets in `mask` at which `name` is ASSIGNED — `name=`, `name+=`, with or without an `export`,
 * `readonly`, `declare`, `typeset` or `local` in front of it.
 *
 * Nothing in front is enumerated, for the reason {@link definitionOffsets} gives: what makes the
 * match ours is only that `name` STARTS A WORD, and a word starts after a metacharacter and nowhere
 * else. `export NAME=` and `readonly NAME=` are caught by that without being named; `$NAME=`,
 * `${NAME}` and `x_NAME=` are excluded by it, because in each the character in front joins the name
 * to something longer.
 */
function assignmentOffsets(mask: string, name: string): number[] {
  const j = `[${JOINED}]*`
  const spelt = name.split('').map((c) => escapeForRegExp(c)).join(j)
  const found: number[] = []
  for (const match of mask.matchAll(new RegExp(`${spelt}${j}\\+?${j}=`, 'g'))) {
    const start = match.index
    if (start !== 0 && !METACHARACTERS.includes(mask[start - 1])) continue
    found.push(start)
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

/**
 * Every OFFSET at which `source` assigns `name` at script scope — outside every function body.
 *
 * Throws rather than under-reporting, for the same reasons {@link shellFunctionDefinitions} does:
 * an unlexable file, an `eval`, a body whose extent cannot be determined, or a disagreement with
 * bash's own parse all fail here.
 */
/**
 * The function bodies of `source` under BOTH readings — this file's lexer over the raw bytes, and
 * the same rules over `bash --pretty-print`'s deparse of them, which must agree on how many there
 * are before either is used to decide scope.
 *
 * The deparse is the reading that is not a re-implementation of bash's grammar. It cannot be asked
 * "is this assignment top level?" — `--pretty-print` labels nothing with a scope — but it renders
 * EVERY body as a `{ … }` group at a fresh word boundary, whatever the source wrote (`f() ( … )`,
 * `f() if …; fi` and `function f { … }` all come back as `f () \n{ \n … \n}`), so the nesting in
 * its output is bash's own rather than the author's layout.
 */
function bodyRangesBothReadings(source: string, where: string): {
  mask: string
  mine: Array<[number, number]>
  deparsedMask: string
  deparsed: Array<[number, number]>
} {
  const mask = maskCached(source, where)
  const mine = functionBodyRanges(mask, where)
  const deparsedWhere = `${where} (as bash parses it)`
  const deparsedMask = maskCached(bashDeparse(source, where), deparsedWhere)
  const deparsed = functionBodyRanges(deparsedMask, deparsedWhere)
  if (deparsed.length !== mine.length) {
    throw new ShellLexError(
      `${where}: this scanner finds ${mine.length} function body/bodies but bash's own parse of the `
      + `same bytes contains ${deparsed.length}. Scope is decided by those bodies, so the two `
      + 'readings must agree on them before anything is reported. Fix the lexer — do not take '
      + 'either number on its own.')
  }
  return { mask, mine, deparsedMask, deparsed }
}

/**
 * How many function BODIES `source` contains, under both readings.
 *
 * Exported for the census: a NUMBER is what separates a walk that visited the tracked scripts and
 * found nothing wrong from one that silently stopped visiting them.
 */
export function shellFunctionBodyCount(source: string, where = 'the script'): number {
  return bodyRangesBothReadings(source, where).mine.length
}

function constantAssignmentOffsets(source: string, name: string, where: string): number[] {
  const mask = maskCached(source, where)

  const evals = evalOffsets(mask)
  if (evals.length > 0) {
    throw new ShellLexError(
      `${where}: line ${lineOf(source, evals[0])} runs \`eval\`, and no lexical reading of this file `
      + `can say how many times it assigns ${name}. \`eval '${name}=/attacker'\` is a STRING to this `
      + "scanner, to any line rule, and to bash's own parser, which deparses it straight back out as "
      + 'the string it is. The count is refused rather than guessed.')
  }

  const { mine: bodies, deparsedMask, deparsed: deparsedBodies } = bodyRangesBothReadings(source, where)
  const offsets = assignmentOffsets(mask, name)
    .filter((offset) => !bodies.some(([start, end]) => offset >= start && offset < end))

  // BASH'S OWN READING OF THE SAME BYTES, as for the definitions. `--pretty-print` deparses from
  // the AST, and it renders EVERY function body as a `{ … }` group at a fresh word boundary —
  // `f() ( … )`, `f() if …; fi` and `function f { … }` all come back as `f () \n{ \n … \n}` —
  // so the nesting in this output is bash's own, not the author's layout. Reading the SAME two
  // rules over it must give the same number of bodies and the same number of script-scope
  // assignments. A disagreement means this file's lexer has misread something; it is reported,
  // never resolved in favour of the smaller number.
  //
  // WHAT THIS CROSS-CHECK CANNOT DO, stated rather than implied: `--pretty-print` does not label
  // a command with its scope, and this reads its output with the same word-level rules, so it is
  // a second reading of the same question and not an oracle for it. It catches a body this file's
  // lexer failed to find or delimited differently from bash — which is the failure mode this
  // guard has actually had — and it does not catch a construct both readings misread alike.
  const deparsed = assignmentOffsets(deparsedMask, name)
    .filter((offset) => !deparsedBodies.some(([start, end]) => offset >= start && offset < end))
  if (deparsed.length !== offsets.length) {
    throw new ShellLexError(
      `${where}: this scanner finds ${offsets.length} script-scope assignment(s) of ${name} `
      + `${offsets.length > 0 ? `(lines ${offsets.map((o) => lineOf(source, o)).join(', ')}) ` : ''}`
      + `but bash's own parse of the same bytes contains ${deparsed.length}. The two readings must `
      + 'agree before a count is reported: they disagree exactly when this file has misread a form '
      + 'bash accepts. Fix the lexer — do not take the lower number.')
  }

  return offsets
}

/**
 * Every line index at which `source` assigns `name` AT SCRIPT SCOPE — that is, anywhere outside a
 * function body, at any indentation and in any command position.
 *
 * THIS USED TO BE A LINE ANCHOR, AND THE ANCHOR WAS THE BYPASS (o3d-1dk9). The rule was
 * `^(?:export|readonly|declare|typeset\s+…)?NAME=` tested line by line, so appending
 *
 *     true; PUBLISH_STAGE_DIRNAME="../../attacker"
 *
 * to scripts/deploy.sh was invisible: the line does not START with the name. Verified under bash —
 * the appended value is the one the script then publishes through — while `shellConstant()` went on
 * returning install.sh's value and the parity comparison went on passing. That is exactly the
 * vacuity {@link shellFunctionDefinitions} was rewritten twice to remove, left standing on the
 * other half of the same claim: the constant that aims every publication's staging directory.
 *
 * SO THE ANCHOR IS GONE AND SCOPE REPLACES IT. "Top level" is not "column 0" — it is "not inside a
 * function body", which is what the old rule was reaching for and could not express. An indented
 * `local NAME=` inside a function stays uncounted because it is in a body, not because it is
 * indented; a `true; NAME=` at script scope is counted because it is at script scope, however it is
 * laid out. Both were run under a real bash to show which value bash takes before either was
 * required of this scanner.
 */
export function shellConstantAssignments(source: string, name: string, where = 'the script'): number[] {
  return constantAssignmentOffsets(source, name, where).map((offset) => lineOf(source, offset) - 1)
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

/**
 * The one line-prefix a lifted assignment may carry. This is NOT how the assignment is DETECTED —
 * detection asks only whether the name starts a word, so `export`, `readonly`, `local` and every
 * other prefix are caught without being listed. It is what the returned LINE is allowed to contain
 * besides the assignment itself, because the rigs in this directory EXECUTE that line: anything
 * else in front of it would be executed too, and would not be the assignment the caller asked for.
 */
const LIFTABLE_PREFIX = /^(?:(?:export|readonly|declare|typeset|local)[ \t]+(?:-[A-Za-z]+[ \t]+)*)?$/

/** As {@link shellConstant}, but `undefined` when the script does not assign it at all. Still
 *  refuses a second assignment: "some other file defines it" is not "this file defines it twice". */
export function shellConstantOptional(source: string, name: string, where = 'the script'): string | undefined {
  const offsets = constantAssignmentOffsets(source, name, where)
  assert.ok(offsets.length <= 1,
    `${where} assigns ${name} ${offsets.length} times at script scope, at lines ${offsets.map((o) => lineOf(source, o)).join(', ')}. `
    + 'Bash keeps the LAST assignment; a harness that lifts the first would run the script with a value '
    + 'the script itself no longer has.')
  if (offsets.length === 0) return undefined
  const lineStart = source.lastIndexOf('\n', offsets[0] - 1) + 1
  const lineEnd = source.indexOf('\n', offsets[0])
  const before = source.slice(lineStart, offsets[0])
  assert.match(before, LIFTABLE_PREFIX,
    `${where}: line ${lineOf(source, offsets[0])} assigns ${name} after ${JSON.stringify(before)}, and this `
    + 'function returns the WHOLE LINE for a rig to execute. Detection covers that assignment wherever '
    + 'it stands — that is the point of dropping the column-0 anchor — but the line around it cannot be '
    + 'lifted and run as if it were the assignment alone. Put the assignment on a line of its own.')
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd)
}
