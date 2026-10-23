import assert from 'node:assert/strict'
import test from 'node:test'

import { parsePackArgs } from '../../lib/reconciliation-pack/cli'
import {
  DEFAULT_PACK_REPORT_DIR, PACK_CHAIN_CODES, PACK_CLI_CODES, PACK_EXIT_CODES, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN,
} from '../../lib/reconciliation-pack/constants'
import { assertClosedRecord } from './schedule-helpers'
import {
  classifyChildEnd, isNotAFault, parsePackOutput, parseScheduleSettings, refusalRecord, scheduledPackArgs,
  type ScheduledRunRecord,
} from '../../lib/reconciliation-pack/schedule'
import {
  PACK_SCHEDULE_FAILURES, PACK_SCHEDULE_REFUSALS,
} from '../../lib/reconciliation-pack/schedule-constants'

const RUN_ID = '20261023T030000Z-0123456789ab'
const dir = `${DEFAULT_PACK_REPORT_DIR}/${RUN_ID}`
const published = `Report: ${dir}/${PACK_REPORT_JSON}\nReport: ${dir}/${PACK_REPORT_MARKDOWN}\n`
const BASE = { scheduleRunId: '11111111-2222-4333-8444-555555555555', phase: 'P1' as const, vendorReads: false, durationMs: 1234 }
const classify = (exitCode: number | null, stderr: string, timedOut = false, sequence: number | null = 7) => classifyChildEnd(BASE, { exitCode, timedOut, stderr }, () => (sequence === null ? null : { sequence }))

test('settings: there is no default phase, and the vendor option is on only for the exact word true', () => {
  for (const absent of [undefined, null, '']) assert.deepEqual(parseScheduleSettings({ phase: absent, vendorReads: undefined }), { ok: false, refusal: 'PHASE_NOT_SET', vendorReads: false })
  for (const bad of ['p1', 'P3', ' P1', 'P1 ', 'P0,P1', 'all']) assert.deepEqual(parseScheduleSettings({ phase: bad, vendorReads: undefined }), { ok: false, refusal: 'PHASE_INVALID', vendorReads: false })
  for (const phase of ['P0', 'P1', 'P2']) assert.deepEqual(parseScheduleSettings({ phase, vendorReads: undefined }), { ok: true, phase, vendorReads: false })
  for (const notTrue of [undefined, null, '', 'false', 'TRUE', 'True', '1', 'yes', ' true']) assert.equal(parseScheduleSettings({ phase: 'P1', vendorReads: notTrue }).vendorReads, false, String(notTrue))
  assert.equal(parseScheduleSettings({ phase: 'P1', vendorReads: 'true' }).vendorReads, true)
  // the refusal reports the vendor option too (it is part of the record)
  assert.equal(parseScheduleSettings({ phase: null, vendorReads: 'true' }).vendorReads, true)
})

test('arguments: the command parses them as the same run an operator would start, with the vendor flag only when asked for', () => {
  const now = new Date('2026-10-23T03:00:00Z')
  for (const phase of ['P0', 'P1', 'P2'] as const) {
    const off = scheduledPackArgs(phase, false)
    assert.deepEqual(off, ['--phase', phase])
    const parsedOff = parsePackArgs(off, now)
    assert.ok(!('code' in parsedOff), 'the real parser accepts it')
    if (!('code' in parsedOff)) assert.deepEqual([parsedOff.phase, parsedOff.vendorReadsOnly, parsedOff.basisOnly, parsedOff.items, parsedOff.reportDir, parsedOff.acceptances], [phase, false, false, null, DEFAULT_PACK_REPORT_DIR, null])
    const on = scheduledPackArgs(phase, true)
    assert.deepEqual(on, ['--phase', phase, '--vendor-reads-only'])
    const parsedOn = parsePackArgs(on, now)
    assert.ok(!('code' in parsedOn) && parsedOn.vendorReadsOnly === true)
  }
})

test('output parsing: only a code from the pack\'s own tables and a report path in the default directory are taken', () => {
  assert.equal(parsePackOutput('Refused: LOCK_HELD\nanother run holds the run lock\n').code, 'LOCK_HELD')
  assert.equal(parsePackOutput('Refused: ACCOUNT_NOT_ALLOWED\nx').code, 'ACCOUNT_NOT_ALLOWED')
  assert.equal(parsePackOutput('Stopped: DATABASE_UNREADABLE\nx').code, 'DATABASE_UNREADABLE')
  assert.equal(parsePackOutput('Not published: WRITE_FAILED\nx').code, 'WRITE_FAILED')
  assert.equal(parsePackOutput('The reconciliation pack failed before it reached an outcome (treat as inconclusive): INTERNAL').code, 'INTERNAL')
  // a code the pack does not define is never taken, whatever it says
  assert.equal(parsePackOutput('Refused: postgres://user:hunter2@host/db').code, null)
  assert.equal(parsePackOutput('Refused: NOT_A_PACK_CODE').code, null)
  assert.equal(parsePackOutput('Refused: SCHEDULE_DISABLED').code, null, 'the job\'s own codes are not the command\'s')
  // report paths
  const ok = parsePackOutput(published)
  assert.deepEqual([ok.runId, ok.reportJson, ok.reportMarkdown], [RUN_ID, `${dir}/${PACK_REPORT_JSON}`, `${dir}/${PACK_REPORT_MARKDOWN}`])
  for (const hostile of [
    `Report: /etc/passwd`, `Report: ${dir}/../../../etc/${PACK_REPORT_JSON}`, `Report: /tmp/${RUN_ID}/${PACK_REPORT_JSON}`, `Report: ${DEFAULT_PACK_REPORT_DIR}/evil/${PACK_REPORT_JSON}`,
    `Report: ${dir}/other.json`, `Report: ${dir}/${PACK_REPORT_JSON}x`, `Report: https://example.com/${RUN_ID}/${PACK_REPORT_JSON}`, `Report: ${dir}/${PACK_REPORT_JSON}?token=abc`,
  ]) {
    const got = parsePackOutput(hostile)
    assert.deepEqual([got.runId, got.reportJson, got.reportMarkdown], [null, null, null], hostile)
  }
  // two different run ids in one output cannot both be the run's report
  const mixed = parsePackOutput(`${published}Report: ${DEFAULT_PACK_REPORT_DIR}/20261023T040000Z-ffffffffffff/${PACK_REPORT_JSON}\n`)
  assert.deepEqual([mixed.runId, mixed.reportJson, mixed.reportMarkdown], [null, null, null])
})

test('how a started command ended: every exit code of the pack, with the meaning the pack gives it', () => {
  const rows: Array<[number, string, string]> = [[0, 'published', 'all-pass'], [1, 'published', 'fail'], [5, 'published', 'inconclusive']]
  for (const [exit, outcome, code] of rows) {
    const record = classify(exit, published)
    assert.deepEqual([record.outcome, record.code, record.exitCode, record.runId, record.sequence, record.reportJson, record.reportMarkdown], [outcome, code, exit, RUN_ID, 7, `${dir}/${PACK_REPORT_JSON}`, `${dir}/${PACK_REPORT_MARKDOWN}`])
    assert.equal(record.exitMeaning, PACK_EXIT_CODES.find((row) => row.code === exit)!.meaning)
    assert.equal(record.codeMeaning, record.exitMeaning)
  }
  // a report that does not verify is NEVER published, whatever the exit code and the printed paths say
  for (const exit of [0, 1, 5]) {
    const unverified = classify(exit, published, false, null)
    assert.deepEqual([unverified.outcome, unverified.code, unverified.exitCode, unverified.runId, unverified.sequence], ['failed', 'REPORT_UNVERIFIED', exit, null, null])
  }
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const record = classifyChildEnd(BASE, { exitCode: 0, timedOut: false, stderr: published }, () => ({ sequence: bad }))
    assert.equal(record.code, 'REPORT_UNVERIFIED', String(bad))
  }
  assert.equal(classifyChildEnd(BASE, { exitCode: 0, timedOut: false, stderr: published }, () => { throw new Error('boom') }).code, 'REPORT_UNVERIFIED')
  // refused / not published / internal: the code the command printed
  const refused = classify(2, 'Refused: LOCK_HELD\nthe text\n')
  assert.deepEqual([refused.outcome, refused.code, refused.exitCode, refused.codeMeaning, refused.runId], ['refused', 'LOCK_HELD', 2, PACK_CHAIN_CODES.LOCK_HELD, null])
  assert.equal(isNotAFault(refused), true)
  const badArgs = classify(2, 'Refused: BAD_ARGUMENTS\n')
  assert.deepEqual([badArgs.outcome, badArgs.code, badArgs.codeMeaning], ['refused', 'BAD_ARGUMENTS', PACK_CLI_CODES.BAD_ARGUMENTS])
  assert.equal(isNotAFault(badArgs), false, 'a refusal for a bad argument or a forbidden account is a fault to fix')
  const notPublished = classify(3, 'Not published: WRITE_FAILED\n')
  assert.deepEqual([notPublished.outcome, notPublished.code, notPublished.exitCode], ['failed', 'WRITE_FAILED', 3])
  const internal = classify(4, 'The reconciliation pack failed before it reached an outcome (treat as inconclusive): INTERNAL\n')
  assert.deepEqual([internal.outcome, internal.code, internal.exitCode], ['failed', 'INTERNAL', 4])
  const dbDown = classify(4, 'Stopped: DATABASE_UNREADABLE\nx')
  assert.equal(dbDown.code, 'DATABASE_UNREADABLE')
})

test('a crash of the runner is not the pack\'s fail: exit 1 (or 0, or 5) without a named report is a failure', () => {
  // `tsx` or `npm` dying before the pack starts exits 1, which the pack also uses for "an item failed"
  for (const exit of [0, 1, 5]) {
    for (const stderr of ['', 'Error: Cannot find module x\n', `Report: ${dir}/${PACK_REPORT_JSON}\n` /* the Markdown line is missing */, `Report: ${dir}/${PACK_REPORT_MARKDOWN}\n`, 'Report: /etc/passwd\nReport: /etc/shadow\n']) {
      const record = classify(exit, stderr)
      assert.equal(record.outcome, 'failed', `${exit} ${JSON.stringify(stderr)}`)
      assert.equal(record.code, 'EXIT_WITHOUT_REPORT')
      assert.equal(record.exitCode, exit)
      assert.equal(record.runId, null)
    }
  }
})

test('every other way the command can end is a closed failure', () => {
  const timeout = classify(null, '', true)
  assert.deepEqual([timeout.outcome, timeout.code, timeout.exitCode, timeout.exitMeaning], ['failed', 'CHILD_TIMED_OUT', null, null])
  assert.equal(classify(null, '').code, 'CHILD_NOT_STARTED')
  assert.equal(classify(137, '').code, 'EXIT_CODE_UNKNOWN')
  assert.equal(classify(137, '').exitCode, 137)
  const nothing = classify(2, 'something unrelated and secret=abc')
  assert.deepEqual([nothing.outcome, nothing.code], ['failed', 'NO_CODE_PRINTED'])
})

test('the record has exactly the documented fields, each matching its grammar, for every kind of end; hostile output reaches none of them', () => {
  const secrets = ['hunter2', 'sk_live_ABCDEF', 'postgres://u:p@h/db', 'Bearer abcdef', 'https://shop.example.com/wp-json', 'consumer_secret', '/home/ims/.env']
  const hostile = `${secrets.join('\n')}\nRefused: ${secrets[2]}\nReport: ${secrets[6]}\n`
  const records: ScheduledRunRecord[] = [
    classify(0, published), classify(1, published + hostile), classify(5, published), classify(2, 'Refused: LOCK_HELD\n' + hostile), classify(2, hostile), classify(3, 'Not published: LOCK_LOST\n' + hostile),
    classify(4, hostile), classify(1, hostile), classify(null, hostile, true), classify(null, hostile), classify(99, hostile),
    ...(Object.keys(PACK_SCHEDULE_REFUSALS) as Array<keyof typeof PACK_SCHEDULE_REFUSALS>).map((code) => refusalRecord({ ...BASE, phase: null }, code)),
  ]
  for (const record of records) {
    assertClosedRecord(record)
    const text = JSON.stringify(record)
    for (const secret of secrets) assert.ok(!text.includes(secret), `${secret} in ${text}`)
  }
  assert.ok(records.length > 15)
})

test('the closed code tables do not overlap, and every code has a sentence', () => {
  const sets = [Object.keys(PACK_SCHEDULE_REFUSALS), Object.keys(PACK_SCHEDULE_FAILURES)]
  const command = [...Object.keys(PACK_CLI_CODES), ...Object.keys(PACK_CHAIN_CODES), 'INTERNAL']
  const all = [...sets[0]!, ...sets[1]!]
  // LOCK codes of the pack and this job's ALREADY_RUNNING are different words; no code is in two tables
  assert.equal(new Set([...all, ...command]).size, all.length + command.length)
  for (const text of [...Object.values(PACK_SCHEDULE_REFUSALS), ...Object.values(PACK_SCHEDULE_FAILURES)]) assert.ok(text.length > 20)
})
