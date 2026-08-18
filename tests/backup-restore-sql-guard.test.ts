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
