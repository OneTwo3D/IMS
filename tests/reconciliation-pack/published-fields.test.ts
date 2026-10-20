import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { PACK_PUBLISHED_FIELDS, PACK_LOCK_FILE, SYSTEM_IDENTIFIER_RE } from '../../lib/reconciliation-pack/constants.ts'
import { compareItem } from '../../lib/reconciliation-pack/compare.ts'
import { defaultItems, newRunId, publishSyntheticRun } from '../../lib/reconciliation-pack/harness.ts'
import { MAX_TOKEN_LENGTH, identityToken, isSafeTokenShape, keyToken, looksSensitive, digest8 } from '../../lib/reconciliation-pack/identity.ts'
import { HOST_NAME_RE, acquireRunLock } from '../../lib/reconciliation-pack/lock.ts'
import { ReportInvalid, buildReport, parseReport, sha256Hex, type ItemInput, type ReportInput } from '../../lib/reconciliation-pack/report.ts'
import { NOW, STAMP, allBrackets, allFiles, cleanup, passItem, scratchDir } from './helpers.ts'

const bases: string[] = []
after(() => cleanup(bases))
const fresh = () => path.join(scratchDir(bases), 'reports')

// The shape Codex found: it passes every character and length check and the old six patterns.
const CANARY = 'api_key_abcdefghijklmnopqrstuv'
const WAREHOUSE_CANARY = CANARY.toUpperCase()
const SYSTEM = '7000000000000000001'

// ---- the token screen ------------------------------------------------------------------------------------------------

test('the credential screen digests what looks like a credential and prints what looks like a key', () => {
  const digested = [
    CANARY, CANARY.toUpperCase(), 'Api_Key_x', 'KEYBOARD', 'MONKEY-WRENCH', 'my-secret', 'SECRET', 'token1', 'passw0rd', 'PWD-1', 'Bearer', 'AUTH-1', 'AUTHOR-GUIDE', 'credit-card',
    'cred', 'private-1', 'cookie-9', 'session-9', 'signature-1', 'jwt-1', 'sk_live_x', 'pk_test_x', 'ghp_x', 'xoxb-1', 'AKIA0000', 'ASIA0000',
    'a'.repeat(24), 'A1b2C3d4E5f6G7h8I9j0K1l2', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldY', '0123456789abcdef0123456789abcdef', 'eyJhbGciOiJIUzI1', 'httpfoo', 'ab/cd+ef/gh+ij/kl+mn/op==', `A-${'b'.repeat(70)}`,
  ]
  for (const raw of digested) {
    assert.equal(looksSensitive(raw), true, raw)
    assert.equal(identityToken('sku', raw), `sku#${digest8(raw)}`, raw)
    assert.ok(!identityToken('sku', raw).includes(raw) || raw.length < 6, raw)
    assert.equal(isSafeTokenShape(raw), false, `a plain ${raw} read back from a file is refused`)
  }
  for (const raw of [CANARY.toUpperCase(), 'API_KEY_AB', 'SECRET-WH']) assert.equal(identityToken('warehouse', raw), `warehouse#${digest8(raw)}`, raw)
  const printed = ['ABC-100', 'WIDGET-BLUE-0001', 'a'.repeat(23), 'abc-def-ghi-jkl-mno-pqr-stu-vwx', 'ACME.WIDGET/2_B', 'x-'.repeat(MAX_TOKEN_LENGTH / 2)]
  for (const raw of printed) {
    assert.equal(looksSensitive(raw), false, raw)
    assert.equal(identityToken('sku', raw), raw, raw)
    assert.equal(isSafeTokenShape(raw), true, raw)
  }
  for (const raw of ['MAIN', 'EAST_2', 'WH-1']) assert.equal(identityToken('warehouse', raw), raw)
  assert.equal(identityToken('ims-id', 'cmabcdefghijklmnopqrstuvw'), 'cmabcdefghijklmnopqrstuvw')
  assert.equal(isSafeTokenShape('cmabcdefghijklmnopqrstuvw|MAIN'), true, 'a cuid part is readable back')
  assert.equal(identityToken('vendor-id', '123456789012345678'), '123456789012345678')
  assert.equal(isSafeTokenShape(`ABC|${CANARY}`), false, 'one bad part refuses the key')
  assert.equal(isSafeTokenShape(`ABC|sku#${digest8(CANARY)}`), true)
})

test('a composite key built from the canary prints digests only', () => {
  const token = keyToken([{ kind: 'sku', raw: CANARY }, { kind: 'warehouse', raw: WAREHOUSE_CANARY }])
  assert.equal(token, `sku#${digest8(CANARY)}|warehouse#${digest8(WAREHOUSE_CANARY)}`)
  assert.ok(!token.toLowerCase().includes('api_key'))
})

// ---- the same shape, end to end through publication ------------------------------------------------------------------

function everyText(dir: string): string {
  const files = allFiles(dir)
  return [...files.map((f) => `${f}\n${readFileSync(f, 'utf8')}`), ...readdirSync(dir)].join('\n')
}

test('END TO END: a credential-shaped SKU and warehouse code reach no published byte, no file name and no error message', () => {
  const dir = fresh()
  const key = [{ kind: 'sku' as const, raw: CANARY }, { kind: 'warehouse' as const, raw: WAREHOUSE_CANARY }]
  const result = compareItem('R1', { imsComplete: true, vendorComplete: true, ims: [{ key, value: '5' }], vendor: [] })
  assert.equal(result.status, 'compared')
  const item: ItemInput = { id: 'R1', outcome: 'fail', reasons: ['DIFFERENCES'], entries: result.status === 'compared' ? result.buckets : undefined }
  const published = publishSyntheticRun({ reportDir: dir, phase: 'P1', asOf: '2026-10-19', now: NOW, streams: allBrackets(), items: { R1: item }, hooks: { lock: { hostname: () => 'api-key-abcdefghijklmnopqrstuv' } } })
  assert.equal(published.ok, true)
  const text = everyText(dir)
  for (const needle of [CANARY, CANARY.toUpperCase(), 'api_key', 'API_KEY', 'api-key-abcdefghijklmnopqrstuv']) assert.ok(!text.includes(needle), `leaked ${needle}`)
  assert.match(text, new RegExp(`sku#${digest8(CANARY)}\\|warehouse#${digest8(WAREHOUSE_CANARY)}`), 'the evidence names it by digest')

  // handed to the builder as an already-formed key, the raw canary is refused, and the refusal does not repeat it
  const items = defaultItems('P1').map((i) => (i.id === 'R1' ? { id: 'R1', outcome: 'fail', reasons: ['DIFFERENCES'], entries: { onlyIms: [{ key: CANARY, ims: '5', vendor: null, delta: null }] } } as unknown as ItemInput : i))
  const input: ReportInput = { runId: newRunId(NOW), systemIdentifier: SYSTEM, phase: 'P1', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams: allBrackets(), items }
  assert.throws(() => buildReport(input, 1, null), (error: unknown) => error instanceof ReportInvalid && !error.message.includes(CANARY))
})

test('END TO END: the canary as a system identifier, run id, host or date is refused everywhere it is accepted', () => {
  const base: ReportInput = { runId: newRunId(NOW), systemIdentifier: SYSTEM, phase: 'P1', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams: allBrackets(), items: defaultItems('P1') }
  const quiet = (over: Partial<ReportInput>) => assert.throws(() => buildReport({ ...base, ...over }, 1, null), (error: unknown) => error instanceof ReportInvalid && !error.message.toLowerCase().includes('api_key'))
  quiet({ systemIdentifier: CANARY })
  quiet({ systemIdentifier: 'ims-test' })
  quiet({ runId: CANARY })
  quiet({ runId: `20261020T120000Z-${'a'.repeat(11)}g` })
  quiet({ asOf: CANARY })
  quiet({ startedAt: CANARY })
  quiet({ phase: CANARY as never })
  quiet({ streams: [{ stream: CANARY as never, start: null, end: null }] })
  // the reader refuses the same things in a file
  const good = JSON.parse(buildReport(base, 1, null).jsonText) as Record<string, unknown>
  for (const [field, value] of [['systemIdentifier', CANARY], ['runId', CANARY], ['asOf', CANARY], ['startedAt', CANARY], ['phase', CANARY], ['kind', CANARY]] as const) {
    assert.throws(() => parseReport(JSON.stringify({ ...good, [field]: value })), (error: unknown) => error instanceof ReportInvalid && !error.message.toLowerCase().includes('api_key'), field)
  }
  // a host name outside the grammar is never written to a lock (the run is refused), and a lock carrying one is not read
  const dir = fresh(); mkdirSync(dir, { mode: 0o700 })
  for (const bad of [CANARY, 'host name', 'a@b', 'a/b', 'x'.repeat(254), '', '-host', 'host_x']) {
    assert.deepEqual(acquireRunLock(dir, { hostname: () => bad }), { ok: false, code: 'LOCK_ERROR' }, bad.slice(0, 20))
    assert.equal(HOST_NAME_RE.test(bad) && bad.length <= 253, false)
  }
  writeFileSync(path.join(dir, PACK_LOCK_FILE), JSON.stringify({ pid: 5, host: CANARY, token: 'a'.repeat(32), createdAt: STAMP, startTime: '1', bootId: 'abc' }), { mode: 0o600 })
  assert.deepEqual(acquireRunLock(dir), { ok: false, code: 'LOCK_UNREADABLE' })
})

test('the system identifier is exactly what PostgreSQL produces: 10 to 20 digits', () => {
  for (const ok of ['1234567890', SYSTEM, '12345678901234567890']) assert.equal(SYSTEM_IDENTIFIER_RE.test(ok), true, ok)
  for (const bad of ['123456789', '123456789012345678901', '', 'ims-test', 'a234567890', '1234567890\n', ' 1234567890', '+1234567890', '１２３４５６７８９０', '123456789a', '12345678901234567890x', 'api_key_abcdefghijklmnopqrstuv']) assert.equal(SYSTEM_IDENTIFIER_RE.test(bad), false, JSON.stringify(bad))
})

// ---- every key and string that reaches output has a row in the field table -----------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
function walk(value: Json, field: string, visit: (field: string, leaf: string | number | boolean | null, path: string) => void, trail = ''): void {
  if (Array.isArray(value)) { value.forEach((v, i) => walk(v, field, visit, `${trail}[${i}]`)); return }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'counts' || k === 'summary') { for (const n of Object.values(v as Record<string, Json>)) if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) assert.fail(`${trail}.${k} holds a non-count`); continue }
      assert.ok(PACK_PUBLISHED_FIELDS.some((f) => f.field === k), `the field "${k}" (${trail}) has no row in the published-fields table`)
      walk(v, k, visit, `${trail}.${k}`)
    }
    return
  }
  visit(field, value, trail)
}

test('UNIVERSAL: every key in the JSON, the evidence and the lock has a row in the table, and every string matches its row\'s grammar', () => {
  const dir = fresh()
  const rows = compareItem('R1', { imsComplete: true, vendorComplete: true, ims: [{ key: [{ kind: 'sku', raw: 'A1' }], value: '5' }, { key: [{ kind: 'sku', raw: CANARY }], value: '2' }, { key: [{ kind: 'sku', raw: 'E1' }], value: '1' }], vendor: [{ key: [{ kind: 'sku', raw: 'E1' }], value: '1' }, { key: [{ kind: 'sku', raw: 'V1' }], value: '3' }] })
  const r9 = compareItem('R9', { imsComplete: true, vendorComplete: true, ims: [{ key: [{ kind: 'vendor-id', raw: 1001 }], value: '10', currency: 'GBP' }], vendor: [{ key: [{ kind: 'vendor-id', raw: 1001 }], value: '10.01', currency: 'GBP' }] })
  const r13 = compareItem('R13', { imsComplete: true, vendorComplete: true, ims: [{ key: [{ kind: 'sku', raw: 'TAX1' }] }, { key: [{ kind: 'sku', raw: 'TAX2' }] }], vendor: [{ key: [{ kind: 'sku', raw: 'TAX1' }] }] })
  const unsettled = compareItem('R12', { imsComplete: true, vendorComplete: true, ims: [{ key: [{ kind: 'sku', raw: 'U1' }], value: '4' }], vendor: [], settling: { carried: new Map(), stamp: STAMP } })
  assert.ok([rows, r9, r13, unsettled].every((r) => r.status === 'compared'))
  const entries = (r: typeof rows) => (r.status === 'compared' ? r.buckets : undefined)
  const held: { lock?: string } = {}
  const published = publishSyntheticRun({
    reportDir: dir, phase: 'P1', asOf: '2026-10-19', now: NOW, streams: allBrackets(),
    items: {
      R1: { id: 'R1', outcome: 'fail', reasons: ['DIFFERENCES'], entries: entries(rows) },
      R9: { id: 'R9', outcome: 'pass', reasons: [], sources: ['ims-database', 'woocommerce-api'], proof: { kind: 'compared' }, entries: entries(r9) },
      R13: { id: 'R13', outcome: 'fail', reasons: ['DIFFERENCES'], entries: entries(r13) },
      R12: { id: 'R12', outcome: 'inconclusive', reasons: ['UNSETTLED_PENDING'], entries: entries(unsettled) },
      R3: passItem('R3'),
    },
    hooks: { beforeCommit: () => { held.lock = readFileSync(path.join(dir, PACK_LOCK_FILE), 'utf8') } },
  })
  assert.equal(published.ok, true, JSON.stringify(published))
  if (!published.ok) return
  let strings = 0
  const check = (field: string, leaf: string | number | boolean | null, where: string) => {
    if (typeof leaf !== 'string') return
    strings += 1
    const row = PACK_PUBLISHED_FIELDS.find((f) => f.field === field)!
    if (field === 'key') { assert.equal(isSafeTokenShape(leaf), true, `${where}: ${leaf}`); return }
    if (row.pattern) assert.match(leaf, row.pattern, `${where} (${field}) = ${leaf}`)
  }
  walk(JSON.parse(readFileSync(published.json, 'utf8')) as Json, '', check, 'json')
  const lines = readFileSync(published.evidence, 'utf8').trim().split('\n')
  assert.ok(lines.length >= 8)
  for (const line of lines) walk(JSON.parse(line) as Json, '', check, 'evidence')
  walk(JSON.parse(held.lock!) as Json, '', check, 'lock')
  walk({ runId: readFileSync(path.join(dir, readdirSync(dir).find((n) => n.startsWith('.seq-'))!), 'utf8').trim() }, '', check, 'claim')
  assert.ok(strings > 100, `precondition: ${strings} strings checked`)
  console.log(`precondition: ${strings} strings checked against the field table`)

  // the Markdown has a fixed set of line shapes; nothing else is in it
  const shapes = [/^# Reconciliation pack$/, /^$/, /^- Run: [0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/, /^- System: [0-9]{10,20}$/, /^- Phase: P[012]$/, /^- As of: \d{4}-\d{2}-\d{2}$/, /^- (Started|Finished): \d{4}-\d{2}-\d{2}T[\d:.]+Z$/, /^- Sequence: [1-9][0-9]*$/, /^- Previous report sha256: (none \(first report\)|[0-9a-f]{64})$/, /^- Evidence: evidence\.jsonl, \d+ lines, sha256 [0-9a-f]{64}$/, /^- Summary: \d+ pass, \d+ fail, \d+ inconclusive, \d+ not-applicable$/, /^- Exit code: [015]$/, /^This report renders no overall verdict; the readiness gate decides\. Identities are in the evidence file only, as sanitised tokens\.$/, /^\|.*\|$/]
  for (const line of readFileSync(published.markdown, 'utf8').split('\n')) assert.ok(shapes.some((re) => re.test(line)), `unexpected Markdown line: ${line.slice(0, 80)}`)
  assert.equal(sha256Hex(readFileSync(published.markdown)), published.record.companionMarkdownSha256)
})
