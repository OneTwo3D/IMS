/**
 * REFUSE A DUMP THAT CAN LEAVE THE DATABASE PARTIALLY RESTORED (o3d-osl8 round 9, finding 3).
 *
 * psql runs the restore with `--single-transaction` and `ON_ERROR_STOP=1`, so a statement that fails
 * halfway through a well-formed dump rolls the whole thing back. That guarantee is only worth
 * anything if the dump cannot END that transaction itself. A top-level `COMMIT;` — or `END;`,
 * `ROLLBACK;`, `ABORT;`, `START TRANSACTION;`, `SAVEPOINT`/`RELEASE` — splits the replay into
 * several transactions, and then a failure at line 40 000 leaves everything before the `COMMIT`
 * durable while the endpoint reports the restore as failed and turns maintenance mode back off.
 *
 * Rounds 7 and 8 argued this away twice ("plain pg_dump emits no transaction control") and then
 * recorded it as documented residue outside the lock's job. It is not residue: this route accepts an
 * operator-supplied upload, and for a whole-database restore a partial apply is the worst available
 * outcome — worse than refusing the file, worse than failing cleanly.
 *
 * WHY THIS IS A LEXER AND NOT A REGEX. `BEGIN` and `COMMIT` appear legitimately inside PL/pgSQL
 * function bodies, which pg_dump writes as dollar-quoted strings; inside ordinary string literals;
 * inside quoted identifiers; inside comments; and inside `COPY ... FROM stdin` data blocks, which
 * are not SQL at all. A line-oriented scan false-positives on every one of those and would reject
 * most real dumps. So the input is lexed: the scanner tracks quoting state across lines and only
 * inspects the FIRST WORD OF A STATEMENT at top level.
 *
 * ═══ WHAT THIS CATCHES ═══
 *   • transaction control as a top-level statement, in any case and any whitespace/comment layout,
 *     including several on one line and one split across lines;
 *   • psql metacommands (`\connect`, `\i`, `\copy`, …) at top level — a `\connect` would move the
 *     replay to another database entirely, outside the transaction AND outside the lock;
 *   • a dump that ends mid-string, mid-dollar-quote, mid-comment or mid-COPY block, i.e. one whose
 *     structure the scanner could not fully account for;
 *   • `standard_conforming_strings` being turned OFF, and `U&'...'` strings — both change what a
 *     backslash means inside a literal, so the scanner could no longer be sure where a string ends.
 *
 * ═══ WHAT THIS CANNOT CATCH — stated, not footnoted ═══
 *   1. TRANSACTION CONTROL EXECUTED INDIRECTLY: `CALL some_proc()` where the procedure body runs
 *      `COMMIT`, or `EXECUTE 'COMMIT'` inside a function. The scanner sees `CALL`/`SELECT`, not the
 *      body. What limits this is PostgreSQL, not the scanner: under `--single-transaction` psql has
 *      already opened an explicit transaction block, and a procedure or DO block that attempts
 *      `COMMIT` inside one raises `invalid_transaction_termination` rather than committing. So this
 *      class ERRORS — which `ON_ERROR_STOP=1` turns into a clean rollback — instead of splitting
 *      the transaction. It is a limit of the scan, not a hole in the atomicity guarantee.
 *   2. STATEMENTS THAT CANNOT RUN INSIDE A TRANSACTION BLOCK at all (`CREATE DATABASE`, `VACUUM`,
 *      `CREATE INDEX CONCURRENTLY`). They are not transaction control, so they pass the scan, and
 *      they then fail at execution — again a clean rollback, not a partial apply.
 *   3. WHETHER THE DUMP IS THE RIGHT DUMP, or whether its contents are safe. That is the manifest
 *      check's job (lib/backup-manifest.ts), not this one.
 *   4. A restore killed BETWEEN transactions cannot exist once this passes, but a restore killed
 *      mid-transaction still rolls back — that is PostgreSQL's guarantee, and it is why the psql
 *      timeout path terminates the backend rather than merely killing the client.
 *
 * AMBIGUITY IS REFUSED, NOT ACCEPTED. Every case where the scanner cannot prove what it is looking
 * at — an unterminated construct, a string-escaping mode it does not model — rejects the file.
 */

const TRANSACTION_CONTROL = new Set([
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'END',
  'ABORT',
  'START',
  'SAVEPOINT',
  'RELEASE',
  'PREPARE',
])

/**
 * Two of those words have a non-transactional statement form, so they are only rejected in the
 * two-word shape. `PREPARE name AS SELECT …` is a prepared statement; `PREPARE TRANSACTION 'x'` is
 * two-phase commit. `RELEASE` is deliberately NOT here: `RELEASE savepoint_name` is legal with the
 * keyword omitted, and `RELEASE` starts nothing else.
 */
const CONDITIONAL_CONTROL: Record<string, string> = {
  START: 'TRANSACTION',
  PREPARE: 'TRANSACTION',
}

/**
 * THE ONLY TWO METACOMMANDS A DUMP MAY CONTAIN, and why there are any (o3d-osl8 round 9, finding 3).
 *
 * pg_dump 17.6+ brackets every plain-format dump with `\restrict <token>` … `\unrestrict <token>`
 * (the CVE-2025-8714 hardening): between them psql REFUSES all metacommands, so the marker is itself
 * a defence against injected ones. Verified against a live `pg_dump 17.11` of this application's own
 * schema — 1.1 GB, and those two lines are the only metacommands in it besides the `\.` COPY
 * terminators, which the scanner handles as data-block structure rather than as commands.
 *
 * The previous validator rejected any line beginning with a backslash. That rejected `\.` and
 * `\restrict` alike, which means THIS ROUTE COULD NOT RESTORE A BACKUP THIS APPLICATION PRODUCED —
 * an unrelated pre-existing break, found by running the new scanner over a real dump instead of over
 * hand-written fixtures.
 *
 * The token is `[A-Za-z0-9]+` in pg_dump's generator; anything else — a quoted argument, a second
 * argument, trailing text — is refused, because a permissive match here is a way back to arbitrary
 * metacommands.
 */
const ALLOWED_METACOMMAND = /^\\(?:un)?restrict[ \t]+[A-Za-z0-9]+[ \t]*\r?$/

export class RestoreSqlRejected extends Error {
  readonly line: number
  constructor(message: string, line: number) {
    super(line > 0 ? `${message} (line ${line})` : message)
    this.name = 'RestoreSqlRejected'
    this.line = line
  }
}

type State =
  | { kind: 'sql' }
  | { kind: 'line-comment' }
  | { kind: 'block-comment'; depth: number }
  | { kind: 'single'; escapes: boolean }
  | { kind: 'double' }
  | { kind: 'dollar'; tag: string }
  | { kind: 'copy-data' }

/**
 * A streaming lexer. Feed it the file in chunks of any size (a chunk may split any construct,
 * including a dollar-quote tag), then call `end()`.
 */
export function createRestoreSqlScanner() {
  let state: State = { kind: 'sql' }
  let line = 1
  /** True while we are before the first word of a statement (start of file, or just after `;`). */
  let atStatementStart = true
  /** The leading words of the current statement, capped. Word 0 decides transaction control. */
  let statementWords: string[] = []
  /** String literals in the current statement, capped — `SET x = 'off'` needs the value. */
  let statementLiterals: string[] = []
  /** Set while a literal's contents are being captured into `statementLiterals`. */
  let capturingLiteral: string | null = null
  /** The current statement's text, capped — only used to spot `COPY … FROM stdin`. */
  let statementHead = ''
  /** The last two non-space chars, for `E'…'` and `U&'…'` detection. */
  let prevSignificant = ''
  let prevSignificant2 = ''
  /** Buffer carried between chunks so a construct split across chunks still lexes. */
  let carry = ''
  /** True at the very start of a line (for metacommand and `\.` detection). */
  let atLineStart = true

  function reject(message: string): never {
    throw new RestoreSqlRejected(message, line)
  }

  function isWordChar(c: string): boolean {
    return /[A-Za-z0-9_$]/.test(c)
  }

  function resetStatement() {
    atStatementStart = true
    statementWords = []
    statementLiterals = []
    capturingLiteral = null
    statementHead = ''
  }

  function finishStatement() {
    // `standard_conforming_strings = off` makes a backslash an escape inside EVERY literal, which
    // changes where literals end — i.e. it invalidates the lexing this whole guard rests on. Checked
    // at statement level rather than by a regex over the raw text, because a chunk boundary can fall
    // anywhere and a per-chunk regex silently misses the split case.
    if (statementWords[0] === 'SET' && statementWords[1] === 'STANDARD_CONFORMING_STRINGS') {
      const values = [...statementWords.slice(2), ...statementLiterals.map((v) => v.toUpperCase())]
      if (values.some((v) => v === 'OFF' || v === 'FALSE' || v === '0')) {
        reject(
          'Restore file disables standard_conforming_strings, which changes how string literals are '
          + 'terminated; this file cannot be checked for transaction control',
        )
      }
    }
    if (statementWords[0] === 'COPY' && /\bFROM\s+STDIN\b/i.test(statementHead)) {
      state = { kind: 'copy-data' }
    }
    resetStatement()
  }

  function checkTransactionControl() {
    const first = statementWords[0]
    if (!first || !TRANSACTION_CONTROL.has(first)) return
    const requiredSecond = CONDITIONAL_CONTROL[first]
    if (requiredSecond && statementWords[1] !== requiredSecond) return
    reject(
      `Restore file contains top-level transaction control (${first}${requiredSecond ? ` ${requiredSecond}` : ''}). `
      + 'The replay must be one transaction so that a mid-file failure cannot leave the database '
      + 'partially restored — re-take the dump with plain pg_dump and do not add transaction '
      + 'statements to it',
    )
  }

  function push(chunk: string): void {
    const text = carry + chunk
    carry = ''
    let i = 0
    // A dollar-quote tag or a `\.` terminator can straddle a chunk boundary; hold back a small tail
    // and re-examine it with the next chunk rather than guessing.
    const limit = text.length
    while (i < limit) {
      const c = text[i]

      if (c === '\n') {
        line += 1
        atLineStart = true
        if (state.kind === 'line-comment') state = { kind: 'sql' }
        else if (state.kind === 'copy-data') {
          // handled by the line scan below
        }
        i += 1
        continue
      }

      switch (state.kind) {
        case 'copy-data': {
          // Consume up to the end of the line; only a line that is exactly `\.` ends the block.
          const nl = text.indexOf('\n', i)
          const lineText = (nl === -1 ? text.slice(i) : text.slice(i, nl))
          if (nl === -1) {
            // Incomplete line: carry it so `\.` split across chunks is still recognised.
            carry = text.slice(i)
            return
          }
          if (lineText.trimEnd() === '\\.') {
            state = { kind: 'sql' }
            resetStatement()
          }
          i = nl
          continue
        }

        case 'line-comment': {
          i += 1
          continue
        }

        case 'block-comment': {
          if (c === '*' && text[i + 1] === '/') {
            const depth = state.depth - 1
            state = depth <= 0 ? { kind: 'sql' } : { kind: 'block-comment', depth }
            i += 2
            continue
          }
          if (c === '/' && text[i + 1] === '*') {
            state = { kind: 'block-comment', depth: state.depth + 1 }
            i += 2
            continue
          }
          if (i === limit - 1 && (c === '*' || c === '/')) { carry = text.slice(i); return }
          i += 1
          continue
        }

        case 'single': {
          if (state.escapes && c === '\\') {
            if (i + 1 >= limit) { carry = text.slice(i); return }
            i += 2
            continue
          }
          if (c === "'") {
            if (i + 1 >= limit) { carry = text.slice(i); return }
            if (text[i + 1] === "'") {
              if (capturingLiteral !== null && capturingLiteral.length < 32) capturingLiteral += "'"
              i += 2
              continue
            }
            state = { kind: 'sql' }
            if (capturingLiteral !== null) {
              if (statementLiterals.length < 4) statementLiterals.push(capturingLiteral)
              capturingLiteral = null
            }
            prevSignificant2 = prevSignificant
            prevSignificant = "'"
            i += 1
            continue
          }
          if (capturingLiteral !== null && capturingLiteral.length < 32) capturingLiteral += c
          i += 1
          continue
        }

        case 'double': {
          if (c === '"') {
            if (i + 1 >= limit) { carry = text.slice(i); return }
            if (text[i + 1] === '"') { i += 2; continue }
            state = { kind: 'sql' }
            prevSignificant2 = prevSignificant
            prevSignificant = '"'
            i += 1
            continue
          }
          i += 1
          continue
        }

        case 'dollar': {
          const close = state.tag
          if (c === '$') {
            if (i + close.length > limit) { carry = text.slice(i); return }
            if (text.startsWith(close, i)) {
              state = { kind: 'sql' }
              prevSignificant2 = prevSignificant
              prevSignificant = '$'
              i += close.length
              continue
            }
          }
          i += 1
          continue
        }

        case 'sql': {
          if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue }

          // A psql metacommand is only a metacommand at the start of a line, in SQL context.
          if (c === '\\') {
            if (!atLineStart) {
              reject('Restore file contains an unexpected backslash outside a string literal')
            }
            const nl = text.indexOf('\n', i)
            if (nl === -1) { carry = text.slice(i); return }
            const command = text.slice(i, nl)
            if (!ALLOWED_METACOMMAND.test(command)) {
              reject('Restore file contains an unsupported psql metacommand')
            }
            i = nl
            continue
          }

          if (c === '-' && text[i + 1] === '-') { state = { kind: 'line-comment' }; i += 2; atLineStart = false; continue }
          if (c === '-' && i === limit - 1) { carry = text.slice(i); return }
          if (c === '/' && text[i + 1] === '*') { state = { kind: 'block-comment', depth: 1 }; i += 2; atLineStart = false; continue }
          if (c === '/' && i === limit - 1) { carry = text.slice(i); return }

          atLineStart = false

          if (c === ';') {
            finishStatement()
            prevSignificant2 = prevSignificant
            prevSignificant = ';'
            i += 1
            continue
          }

          if (c === "'") {
            // `U&'…'` chooses its own escape character (UESCAPE, default backslash), so the scanner
            // cannot know where such a literal ends. Refused rather than guessed. Detected from the
            // two preceding significant characters, which survive a chunk boundary — a regex over
            // the raw chunk does not.
            if (prevSignificant === '&' && (prevSignificant2 === 'U' || prevSignificant2 === 'u')) {
              reject(
                "Restore file contains a Unicode-escape string literal (U&'…'), whose escape "
                + 'character is configurable; this file cannot be checked for transaction control',
              )
            }
            // `E'…'` uses backslash escapes; a bare literal does not (standard_conforming_strings,
            // which finishStatement asserts stays on). Getting this wrong shifts every subsequent
            // string boundary.
            const escapes = prevSignificant === 'E' || prevSignificant === 'e'
            state = { kind: 'single', escapes }
            // Capture the contents only where a value is load-bearing, so a 10MB literal is not
            // buffered: the SET statement above is the only case.
            capturingLiteral = statementWords[0] === 'SET' ? '' : null
            prevSignificant2 = prevSignificant
            prevSignificant = "'"
            i += 1
            continue
          }

          if (c === '"') { state = { kind: 'double' }; prevSignificant2 = prevSignificant; prevSignificant = '"'; i += 1; continue }

          if (c === '$') {
            // A dollar quote opens as `$tag$`; `$1` is a parameter and `$` alone is not special.
            const rest = text.slice(i)
            const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)
            if (match) {
              state = { kind: 'dollar', tag: match[0] }
              i += match[0].length
              prevSignificant2 = prevSignificant
              prevSignificant = '$'
              continue
            }
            // Could be a tag straddling the chunk boundary — only if there is no newline after it,
            // since a dollar-quote tag cannot contain one.
            if (!rest.includes('\n') && rest.length < 128) { carry = rest; return }
            prevSignificant2 = prevSignificant
            prevSignificant = '$'
            i += 1
            continue
          }

          if (isWordChar(c)) {
            let j = i
            while (j < limit && isWordChar(text[j])) j += 1
            if (j === limit) { carry = text.slice(i); return }
            const word = text.slice(i, j)
            if (atStatementStart) atStatementStart = false
            if (statementWords.length < 8) statementWords.push(word.toUpperCase())
            if (statementWords.length <= 2) checkTransactionControl()
            if (statementHead.length < 512) statementHead += ` ${word}`
            prevSignificant2 = prevSignificant
            prevSignificant = word[word.length - 1]
            i = j
            continue
          }

          if (statementHead.length < 512) statementHead += c
          prevSignificant2 = prevSignificant
          prevSignificant = c
          i += 1
          continue
        }
      }
    }
  }

  return {
    push,
    end(): void {
      // A synthetic final newline, always: it flushes a held-back tail (a word, a `\.`, a partial
      // dollar-quote tag) and closes a line comment on a file with no trailing newline. Without it,
      // a dump ending `-- Dumped by pg_dump` would be refused for ending "inside a construct".
      push('\n')
      if (carry.length > 0) {
        throw new RestoreSqlRejected(
          'Restore file ends with input the scanner could not resolve, so it cannot be checked for '
          + 'transaction control and will not be replayed',
          line,
        )
      }
      if (state.kind !== 'sql' && state.kind !== 'line-comment') {
        throw new RestoreSqlRejected(
          `Restore file ends inside an unterminated ${describe(state)}; it cannot be checked for `
          + 'transaction control and will not be replayed',
          line,
        )
      }
    },
  }
}

function describe(state: State): string {
  switch (state.kind) {
    case 'single': return 'string literal'
    case 'double': return 'quoted identifier'
    case 'dollar': return `dollar-quoted block (${state.tag})`
    case 'block-comment': return 'block comment'
    case 'copy-data': return 'COPY … FROM stdin data block (no terminating \\.)'
    default: return 'construct'
  }
}

/** Convenience for tests and small inputs. Throws `RestoreSqlRejected` on a refusal. */
export function scanRestoreSql(sql: string): void {
  const scanner = createRestoreSqlScanner()
  scanner.push(sql)
  scanner.end()
}
