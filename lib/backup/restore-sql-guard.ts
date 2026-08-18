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
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ROUND 10 — THE DESYNCHRONISATION CLASS, AND WHY IT IS NOW CLOSED BY CONSTRUCTION
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A lexer that is one character out of step with PostgreSQL is WORSE than no lexer: it reports
 * "no transaction control" over a file whose `COMMIT` it simply could not see. Round 10's review
 * found the first instance (`SET SESSION standard_conforming_strings = off`, which the round-9 check
 * did not match because it only compared word 1 against the GUC name). Enumerating its siblings
 * found FIVE more accepted bypasses, of two different kinds:
 *
 *   A. THE ESCAPING-MODE FAMILY. Turning `standard_conforming_strings` off makes a backslash an
 *      escape inside EVERY plain `'…'` literal, which moves where that literal ENDS. Round 9
 *      defended this by trying to spot the statement that does it. That defence can never be
 *      complete, because the setting can be changed by:
 *         SET SESSION … / SET LOCAL … / SET … TO off / SET "standard_conforming_strings" = off
 *         RESET standard_conforming_strings / RESET ALL / SET … = DEFAULT
 *         SELECT set_config('standard_conforming_strings', 'off', false)   ← a FUNCTION call
 *         SELECT set_config('standard_' || 'conforming_strings', 'off', false)  ← computed name
 *         a DO block, a CALL, or ANY function whose body runs one of the above
 *      The last three are not lexically visible at all. Detecting the statement is the wrong shape
 *      of answer.
 *
 *      SO THE SCANNER NO LONGER DEPENDS ON THE SETTING. The two modes differ in exactly one place:
 *      a run of backslashes of ODD length immediately before a `'` inside a plain literal ends that
 *      literal when the setting is ON and does not when it is OFF. (`\\` pairs and `\x` for any
 *      other x close at the same quote under both modes, so neither is ambiguous.) That one
 *      construct is now REFUSED. Every other input lexes identically under both settings, so it no
 *      longer matters how — or whether — the setting was changed: by a statement the scanner can
 *      read, by one it cannot, or by the server's own default. The explicit `SET` check is kept as
 *      defence in depth and generalised to every spelling, but the guarantee no longer rests on it.
 *
 *   B. THE STRING-PREFIX FAMILY. `E'…'` uses backslash escapes and `'…'` does not, so the scanner
 *      has to know which it is looking at. Round 9 decided that from the LAST CHARACTER before the
 *      quote, so any identifier ending in `e` was read as an escape-string prefix — and
 *      `SELECT name'a\'; COMMIT; --' ;` was accepted, with the `COMMIT` swallowed as string
 *      content. That payload needs NO setting change: it works against a stock dump. Round 10
 *      recognised the prefix from the TOKEN before the quote instead — which was still wrong, and
 *      wrong in the direction that accepts. See round 11 below.
 *
 * The scan is therefore mode-independent, and the residue below is stated in those terms.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ROUND 11 — WHY THE SAME BYPASS CAME BACK A THIRD TIME, AND THE RULE THAT ENDS IT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Round 11 defeated the token-based prefix check with ONE SPACE:
 *
 *     CREATE DOMAIN e AS text;
 *     SELECT e 'a\'; COMMIT; --' ;
 *
 * `prevToken` is `W:E` there, because whitespace and comments push no token — so the scanner read
 * an escape-string, swallowed `COMMIT` as string content, and passed the file. PostgreSQL reads
 * `e 'a\'` as a typed constant of type `e` over a PLAIN literal, ends that literal at the second
 * quote, and executes the `COMMIT` at top level. Partial restore, again, by the third distinct
 * route in three rounds.
 *
 * THE UNDERLYING MISREADING, stated once so it is not re-fixed a fourth time. Rounds 9 and 10 both
 * asked "WHAT came before the quote?" — a character, then a token. Neither is the question.
 * PostgreSQL's rule is not about what came before at all; it is about ADJACENCY: `scan.l` matches
 * `xestart` as `[eE]{quote}` — ONE lexeme — so the prefix exists only when the `E` and the quote
 * are touching, and flex's longest-match rule is what stops `name'…'` from ever matching it.
 * A history of tokens has thrown position away, which is precisely the fact the rule turns on, so
 * every answer computed from it can be defeated by moving something. That is why this class kept
 * coming back: the model was missing the dimension the real rule lives in.
 *
 * SO POSITION IS NOW CARRIED. Every token records the absolute stream offset where it ENDED, and a
 * prefix is recognised only when that offset is the quote's own offset. Whitespace, comments,
 * newlines and chunk boundaries all move the offset and therefore all break the prefix, exactly as
 * they do in PostgreSQL.
 *
 * AND THE RULE THAT MAKES THE DIRECTION SAFE, which is the part that generalises beyond `E`:
 *
 *     A LEXICAL DECISION THAT WIDENS WHAT THE SCANNER WILL SWALLOW MUST BE PROVEN EXACTLY.
 *     ONE THAT ONLY NARROWS MAY BE APPROXIMATE, AND SHOULD BE DELIBERATELY LOOSE.
 *
 * Reading `E'…'` WIDENS: backslash escapes make the literal end later, so more bytes become string
 * content and a `COMMIT` can hide in them. That decision is now exact (adjacency), and when it is
 * not proven the scanner falls back to the PLAIN reading — which refuses `\'` as ambiguous, so the
 * fallback is a refusal rather than a guess. Reading `U&'…'` only NARROWS: its outcome is an
 * outright rejection, so its check is left LOOSE (token-based, whitespace-tolerant) on purpose —
 * being over-eager there costs a false reject, which is the direction this file fails in.
 *
 * THE SECOND HALF OF THE SAME BUG: WHAT COUNTS AS ONE WORD. Adjacency is only as good as the token
 * boundaries it is measured against. PostgreSQL's `ident_cont` is `[A-Za-z\200-\377_0-9\$]` — it
 * includes every non-ASCII byte — and this scanner's did not. So `xée'a\'` split into `xé`, a
 * standalone `e` and a quote, making the `e` adjacent and the payload live again through a
 * different door. `isWordChar` now accepts every code unit ≥ 0x80, so this scanner's idea of one
 * identifier is PostgreSQL's, and no accented character can manufacture a prefix.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ROUND 12 — THE CHARACTER CLASSES THEMSELVES, AUDITED AGAINST A LIVE POSTGRESQL
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Round 11 fixed the `E`-prefix class soundly by carrying position. Round 12 found two MORE
 * accepted bypasses that had nothing to do with position — `$é$` and a bare `\r` — which makes
 * four consecutive rounds, each defeating this scanner by a different construct. The pattern is
 * not "one more missed case": it is that the scanner's CHARACTER CLASSES were written from
 * memory of PostgreSQL's grammar rather than checked against it. So this round stopped guessing
 * and MEASURED every class that decides where a literal or a comment ends, by running each
 * payload through a real `psql` 17.11 and asking whether a top-level `COMMIT` actually executed
 * (a stray one outside a transaction says so itself: `WARNING: there is no transaction in
 * progress`). The comparison, and its three surprises, are recorded here so the next round starts
 * from measurements instead of repeating them.
 *
 *   CLASS                     PostgreSQL (scan.l)              THIS SCANNER          VERDICT
 *   ───────────────────────────────────────────────────────────────────────────────────────────
 *   dolq_start                [A-Za-z\200-\377_]               [A-Za-z_]             FIXED ↓
 *   dolq_cont                 [A-Za-z\200-\377_0-9]            [A-Za-z0-9_]          FIXED ↓
 *   newline (ends a comment)  [\n\r]                           [\n]                  FIXED ↓
 *   space                     [ \t\n\r\f\v]                    [ \t\r]               FIXED ↓
 *   ident_start / ident_cont  [A-Za-z\200-\377_](0-9\$)        ≥0x80 accepted        matches
 *   xestart                   [eE]{quote}, ONE lexeme          adjacency (round 11)  matches
 *   xcstart / xcstop / nested  `\/\*{op_chars}*` / `\*+\/`      char-pair + depth     matches
 *   quotecontinue             {quote}{ws_with_newline}{quote}  two separate literals equivalent
 *   COPY end-of-data          `\.` alone, or `\.` then CR      `trimEnd() == '\.'`   FIXED ↓
 *
 * THE THREE SURPRISES, all of which contradicted what this file would otherwise have assumed:
 *
 *      (Block-comment delimiters are spelled `\/\*` and `\*\/` throughout this comment, for the
 *      obvious reason.)
 *
 *   1. `\/\*\/\*` DOES nest to depth two. `xcstart` is `\/\*{op_chars}*` and both `*` and `/` are
 *      op_chars, so it looked as though PostgreSQL would swallow `\/\*\/\*` as ONE comment-open
 *      and close it on the first `\*\/`, leaving this scanner one level deep and swallowing real
 *      SQL — the bypass direction. Measured: `SELECT 1; \/\*\/\* x \*\/ COMMIT; \*\/` does NOT
 *      commit. Every block-comment variant tried (`\/\*\*\/`, `\/\*\/`, `\/\*+ hint \*\/`,
 *      `\/\* x \*\*\*\/`, nested) agrees with this scanner. NOTHING WAS CHANGED HERE, on
 *      evidence rather than on assumption.
 *
 *   2. A METACOMMAND DOES NOT END AT A BARE `\r`, even though a line COMMENT does. The two are
 *      different mechanisms: the lexer's `newline` class is `[\n\r]`, but psql's line reader
 *      (`pg_get_line`) splits on `\n` alone. Measured: `\echo AAA\rSELECT 2;` prints
 *      `AAA SELECT 2;` — the CR was argument whitespace, not a terminator. So the metacommand
 *      scan below still runs to the next `\n`, and `\r` was NOT added to it. Had this been
 *      "fixed" for symmetry with the comment rule, a metacommand line would have ended early and
 *      the remainder would have been lexed as SQL that psql never executes.
 *
 *   3. COPY DATA IS LINE-ORIENTED ON `\n` ONLY, and its end-of-data marker is exact. Measured:
 *      `\. ` (one trailing space) is NOT a terminator — psql reads on to EOF — and neither is
 *      `\.<CR>JUNK`; but `\.` followed by CR is. `trimEnd()` accepted all of them.
 *
 * WHAT CHANGED, and why each change is in the direction the header's rule permits:
 *
 *   • DOLLAR-QUOTE TAGS ARE NOW PostgreSQL's CLASSES EXACTLY, high bytes included. This one
 *     WIDENS what gets swallowed (a dollar body is skipped wholesale), so by the rule above it
 *     has to be exact — and it is, both against `scan.l` and against psql. It also had to change:
 *     FAILING to recognise a tag is not the safe direction here, which is the trap in the
 *     round-12 payload `SELECT $é$ '$é$; COMMIT; -- ' ;`. Not recognising `$é$` did not make the
 *     scanner read the body as harmless SQL — it made the `'` inside the body OPEN A STRING that
 *     ran on and swallowed the genuinely top-level `COMMIT` after it. A missed quoting construct
 *     desynchronises the scanner in whichever direction the file's author chooses, so "we simply
 *     won't recognise it" is never a fallback. REFUSING is the fallback, which is why an
 *     unresolvably long tag is now rejected rather than skipped.
 *
 *   • THE 128-CHARACTER TAG WINDOW IS GONE. It was a guess about how much input to hold back, and
 *     it was WRONG IN THE ACCEPTING DIRECTION: a tag longer than the window that straddled a
 *     chunk boundary was abandoned mid-tag and its body re-lexed as SQL, exactly as in the
 *     accented case. Production reads 64 KiB chunks, so this was reachable on any dump with a
 *     >128-character dollar tag. It is replaced by a scan over the real tag classes that holds
 *     only while the tag is genuinely unfinished, with a bound that REFUSES rather than guesses.
 *     Found by parameterising the fixtures over chunk size; a single whole-string scan accepts
 *     this payload and a single whole-string scan is what the old tests did.
 *
 *   • `\r` IS A NEWLINE WHERE PostgreSQL SAYS IT IS — it ends a line comment — and CRLF counts as
 *     one line, not two. This only NARROWS what is swallowed, so it may be (and is) loose.
 *
 *   • `atLineStart` IS DELIBERATELY *NOT* SET BY A BARE `\r`, though psql does recognise a
 *     metacommand there. Modelling psql's argument parsing exactly is a widening decision this
 *     file would then have to prove; refusing every backslash after a bare CR needs no proof and
 *     costs only a CR-only dump containing `\restrict`, which pg_dump does not emit. CRLF is
 *     unaffected: the `\n` still opens a line.
 *
 * ═══ WHAT THIS CATCHES ═══
 *   • transaction control as a top-level statement, in any case and any whitespace/comment layout,
 *     including several on one line and one split across lines;
 *   • psql metacommands (`\connect`, `\i`, `\copy`, …) at top level — a `\connect` would move the
 *     replay to another database entirely, outside the transaction AND outside the lock;
 *   • a dump that ends mid-string, mid-dollar-quote, mid-comment or mid-COPY block, i.e. one whose
 *     structure the scanner could not fully account for;
 *   • any literal whose END depends on `standard_conforming_strings`, and `U&'…'` strings, whose
 *     escape character is configurable — both refused as ambiguous rather than guessed;
 *   • any statement that names `standard_conforming_strings` (as a word, a quoted identifier or a
 *     string literal) other than the one safe form `SET [SESSION|LOCAL] standard_conforming_strings
 *     = on`, `RESET ALL`, and any `set_config(…)` other than the `search_path` call pg_dump emits.
 *
 * ═══ WHAT THIS CANNOT CATCH — stated, not footnoted ═══
 *   1. TRANSACTION CONTROL EXECUTED INDIRECTLY: `CALL some_proc()` where the procedure body runs
 *      `COMMIT`, or `EXECUTE 'COMMIT'` inside a function. The scanner sees `CALL`/`SELECT`, not the
 *      body. What limits this is PostgreSQL, not the scanner: under `--single-transaction` psql has
 *      already opened an explicit transaction block, and a procedure or DO block that attempts
 *      `COMMIT` inside one raises `invalid_transaction_termination` rather than committing. So this
 *      class ERRORS — which `ON_ERROR_STOP=1` turns into a clean rollback — instead of splitting
 *      the transaction. It is a limit of the scan, not a hole in the atomicity guarantee.
 *   2. A GUC CHANGED FROM INSIDE A FUNCTION BODY, `DO` block or `CALL`. Still invisible — but no
 *      longer load-bearing, per (A) above: the only setting that changed this lexer's answer no
 *      longer changes it.
 *   3. STATEMENTS THAT CANNOT RUN INSIDE A TRANSACTION BLOCK at all (`CREATE DATABASE`, `VACUUM`,
 *      `CREATE INDEX CONCURRENTLY`). They are not transaction control, so they pass the scan, and
 *      they then fail at execution — again a clean rollback, not a partial apply.
 *   4. WHETHER THE DUMP IS THE RIGHT DUMP, or whether its contents are safe. That is the manifest
 *      check's job (lib/backup-manifest.ts), not this one.
 *   5. A restore killed BETWEEN transactions cannot exist once this passes, but a restore killed
 *      mid-transaction still rolls back — that is PostgreSQL's guarantee, and it is why the psql
 *      timeout path terminates the backend rather than merely killing the client.
 *   6. FALSE REJECTS IT KNOWINGLY ACCEPTS, because refusing on ambiguity is the stated principle:
 *      a `CREATE FUNCTION … BEGIN ATOMIC … END;` body (PG14+ SQL-standard bodies are not
 *      dollar-quoted, so their inner `END;` reads as top-level transaction control), and a literal
 *      containing `\'`. Neither appears in a plain `pg_dump` of this application. Both refuse the
 *      file rather than passing it, which is the direction a wrong answer has to fail in.
 *
 * AMBIGUITY IS REFUSED, NOT ACCEPTED. Every case where the scanner cannot prove what it is looking
 * at — an unterminated construct, a string whose end depends on a setting, a prefix it cannot
 * attribute — rejects the file.
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

/** The one GUC whose value used to change this lexer's answer. See family (A) in the header. */
const LEXICAL_MODE_GUC = 'STANDARD_CONFORMING_STRINGS'
/** Values of it that leave the standard (and this scanner's) reading of a literal in force. */
const LEXICAL_MODE_ON_VALUES = new Set(['ON', 'TRUE', '1'])
/** The only `set_config` call a plain pg_dump emits; every other use of it is refused. */
const ALLOWED_SET_CONFIG_TARGET = 'SEARCH_PATH'

/** How much of a statement is retained for the checks above. Bounded so a 1 GB file cannot buffer. */
const MAX_STATEMENT_WORDS = 32
const MAX_STATEMENT_LITERALS = 4
const MAX_LITERAL_CHARS = 64
/**
 * How long a dollar-quote tag may be before the scanner gives up and refuses the file (round 12).
 *
 * PostgreSQL imposes no limit, but `carry` holds an unfinished tag across chunks, so SOME bound is
 * needed or a crafted file could buffer without end. The bound only applies to a tag still
 * unfinished at the end of the available input; a long tag that arrives complete is accepted
 * normally. It replaces a 128-character window that silently ABANDONED the tag instead of
 * refusing, which was itself a bypass at chunk sizes that straddled a long tag.
 */
const MAX_DOLLAR_TAG_CHARS = 256

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

/** A captured literal or quoted identifier. `truncated` matters: a clipped value proves nothing. */
type CapturedText = { value: string; truncated: boolean }

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
  let statementLiterals: CapturedText[] = []
  /** Quoted identifiers in the current statement — `SET "standard_conforming_strings" = off`. */
  let statementIdents: CapturedText[] = []
  /** Set while a literal's or identifier's contents are being captured. */
  let capturing: CapturedText | null = null
  /** Streaming `COPY … FROM stdin` detection — not a capped substring, so a wide table still works. */
  let copyFromStdin = false
  let previousWord = ''
  /**
   * The last two SIGNIFICANT TOKENS, as `W:<upper word>` or `C:<char>`.
   *
   * TOKENS, not characters (round 10, family (B) in the header). A string prefix is a token: `E'…'`
   * is the one-character token `E` followed by a quote. Deciding it from the last CHARACTER read
   * `name'…'` as an escape-string and let a top-level `COMMIT` be swallowed as string content.
   * Carried across chunk boundaries, which a regex over a chunk cannot be.
   */
  let prevToken = ''
  let prevToken2 = ''
  /**
   * The ABSOLUTE stream offset one past the end of `prevToken` (round 11).
   *
   * This is the dimension a token history throws away, and the one PostgreSQL's string-prefix rule
   * actually turns on. Absolute rather than chunk-relative so a prefix split across a chunk
   * boundary is measured the same way as one that is not.
   */
  let prevTokenEnd = -1
  /** Absolute stream offset of the first character of `carry` — the base for every offset above. */
  let streamPos = 0
  /** Buffer carried between chunks so a construct split across chunks still lexes. */
  let carry = ''
  /** True at the very start of a line (for metacommand and `\.` detection). */
  let atLineStart = true

  function reject(message: string): never {
    throw new RestoreSqlRejected(message, line)
  }

  /**
   * PostgreSQL's `ident_cont`, not a convenient subset of it (round 11).
   *
   * `scan.l` defines `ident_cont` as `[A-Za-z\200-\377_0-9\$]`, so EVERY non-ASCII byte continues
   * an identifier. Leaving them out split `xée` into `xé` + `e`, which handed the adjacency test a
   * standalone `E` that PostgreSQL never sees, and re-opened the escape-string bypass through a
   * different door. Whether the file was decoded as UTF-8 (one char ≥ 0x80) or byte-wise (several,
   * each ≥ 0x80) the answer is the same, which is why the test is on the code unit and not on a
   * character class.
   */
  function isWordChar(c: string): boolean {
    return /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80
  }

  /**
   * PostgreSQL's `dolq_start` — `[A-Za-z\200-\377_]`. NOT the same class as `ident_start`: a
   * dollar-quote tag may not begin with a digit (`$1$` is the parameter `$1` followed by a stray
   * `$`, which psql confirms), and `$` itself is excluded because it terminates the tag.
   */
  function isDollarTagStart(c: string): boolean {
    return /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80
  }

  /**
   * PostgreSQL's `dolq_cont` — `[A-Za-z\200-\377_0-9]`. Digits are allowed after the first
   * character; `$` still is not. The high-byte range is the half round 12 was missing: without it
   * `$é$` was not read as a delimiter at all, and the `'` inside its body opened a string that
   * swallowed the following top-level `COMMIT`.
   */
  function isDollarTagCont(c: string): boolean {
    return /[A-Za-z0-9_]/.test(c) || c.charCodeAt(0) >= 0x80
  }

  /** `endAbs` is the absolute offset one past this token's last character. */
  function pushToken(token: string, endAbs: number) {
    prevToken2 = prevToken
    prevToken = token
    prevTokenEnd = endAbs
  }

  function capture(text: string) {
    if (capturing === null) return
    if (capturing.value.length >= MAX_LITERAL_CHARS) { capturing.truncated = true; return }
    capturing.value += text
  }

  function endCapture(into: CapturedText[]) {
    if (capturing === null) return
    if (into.length < MAX_STATEMENT_LITERALS) into.push(capturing)
    capturing = null
  }

  function resetStatement() {
    atStatementStart = true
    statementWords = []
    statementLiterals = []
    statementIdents = []
    capturing = null
    copyFromStdin = false
    previousWord = ''
  }

  /** Does this statement name `standard_conforming_strings` anywhere the scanner can see? */
  function mentionsLexicalModeGuc(): boolean {
    if (statementWords.includes(LEXICAL_MODE_GUC)) return true
    return [...statementLiterals, ...statementIdents]
      .some((c) => !c.truncated && c.value.toUpperCase() === LEXICAL_MODE_GUC)
  }

  /**
   * The ONE accepted spelling: `SET [SESSION|LOCAL] standard_conforming_strings [=|TO] on`, with
   * `on` also spelled `true`, `1` or quoted. Every plain pg_dump emits it, so it cannot be refused;
   * everything else that names the GUC — including `= DEFAULT`, which resolves to a server default
   * this scanner cannot read — is refused rather than interpreted.
   */
  function isLexicalModeReaffirmed(): boolean {
    if (statementIdents.length > 0) return false
    const words = [...statementWords]
    if (words[0] !== 'SET') return false
    if (words[1] === 'SESSION' || words[1] === 'LOCAL') words.splice(1, 1)
    if (words[1] !== LEXICAL_MODE_GUC) return false
    if (words[2] === 'TO') words.splice(2, 1)
    if (statementLiterals.length > 1) return false
    if (statementLiterals.length === 1) {
      const literal = statementLiterals[0]
      return words.length === 2 && !literal.truncated && LEXICAL_MODE_ON_VALUES.has(literal.value.toUpperCase())
    }
    return words.length === 3 && LEXICAL_MODE_ON_VALUES.has(words[2])
  }

  function finishStatement() {
    // DEFENCE IN DEPTH, NOT THE GUARANTEE (round 10). Since a literal whose end depends on this
    // setting is refused outright, a missed spelling here can no longer desynchronise the lexer.
    // It is still refused, because a dump that wants the escaping mode changed is not a dump this
    // route should be replaying, and because a diagnosis naming the cause beats one that does not.
    if (mentionsLexicalModeGuc() && !isLexicalModeReaffirmed()) {
      reject(
        'Restore file changes standard_conforming_strings, which decides how string literals are '
        + 'terminated; only `SET standard_conforming_strings = on` is accepted',
      )
    }
    if (statementWords[0] === 'RESET' && statementWords[1] === 'ALL') {
      reject(
        'Restore file resets every session setting (RESET ALL), which can change how string '
        + 'literals are terminated; this file cannot be checked for transaction control',
      )
    }
    if (statementWords.includes('SET_CONFIG')) {
      // `SELECT pg_catalog.set_config('search_path', '', false);` is pg_dump's own. Any other
      // set_config — including one whose target is computed at run time and therefore unreadable
      // here — is refused rather than parsed.
      const target = statementLiterals[0]
      const allowed = statementWords[0] === 'SELECT'
        && target !== undefined
        && !target.truncated
        && target.value.toUpperCase() === ALLOWED_SET_CONFIG_TARGET
      if (!allowed) {
        reject(
          'Restore file calls set_config() for something other than search_path; it can change a '
          + 'session setting this check depends on and will not be replayed',
        )
      }
    }
    if (copyFromStdin) state = { kind: 'copy-data' }
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
    // Absolute offset of `text[0]`, so every position below can be expressed in stream coordinates
    // that survive a chunk boundary. `hold` is the ONE way input is carried forward, so the two
    // cannot drift apart.
    const base = streamPos
    const hold = (at: number) => { carry = text.slice(at); streamPos = base + at }
    let i = 0
    // A dollar-quote tag or a `\.` terminator can straddle a chunk boundary; hold back a small tail
    // and re-examine it with the next chunk rather than guessing.
    const limit = text.length
    while (i < limit) {
      const c = text[i]

      // PostgreSQL's `newline` class is `[\n\r]` and `non_newline` is `[^\n\r]`, so a bare CR ends
      // a `--` line comment exactly as LF does (round 12). Only LF did, and `-- x\rCOMMIT;` was
      // therefore swallowed whole while psql executed the COMMIT.
      //
      // COPY data is excluded on purpose and is NOT a symmetry gap: psql reads COPY data with
      // `pg_get_line`, which splits on `\n` alone, so a CR there is ordinary data. Measured, not
      // assumed — see the round-12 notes in the header.
      if (c === '\r' && state.kind !== 'copy-data') {
        // A CR at the very end of the input may be the first half of a CRLF; hold it back so the
        // pair is always counted as one line rather than two.
        if (i + 1 >= limit) { hold(i); return }
        line += 1
        if (state.kind === 'line-comment') state = { kind: 'sql' }
        if (text[i + 1] === '\n') {
          // CRLF: the LF is what psql's line reader splits on, so this does open a new line.
          atLineStart = true
          i += 2
        } else {
          // A bare CR deliberately does NOT open a line for metacommand purposes. See round 12.
          i += 1
        }
        continue
      }

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
            hold(i)
            return
          }
          // psql's end-of-data marker is the line `\.`, optionally with a trailing CR (a CRLF
          // dump). It is EXACT: measured against psql 17.11, `\. ` with one trailing space is not
          // a terminator and neither is `\.<CR>JUNK` — psql reads on to EOF in both cases.
          // `trimEnd()` accepted all of them, which ended the data block early and lexed the rest
          // of the data as SQL.
          if (lineText === '\\.' || lineText === '\\.\r') {
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
          if (i === limit - 1 && (c === '*' || c === '/')) { hold(i); return }
          i += 1
          continue
        }

        case 'single': {
          if (c === '\\') {
            if (i + 1 >= limit) { hold(i); return }
            if (state.escapes) {
              // An `E'…'` literal: backslash escapes are the standard reading, in every mode.
              capture(text.slice(i, i + 2))
              i += 2
              continue
            }
            // A PLAIN literal, where the reading DEPENDS ON standard_conforming_strings.
            //   `\\`  — an escaped backslash (off) or two backslashes (on). Either way the literal
            //           continues past both, so the two modes agree and this is not ambiguous.
            //   `\x`  — an escape for some other character (off) or a backslash then x (on). Again
            //           the literal ends at the same quote under both.
            //   `\'`  — an escaped QUOTE (off) or a backslash followed by the literal's TERMINATOR
            //           (on). The two modes disagree about where this literal ends, and therefore
            //           about which of the following bytes are SQL. Refused: this is the exact
            //           ambiguity every `standard_conforming_strings` payload is built on, and
            //           refusing it is what makes this scan independent of the setting's value.
            if (text[i + 1] === '\\') { capture('\\\\'); i += 2; continue }
            if (text[i + 1] === "'") {
              reject(
                'Restore file contains a backslash-escaped quote inside a plain string literal, '
                + 'where the literal ends depends on standard_conforming_strings; this file cannot '
                + 'be checked for transaction control',
              )
            }
            capture('\\')
            i += 1
            continue
          }
          if (c === "'") {
            if (i + 1 >= limit) { hold(i); return }
            if (text[i + 1] === "'") {
              capture("'")
              i += 2
              continue
            }
            state = { kind: 'sql' }
            endCapture(statementLiterals)
            pushToken("C:'", base + i + 1)
            i += 1
            continue
          }
          capture(c)
          i += 1
          continue
        }

        case 'double': {
          if (c === '"') {
            if (i + 1 >= limit) { hold(i); return }
            if (text[i + 1] === '"') { capture('"'); i += 2; continue }
            state = { kind: 'sql' }
            endCapture(statementIdents)
            pushToken('C:"', base + i + 1)
            i += 1
            continue
          }
          capture(c)
          i += 1
          continue
        }

        case 'dollar': {
          const close = state.tag
          if (c === '$') {
            if (i + close.length > limit) { hold(i); return }
            if (text.startsWith(close, i)) {
              state = { kind: 'sql' }
              pushToken('C:$', base + i + close.length)
              i += close.length
              continue
            }
          }
          i += 1
          continue
        }

        case 'sql': {
          // PostgreSQL's `space` is `[ \t\n\r\f\v]`. CR and LF are handled above; form feed and
          // vertical tab were previously falling through to the token push at the bottom of this
          // case, which is harmless (a token breaks prefix adjacency exactly as whitespace does)
          // but is not what PostgreSQL calls them.
          if (c === ' ' || c === '\t' || c === '\f' || c === '\v') { i += 1; continue }

          // A psql metacommand is only a metacommand at the start of a line, in SQL context.
          if (c === '\\') {
            if (!atLineStart) {
              reject('Restore file contains an unexpected backslash outside a string literal')
            }
            const nl = text.indexOf('\n', i)
            if (nl === -1) { hold(i); return }
            const command = text.slice(i, nl)
            if (!ALLOWED_METACOMMAND.test(command)) {
              reject('Restore file contains an unsupported psql metacommand')
            }
            i = nl
            continue
          }

          if (c === '-' && text[i + 1] === '-') { state = { kind: 'line-comment' }; i += 2; atLineStart = false; continue }
          if (c === '-' && i === limit - 1) { hold(i); return }
          if (c === '/' && text[i + 1] === '*') { state = { kind: 'block-comment', depth: 1 }; i += 2; atLineStart = false; continue }
          if (c === '/' && i === limit - 1) { hold(i); return }

          atLineStart = false

          if (c === ';') {
            finishStatement()
            pushToken('C:;', base + i + 1)
            i += 1
            continue
          }

          if (c === "'") {
            // Is the character before this quote the last character of the previous token, or is
            // there whitespace, a comment or a newline in between? THAT is PostgreSQL's rule for a
            // string prefix (`scan.l` matches `[eE]{quote}` as one lexeme), and it is the fact
            // rounds 9 and 10 kept computing without — first from the previous character, then from
            // the previous token, both of which are blind to a single space. See round 11 above.
            const prefixTouchesQuote = prevTokenEnd === base + i

            // `U&'…'` chooses its own escape character (UESCAPE, default backslash), so the scanner
            // cannot know what it is reading. Refused rather than guessed — and because the outcome
            // is a REFUSAL, this check is deliberately left loose: adjacency is NOT required, so
            // `u & 'x'` is refused too. Over-eagerness here costs a false reject, which is the
            // direction this file is allowed to be wrong in.
            if (prevToken === 'C:&' && prevToken2 === 'W:U') {
              reject(
                "Restore file contains a Unicode-escape string literal (U&'…'), whose escape "
                + 'character is configurable; this file cannot be checked for transaction control',
              )
            }
            // `E'…'` uses backslash escapes, so reading one WIDENS what the scanner swallows — a
            // `COMMIT` can hide inside a literal that ends later than a plain one would. That makes
            // it the decision that has to be exact: the previous token must be a standalone `E` AND
            // must touch this quote. When it does not, the plain reading applies, and the plain
            // reading REFUSES `\'` as ambiguous — so an unproven prefix ends in a refusal rather
            // than in a guess.
            const escapes = prevToken === 'W:E' && prefixTouchesQuote
            state = { kind: 'single', escapes }
            capturing = { value: '', truncated: false }
            pushToken("C:'", base + i + 1)
            i += 1
            continue
          }

          if (c === '"') {
            state = { kind: 'double' }
            capturing = { value: '', truncated: false }
            pushToken('C:"', base + i + 1)
            i += 1
            continue
          }

          if (c === '$') {
            // A dollar quote opens as `$tag$`, where the tag is `dolq_start dolq_cont*` or empty;
            // `$1` is a parameter and a bare `$` is not special. Scanned against PostgreSQL's own
            // classes rather than matched with an ASCII regex — see round 12 in the header.
            let j = i + 1
            if (j < limit && isDollarTagStart(text[j])) {
              j += 1
              while (j < limit && isDollarTagCont(text[j])) j += 1
            }
            if (j >= limit) {
              // The tag runs to the end of the input we have, so it may continue into the next
              // chunk. Hold it back rather than guess — but only within a bound, because `carry`
              // is the one place input accumulates. Beyond the bound the construct is
              // unresolvable, and an unresolvable construct is REFUSED, never skipped: skipping a
              // tag re-lexes its body as SQL, which is how the round-12 payload hid its COMMIT.
              if (j - i > MAX_DOLLAR_TAG_CHARS) {
                reject(
                  'Restore file contains a dollar-quote tag too long for this check to resolve, so '
                  + 'the end of the quoted block cannot be located and the file cannot be checked '
                  + 'for transaction control',
                )
              }
              hold(i)
              return
            }
            if (text[j] === '$') {
              state = { kind: 'dollar', tag: text.slice(i, j + 1) }
              pushToken('C:$', base + j + 1)
              i = j + 1
              continue
            }
            // Not a delimiter. PostgreSQL's `dolqfailed` rule throws back everything but the
            // leading `$` and treats that as an ordinary character, so this does the same.
            pushToken('C:$', base + i + 1)
            i += 1
            continue
          }

          if (isWordChar(c)) {
            let j = i
            while (j < limit && isWordChar(text[j])) j += 1
            if (j === limit) { hold(i); return }
            const word = text.slice(i, j)
            const upper = word.toUpperCase()
            if (atStatementStart) atStatementStart = false
            if (statementWords.length < MAX_STATEMENT_WORDS) statementWords.push(upper)
            if (statementWords.length <= 2) checkTransactionControl()
            // Streaming, so a COPY with more column names than any fixed-size buffer would hold
            // still enters data mode. Getting this wrong lexes tab-separated DATA as SQL, which is
            // the same desynchronisation by another route.
            if (statementWords[0] === 'COPY' && upper === 'STDIN' && previousWord === 'FROM') copyFromStdin = true
            previousWord = upper
            pushToken(`W:${upper}`, base + j)
            i = j
            continue
          }

          pushToken(`C:${c}`, base + i + 1)
          i += 1
          continue
        }
      }
    }
    // Everything in `text` was consumed and nothing was held back.
    streamPos = base + limit
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
