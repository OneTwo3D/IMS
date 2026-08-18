import assert from 'node:assert/strict'
import test from 'node:test'

import { createRestoreSqlScanner, scanRestoreSql, RestoreSqlRejected } from '@/lib/backup/restore-sql-guard'

// ---------------------------------------------------------------------------
// o3d-osl8 round 9, finding 3 — accepted transaction control can leave a PARTIAL restore.
//
// psql replays the dump under `--single-transaction` with `ON_ERROR_STOP=1`, so a failure anywhere
// rolls the whole file back. A top-level `COMMIT;` in the dump ends that transaction: everything
// before it is durable, everything after it is not, and the endpoint still reports the restore as
// failed and switches maintenance mode back off. Rounds 7 and 8 argued this away as "plain pg_dump
// emits no transaction control" — an argument about well-formed input, over an operator-supplied
// upload — and round 8's test explicitly ASSERTED the accepting behaviour.
//
// The check has to be a lexer. `BEGIN`/`COMMIT` appear legitimately inside PL/pgSQL bodies (which
// pg_dump writes as dollar-quoted strings), inside string literals, inside comments and inside COPY
// data. Every test below that ACCEPTS is a case a naive scan would have rejected; every test that
// REJECTS is a case a naive scan would have missed.
// ---------------------------------------------------------------------------

/**
 * Shaped like a real `pg_dump --format=plain` file, because that is what this route is fed.
 *
 * Contains, deliberately: the `\restrict`/`\unrestrict` pair pg_dump 17.6+ emits, a COPY block whose
 * DATA mentions COMMIT and whose terminator is `\.`, a PL/pgSQL body containing BEGIN/COMMIT/END,
 * COMMIT inside a string literal, and COMMIT inside both comment forms.
 */
const REALISTIC_DUMP = `--
-- PostgreSQL database dump
--

\\restrict ffLfvChtK2Ej2Bjro0yjQ2DgkXfpunJAwj3fLSoDlxzh9PhgeAtWpnCJ9pPkEzr

SET statement_timeout = 0;
SET standard_conforming_strings = on;
SET default_table_access_method = heap;

CREATE TABLE public.settings (
    key text NOT NULL,
    value text NOT NULL
);

CREATE FUNCTION public.touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.value := 'x';
  COMMIT;
  RETURN NEW;
END;
$$;

COPY public.settings (key, value) FROM stdin;
plugin_xero_enabled	true
note	a value that says COMMIT; and BEGIN; and \\N
\\.

INSERT INTO public.settings VALUES ('msg', 'this literal contains COMMIT; too');
-- COMMIT; in a line comment
/* COMMIT; in a block comment */

\\unrestrict ffLfvChtK2Ej2Bjro0yjQ2DgkXfpunJAwj3fLSoDlxzh9PhgeAtWpnCJ9pPkEzr
`

function verdict(sql: string): string {
  try {
    scanRestoreSql(sql)
    return 'accepted'
  } catch (error) {
    assert.ok(error instanceof RestoreSqlRejected, 'refusals are typed, so a bug cannot masquerade as one')
    return error.message
  }
}

/** The same input, fed one character at a time. A chunk boundary must not change the verdict. */
function chunkedVerdict(sql: string, size = 1): string {
  try {
    const scanner = createRestoreSqlScanner()
    for (let i = 0; i < sql.length; i += size) scanner.push(sql.slice(i, i + size))
    scanner.end()
    return 'accepted'
  } catch (error) {
    return (error as Error).message
  }
}

// ---------------------------------------------------------------------------
// ROUND 12 — THE HARNESS ITSELF WAS THE REASON THESE KEPT GETTING THROUGH.
//
// Four rounds in a row found a fresh bypass of this lexer, and every one of them was ACCEPTED by
// the tests above before it was reported. That is a statement about the fixtures, not about the
// payloads: the fixtures fed each input exactly twice — whole, and one character at a time — and
// both of those happen to be the framings a streaming lexer is LEAST likely to get wrong.
//
// The two failure modes are different, and it is worth being exact about which harness gap each
// one exposes, because only one of them is fixed by more framings:
//
//   • `$é$` and the bare `\r` are accepted UNANIMOUSLY — whole, at size 1, and at every size in
//     between. No amount of chunking finds them. What finds them is comparing the verdict against
//     what PostgreSQL ACTUALLY DOES, which is why the fixtures below carry a measured `pgCommits`
//     rather than an expectation written from the grammar.
//
//   • The long dollar tag is a genuine framing DISAGREEMENT: reverting the fix accepts it at chunk
//     sizes 1-104 and refuses it whole. The old two-framing comparison would have caught that —
//     but only if someone had already written a 200-character dollar tag into the corpus. It
//     never was, because the payload has to be guessed before the framing matters.
//
// So the framing is now EXHAUSTIVE rather than sampled, and the assertion is unanimity: one
// verdict across every possible split, not agreement between two of them. That turns "someone
// must guess both the payload and the chunk size" into "any framing-dependent construct fails on
// whatever payload does reach the corpus" — a real narrowing of the gap, and not a claim to have
// closed it, since the unanimous cases above show framing is not where these mostly live.
// ---------------------------------------------------------------------------

/**
 * The verdict at EVERY chunk size from 1 to the whole input, plus the whole input in one push.
 *
 * Returns the single agreed verdict, or throws with the disagreement — a scanner whose answer
 * depends on how the file happened to be read is broken whichever answer is the right one, and the
 * disagreement is the interesting failure, so it is reported rather than collapsed.
 */
function unanimousVerdict(sql: string): string {
  const byVerdict = new Map<string, number[]>()
  const record = (v: string, size: number) => {
    const sizes = byVerdict.get(v)
    if (sizes === undefined) byVerdict.set(v, [size])
    else if (sizes.length < 6) sizes.push(size)
  }
  record(verdict(sql), 0)
  for (let size = 1; size <= sql.length; size += 1) record(chunkedVerdict(sql, size), size)
  if (byVerdict.size === 1) return [...byVerdict.keys()][0]
  const detail = [...byVerdict.entries()]
    .map(([v, sizes]) => `  at chunk sizes ${sizes.join(',')}${sizes.length >= 6 ? ',…' : ''} (0 = whole): ${v}`)
    .join('\n')
  throw new assert.AssertionError({
    message: `the verdict depends on chunk size for ${JSON.stringify(sql.slice(0, 60))}\n${detail}`,
  })
}

/** LF is what pg_dump emits; CRLF and bare CR are what a file that has been through Windows is. */
const asCrlf = (sql: string) => sql.replace(/\n/g, '\r\n')
const asCr = (sql: string) => sql.replace(/\n/g, '\r')

/**
 * A payload with its MEASURED PostgreSQL behaviour.
 *
 * `pgCommits` is not an opinion about the grammar: each of these was run through a live
 * `psql` 17.11 and classified by whether a top-level `COMMIT` actually executed, which a stray one
 * announces itself (`WARNING: there is no transaction in progress`). Four rounds of arguing from
 * a remembered `scan.l` produced four bypasses, so the ground truth here is the server's.
 */
type Measured = { name: string; sql: string; pgCommits: boolean }

test('a realistic pg_dump file is ACCEPTED, including every place BEGIN/COMMIT legitimately appears', () => {
  assert.equal(verdict(REALISTIC_DUMP), 'accepted')
})

test('the previous validator rejected this application\'s own backups', () => {
  // THE UNRELATED BREAK THIS ROUND FOUND, kept as a test because it is the reason to check a real
  // dump rather than a hand-written fixture. The old rule was `/^\s*\\/` per line, i.e. "reject any
  // line starting with a backslash". Both writers here run `pg_dump --format=plain`, whose output
  // contains `\.` COPY terminators and — on pg_dump 17.6+ — a `\restrict`/`\unrestrict` pair. So
  // the restore endpoint refused every backup this application produces.
  const oldRule = (sql: string) => sql.split('\n').some((line) => /^\s*\\/.test(line))
  assert.ok(oldRule(REALISTIC_DUMP), 'the old rule rejected it')
  assert.equal(verdict(REALISTIC_DUMP), 'accepted', 'and the lexer does not')
})

test('top-level transaction control is REJECTED, in every form and layout', () => {
  const rejected = [
    'UPDATE settings SET value = \'x\';\nCOMMIT;\n',
    'select 1;\n  commit ;\n',
    'SELECT 1;\nEND;\n',
    'ROLLBACK;',
    'ABORT;',
    'BEGIN;\nSELECT 1;\n',
    'START TRANSACTION;',
    'SAVEPOINT a;',
    'RELEASE a;',
    "PREPARE TRANSACTION 'x';",
    'SELECT 1; COMMIT;',                 // second statement on the same line
    'SELECT 1; /* here */ COMMIT;',      // separated by a comment
    'SELECT 1;\nCOM' + 'MIT\n;\n',       // keyword and terminator on different lines
  ]
  for (const sql of rejected) {
    assert.match(verdict(sql), /transaction control/, `should refuse: ${JSON.stringify(sql)}`)
  }
})

test('the two-word forms do not swallow the ordinary statements that share their keyword', () => {
  // `PREPARE name AS …` is a prepared statement, not two-phase commit. Refusing it would be a
  // false positive of exactly the kind that makes a guard get disabled.
  assert.equal(verdict('PREPARE p AS SELECT 1;'), 'accepted')
  assert.match(verdict("PREPARE TRANSACTION 'gid';"), /transaction control/)
})

test('only psql metacommands pg_dump itself emits are accepted', () => {
  assert.equal(verdict('\\restrict abc123XYZ\nSELECT 1;\n'), 'accepted')
  assert.equal(verdict('\\unrestrict abc123XYZ\n'), 'accepted')
  for (const sql of [
    '\\connect postgres\n',
    '\\i /etc/passwd\n',
    "\\copy settings from '/etc/passwd'\n",
    '\\restrict abc; \\connect evil\n',   // a second command smuggled onto the same line
    '\\restrict\n',                       // no token
    '\\restricted abc\n',                 // near-miss name
    "\\restrict 'abc'\n",                 // quoted argument
  ]) {
    assert.match(verdict(sql), /metacommand/, `should refuse: ${JSON.stringify(sql)}`)
  }
})

test('a file the scanner cannot fully account for is REFUSED, not accepted', () => {
  // The stated preference: ambiguity refuses. Each of these leaves the lexer in a state where it
  // can no longer say where the next statement begins, so it cannot claim there is no COMMIT.
  assert.match(verdict('CREATE FUNCTION f() AS $$ BEGIN\n'), /unterminated dollar-quoted block/)
  assert.match(verdict("INSERT INTO t VALUES ('unclosed\n"), /unterminated string literal/)
  assert.match(verdict('/* unclosed\nSELECT 1;\n'), /unterminated block comment/)
  assert.match(verdict('COPY t FROM stdin;\n1\t2\n'), /unterminated COPY/)
  assert.match(verdict('SET standard_conforming_strings = off;\n'), /standard_conforming_strings/)
  assert.match(verdict("SET standard_conforming_strings TO 'off';\n"), /standard_conforming_strings/)
  assert.match(verdict("SELECT U&'\\0041';"), /Unicode-escape/)
})

test('COMMIT is only transaction control at the START of a statement', () => {
  // A `COMMIT` in the middle of a statement is a syntax error for psql, not a commit — treating it
  // as one would reject dumps for no reason. This is the case that makes the "first word" rule the
  // right rule rather than a convenient one.
  assert.equal(verdict('ALTER TABLE t ADD CONSTRAINT c FOREIGN KEY (a) REFERENCES commit_log(id);'), 'accepted')
  assert.equal(verdict('SELECT commit FROM t;'), 'accepted')
  assert.equal(verdict('INSERT INTO t (commit) VALUES (1);'), 'accepted')
})

test('an E-string backslash escape does not shift where the literal ends', () => {
  // If the scanner got this wrong, everything after it would be lexed in the wrong state — the
  // classic way a SQL scanner produces both false positives and silent misses.
  assert.equal(verdict("SELECT E'it\\'s fine'; SELECT 2;"), 'accepted')
  assert.match(verdict("SELECT E'it\\'s fine'; COMMIT;"), /transaction control/)
  assert.equal(verdict("SELECT 'doubled '' quote'; SELECT 2;"), 'accepted')
  assert.match(verdict("SELECT 'doubled '' quote'; COMMIT;"), /transaction control/)
})

test('a chunk boundary cannot change the verdict', () => {
  // The scanner is fed by a read stream, so every construct — a dollar-quote tag, a `\.`
  // terminator, a keyword, a `\restrict` line — can be split across two chunks. Fed one character
  // at a time, every case above must reach the same answer.
  for (const sql of [
    REALISTIC_DUMP,
    'SELECT 1;\nCOMMIT;\n',
    '\\restrict abc123\nSELECT 1;\n',
    '\\connect postgres\n',
    'CREATE FUNCTION f() RETURNS void AS $tag$ COMMIT; $tag$;\n',
    'COPY t FROM stdin;\nCOMMIT;\n\\.\nSELECT 1;\n',
    'SET standard_conforming_strings = off;\n',
    "SELECT U&'\\0041';",
    // ROUND 10. Each of these was ACCEPTED whole AND one character at a time before the fix, so
    // chunk parity here is the assertion that the fix is in the lexer's state and not in a regex
    // that happens to see the whole file.
    "SET SESSION standard_conforming_strings = off;\nSELECT 'a\\'; -- '; COMMIT;\n",
    "SELECT 'a\\'; -- '; COMMIT;\n",
    "SELECT name'a\\'; COMMIT; --' ;\n",
    "SELECT set_config('standard_conforming_strings', 'off', false);\n",
  ]) {
    assert.equal(chunkedVerdict(sql), verdict(sql), `chunking changed the verdict for ${JSON.stringify(sql.slice(0, 40))}`)
  }
})

test('COPY data is data — its contents are never read as SQL, and its terminator is not a metacommand', () => {
  const sql = 'COPY public.settings (key, value) FROM stdin;\nk\tCOMMIT;\nj\t\\connect evil\n\\.\nSELECT 1;\n'
  assert.equal(verdict(sql), 'accepted')
  // ...but the block genuinely ends at `\.`, so control after it is still caught.
  assert.match(verdict(sql.replace('SELECT 1;', 'COMMIT;')), /transaction control/)
})

test('a file with no trailing newline is not refused for that alone', () => {
  // The scanner appends a synthetic final newline, so a dump ending mid-comment or mid-word is
  // resolved rather than reported as "ends inside a construct". Refusing ambiguity must not spill
  // over into refusing ordinary files.
  assert.equal(verdict('SELECT 1;\n-- Dumped by pg_dump'), 'accepted')
  assert.equal(verdict('SELECT 1;'), 'accepted')
  // ...but a genuinely unterminated construct is still refused, newline or not.
  assert.match(verdict("SELECT 'unterminated"), /unterminated string literal/)
  assert.match(verdict('COM' + 'MIT'), /transaction control/)
})

test('a dollar-quoted body ends only at its OWN tag', () => {
  assert.equal(verdict('CREATE FUNCTION f() RETURNS void AS $a$ SELECT $b$ inner $b$; $a$;\nSELECT 1;\n'), 'accepted')
  assert.match(verdict('CREATE FUNCTION f() RETURNS void AS $a$ SELECT 1; $a$;\nCOMMIT;\n'), /transaction control/)
})

// ---------------------------------------------------------------------------
// o3d-osl8 ROUND 10, FINDING 1 — the lexer could be knocked out of step, and then it reported
// "no transaction control" over a file whose COMMIT it simply could not see.
//
// The review found ONE spelling (`SET SESSION`). Enumerating its siblings found five more accepted
// bypasses, and the last of them needs no setting change at all. The tests below are grouped by the
// CLASS each one belongs to, because fixing them one payload at a time is what produced a guard
// that could be defeated by the next spelling.
// ---------------------------------------------------------------------------

/** The payload from the review, reduced to its two halves. */
const ESCAPED_QUOTE_HIDING_COMMIT = "SELECT 'a\\'; -- '; COMMIT;\nSELECT 1;\n"

test('the reported bypass is refused: SET SESSION + an escaped quote that hides a top-level COMMIT', () => {
  // PostgreSQL reads `'a\'; -- '` as ONE literal when standard_conforming_strings is off, so the
  // `COMMIT;` after it is a top-level statement and the replay is no longer one transaction. The
  // round-9 scanner read the literal as ending at the quote after the backslash and swallowed the
  // COMMIT as line-comment content — the exact shape of desynchronisation this guard exists to
  // avoid, since a partial restore is the outcome it is protecting against.
  const payload = 'SET SESSION standard_conforming_strings = off;\n' + ESCAPED_QUOTE_HIDING_COMMIT
  assert.notEqual(verdict(payload), 'accepted')
  assert.equal(chunkedVerdict(payload), verdict(payload))
})

test('every spelling that can turn standard_conforming_strings off is refused, not just the one', () => {
  // A guard that matched `SET <name>` and nothing else was defeated by `SET SESSION <name>`. These
  // are its siblings; each was ACCEPTED before this round.
  for (const statement of [
    'SET SESSION standard_conforming_strings = off;',
    'SET LOCAL standard_conforming_strings = off;',
    'SET standard_conforming_strings TO off;',
    'SET standard_conforming_strings = DEFAULT;',      // resolves to a server default we cannot read
    'SET "standard_conforming_strings" = off;',         // quoted identifier
    'set session STANDARD_CONFORMING_STRINGS = FALSE;', // case
    'RESET standard_conforming_strings;',
    'RESET ALL;',
    "SELECT set_config('standard_conforming_strings', 'off', false);",
    "SELECT pg_catalog.set_config('standard_conforming_strings', 'off', false);",
    "SELECT set_config('standard_' || 'conforming_strings', 'off', false);", // name computed at run time
  ]) {
    const sql = `${statement}\nSELECT 1;\n`
    assert.notEqual(verdict(sql), 'accepted', `should refuse: ${statement}`)
    assert.equal(chunkedVerdict(sql), verdict(sql), `chunking changed the verdict for ${statement}`)
  }
})

test('...while the ON form every pg_dump emits is still accepted, in its spellings too', () => {
  // Refusing this would refuse every backup this application produces — the failure mode round 9
  // found in the PREVIOUS validator, and the reason a guard has to be tested in both directions.
  for (const statement of [
    'SET standard_conforming_strings = on;',
    'SET SESSION standard_conforming_strings = on;',
    'SET LOCAL standard_conforming_strings = on;',
    'SET standard_conforming_strings TO on;',
    "SET standard_conforming_strings = 'on';",
    'SET standard_conforming_strings = true;',
    'SET standard_conforming_strings = 1;',
  ]) {
    assert.equal(verdict(`${statement}\nSELECT 1;\n`), 'accepted', `should accept: ${statement}`)
  }
})

test('THE CLASS IS CLOSED BY CONSTRUCTION: the verdict no longer depends on the setting at all', () => {
  // This is the assertion that matters more than any individual spelling above. The setting can
  // also be changed from inside a function body, a DO block or a CALL — none of which any lexer can
  // read — so a guard built on detecting the statement can never be complete.
  //
  // The two modes differ in exactly ONE construct: a backslash run of odd length immediately before
  // a quote inside a plain literal ends that literal when the setting is on and does not when it is
  // off. That construct is refused, so every other input lexes identically under both settings and
  // it stops mattering HOW the setting was changed. Here that is shown by removing the `SET`
  // entirely: the payload is refused on its own account.
  assert.match(verdict(ESCAPED_QUOTE_HIDING_COMMIT), /backslash-escaped quote/)
  assert.equal(chunkedVerdict(ESCAPED_QUOTE_HIDING_COMMIT), verdict(ESCAPED_QUOTE_HIDING_COMMIT))

  // ...and the same payload behind an indirection no lexer can follow is refused for the same
  // reason, which is the point: the indirection is now irrelevant.
  assert.match(
    verdict('CALL some_procedure_that_sets_the_guc();\n' + ESCAPED_QUOTE_HIDING_COMMIT),
    /backslash-escaped quote/,
  )
  assert.match(
    verdict('DO $$ BEGIN EXECUTE \'SET standard_conforming_strings = off\'; END $$;\n' + ESCAPED_QUOTE_HIDING_COMMIT),
    /backslash-escaped quote/,
  )

  // The backslash forms whose reading does NOT depend on the setting stay accepted, so the refusal
  // is aimed at the ambiguity rather than at backslashes.
  assert.equal(verdict("SELECT 'a\\\\b'; SELECT 1;"), 'accepted', 'an escaped backslash closes at the same quote in both modes')
  assert.equal(verdict("SELECT 'a\\nb'; SELECT 1;"), 'accepted', 'and so does a backslash before any non-quote')
  assert.match(verdict("SELECT 'a\\\\b'; COMMIT;"), /transaction control/, 'and the scan still runs afterwards')
})

test('a string prefix is the previous TOKEN, not the previous character', () => {
  // THE SIXTH BYPASS, and the worst of them: it needs NO setting change and works against a stock
  // dump. Round 9 decided "is this an E'…' escape-string?" from the last character before the
  // quote, so `name'…'`, `date'…'` and `true'…'` — ordinary typed literals — were lexed as
  // escape-strings, and `SELECT name'a\'; COMMIT; --' ;` was ACCEPTED with the COMMIT swallowed.
  assert.notEqual(verdict("SELECT name'a\\'; COMMIT; --' ;\nSELECT 1;\n"), 'accepted')
  assert.notEqual(verdict("SELECT date'a\\'; COMMIT; --' ;\nSELECT 1;\n"), 'accepted')

  // A real E-string still uses backslash escapes...
  assert.equal(verdict("SELECT E'it\\'s fine'; SELECT 2;"), 'accepted')
  // ...and a typed literal with no ambiguity in it is still ordinary SQL.
  assert.equal(verdict("SELECT date'2020-01-01'; SELECT 1;"), 'accepted')
  assert.match(verdict("SELECT date'2020-01-01'; COMMIT;"), /transaction control/)

  // The same rule on the other prefix: `U&'…'` is refused because its escape character is
  // configurable, but an identifier merely ENDING in `u` is not that prefix.
  assert.match(verdict("SELECT U&'\\0041';"), /Unicode-escape/)
  assert.equal(verdict("SELECT menu & 'x'; SELECT 1;"), 'accepted')
})

test("pg_dump's own set_config call is accepted and every other one is refused", () => {
  // Plain pg_dump emits `SELECT pg_catalog.set_config('search_path', '', false);` many times, so a
  // blanket refusal of set_config would refuse every real dump. Everything else it can be pointed
  // at — including a target computed at run time — is refused instead of parsed.
  assert.equal(verdict("SELECT pg_catalog.set_config('search_path', '', false);\nSELECT 1;\n"), 'accepted')
  assert.match(verdict("SELECT set_config('search_path', '', false);\nCOMMIT;\n"), /transaction control/)
  assert.match(verdict("SELECT set_config('backslash_quote', 'off', false);\n"), /set_config/)
})

test('a COPY wider than any fixed-size buffer still enters DATA mode', () => {
  // The round-9 code decided "is this COPY … FROM stdin?" from the first 512 characters of the
  // statement. A table with enough columns pushes `FROM stdin` past that, and then the tab-separated
  // DATA is lexed as SQL — a quote in a value puts the scanner in a string state PostgreSQL is not
  // in, which is the same desynchronisation by another route. Detection is now streaming.
  const columns = Array.from({ length: 200 }, (_, i) => `column_number_${i}`).join(', ')
  const sql = `COPY public.wide (${columns}) FROM stdin;\nvalue\tit's data\tCOMMIT;\n\\.\nSELECT 1;\n`
  assert.equal(verdict(sql), 'accepted')
  assert.equal(chunkedVerdict(sql), 'accepted')
  // ...and the block still genuinely ends at `\.`
  assert.match(verdict(sql.replace('SELECT 1;', 'COMMIT;')), /transaction control/)
})

test('WHITESPACE, COMMENTS AND NEWLINES between E and the quote do not make an escape-string', () => {
  // o3d-osl8 ROUND 11, FINDING 1 — the same bypass, back for the third time by a third route.
  //
  // Round 9 read the prefix from the previous CHARACTER (`name'…'` became an escape-string). Round
  // 10 read it from the previous TOKEN and called the class closed by construction. One space
  // defeats that: whitespace pushes no token, so `prevToken` is still `W:E`.
  //
  //     CREATE DOMAIN e AS text;
  //     SELECT e 'a\'; COMMIT; --' ;
  //
  // PostgreSQL matches `xestart` as `[eE]{quote}` — ONE lexeme — so `e 'a\'` is a typed constant of
  // type `e` over a PLAIN literal, that literal ends at the second quote, and the `COMMIT` executes
  // at top level. The scanner read an escape-string and swallowed it. Prefix recognition is now
  // ADJACENCY: the previous token must END where the quote BEGINS.
  const payload = "SELECT e 'a\\'; COMMIT; --' ;\nSELECT 1;\n"
  assert.notEqual(verdict(payload), 'accepted')
  assert.notEqual(chunkedVerdict(payload), 'accepted')
  assert.notEqual(verdict("CREATE DOMAIN e AS text;\nSELECT e 'a\\'; COMMIT; --' ;\n"), 'accepted')

  // Every other way of putting distance between the two, since the rule is about position and not
  // about the space character in particular.
  assert.notEqual(verdict("SELECT e/*c*/'a\\'; COMMIT; --' ;\n"), 'accepted')
  assert.notEqual(verdict("SELECT e -- c\n'a\\'; COMMIT; --' ;\n"), 'accepted')
  assert.notEqual(verdict("SELECT e\n'a\\'; COMMIT; --' ;\n"), 'accepted')
  assert.notEqual(verdict("SELECT e\t'a\\'; COMMIT; --' ;\n"), 'accepted')
  assert.notEqual(verdict("SELECT E  'a\\'; COMMIT; --' ;\n"), 'accepted')

  // ...and the same for the plain-literal case that has no prefix at all, so the refusal above is
  // the PLAIN reading being applied rather than a new special case for `e`.
  assert.notEqual(verdict("SELECT 'a\\'; COMMIT; --' ;\n"), 'accepted')

  // A GENUINE escape-string is still one — the fix must not refuse what pg_dump legitimately emits.
  assert.equal(verdict("SELECT E'it\\'s fine'; SELECT 2;"), 'accepted')
  assert.equal(verdict("SELECT e'it\\'s fine'; SELECT 2;"), 'accepted')
  assert.equal(chunkedVerdict("SELECT E'it\\'s fine'; SELECT 2;"), 'accepted')
  // ...including one immediately after a closing quote, paren or dollar-quote, where adjacency
  // holds against a non-word token.
  assert.equal(verdict("SELECT ('x')::text, E'a\\'b'; SELECT 1;"), 'accepted')
  assert.equal(verdict("SELECT $$body$$, E'a\\'b'; SELECT 1;"), 'accepted')
})

test('a non-ASCII identifier ending in `e` is ONE word, so it cannot manufacture a prefix', () => {
  // ROUND 11, FINDING 1, second half. Adjacency is only as good as the token boundaries it is
  // measured against. PostgreSQL's `ident_cont` includes every byte in \200-\377, and this
  // scanner's word class did not — so `xée` split into `xé` and a standalone `e`, the `e` was
  // adjacent to the quote, and the payload was live again by a different door.
  assert.notEqual(verdict("SELECT xée'a\\'; COMMIT; --' ;\n"), 'accepted')
  assert.notEqual(chunkedVerdict("SELECT xée'a\\'; COMMIT; --' ;\n"), 'accepted')
  assert.notEqual(verdict("SELECT naïve'a\\'; COMMIT; --' ;\n"), 'accepted')
  // ...and the same for the U& prefix, whose refusal must not be dodgeable the same way.
  assert.notEqual(verdict("SELECT xé'\\0041'; COMMIT;\n"), 'accepted')

  // A non-ASCII identifier in ordinary use is still ordinary SQL.
  assert.equal(verdict('SELECT "café" FROM t; SELECT 1;'), 'accepted')
  assert.equal(verdict("INSERT INTO t VALUES ('café'); SELECT 1;"), 'accepted')
})

test('the U& refusal is deliberately LOOSE, because its outcome is a refusal', () => {
  // The asymmetry is the rule that generalises beyond `E`: a decision that WIDENS what the scanner
  // swallows must be exact, and one that only NARROWS may be approximate. Reading `E'…'` widens —
  // more bytes become string content — so it requires adjacency. Refusing `U&'…'` narrows, so it
  // does not, and `u & 'x'` is refused too. That false reject is the direction this file fails in.
  assert.match(verdict("SELECT U&'\\0041';"), /Unicode-escape/)
  assert.match(verdict("SELECT u  &  'x'; SELECT 1;"), /Unicode-escape/)
  assert.match(verdict("SELECT u\n&\n'x';"), /Unicode-escape/)
  // ...but an identifier merely ENDING in `u` is still not the prefix.
  assert.equal(verdict("SELECT menu & 'x'; SELECT 1;"), 'accepted')
})

// ---------------------------------------------------------------------------
// o3d-osl8 ROUND 12 — THE CHARACTER CLASSES, AUDITED AGAINST A LIVE POSTGRESQL.
//
// Rounds 9, 10 and 11 each fixed a rule about WHERE a construct ends. Round 12's two findings are
// about WHICH CHARACTERS a construct is made of, which is the layer underneath: `$é$` is a
// dollar-quote delimiter and a bare `\r` ends a line comment, and this scanner believed neither.
//
// The tests below assert against MEASURED PostgreSQL behaviour rather than against a reading of
// the grammar. Every `pgCommits: true` case was confirmed to execute a top-level COMMIT under
// psql 17.11, and every `pgCommits: false` case was confirmed not to; the scanner must refuse the
// first kind and is free to accept the second.
// ---------------------------------------------------------------------------

/**
 * WHY A MISSED QUOTING CONSTRUCT IS NOT THE SAFE DIRECTION.
 *
 * The instinct is that failing to recognise `$é$` just means the body gets read as SQL, and SQL
 * that does not parse gets refused. That is not what happens. The body is chosen by whoever wrote
 * the file, so it contains a single `'` — and the scanner, not being in a dollar-quote, opens a
 * STRING there. That string runs past the end of the real dollar-quoted literal and swallows the
 * genuinely top-level `COMMIT` that follows it.
 *
 * This is the shape of all four rounds' payloads, and it is why "the scanner will just not
 * recognise it" is never an argument for leaving a class wrong.
 */
const NON_ASCII_DOLLAR_TAG = "SELECT $\u00e9$ '$\u00e9$; COMMIT; -- ' ;\nSELECT 1;\n"

test('a non-ASCII dollar-quote tag cannot hide a top-level COMMIT', () => {
  // PostgreSQL's `dolq_start`/`dolq_cont` are [A-Za-z\200-\377_] and [A-Za-z\200-\377_0-9]: EVERY
  // high byte is a tag character. This scanner matched an ASCII-only regex, so `$é$` was not a
  // delimiter to it, and the `'` inside the body opened a string that swallowed the COMMIT.
  // Measured under psql 17.11: this payload DOES execute a top-level COMMIT.
  assert.match(unanimousVerdict(NON_ASCII_DOLLAR_TAG), /transaction control/)

  // Every position a high byte can occupy in a tag, since the two classes are different.
  assert.match(unanimousVerdict("SELECT $a\u00e9b$ '$a\u00e9b$; COMMIT; -- ' ;\n"), /transaction control/, 'high byte in dolq_cont')
  assert.match(unanimousVerdict("SELECT $\u00f1$ '$\u00f1$; COMMIT; -- ' ;\n"), /transaction control/, 'a different high byte')
  assert.match(unanimousVerdict("SELECT $\u{1d51e}$ '$\u{1d51e}$; COMMIT; -- ' ;\n"), /transaction control/, 'astral char = two code units, both >= 0x80')

  // ...and a non-ASCII tag in ORDINARY use is still a dollar-quoted body, so the fix recognises
  // the construct rather than merely refusing anything with a high byte near a `$`.
  assert.equal(unanimousVerdict('CREATE FUNCTION f() RETURNS void AS $caf\u00e9$ SELECT 1; $caf\u00e9$;\nSELECT 1;\n'), 'accepted')
  assert.match(
    verdict('CREATE FUNCTION f() RETURNS void AS $caf\u00e9$ SELECT 1; $caf\u00e9$;\nCOMMIT;\n'),
    /transaction control/,
    'and the scan resynchronises after it',
  )
  // A `BEGIN`/`COMMIT` inside such a body is still function source, not transaction control.
  assert.equal(verdict('CREATE FUNCTION f() RETURNS trigger AS $caf\u00e9$\nBEGIN\n  COMMIT;\nEND;\n$caf\u00e9$;\n'), 'accepted')
})

test('the dollar-quote tag classes match PostgreSQL exactly, in both directions', () => {
  // Each of these was measured under psql 17.11. `$1$` is NOT a tag — `$1` is a parameter — so
  // PostgreSQL puts the COMMIT inside the following plain literal and never executes it; the
  // scanner is therefore right to accept. Getting that one wrong in the other direction would
  // refuse dumps for no reason.
  const measured: Measured[] = [
    { name: 'empty tag', sql: "SELECT $$ '$$; COMMIT; -- ' ;\n", pgCommits: true },
    { name: 'ascii tag', sql: "SELECT $tag$ '$tag$; COMMIT; -- ' ;\n", pgCommits: true },
    { name: 'underscore start', sql: "SELECT $_q$ '$_q$; COMMIT; -- ' ;\n", pgCommits: true },
    { name: 'digit in dolq_cont', sql: "SELECT $a1$ '$a1$; COMMIT; -- ' ;\n", pgCommits: true },
    { name: 'high byte in dolq_start', sql: "SELECT $\u00e9$ '$\u00e9$; COMMIT; -- ' ;\n", pgCommits: true },
    // `$` is in `ident_cont` but NOT in `dolq_cont`, so `$a$b$` is the tag `$a$` and then `b$`.
    { name: '$ is not a tag char', sql: "SELECT $a$b$ '$a$b$; COMMIT; -- ' ;\n", pgCommits: true },
    // dolq_start excludes digits, so this is the parameter `$1` and the COMMIT ends up in a string.
    { name: 'digit START is a parameter', sql: "SELECT $1$ '$1$; COMMIT; -- ' ;\n", pgCommits: false },
    // A hyphen is in neither class, so `$a-b$` is not a delimiter either.
    { name: 'hyphen is not a tag char', sql: "SELECT $a-b$ '$a-b$; COMMIT; -- ' ;\n", pgCommits: false },
  ]
  for (const { name, sql, pgCommits } of measured) {
    const v = unanimousVerdict(sql)
    if (pgCommits) assert.match(v, /transaction control/, `PostgreSQL commits here, so the scanner must SEE that COMMIT — not merely refuse the file for some other reason: ${name}`)
    else assert.equal(v, 'accepted', `PostgreSQL hides the COMMIT here, so refusing it is a false reject: ${name}`)
  }
})

test('a dollar-quote tag longer than the scanner can hold is REFUSED, not abandoned mid-tag', () => {
  // THE BYPASS THE OLD HARNESS COULD NOT EXPRESS. The scanner used to hold back a straddling tag
  // only while the remaining text was under 128 characters; past that it gave up, emitted the `$`
  // as an ordinary character and carried on — abandoning the tag, which is the same
  // desynchronisation as not recognising `$é$`.
  //
  // Reverting the fix accepts this at chunk sizes 1-104 and refuses it whole, so it is a framing
  // DISAGREEMENT rather than a uniform miss — the kind `unanimousVerdict` reports by construction.
  // Production reads 64 KiB chunks, which puts it squarely in the accepting band whenever such a
  // tag straddles a read boundary. Measured under psql 17.11: a 200-character tag is a perfectly
  // ordinary dollar quote and this payload DOES execute a top-level COMMIT.
  const tag = `$${'z'.repeat(200)}$`
  assert.match(unanimousVerdict(`SELECT ${tag} '${tag}; COMMIT; -- ' ;\n`), /transaction control/)

  // The bound refuses rather than guesses: a tag that never terminates cannot be resolved, so the
  // file is refused with a diagnosis instead of being scanned in the wrong state.
  assert.match(verdict(`SELECT $${'z'.repeat(400)}`), /dollar-quote tag too long/)

  // ...and a long tag that DOES terminate is still an ordinary dollar quote, at every framing.
  assert.equal(unanimousVerdict(`SELECT ${tag} SELECT 1; ${tag};\nSELECT 2;\n`), 'accepted')
})

test('a bare CR ends a line comment, exactly as PostgreSQL says it does', () => {
  // PostgreSQL's `newline` class is [\n\r] and `non_newline` is [^\n\r], so `--` runs to EITHER.
  // Only LF ended a line comment here, so the comment swallowed the rest of a CR-terminated file
  // while psql ended it at the CR and executed the COMMIT. Measured under psql 17.11: this commits.
  assert.match(unanimousVerdict('SELECT 1; -- comment\rCOMMIT;\r'), /transaction control/)
  assert.match(unanimousVerdict('SELECT 1; -- comment\rCOMMIT;\n'), /transaction control/)
  // CRLF worked only by accident — the LF arrived immediately after the CR — so it is pinned too.
  assert.match(unanimousVerdict('SELECT 1; -- comment\r\nCOMMIT;\r\n'), /transaction control/)
  // A CR-only file with no comment at all: the statement split must still be found.
  assert.match(unanimousVerdict('SELECT 1;\rCOMMIT;\r'), /transaction control/)

  // A COMMIT that is genuinely still inside the comment stays hidden, so this narrows the comment
  // rather than abandoning it. Form feed and vertical tab are `space` in PostgreSQL, NOT `newline`.
  assert.equal(unanimousVerdict('SELECT 1; -- comment\fCOMMIT;\n'), 'accepted')
  assert.equal(unanimousVerdict('SELECT 1; -- comment\vCOMMIT;\n'), 'accepted')
  assert.equal(unanimousVerdict('SELECT 1; -- comment COMMIT;\nSELECT 2;\n'), 'accepted')
})

test('a CR inside a literal is content, not a terminator', () => {
  // The other direction of the same change: making CR a newline must not make it end a string.
  assert.match(unanimousVerdict("SELECT 'a\rb'; COMMIT;\n"), /transaction control/)
  assert.equal(unanimousVerdict("SELECT 'a\rb'; SELECT 2;\n"), 'accepted')
  assert.equal(unanimousVerdict('SELECT $q$a\rb$q$; SELECT 2;\n'), 'accepted')
  assert.equal(unanimousVerdict('SELECT "a\rb" FROM t; SELECT 2;\n'), 'accepted')
  // ...and it must not end a BLOCK comment either, which has no newline rule at all.
  assert.equal(unanimousVerdict('SELECT 1; /* a\rCOMMIT; */ SELECT 2;\n'), 'accepted')
})

test('a whole dump keeps its verdict under every line-ending convention', () => {
  // Parameterising over line endings rather than testing one payload per ending: the point is that
  // the convention is not supposed to be able to change an answer, so it is asserted as a property.
  const cases: [string, string][] = [
    ['accepted', 'SELECT 1;\nSELECT 2;\n'],
    ['accepted', 'SELECT 1;\n-- COMMIT; in a comment\nSELECT 2;\n'],
    ['refused', 'SELECT 1;\nCOMMIT;\n'],
    ['refused', 'SELECT 1;\n-- c\nCOMMIT;\n'],
    ['refused', 'CREATE FUNCTION f() RETURNS void AS $a$ SELECT 1; $a$;\nCOMMIT;\n'],
    ['accepted', 'CREATE FUNCTION f() RETURNS void AS $a$\nBEGIN\nCOMMIT;\nEND;\n$a$;\n'],
  ]
  for (const [expected, lf] of cases) {
    for (const [ending, sql] of [['LF', lf], ['CRLF', asCrlf(lf)], ['CR', asCr(lf)]] as const) {
      const v = unanimousVerdict(sql)
      const got = v === 'accepted' ? 'accepted' : 'refused'
      assert.equal(got, expected, `${ending} changed the verdict for ${JSON.stringify(lf.slice(0, 40))}: ${v}`)
    }
  }
})

test('a CRLF pg_dump is accepted; a CR-only one is refused for its metacommands, deliberately', () => {
  // pg_dump emits LF, but a dump that has been through a Windows editor arrives as CRLF and must
  // still restore — CRLF is the case a naive "CR is a newline" change would break, because the
  // `\restrict` line then ends in a CR the metacommand pattern has to tolerate.
  assert.equal(verdict(asCrlf(REALISTIC_DUMP)), 'accepted')
  assert.equal(chunkedVerdict(asCrlf(REALISTIC_DUMP)), 'accepted')

  // A CR-ONLY file is refused, and this is a CHOICE rather than an oversight. psql does recognise
  // a metacommand after a bare CR, but modelling its argument parsing exactly is a widening
  // decision; refusing every backslash after a bare CR needs no proof and costs only a CR-only
  // dump containing `\restrict`, which pg_dump does not emit. Asserted so the choice is visible
  // and a future round does not "fix" it without noticing the widening.
  assert.match(verdict(asCr(REALISTIC_DUMP)), /backslash/)

  // ...and a CR-only file with no metacommands is scanned normally, so the refusal above is about
  // the backslash rule and not about CR-only input as such.
  assert.equal(unanimousVerdict(asCr('SELECT 1;\nSELECT 2;\n')), 'accepted')
})

test("the COPY end-of-data marker is psql's, exactly", () => {
  // Measured under psql 17.11: `\.` alone ends the data, and `\.` followed by CR does; `\. ` with
  // one trailing space does NOT (psql reads on to EOF), and neither does `\.<CR>JUNK`. The
  // previous rule was `trimEnd() === '\\.'`, which ended the block on all of them and then lexed
  // the remaining DATA as SQL.
  const copy = (term: string) => `COPY t (a) FROM stdin;\nrow1\n${term}\nCOMMIT;\n`
  assert.match(verdict(copy('\\.')), /transaction control/, 'the block ends, so the COMMIT after it is top level')
  assert.match(verdict(copy('\\.\r')), /transaction control/, 'CRLF dumps end their data block too')
  assert.match(verdict(copy('\\. ')), /unterminated COPY/, 'a trailing space is not psql\'s marker')
  assert.match(verdict(copy('\\.\rJUNK')), /unterminated COPY/, 'nor is a CR with anything after it')
  assert.match(verdict(copy(' \\.')), /unterminated COPY/, 'nor is an indented one')
  // COPY data is still \n-oriented: a bare CR inside it is data, not a line break.
  assert.equal(verdict('COPY t (a) FROM stdin;\nrow\rwith a CR\n\\.\nSELECT 1;\n'), 'accepted')
})

test('EVERY payload from rounds 9-12 has ONE verdict across ALL chunk sizes', () => {
  // The property that the individual tests above are instances of, applied to the whole corpus.
  // This is the assertion the harness was missing: `chunkedVerdict` compared TWO framings, and the
  // round-12 long-tag bypass lives strictly between them. Any construct whose recognition depends
  // on how much input happens to be buffered fails here regardless of which answer it settles on.
  const corpus = [
    REALISTIC_DUMP,
    NON_ASCII_DOLLAR_TAG,
    'SELECT 1;\nCOMMIT;\n',
    '\\restrict abc123\nSELECT 1;\n',
    'CREATE FUNCTION f() RETURNS void AS $tag$ COMMIT; $tag$;\n',
    'COPY t FROM stdin;\nCOMMIT;\n\\.\nSELECT 1;\n',
    "SELECT 'a\\'; -- '; COMMIT;\n",
    "SELECT e 'a\\'; COMMIT; --' ;\n",
    "SELECT x\u00e9e'a\\'; COMMIT; --' ;\n",
    'SELECT 1; -- comment\rCOMMIT;\r',
    `SELECT $${'z'.repeat(200)}$ '$${'z'.repeat(200)}$; COMMIT; -- ' ;\n`,
    "SELECT U&'\\0041';",
    'SET standard_conforming_strings = off;\n',
  ]
  for (const sql of corpus) unanimousVerdict(sql)
})
