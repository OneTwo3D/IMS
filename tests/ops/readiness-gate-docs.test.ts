import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  ACCEPTANCES_DEFAULT_FILE,
  CHECK_CATALOGUE,
  READINESS_GATE_DOC_BLOCKS,
  READINESS_GATE_DOC_BLOCK_CLOSE,
  READINESS_GATE_DOC_BLOCK_OPEN,
  READINESS_GATE_DOC_PLACEMENTS,
  READINESS_GATE_EXIT_CODES,
  REHEARSAL_MAX_AGE_DAYS,
  ACCEPTANCE_MAX_DAYS,
  ACCEPTANCE_REASON_MIN_LENGTH,
  READINESS_GATE_COMMAND,
  type ReadinessGateDocBlockId,
} from '../../lib/ops/readiness-gate-constants.ts'
import { parseAcceptanceFile } from '../../lib/ops/readiness-gate.ts'

/**
 * DOCS AND CODE AGREE, UNIVERSALLY (same shape as tests/security/outbound-write-hold-docs.test.ts).
 * Every readiness-gate block in every doc equals the constants text; the exit-code table is the code's
 * table row for row; the documented example is accepted by the real parser; a stale number in the
 * prose of the section is found by an ABSENCE check.
 */

const ROOT = process.cwd()
const OPEN_RE = /<!-- readiness-gate:([a-z-]+) -->/g

function blocksIn(text: string): Array<{ id: string; body: string }> {
  const found: Array<{ id: string; body: string }> = []
  for (const match of text.matchAll(OPEN_RE)) {
    const id = match[1]!
    const start = (match.index ?? 0) + match[0].length
    const close = text.indexOf(READINESS_GATE_DOC_BLOCK_CLOSE(id), start)
    assert.ok(close > start, `block ${id} has no closing marker`)
    found.push({ id, body: text.slice(start, close).replace(/^\n/, '').replace(/\n$/, '') })
  }
  return found
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    const stat = statSync(full, { throwIfNoEntry: false })
    if (!stat) return []
    if (stat.isDirectory()) return entry === 'archive' || entry === 'completed' ? [] : markdownFiles(full)
    return entry.endsWith('.md') ? [full] : []
  })
}

test('every marked block in every doc equals the constants text, and each placement is present exactly once', () => {
  const files = markdownFiles(join(ROOT, 'docs'))
  const seen = new Map<string, string[]>()
  let examined = 0
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1)
    for (const block of blocksIn(readFileSync(file, 'utf8'))) {
      examined += 1
      assert.ok(block.id in READINESS_GATE_DOC_BLOCKS, `${rel}: unknown block ${block.id}`)
      assert.equal(block.body, READINESS_GATE_DOC_BLOCKS[block.id as ReadinessGateDocBlockId], `${rel}: block ${block.id} differs from the constants module`)
      seen.set(rel, [...(seen.get(rel) ?? []), block.id])
    }
  }
  console.log(`precondition: ${files.length} docs scanned, ${examined} readiness-gate blocks compared`)
  const expected = READINESS_GATE_DOC_PLACEMENTS.reduce((sum, p) => sum + p.blocks.length, 0)
  assert.equal(examined, expected)
  for (const placement of READINESS_GATE_DOC_PLACEMENTS) assert.deepEqual([...(seen.get(placement.file) ?? [])].sort(), [...placement.blocks].sort(), placement.file)
  assert.deepEqual([...seen.keys()].sort(), READINESS_GATE_DOC_PLACEMENTS.map((p) => p.file).sort())
})

test('marker spelling: no malformed, unclosed or duplicated marker hides', () => {
  for (const placement of READINESS_GATE_DOC_PLACEMENTS) {
    const text = readFileSync(join(ROOT, placement.file), 'utf8')
    assert.equal((text.match(/<!--\s*readiness-gate:/g) ?? []).length, placement.blocks.length)
    assert.equal((text.match(/<!--\s*\/readiness-gate:/g) ?? []).length, placement.blocks.length)
    for (const id of placement.blocks) assert.equal(text.split(READINESS_GATE_DOC_BLOCK_OPEN(id)).length, 2, id)
  }
})

test('the documented exit-code table is the code table, row for row', () => {
  const doc = readFileSync(join(ROOT, 'docs/installation.md'), 'utf8')
  const block = blocksIn(doc).find((b) => b.id === 'exit-codes')!
  const rows = block.body.split('\n').filter((line) => /^\| \d+ \|/.test(line))
  console.log(`precondition: ${rows.length} documented rows, ${READINESS_GATE_EXIT_CODES.length} in code`)
  assert.equal(rows.length, READINESS_GATE_EXIT_CODES.length)
  for (const row of READINESS_GATE_EXIT_CODES) assert.ok(rows.some((line) => line === `| ${row.code} | ${row.name} | ${row.meaning} |`), `exit code ${row.code}`)
})

test('the phase table lists every catalogue check with its requirement for every phase', () => {
  const doc = readFileSync(join(ROOT, 'docs/installation.md'), 'utf8')
  const block = blocksIn(doc).find((b) => b.id === 'phases')!
  for (const definition of CHECK_CATALOGUE) assert.ok(block.body.includes(`| ${definition.title.replace(/\|/g, '\\|')} |`), definition.id)
  assert.ok(block.body.includes('| Check | P0 | P1 | P2 |'))
})

test('the example acceptance file in the docs is accepted by the real parser, with no problems', () => {
  const doc = readFileSync(join(ROOT, 'docs/installation.md'), 'utf8')
  const start = doc.indexOf('### Readiness gate')
  const end = doc.indexOf('## Updating', start)
  const section = doc.slice(start, end)
  const examples = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]!)
  console.log(`precondition: ${examples.length} JSON example(s) in the readiness gate section`)
  assert.equal(examples.length, 1)
  const parsed = parseAcceptanceFile(examples[0]!)
  assert.equal(parsed.status, 'ok')
  assert.deepEqual(parsed.problems, [])
  assert.equal(parsed.entries.length, 1)
  assert.ok(section.includes(ACCEPTANCES_DEFAULT_FILE))
})

test('absence: the readiness gate section states no number or command that the code does not define', () => {
  const doc = readFileSync(join(ROOT, 'docs/installation.md'), 'utf8')
  const start = doc.indexOf('### Readiness gate')
  const feedStart = doc.indexOf('### How it feeds the go/no-go gate')
  const section = doc.slice(start, doc.indexOf('## Updating', start))
  const feed = doc.slice(feedStart, start)
  // Every "N days" in the section and its lead-in is one of the code's limits.
  const allowed = new Set([REHEARSAL_MAX_AGE_DAYS, ACCEPTANCE_MAX_DAYS])
  const days = [...(feed + section).matchAll(/\b(\d+) days?\b/g)].map((m) => Number(m[1]))
  console.log(`precondition: ${days.length} day-count mentions: ${days.join(', ')}`)
  assert.ok(days.length >= 2)
  for (const d of days) assert.ok(allowed.has(d), `${d} days is not a limit defined by the gate`)
  assert.ok((feed + section).includes(`${REHEARSAL_MAX_AGE_DAYS} days`))
  assert.ok(section.includes(`${ACCEPTANCE_REASON_MIN_LENGTH} characters`))
  // Every `npm run readiness:...` mention names the one command.
  const commands = [...section.matchAll(/npm run (readiness:[a-z-]+)/g)].map((m) => m[1])
  assert.ok(commands.length >= 2)
  for (const c of commands) assert.equal(`npm run ${c}`, READINESS_GATE_COMMAND)
})

test('package.json defines the command the docs name', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(pkg.scripts['readiness:gate'], 'tsx scripts/readiness-gate.ts')
})

test('the changed endpoint behaviour is stated in the docs block AND the changelog: a PARTIAL newest run blocks, allowWarnings or not', () => {
  const doc = readFileSync(join(ROOT, 'docs/installation.md'), 'utf8')
  const block = blocksIn(doc).find((b) => b.id === 'endpoint')
  assert.ok(block, 'precondition: the endpoint block is in the docs')
  for (const phrase of ['HTTP 412', '?allowWarnings=true', 'PARTIAL', 'FAILED', 'Changed behaviour', 'same instant']) assert.ok(block.body.includes(phrase), `docs block names ${phrase}`)
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const unreleased = changelog.slice(changelog.indexOf('## Unreleased'), changelog.indexOf('\n## ', changelog.indexOf('## Unreleased') + 5) === -1 ? undefined : changelog.indexOf('\n## ', changelog.indexOf('## Unreleased') + 5))
  console.log(`precondition: changelog Unreleased section is ${unreleased.length} characters`)
  for (const phrase of ['/api/admin/rollout-readiness', 'PARTIAL', 'BLOCKS', '412', 'allowWarnings=true']) assert.ok(unreleased.includes(phrase), `changelog names ${phrase}`)
})
