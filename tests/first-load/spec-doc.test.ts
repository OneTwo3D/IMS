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
  DATASETS, DATASET_NAMES, EXIT_CODE_TABLE, IMPORTER_MAX_BYTES, IMPORTER_MAX_ROWS, IMPORT_TARGETS, MAX_BYTES_PER_FILE, MAX_ROWS_PER_FILE, type ImporterTarget,
} from '../../lib/first-load/spec.ts'
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
