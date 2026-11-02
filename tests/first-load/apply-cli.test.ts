import assert from 'node:assert/strict'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { createHash } from 'node:crypto'

import { APPLY_EXIT_CODE_TABLE, REHEARSAL_RECORD_FORMAT_VERSION, RUNNER_APPLICATION_NAME } from '../../lib/first-load/apply/constants.ts'
import { DEFAULT_OPERATOR, REHEARSAL_DATABASE, buildRehearsalRecord, checkChildProof, checkRecordBinding, checkRecordBuild, checkRecordReportFile, checkRecordSchema, deriveRehearsalVerdict, validateChildReport, type RehearsalSignals, buildRunnerEnv, exitNameOfCode, helpText, libpqEnvFromUrl, parseCliArgs, reportStem } from '../../lib/first-load/apply/cli.ts'
import { VERIFICATION_IDS } from '../../lib/first-load/apply/verify-core.ts'
import { runLoad } from '../../lib/first-load/apply/orchestrate.ts'
import { verifyPublishedReport } from '../../lib/ops/published-report.ts'
import { prepareReportDir, publishReportPair, readEnvFile, sha256OfFile } from '../../scripts/lib/first-load-apply-files.ts'
import { sameCounts } from '../../scripts/lib/first-load-rehearse.ts'
import { FakeDatabase, loadOk, prepareSynthetic, preparedFiles } from './apply-helpers.ts'
import { precondition } from './helpers.ts'
import { scratchRoot } from '../helpers/scratch-root'

/**
 * THE COMMAND LINE, WITHOUT A DATABASE: arguments, the environment a run gets, the rehearsal record, the env file and the report directory. (The command against a real database,
 * including a real rehearsal, is apply-cli-e2e.test.ts.) Each arm names, in a comment, the change that makes it green again.
 */

const base = ['--manifest', 'm.json', '--env-file', 'e.env', '--expect-db', 'ims', '--expect-system-id', '123', '--report-dir', 'r']
const parse = (...extra: string[]) => parseCliArgs([...base, ...extra])

test('arguments: the three modes, the default, and every refusal', (t) => {
  const run = (parsed: ReturnType<typeof parseCliArgs>) => { assert.equal(parsed.kind, 'run'); return (parsed as Extract<typeof parsed, { kind: 'run' }>).args }
  assert.equal(run(parse()).mode, 'rehearse', 'the default is the rehearsal, never an apply')
  assert.equal(run(parse('--plan')).mode, 'plan')
  const apply = run(parse('--apply', '--rehearsal-record', 'rec.json', '--resume', '--operator', 'Pat Buyer'))
  assert.deepEqual({ mode: apply.mode, resume: apply.resume, operator: apply.operator, record: apply.rehearsalRecord }, { mode: 'apply', resume: true, operator: 'Pat Buyer', record: 'rec.json' })
  assert.equal(run(parse()).operator, DEFAULT_OPERATOR)
  const arms: Array<[string, string[], RegExp]> = [
    ['two modes', ['--plan', '--apply', '--rehearsal-record', 'x'], /at most one of/],
    ['apply without a record', ['--apply'], /--apply needs --rehearsal-record/],
    ['a record on a plan', ['--plan', '--rehearsal-record', 'x'], /only valid with --apply/],
    ['resume on a rehearsal', ['--resume'], /--resume is only valid with --apply/],
    ['root on an apply', ['--apply', '--rehearsal-record', 'x', '--root', '/var/tmp'], /--root is only valid with --rehearse/],
    ['an unknown argument', ['--force'], /not recognised/],
    ['a flag with no value', ['--operator'], /needs a value/],
    ['a repeated flag', ['--plan', '--plan'], /given twice/],
    ['a repeated value', ['--operator', 'a', '--operator', 'b'], /given twice/],
    ['an operator label with a slash', ['--operator', '../x'], /--operator must be/],
    ['the rehearsal child flags (they are not part of the public command)', ['--apply', '--rehearsal-child-dir', '/var/tmp/x', '--report-stem', 's'], /not recognised/],
    ['the child flags together with a record', ['--apply', '--rehearsal-child-dir', '/var/tmp/x', '--report-stem', 's', '--rehearsal-record', 'r'], /not recognised/],
  ]
  for (const [label, extra, pattern] of arms) {
    const parsed = parse(...extra)
    assert.equal(parsed.kind, 'usage', label)
    assert.ok((parsed as { problems: string[] }).problems.some((p) => pattern.test(p)), `${label}: ${JSON.stringify(parsed)}`)
  }
  for (const missing of ['--manifest', '--env-file', '--expect-db', '--expect-system-id', '--report-dir']) {
    const i = base.indexOf(missing)
    const parsed = parseCliArgs(base.filter((_, j) => j !== i && j !== i + 1))
    assert.equal(parsed.kind, 'usage')
    assert.ok((parsed as { problems: string[] }).problems.some((p) => p.includes(`${missing} is required`)), missing)
  }
  assert.equal(parseCliArgs(['--help']).kind, 'help')
  precondition(t, 'argument arms', arms.length + 5 + 5)
})

test('no secret on the command line: a value that looks like a connection string with a credential is refused', (t) => {
  // Mutation: delete the CREDENTIAL_IN_URL check in parseCliArgs and every arm here parses as a normal run.
  const values = ['postgresql://ims:hunter2@127.0.0.1:5432/ims', 'postgres://ims@host/db', 'https://user:pw@example.test/x', 'x?password=abc', 'x&token=abc', 'x?key=abc', 'mysql://root:@h/d']
  for (const value of values) {
    const parsed = parseCliArgs(['--manifest', value, '--env-file', 'e', '--expect-db', 'd', '--expect-system-id', '1', '--report-dir', 'r'])
    assert.equal(parsed.kind, 'usage', value)
    const text = JSON.stringify(parsed)
    assert.match(text, /looks like it carries a credential/)
    assert.ok(!text.includes('hunter2') && !text.includes('abc'), 'the offending value is not echoed')
  }
  precondition(t, 'credential arms', values.length)
  assert.equal(parseCliArgs([...base, '--plan']).kind, 'run', 'control: an ordinary path is not mistaken for a credential')
})

test('the help text carries the exit table, row for row, from the one source', () => {
  const help = helpText()
  for (const row of APPLY_EXIT_CODE_TABLE) assert.ok(help.includes(`  ${row.code}  ${row.name}: ${row.meaning}`), row.name)
  assert.match(help, /THE APPLICATION MUST BE STOPPED/)
  assert.doesNotMatch(help, /DATABASE_URL=|postgres(ql)?:\/\//, 'no connection string in the help')
})

test('the environment of a run: a whitelist, the file\'s variables, the application name; never an inherited database, PG variable or redirect', (t) => {
  const parent = { PATH: '/usr/bin', LANG: 'C', TZ: 'UTC', DATABASE_URL: 'postgresql://inherited/db', PGHOST: 'inherited', MINTSOFT_WRITE_ALLOWED: 'https://x|1', NODE_OPTIONS: '--require /x', HOME: '/home/x' }
  const built = buildRunnerEnv({ DATABASE_URL: 'postgresql://file/db', AUTH_SECRET: 's' }, parent, '/home/x')
  assert.deepEqual(built.problems, [])
  assert.equal(built.env.DATABASE_URL, 'postgresql://file/db', "the file's database, not the inherited one")
  assert.equal(built.env.PGAPPNAME, RUNNER_APPLICATION_NAME)
  for (const inherited of ['PGHOST', 'MINTSOFT_WRITE_ALLOWED', 'NODE_OPTIONS']) assert.equal(built.env[inherited], undefined, `${inherited} is not inherited`)
  assert.deepEqual(Object.keys(built.env).sort(), ['AUTH_SECRET', 'DATABASE_URL', 'HOME', 'LANG', 'PATH', 'PGAPPNAME', 'TZ'])
  // A variable in the FILE that would redirect a client library is refused, not dropped; a grant in the file is kept (the held check must see it and fail).
  const arms: Array<[string, Record<string, string>, RegExp]> = [
    ['PGHOST in the file', { DATABASE_URL: 'postgresql://f/d', PGHOST: 'elsewhere' }, /sets PGHOST/],
    ['PGPASSWORD in the file', { DATABASE_URL: 'postgresql://f/d', PGPASSWORD: 'x' }, /sets PGPASSWORD/],
    ['NODE_OPTIONS in the file', { DATABASE_URL: 'postgresql://f/d', NODE_OPTIONS: '--require /x' }, /sets NODE_OPTIONS/],
    ['no DATABASE_URL', { AUTH_SECRET: 's' }, /no DATABASE_URL/],
    ['a blank DATABASE_URL', { DATABASE_URL: '' }, /no DATABASE_URL/],
  ]
  for (const [label, file, pattern] of arms) assert.ok(buildRunnerEnv(file, parent, '/h').problems.some((p) => pattern.test(p)), label)
  assert.equal(buildRunnerEnv({ DATABASE_URL: 'postgresql://f/d', MINTSOFT_WRITE_ALLOWED: 'g' }, parent, '/h').env.MINTSOFT_WRITE_ALLOWED, 'g')
  precondition(t, 'environment arms', arms.length + 3)
})

test('libpq variables are derived from the URL for the client tools, and the URL itself is not passed on', () => {
  const ok = libpqEnvFromUrl('postgresql://some%20user:p%40ss@db.example.test:5433/ims?sslmode=require')
  assert.deepEqual(ok.problems, [])
  assert.deepEqual(ok.env, { PGHOST: 'db.example.test', PGPORT: '5433', PGUSER: 'some user', PGPASSWORD: 'p@ss', PGDATABASE: 'ims', PGSSLMODE: 'require', PGAPPNAME: RUNNER_APPLICATION_NAME })
  for (const bad of ['', 'not a url', 'mysql://u:p@h/d', 'postgresql://u:p@h/']) assert.ok(libpqEnvFromUrl(bad).problems.length > 0, bad)
})

const BUILD = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), clean: true, path: '/opt/ims/app' }
const DIGEST = 'd'.repeat(64)
const STEPS = ['suppliers', 'products']
const stepRow = (step: string) => ({ step, status: 'DONE', emitted: 3, created: 3, updated: 0, skippedExisting: 0, failed: 0, conflicts: [] })
const items = () => VERIFICATION_IDS.map((id) => ({ id, result: 'pass' }))
const goodReport = (over: Record<string, unknown> = {}) => ({ tool: 'first-load-apply', mode: 'apply', manifestDigest: DIGEST, exit: { name: 'OK' }, verification: items(), steps: STEPS.map(stepRow), accountingBalanced: true, problems: [], target: { database: REHEARSAL_DATABASE }, ...over })
const N = VERIFICATION_IDS.length
const SIGNALS: RehearsalSignals = { childStarted: true, childTimedOut: false, childExitCode: 0, report: { exitName: 'OK', verificationItems: N, verificationFailed: 0, complete: true }, targetUnchanged: true, teardownComplete: true, problemCount: 0 }

test('the rehearsal verdict is derived in ONE place from every signal, and is OK only when all of them are good (each signal has an arm)', (t) => {
  // Mutation per arm: delete the corresponding line of deriveRehearsalVerdict and that arm's verdict becomes 'OK' (or the next signal's word).
  assert.deepEqual(deriveRehearsalVerdict(SIGNALS), { verdict: 'OK', loadExit: 'OK' })
  const arms: Array<[string, Partial<RehearsalSignals>, string]> = [
    ['the child never started', { childStarted: false }, 'NOT_RUN'],
    ['the child timed out', { childTimedOut: true }, 'CHILD_TIMED_OUT'],
    ['the child was killed by a signal', { childExitCode: null }, 'CHILD_KILLED'],
    ['an exit code outside the table', { childExitCode: 99 }, 'CHILD_EXIT_UNKNOWN'],
    ['the child exited 0 but its report is missing or invalid', { report: null }, 'REPORT_MISSING_OR_INVALID'],
    ['the report names another exit than the process', { report: { exitName: 'VERIFY_FAILED', verificationItems: N, verificationFailed: 0, complete: true } }, 'REPORT_DISAGREES_WITH_EXIT'],
    ['a non-zero exit is mapped', { childExitCode: 1, report: { exitName: 'VERIFY_FAILED', verificationItems: N, verificationFailed: 1, complete: true } }, 'VERIFY_FAILED'],
    ['a partial report with no verification items', { report: { exitName: 'OK', verificationItems: 3, verificationFailed: 0, complete: true } }, 'VERIFICATION_NOT_ALL_PASS'],
    ['an incomplete report (a step not DONE, a problem listed, another target)', { report: { exitName: 'OK', verificationItems: N, verificationFailed: 0, complete: false } }, 'REPORT_INCOMPLETE'],
    ['a failing verification item behind an OK exit', { report: { exitName: 'OK', verificationItems: N, verificationFailed: 1, complete: true } }, 'VERIFICATION_NOT_ALL_PASS'],
    ['the target changed', { targetUnchanged: false }, 'TARGET_CHANGED'],
    ['the teardown failed after the report', { teardownComplete: false }, 'TEARDOWN_INCOMPLETE'],
    ['any problem was recorded on the way', { problemCount: 1 }, 'PROBLEMS_RECORDED'],
  ]
  for (const [label, over, verdict] of arms) {
    const got = deriveRehearsalVerdict({ ...SIGNALS, ...over })
    assert.equal(got.verdict, verdict, label)
    assert.notEqual(got.verdict, 'OK', label)
    if (label !== 'a non-zero exit is mapped') assert.notEqual(got.loadExit, 'OK', `${label}: the load exit never reads OK beside a non-OK verdict`)
  }
  precondition(t, 'verdict arms', arms.length)
})

test('an OK record cannot be built without the bound report, a load exit of OK, an unchanged target and a complete teardown', (t) => {
  const base = { manifestDigest: DIGEST, targetSystemId: '7', schemaHash: '1111111111111111111111111111111111111111111111111111111111111111', build: BUILD, finishedAt: new Date('2026-10-20T10:00:00Z'), verdict: 'OK', loadExit: 'OK' as const, targetUnchanged: true, teardownComplete: true, report: { file: 'r.json', sha256: 'a'.repeat(64), verificationItems: N, verificationFailed: 0, complete: true } }
  assert.equal(buildRehearsalRecord(base).verdict, 'OK')
  // Mutation: build 'OK' from args.verdict alone and every arm below is green.
  const arms: Array<Record<string, unknown>> = [{ report: null }, { loadExit: null }, { targetUnchanged: false }, { teardownComplete: false }]
  for (const over of arms) assert.notEqual(buildRehearsalRecord({ ...base, ...over } as typeof base).verdict, 'OK', JSON.stringify(over))
  precondition(t, 'record arms', arms.length)
})

test('a child report is valid only with EXACTLY the closed verification list, the load\'s own steps and the throwaway target (no "non-empty", no "all pass of whatever is there")', (t) => {
  assert.deepEqual(validateChildReport(goodReport(), DIGEST, STEPS), { exitName: 'OK', verificationItems: N, verificationFailed: 0, complete: true })
  assert.equal(validateChildReport(goodReport({ verification: items().map((i, k) => (k === 0 ? { ...i, result: 'fail' } : i)) }), DIGEST, STEPS)?.verificationFailed, 1)
  const rows = items()
  const bad: Array<[string, unknown]> = [
    ['not an object', null], ['a string', 'x'], ['an array', []],
    ['another tool', goodReport({ tool: 'other' })], ['another digest', goodReport({ manifestDigest: 'e'.repeat(64) })], ['not an apply report', goodReport({ mode: 'plan' })],
    ['an exit outside the table', goodReport({ exit: { name: 'WHATEVER' } })], ['no exit', goodReport({ exit: null })], ['verification not a list', goodReport({ verification: 'pass' })],
    ['one id dropped', goodReport({ verification: rows.slice(1) })],
    ['one id dropped and another duplicated as padding', goodReport({ verification: [...rows.slice(1), rows[1]] })],
    ['one id swapped for an unknown one', goodReport({ verification: [{ id: 'made-up', result: 'pass' }, ...rows.slice(1)] })],
    ['every id plus one duplicate', goodReport({ verification: [...rows, rows[3]] })],
    ['an extra item beyond the list', goodReport({ verification: [...rows, { id: 'extra', result: 'pass' }] })],
    ['an item with no id', goodReport({ verification: [{ result: 'pass' }, ...rows.slice(1)] })],
    ['no verification at all', (() => { const r = goodReport(); delete (r as Record<string, unknown>).verification; return r })()],
  ]
  for (const [label, parsed] of bad) assert.equal(validateChildReport(parsed, DIGEST, STEPS), null, label)
  // Shape-complete but not a clean finished load: parsed, and marked incomplete (the verdict then refuses it).
  const incomplete: Array<[string, unknown]> = [
    ['a step missing', goodReport({ steps: [stepRow('suppliers')] })], ['steps in another order', goodReport({ steps: [stepRow('products'), stepRow('suppliers')] })],
    ['an extra step', goodReport({ steps: [...STEPS.map(stepRow), stepRow('opening-stock')] })], ['a step not DONE', goodReport({ steps: [{ ...stepRow('suppliers'), status: 'FAILED' }, stepRow('products')] })],
    ['a failed unit', goodReport({ steps: [{ ...stepRow('suppliers'), failed: 1, created: 2 }, stepRow('products')] })], ['an unbalanced step', goodReport({ steps: [{ ...stepRow('suppliers'), emitted: 4 }, stepRow('products')] })],
    ['a conflict listed', goodReport({ steps: [{ ...stepRow('suppliers'), conflicts: [{}] }, stepRow('products')] })], ['accounting not balanced', goodReport({ accountingBalanced: false })],
    ['a problem listed', goodReport({ problems: ['x'] })], ['another target database', goodReport({ target: { database: 'ims' } })], ['no target', goodReport({ target: null })],
  ]
  for (const [label, parsed] of incomplete) assert.equal(validateChildReport(parsed, DIGEST, STEPS)?.complete, false, label)
  precondition(t, 'report arms', bad.length + incomplete.length)
})

test('the apply re-validates what an OK record binds: fields, then the report file itself', (t) => {
  const record = { verdict: 'OK', loadExit: 'OK', targetUnchanged: true, teardownComplete: true, report: { file: 'r.json', sha256: 'a'.repeat(64), verificationItems: N, verificationFailed: 0, complete: true } }
  assert.deepEqual(checkRecordBinding(record), [])
  const clone = (over: Record<string, unknown>) => ({ ...record, ...over })
  const badFields: unknown[] = [
    null, {}, clone({ loadExit: 'VERIFY_FAILED' }), clone({ loadExit: null }), clone({ targetUnchanged: false }), clone({ targetUnchanged: undefined }), clone({ teardownComplete: false }), clone({ report: null }), clone({ report: undefined }),
    clone({ report: { ...record.report, file: '../r.json' } }), clone({ report: { ...record.report, file: 'r.csv' } }), clone({ report: { ...record.report, sha256: 'xyz' } }),
    clone({ report: { ...record.report, verificationItems: 0 } }), clone({ report: { ...record.report, verificationItems: N - 1 } }), clone({ report: { ...record.report, verificationItems: N + 1 } }), clone({ report: { ...record.report, verificationFailed: 1 } }), clone({ report: { ...record.report, verificationFailed: undefined } }),
  ]
  for (const bad of badFields) assert.ok(checkRecordBinding(bad).length > 0, JSON.stringify(bad))
  const sha = 'a'.repeat(64)
  assert.deepEqual(checkRecordReportFile(record, sha, goodReport(), DIGEST, STEPS), [])
  const fileArms: Array<[string, string, unknown]> = [
    ['the file changed', 'b'.repeat(64), goodReport()],
    ['another load', sha, goodReport({ manifestDigest: 'e'.repeat(64) })],
    ['not OK inside', sha, goodReport({ exit: { name: 'VERIFY_FAILED' } })],
    ['a failing item inside', sha, goodReport({ verification: items().map((i, k) => (k === 0 ? { ...i, result: 'fail' } : i)) })],
    ['a dropped item', sha, goodReport({ verification: items().slice(1) })],
    ['padding with a duplicate', sha, goodReport({ verification: [...items().slice(1), items()[1]] })],
    ['an incomplete load', sha, goodReport({ steps: [stepRow('suppliers')] })],
    ['unparseable', sha, null],
  ]
  for (const [label, hash, parsed] of fileArms) assert.equal(checkRecordReportFile(record, hash, parsed, DIGEST, STEPS).length, 1, label)
  assert.equal(checkRecordReportFile({ ...record, report: null }, sha, goodReport(), DIGEST, STEPS).length, 1)
  precondition(t, 'binding arms', badFields.length + fileArms.length + 1)
})

test('the record the command writes is accepted by the gate it feeds, and by nothing weaker', async () => {
  const prepared = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore' })
  const record = buildRehearsalRecord({ manifestDigest: prepared.manifestDigest, targetSystemId: 'sys-1', schemaHash: '1111111111111111111111111111111111111111111111111111111111111111', build: BUILD, finishedAt: new Date(), verdict: 'OK', loadExit: 'OK', targetUnchanged: true, teardownComplete: true, report: { file: 'r.json', sha256: 'a'.repeat(64), verificationItems: N, verificationFailed: 0 } })
  const db = new FakeDatabase(prepared)
  const accepted = await runLoad(prepared, db.ports(), { mode: 'apply', resume: false, rehearsal: record, systemId: 'sys-1', now: new Date(), maxRehearsalAgeHours: 24 })
  assert.equal(accepted.exit, 'OK', accepted.problems.join('; '))
  const refusedDb = new FakeDatabase(prepared)
  const bad = await runLoad(prepared, refusedDb.ports(), { mode: 'apply', resume: false, rehearsal: { ...record, verdict: 'VERIFY_FAILED' }, systemId: 'sys-1', now: new Date(), maxRehearsalAgeHours: 24 })
  assert.equal(bad.exit, 'PRECONDITION_REFUSED')
  assert.deepEqual(refusedDb.executed, [], 'nothing was sent')
})

test('the rehearsal waiver: an apply with thisIsTheRehearsal needs no record; without it, none is refused. The flag is the one thing waived.', async (t) => {
  // Mutation: ignore options.thisIsTheRehearsal in runLoad (always check the gate) and the first arm is refused; ignore the mode check and the second is green with no record.
  const prepared = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore' })
  const opts = { mode: 'apply' as const, resume: false, rehearsal: null, systemId: null, now: new Date(), maxRehearsalAgeHours: 24 }
  const waived = new FakeDatabase(prepared)
  const ok = await runLoad(prepared, waived.ports(), { ...opts, thisIsTheRehearsal: true })
  assert.equal(ok.exit, 'OK')
  const refused = new FakeDatabase(prepared)
  const no = await runLoad(prepared, refused.ports(), opts)
  assert.equal(no.exit, 'PRECONDITION_REFUSED')
  assert.deepEqual(refused.executed, [])
  // The flag does not waive the rest of the gate's neighbours: a plan is still a plan, and a conflict still stops a waived apply.
  const conflicted = new FakeDatabase(prepared)
  const unit = prepared.steps[0].units[0]
  conflicted.seed(prepared.steps[0].step, { key: unit.key, collisionKey: unit.collisionKey, fingerprint: `${unit.fingerprint}-other`, recipe: null })
  const stopped = await runLoad(prepared, conflicted.ports(), { ...opts, thisIsTheRehearsal: true })
  assert.notEqual(stopped.exit, 'OK')
  precondition(t, 'waiver arms', 3)
})

test('a report stem is a plain file stem built from the mode, the run id and a UTC stamp', () => {
  assert.equal(reportStem('rehearse', 'run-1', new Date('2026-10-20T10:11:12.345Z')), 'first-load-apply-rehearse-run-1-20261020T101112Z')
  assert.equal(exitNameOfCode(3), 'PRECONDITION_REFUSED')
  assert.equal(exitNameOfCode(99), null)
  assert.equal(exitNameOfCode(null), null)
  assert.equal(REHEARSAL_DATABASE, 'ims_firstload_rehearsal')
})

test('the target is proved unchanged by exact counts of every table: one row, one added table or one dropped table is a change', (t) => {
  const before = { a: 1, b: 0, c: 5 }
  assert.equal(sameCounts(before, { ...before }), true)
  // Mutation: compare only the keys of `before`, or only totals, and the added-table and swapped-rows arms are green.
  const arms: Array<Record<string, number>> = [{ a: 2, b: 0, c: 5 }, { a: 1, b: 0, c: 5, d: 0 }, { a: 1, b: 0 }, { a: 0, b: 1, c: 5 }]
  for (const after of arms) assert.equal(sameCounts(before, after), false, JSON.stringify(after))
  precondition(t, 'count arms', arms.length)
})

// ---------------------------------------------------------------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------------------------------------------------------------

// Under /var/tmp, not os.tmpdir(): the unit tier points TMPDIR at a private directory that other accounts could write to, and the report directory's ancestor check (rightly) refuses that.
const scratch = mkdtempSync(path.join(scratchRoot(), 'first-load-apply-cli-unit-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let counter = 0
const fresh = (label: string) => path.join(scratch, `${label}-${++counter}`)

function writeEnv(text: string, mode: number): string {
  const file = fresh('env')
  writeFileSync(file, text, { mode })
  chmodSync(file, mode)
  return file
}

test('the env file: mode 600, owned by the caller, a regular file, KEY=VALUE lines; a bad line is a count and never its text', (t) => {
  const ok = readEnvFile(writeEnv('# a comment\n\nDATABASE_URL=postgresql://u:p@h/d\nexport AUTH_SECRET="quoted value"\nSINGLE=\'single\'\nEMPTY=\n', 0o600))
  assert.ok(ok.ok)
  assert.deepEqual(ok.ok && ok.env, { DATABASE_URL: 'postgresql://u:p@h/d', AUTH_SECRET: 'quoted value', SINGLE: 'single', EMPTY: '' })
  // Mutation: drop the mode check and the 644 arm is green; drop O_NOFOLLOW and the symlink arm is green.
  const readable = readEnvFile(writeEnv('A=1\n', 0o644))
  assert.ok(!readable.ok && /mode 600/.test(readable.problem))
  const groupWritable = readEnvFile(writeEnv('A=1\n', 0o620))
  assert.ok(!groupWritable.ok)
  const real = writeEnv('A=1\n', 0o600)
  const link = fresh('link')
  symlinkSync(real, link)
  assert.ok(!readEnvFile(link).ok, 'a symlink is not followed')
  const dir = fresh('dir')
  mkdirSync(dir)
  assert.ok(!readEnvFile(dir).ok, 'a directory is not an env file')
  assert.ok(!readEnvFile(path.join(scratch, 'does-not-exist')).ok)
  const bad = readEnvFile(writeEnv('A=1\nthis line is SECRETTEXT\nnot a variable either\n', 0o600))
  assert.ok(!bad.ok && /2 line\(s\)/.test(bad.problem) && !/SECRETTEXT/.test(bad.problem), 'a count, never the text')
  assert.ok(!readEnvFile(writeEnv(`A=${'x'.repeat(300 * 1024)}\n`, 0o600)).ok, 'bounded')
  precondition(t, 'env arms', 8)
})

test('the report directory: created 700; a symlink or an open directory is refused', (t) => {
  const made = prepareReportDir(path.join(fresh('reports'), 'nested'))
  assert.ok(made.ok)
  assert.equal(lstatSync(made.ok ? made.value.dir : '').mode & 0o777, 0o700)
  const open = fresh('open')
  mkdirSync(open, { mode: 0o755 })
  chmodSync(open, 0o755)
  assert.ok(!prepareReportDir(open).ok, 'group/other access is refused')
  const real = fresh('real')
  mkdirSync(real, { mode: 0o700 })
  const link = fresh('dirlink')
  symlinkSync(real, link)
  assert.ok(!prepareReportDir(link).ok, 'a symlink is refused')
  const file = fresh('afile')
  writeFileSync(file, 'x')
  assert.ok(!prepareReportDir(file).ok, 'a file is refused')
  precondition(t, 'directory arms', 4)
})

test('a report pair is published Markdown first and JSON last, exclusively, naming the Markdown by SHA-256; nothing is overwritten and a failure leaves nothing', (t) => {
  const made = prepareReportDir(fresh('pub'))
  assert.ok(made.ok)
  const dir = made.ok ? made.value : (undefined as never)
  const files = publishReportPair(dir, 'stem-1', { tool: 'x', n: 1 }, '# report\n')
  assert.equal(verifyPublishedReport(files.json).ok, true)
  assert.equal(lstatSync(files.json).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir.dir).sort(), ['stem-1.json', 'stem-1.md'], 'no temporary name is left behind')
  // A second publication under the same stem is refused and changes nothing (the link fails when the name exists). Mutation: rename over it instead and this is green.
  const before = readFileSync(files.json, 'utf8')
  assert.throws(() => publishReportPair(dir, 'stem-1', { tool: 'y' }, '# other\n'), /EEXIST/)
  assert.equal(readFileSync(files.json, 'utf8'), before)
  assert.deepEqual(readdirSync(dir.dir).sort(), ['stem-1.json', 'stem-1.md'])
  // A failure on the second file leaves neither final name (the Markdown that was already linked is removed).
  let written = 0
  assert.throws(() => publishReportPair(dir, 'stem-2', { tool: 'z' }, '# z\n', { writeFile: (file, data) => { if (++written === 2) throw new Error('disk full'); writeFileSync(file, data, { flag: 'wx', mode: 0o600 }) } }), /disk full/)
  assert.deepEqual(readdirSync(dir.dir).sort(), ['stem-1.json', 'stem-1.md'], 'a failed publication leaves no half report')
  // The directory replaced under the run is detected before anything is linked into it.
  const moved = `${dir.dir}-moved`
  const replaced = prepareReportDir(fresh('pub2'))
  assert.ok(replaced.ok)
  const d2 = replaced.ok ? replaced.value : (undefined as never)
  const hold = fresh('hold')
  mkdirSync(hold, { mode: 0o700 })
  rmSync(d2.dir, { recursive: true })
  symlinkSync(hold, d2.dir)
  assert.throws(() => publishReportPair(d2, 'stem-3', { tool: 'w' }, '# w\n'), /replaced/)
  assert.deepEqual(readdirSync(hold), [], 'nothing was written through the planted link')
  void moved
  void linkSync
  precondition(t, 'publication arms', 4)
})

test('a file hash is of the bytes, and a symlink is refused', () => {
  const file = fresh('hash')
  writeFileSync(file, 'abc')
  const hashed = sha256OfFile(file)
  assert.ok(hashed.ok && hashed.sha256 === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' && hashed.bytes === 3)
  const link = fresh('hashlink')
  symlinkSync(file, link)
  assert.ok(!sha256OfFile(link).ok)
})

test('the command refuses a record made against another schema, or by something else (no schema head)', (t) => {
  // Mutation: return [] from checkRecordSchema and every arm but the control is green.
  assert.deepEqual(checkRecordSchema({ schemaHash: '1111111111111111111111111111111111111111111111111111111111111111' }, '1111111111111111111111111111111111111111111111111111111111111111'), [])
  const arms: unknown[] = [{ schemaHash: '2222222222222222222222222222222222222222222222222222222222222222' }, {}, { schemaHash: '' }, { schemaHash: 5 }, { schemaHash: 'abc' }, null, 'x', []]
  for (const record of arms) assert.equal(checkRecordSchema(record, '1111111111111111111111111111111111111111111111111111111111111111').length, 1, JSON.stringify(record))
  precondition(t, 'schema arms', arms.length)
})

test('rehearse mode: a record that cannot be published turns an OK rehearsal into the closed non-OK exit, printed as the result (and a published one stays OK)', async () => {
  const { rehearseMode } = await import('../../scripts/first-load-apply.ts')
  const preparedRun = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore' })
  const okOutcome = { exit: 'OK' as const, loadExit: 'OK' as const, record: { verdict: 'OK' } as never, targetUnchanged: true, teardownComplete: true, problems: [], report: { json: '/x/r.json', sha256: 'a'.repeat(64) } }
  const args = { mode: 'rehearse', manifest: 'm.json', envFile: 'e', expectDb: 'd', expectSystemId: '1', reportDir: 'r', rehearsalRecord: null, resume: false, operator: 'op', root: '/var/tmp', rehearsalChild: null } as const
  const ctx = { prepared: preparedRun, targetEnv: { DATABASE_URL: 'postgresql://x/y' }, identity: { systemId: '1' }, reportDir: { dir: '/x', dev: 0, ino: 0 }, stem: 'first-load-apply-rehearse-run-20261020T100000Z', now: new Date() }
  const run = async (publish: () => string) => {
    const out: string[] = []
    const err: string[] = []
    const code = await rehearseMode({ ...args }, { out: (t) => out.push(t), err: (t) => err.push(t) }, ctx, { rehearse: async () => okOutcome, publishRecord: publish as never })
    return { code, text: [...out, ...err].join('') }
  }
  // Mutation: use outcome.exit unchanged (the old shape) and the failing-publication arm exits 0.
  const failed = await run(() => { throw new Error('EEXIST /secret/path') })
  assert.notEqual(failed.code, 0)
  assert.equal(failed.code, 6, 'INTERNAL')
  assert.match(failed.text, /INTERNAL \(exit 6\)/)
  assert.match(failed.text, /RECORD_NOT_PUBLISHED/)
  assert.doesNotMatch(failed.text, /secret/, 'the error text is not printed')
  const fine = await run(() => '/x/record.json')
  assert.equal(fine.code, 0)
  assert.match(fine.text, /Rehearsal record: \/x\/record\.json/)
})

test('the child flags exist only for the rehearsal\'s own entrypoint: the public parse refuses them, the child parse accepts them with the child rules', (t) => {
  // Mutation: add the child flags to VALUE_FLAGS (the public list) and every public arm here is green, so the first assertion fails.
  const childArgs = ['--apply', '--rehearsal-child-dir', '/var/tmp/x', '--report-stem', 'stem']
  assert.equal(parseCliArgs([...base, ...childArgs]).kind, 'usage')
  const parsed = parseCliArgs([...base, ...childArgs], { allowChild: true })
  assert.equal(parsed.kind, 'run')
  assert.deepEqual((parsed as { args: { rehearsalChild: unknown } }).args.rehearsalChild, { runDir: '/var/tmp/x', reportStem: 'stem' })
  const arms: Array<[string, string[], RegExp]> = [
    ['a dir without a stem', ['--apply', '--rehearsal-child-dir', '/var/tmp/x'], /given together/],
    ['a child that is not an apply', ['--plan', '--rehearsal-child-dir', '/var/tmp/x', '--report-stem', 's'], /runs as --apply/],
    ['a child with a record', [...childArgs, '--rehearsal-record', 'r'], /IS the rehearsal/],
    ['a child with --resume', [...childArgs, '--resume'], /IS the rehearsal/],
  ]
  for (const [label, extra, pattern] of arms) {
    const got = parseCliArgs([...base, ...extra], { allowChild: true })
    assert.equal(got.kind, 'usage', label)
    assert.ok((got as { problems: string[] }).problems.some((p) => pattern.test(p)), label)
  }
  precondition(t, 'child parse arms', arms.length + 2)
})

test('a claim to be the rehearsal\'s child is proved by a token, a cluster and not being the target; any one missing is a refusal with closed codes', (t) => {
  const token = 'a'.repeat(64)
  const hash = createHash('sha256').update(token).digest('hex')
  const proof = { tokenSha256: hash, clusterSystemId: 'copy-1', targetSystemId: 'real-1' }
  assert.deepEqual(checkChildProof(proof, hash, 'copy-1'), [])
  // Mutation: delete the matching line of checkChildProof and that arm is green.
  const arms: Array<[string, unknown, string | null, string, string]> = [
    ['no proof file', null, hash, 'copy-1', 'NO_PROOF'],
    ['a proof of the wrong shape', { tokenSha256: 'x' }, hash, 'copy-1', 'NO_PROOF'],
    ['no token presented', proof, null, 'copy-1', 'NO_TOKEN'],
    ['another token', proof, 'b'.repeat(64), 'copy-1', 'TOKEN_MISMATCH'],
    ['another cluster', proof, hash, 'copy-2', 'WRONG_CLUSTER'],
    ['the real target', { ...proof, clusterSystemId: 'real-1' }, hash, 'real-1', 'IS_THE_TARGET'],
  ]
  for (const [label, p, presented, connected, code] of arms) assert.ok(checkChildProof(p, presented, connected).includes(code), label)
  precondition(t, 'proof arms', arms.length + 1)
})

test('the relaxation switch has one setter: thisIsTheRehearsal is set in exactly one place, after the authenticated-child branch', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const found: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) walk(full)
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) readFileSync(full, 'utf8').split('\n').forEach((line, i) => { if (/thisIsTheRehearsal\s*:\s*true/.test(line)) found.push(`${full.replace(process.cwd() + '/', '')}:${i + 1}`) })
    }
  }
  for (const root of ['lib', 'app', 'scripts']) walk(`${process.cwd()}/${root}`)
  assert.equal(found.length, 1, JSON.stringify(found))
  assert.match(found[0]!, /^scripts\/first-load-apply\.ts:/)
  const src = readFileSync('scripts/first-load-apply.ts', 'utf8')
  assert.ok(src.indexOf('checkChildProof(') < src.indexOf('thisIsTheRehearsal: true'), 'the proof is checked before the switch is set')
})

test('the record binds the code: the same clean commit and tree is accepted, anything else is refused [mutation: checkRecordBuild returns []]', (t) => {
  const record = { build: BUILD }
  assert.deepEqual(checkRecordBuild(record, BUILD), [])
  assert.deepEqual(checkRecordBuild(record, { ...BUILD, path: '/somewhere/else' }), [], 'the same code in another checkout path is the same code')
  const arms: Array<[string, unknown, typeof BUILD | null]> = [
    ['another commit', record, { ...BUILD, commit: 'c'.repeat(40) }],
    ['another tree', record, { ...BUILD, tree: 'd'.repeat(40) }],
    ['this checkout is dirty', record, { ...BUILD, clean: false }],
    ['this checkout cannot be identified', record, null],
    ['the record was made on a dirty checkout', { build: { ...BUILD, clean: false } }, BUILD],
    ['the record names no build', {}, BUILD],
    ['the record names a null build', { build: null }, BUILD],
    ['the record names a malformed build', { build: { commit: 'x', tree: 'y', clean: true, path: 'p' } }, BUILD],
    ['the record is not an object', 'text', BUILD],
    ['the record is an array', [], BUILD],
  ]
  for (const [label, rec, current] of arms) assert.equal(checkRecordBuild(rec, current).length, 1, label)
  precondition(t, 'build arms', arms.length)
})
