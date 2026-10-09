/**
 * docs/first-load-input-spec.md and lib/first-load/spec.ts must agree. Every check here is UNIVERSAL: it walks every
 * table row or heading the document has and compares each with the code, and also checks the other direction, so a stale
 * row or a missing one fails. (An "includes" check would be satisfied by a correct row sitting beside a stale one.)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  APPLY_TIME_CHECKS, DATASETS, DATASET_NAMES, EXIT_CODE_TABLE, SNAPSHOT_EXIT_CODE_TABLE, SNAPSHOT_FILE_NAMES, VARIANT_PARENT_STATUS_LIFECYCLE, IMPORTER_MAX_BYTES, IMPORTER_MAX_ROWS, IMPORT_TARGETS, MAX_BYTES_PER_FILE, MAX_ROWS_PER_FILE, type ImporterTarget,
} from '../../lib/first-load/spec.ts'
import { ENV_KEYS, DEFAULT_MIN_INTERVAL_MS } from '../../lib/first-load/woo-snapshot/cli.ts'
import { WALK_MAX_ATTEMPTS } from '../../lib/first-load/woo-snapshot/walk.ts'
import { precondition } from './helpers.ts'

const doc = readFileSync(path.join(process.cwd(), 'docs/first-load-input-spec.md'), 'utf8')

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

test('the exit-code table in the document is exactly EXIT_CODE_TABLE (every row, both directions)', (t) => {
  const rows = tableRows(section('## Exit codes'))
  precondition(t, 'document exit-code rows', rows.length)
  assert.equal(rows.length, EXIT_CODE_TABLE.length)
  EXIT_CODE_TABLE.forEach((expected, index) => {
    assert.deepEqual(rows[index], [String(expected.code), expected.name, expected.meaning])
  })
})

test('every dataset section lists exactly the canonical columns, in order, with the right required flags', (t) => {
  const headings = [...doc.matchAll(/^### Dataset: (.+)$/gm)].map((m) => m[1])
  precondition(t, 'dataset headings in the document', headings.length)
  assert.deepEqual([...headings].sort(), [...DATASET_NAMES].sort(), 'the document documents every dataset and no other')
  for (const name of DATASET_NAMES) {
    const rows = tableRows(section(`### Dataset: ${name}`))
    assert.deepEqual(rows.map((r) => r[0].replace(/`/g, '')), [...DATASETS[name].columns], `${name}: columns`)
    for (const row of rows) {
      const column = row[0].replace(/`/g, '')
      assert.equal(row[1] === 'yes', DATASETS[name].required.includes(column), `${name}.${column}: required flag`)
      assert.ok(row[1] === 'yes' || row[1] === 'no', `${name}.${column}: required is yes or no`)
    }
  }
})

test('every output-header block equals the header the tool writes', (t) => {
  const targets = Object.keys(IMPORT_TARGETS) as ImporterTarget[]
  const headings = [...doc.matchAll(/^### Output header: (.+)$/gm)].map((m) => m[1])
  precondition(t, 'output-header blocks in the document', headings.length)
  assert.deepEqual([...headings].sort(), [...targets].sort())
  for (const target of targets) {
    const block = /```text\n([^\n]+)\n```/.exec(section(`### Output header: ${target}`))
    assert.ok(block, `${target}: no header block`)
    assert.equal(block[1], IMPORT_TARGETS[target].headers.join(','), target)
  }
})

test('the limits the document states are the limits in the code', (t) => {
  precondition(t, 'limits', 4)
  assert.ok(doc.includes('At most 9,999 data rows and 9,999,999 bytes per file'))
  assert.equal(MAX_ROWS_PER_FILE, 9_999)
  assert.equal(MAX_BYTES_PER_FILE, 9_999_999)
  assert.ok(doc.includes('they accept 10,000 rows and 10 MiB'))
  assert.equal(IMPORTER_MAX_ROWS, 10_000)
  assert.equal(IMPORTER_MAX_BYTES, 10 * 1024 * 1024)
})

test('the document has no stale statement of the old "fewer than 10,000 rows" misreading or an unconditional load claim', (t) => {
  precondition(t, 'absence checks', 3)
  assert.ok(!/importers? (accept|accepts) (fewer|less) than 10,000/i.test(doc))
  assert.ok(!/nothing was loaded anywhere|will be loaded for you|loads? (it|them) automatically/i.test(doc))
  assert.ok(!/\bTODO\b|\bTBD\b/.test(doc))
})

test('the apply-time checks in the document are exactly APPLY_TIME_CHECKS (every row, both directions)', (t) => {
  const rows = tableRows(section('## Apply-time checks this tool cannot prove'))
  precondition(t, 'document apply-time rows', rows.length)
  assert.deepEqual(rows, APPLY_TIME_CHECKS.map((c) => [c.id, c.area, c.check]))
})

test('the snapshot exit-code table in the document is exactly SNAPSHOT_EXIT_CODE_TABLE (every row, both directions)', (t) => {
  const rows = tableRows(section('### Snapshot exit codes'))
  precondition(t, 'document snapshot exit-code rows', rows.length)
  assert.equal(rows.length, SNAPSHOT_EXIT_CODE_TABLE.length)
  SNAPSHOT_EXIT_CODE_TABLE.forEach((expected, index) => {
    assert.deepEqual(rows[index], [String(expected.code), expected.name, expected.meaning])
  })
})

test('the snapshot command section documents exactly the environment variables the command reads, the files it writes and its defaults', (t) => {
  const body = section('## WooCommerce snapshot command')
  const documented = tableRows(body.slice(body.indexOf('| Variable |'), body.indexOf('An unknown variable'))).map((row) => row[0].replace(/`/g, ''))
  precondition(t, 'documented environment variables', documented.length)
  assert.deepEqual([...documented].sort(), Object.values(ENV_KEYS).sort(), 'every variable the command reads is documented, and none that it does not')
  const files = tableRows(body.slice(body.indexOf('| File |'), body.indexOf('**Completeness is proved')))
  precondition(t, 'documented output files', files.length)
  assert.deepEqual(files.map((row) => row[0].replace(/`/g, '')).sort(), [SNAPSHOT_FILE_NAMES.snapshot, SNAPSHOT_FILE_NAMES.provenance, SNAPSHOT_FILE_NAMES.variantParents].sort())
  assert.ok(body.includes(`(default ${DEFAULT_MIN_INTERVAL_MS})`), 'the documented default interval is the real one')
  assert.equal(WALK_MAX_ATTEMPTS, 3)
  assert.ok(body.includes('retried up to three times'), 'the documented retry count is the real one')
  assert.ok(body.includes(SNAPSHOT_FILE_NAMES.partial), 'the resume file is documented')
})

test('the parentStatus row documents exactly the closed status mapping (every pair, both directions)', (t) => {
  const rows = tableRows(section('### Dataset: variant-parents'))
  const row = rows.find((r) => r[0] === '`parentStatus`')
  assert.ok(row, 'the parentStatus row exists')
  const documented = Object.fromEntries([...row![2].matchAll(/`([a-z]+)` = (ACTIVE|DRAFT)/g)].map((m) => [m[1], m[2]]))
  precondition(t, 'statuses in the closed mapping', Object.keys(VARIANT_PARENT_STATUS_LIFECYCLE).length)
  assert.deepEqual(documented, { ...VARIANT_PARENT_STATUS_LIFECYCLE })
})

test('the document no longer says variants wait for parents from "another source" or that the stock report alone leaves them blocked', (t) => {
  precondition(t, 'absence checks', 2)
  assert.ok(!/until the VARIABLE parent products are supplied/.test(doc))
  assert.ok(!/have to come from another source before variants can load/.test(doc))
})
