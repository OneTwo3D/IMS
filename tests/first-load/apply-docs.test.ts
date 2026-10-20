/**
 * docs/first-load-apply.md and lib/first-load/apply/constants.ts must agree. Every check is UNIVERSAL: it walks every table row or block the
 * document has and compares it with the code, and also the other way round, so a stale row or a missing one fails.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  APPLY_CHECK_COVERAGE, APPLY_EXIT_CODE_TABLE, APPLY_MANIFEST_KEYS, APPLY_STEP_IDS, CHECK_COVERAGE_STATUSES, CONFLICT_CODES, CONFLICT_CODE_MEANING, NOTHING_WRITTEN_TEXT,
  REHEARSAL_MAX_AGE_HOURS, RESTORE_PROCEDURE_TEXT, ROWS_WRITTEN_TEXT, STEP_PREREQUISITES, STEP_TARGET, TRANSFERS_REFUSAL, WAREHOUSE_TYPES,
} from '../../lib/first-load/apply/constants.ts'
import { APPLY_TIME_CHECKS, MAX_BYTES_PER_FILE, MAX_ROWS_PER_FILE } from '../../lib/first-load/spec.ts'
import { IMPORT_CALL_MAX_ROWS } from '../../lib/first-load/apply/import-calls.ts'
import { CHILD_FLAGS, CLI_FLAGS, KNOWN_FLAGS, REHEARSAL_DATABASE } from '../../lib/first-load/apply/cli.ts'
import { VERIFICATION_IDS, VERIFICATION_MEANING } from '../../lib/first-load/apply/verify-core.ts'
import { FIRST_LOAD_APPLY_STEP_LOCK_NAMESPACE } from '../../lib/db/advisory-locks.ts'
import { precondition } from './helpers.ts'
import { RUNNER_APPLICATION_NAME } from '../../lib/first-load/apply/constants.ts'

const doc = readFileSync(path.join(process.cwd(), 'docs/first-load-apply.md'), 'utf8')

function section(heading: string): string {
  const start = doc.indexOf(`\n${heading}\n`)
  assert.ok(start >= 0, `missing heading ${heading}`)
  const rest = doc.slice(start + heading.length + 2)
  const next = rest.search(/\n#{1,3} /)
  return next < 0 ? rest : rest.slice(0, next)
}

function tableRows(markdown: string): string[][] {
  const rows = markdown.split('\n').filter((line) => line.startsWith('|'))
  return rows.slice(2).map((line) => line.replace(/^\|\s*|\s*\|$/g, '').split(/\s\|\s/).map((cell) => cell.trim()))
}

test('the exit-code table in the document is exactly APPLY_EXIT_CODE_TABLE (every row, both directions)', (t) => {
  const rows = tableRows(section('## Exit codes'))
  precondition(t, 'document exit-code rows', rows.length)
  assert.equal(rows.length, APPLY_EXIT_CODE_TABLE.length)
  APPLY_EXIT_CODE_TABLE.forEach((expected, index) => assert.deepEqual(rows[index], [String(expected.code), expected.name, expected.meaning]))
})

test('the steps table is exactly the step ids, their importer file and their prerequisites', (t) => {
  const rows = tableRows(section('## Steps'))
  precondition(t, 'document step rows', rows.length)
  assert.deepEqual(rows.map((r) => r[0]), [...APPLY_STEP_IDS])
  for (const row of rows) {
    const id = row[0] as (typeof APPLY_STEP_IDS)[number]
    assert.equal(row[1], STEP_TARGET[id])
    assert.equal(row[2], STEP_PREREQUISITES[id].length === 0 ? 'none' : STEP_PREREQUISITES[id].join(', '))
  }
})

test('the conflict-code table is exactly CONFLICT_CODES with their meanings', (t) => {
  const rows = tableRows(section('### Conflict codes'))
  precondition(t, 'document conflict rows', rows.length)
  assert.deepEqual(rows.map((r) => r[0]), [...CONFLICT_CODES])
  for (const row of rows) assert.equal(row[1], CONFLICT_CODE_MEANING[row[0] as (typeof CONFLICT_CODES)[number]])
})

test('every operator-text block equals the sentence the runner prints', (t) => {
  const blocks = [...doc.matchAll(/^### Operator text: (.+)\n\n```text\n([\s\S]*?)\n```/gm)].map((m) => [m[1], m[2]] as const)
  precondition(t, 'operator-text blocks', blocks.length)
  assert.deepEqual(blocks, [['nothing-written', NOTHING_WRITTEN_TEXT], ['rows-written', ROWS_WRITTEN_TEXT], ['restore-procedure', RESTORE_PROCEDURE_TEXT], ['transfers-refusal', TRANSFERS_REFUSAL]])
})

test('every apply-time check has exactly one coverage row, and the document has no other', (t) => {
  const rows = tableRows(section('## Coverage of the apply-time checks'))
  precondition(t, 'coverage rows', rows.length)
  assert.deepEqual(rows.map((r) => r[0]), APPLY_TIME_CHECKS.map((c) => c.id), 'same ids in the same order as APPLY_TIME_CHECKS')
  assert.deepEqual(Object.keys(APPLY_CHECK_COVERAGE).sort(), APPLY_TIME_CHECKS.map((c) => c.id).sort(), 'the code has an entry for every id and no other')
  for (const row of rows) {
    assert.ok((CHECK_COVERAGE_STATUSES as readonly string[]).includes(row[1]))
    assert.equal(row[1], APPLY_CHECK_COVERAGE[row[0]].status)
    assert.equal(row[2], APPLY_CHECK_COVERAGE[row[0]].core)
    assert.equal(row[3], APPLY_CHECK_COVERAGE[row[0]].database)
  }
  assert.deepEqual([...new Set(rows.map((r) => r[1]))].sort(), [...CHECK_COVERAGE_STATUSES].sort(), 'each status is used at least once (so the vocabulary is not dead)')
})

test('the apply-manifest key table lists every manifest key and no other', (t) => {
  const keys = tableRows(section('## The apply manifest')).map((r) => r[0])
  precondition(t, 'manifest keys documented', keys.length)
  assert.deepEqual(keys, [...APPLY_MANIFEST_KEYS])
})

test('numbers the document states are the numbers in the code', (t) => {
  precondition(t, 'stated numbers', 3)
  assert.ok(doc.includes(`finished within ${REHEARSAL_MAX_AGE_HOURS} hours`))
  assert.ok(doc.includes(`${MAX_ROWS_PER_FILE.toLocaleString('en-US')} rows and ${MAX_BYTES_PER_FILE.toLocaleString('en-US')} bytes`))
  assert.deepEqual([...WAREHOUSE_TYPES], ['STANDARD', 'QUARANTINE', 'RESTOCK'])
})

test('the warehouse types the manifest accepts are the prisma WarehouseType enum', (t) => {
  const schema = readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
  const block = /enum WarehouseType \{([^}]*)\}/.exec(schema)
  assert.ok(block, 'the enum is in the schema')
  const values = block[1].split('\n').map((l) => l.trim()).filter(Boolean)
  precondition(t, 'enum values', values.length)
  assert.deepEqual([...WAREHOUSE_TYPES], values)
})

test('the database side\'s stated numbers are the numbers in the code', (t) => {
  precondition(t, 'stated numbers', 2)
  assert.ok(doc.includes(`calls of at most ${IMPORT_CALL_MAX_ROWS.toLocaleString('en-US')} rows`))
  assert.ok(doc.includes(`\`(${FIRST_LOAD_APPLY_STEP_LOCK_NAMESPACE}, n)\``))
  assert.ok(doc.includes('411220875') && FIRST_LOAD_APPLY_STEP_LOCK_NAMESPACE === 411_220_875)
})

test('the quiesce precondition is stated at the top, with the application name the code uses', (t) => {
  precondition(t, 'checks', 2)
  assert.ok(doc.indexOf('PRECONDITION: THE APPLICATION IS STOPPED') > -1 && doc.indexOf('PRECONDITION: THE APPLICATION IS STOPPED') < doc.indexOf('**What exists today:**'), 'before anything else')
  assert.ok(doc.includes(`PGAPPNAME=${RUNNER_APPLICATION_NAME}`))
})

test('the verification table lists every verification id with its meaning, in order, and no other', (t) => {
  const rows = tableRows(section('## Verification and the census'))
  precondition(t, 'document verification rows', rows.length)
  assert.deepEqual(rows.map((r) => r[0]), [...VERIFICATION_IDS])
  for (const row of rows) assert.equal(row[1], VERIFICATION_MEANING[row[0] as (typeof VERIFICATION_IDS)[number]])
})

test('the flag table lists every flag the command accepts (except the two internal ones), with its value and scope, and no other', (t) => {
  const rows = tableRows(section('## The command')).map((r) => r.map((c) => c.replace(/^`|`$/g, '')))
  precondition(t, 'document flag rows', rows.length)
  assert.deepEqual(rows.map((r) => r[0]), CLI_FLAGS.map((f) => f.flag))
  rows.forEach((row, i) => assert.deepEqual(row, [CLI_FLAGS[i].flag, CLI_FLAGS[i].value === '' ? 'none' : CLI_FLAGS[i].value, CLI_FLAGS[i].applies, CLI_FLAGS[i].meaning]))
  // The parser accepts exactly the documented flags.
  assert.deepEqual([...KNOWN_FLAGS].sort(), CLI_FLAGS.map((f) => f.flag).sort())
  // The child flags are not part of the public surface at all.
  for (const flag of CHILD_FLAGS) assert.ok(!KNOWN_FLAGS.includes(flag), flag)
  assert.ok(doc.includes(REHEARSAL_DATABASE))
})
