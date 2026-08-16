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
