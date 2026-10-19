import assert from 'node:assert/strict'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { APPLY_EXIT_CODE_TABLE, REHEARSAL_RECORD_FORMAT_VERSION, RUNNER_APPLICATION_NAME } from '../../lib/first-load/apply/constants.ts'
import { DEFAULT_OPERATOR, REHEARSAL_DATABASE, buildRehearsalRecord, checkRecordBinding, checkRecordReportFile, checkRecordSchema, deriveRehearsalVerdict, validateChildReport, type RehearsalSignals, buildRunnerEnv, exitNameOfCode, helpText, libpqEnvFromUrl, parseCliArgs, reportStem } from '../../lib/first-load/apply/cli.ts'
import { runLoad } from '../../lib/first-load/apply/orchestrate.ts'
import { verifyPublishedReport } from '../../lib/ops/published-report.ts'
import { prepareReportDir, publishReportPair, readEnvFile, sha256OfFile } from '../../scripts/lib/first-load-apply-files.ts'
import { sameCounts } from '../../scripts/lib/first-load-rehearse.ts'
import { FakeDatabase, loadOk, prepareSynthetic, preparedFiles } from './apply-helpers.ts'
import { precondition } from './helpers.ts'

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
    ['a child dir without a stem', ['--apply', '--rehearsal-child-dir', '/var/tmp/x'], /given together/],
    ['a child that is not an apply', ['--plan', '--rehearsal-child-dir', '/var/tmp/x', '--report-stem', 's'], /runs as --apply/],
    ['a child with a record', ['--apply', '--rehearsal-child-dir', '/var/tmp/x', '--report-stem', 's', '--rehearsal-record', 'r'], /IS the rehearsal/],
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

const DIGEST = 'd'.repeat(64)
const goodReport = (over: Record<string, unknown> = {}) => ({ tool: 'first-load-apply', manifestDigest: DIGEST, exit: { name: 'OK' }, verification: [{ id: 'a', result: 'pass' }, { id: 'b', result: 'pass' }], ...over })
const SIGNALS: RehearsalSignals = { childStarted: true, childTimedOut: false, childExitCode: 0, report: { exitName: 'OK', verificationItems: 2, verificationFailed: 0 }, targetUnchanged: true, teardownComplete: true, problemCount: 0 }

test('the rehearsal verdict is derived in ONE place from every signal, and is OK only when all of them are good (each signal has an arm)', (t) => {
  // Mutation per arm: delete the corresponding line of deriveRehearsalVerdict and that arm's verdict becomes 'OK' (or the next signal's word).
  assert.deepEqual(deriveRehearsalVerdict(SIGNALS), { verdict: 'OK', loadExit: 'OK' })
  const arms: Array<[string, Partial<RehearsalSignals>, string]> = [
    ['the child never started', { childStarted: false }, 'NOT_RUN'],
    ['the child timed out', { childTimedOut: true }, 'CHILD_TIMED_OUT'],
    ['the child was killed by a signal', { childExitCode: null }, 'CHILD_KILLED'],
    ['an exit code outside the table', { childExitCode: 99 }, 'CHILD_EXIT_UNKNOWN'],
    ['the child exited 0 but its report is missing or invalid', { report: null }, 'REPORT_MISSING_OR_INVALID'],
    ['the report names another exit than the process', { report: { exitName: 'VERIFY_FAILED', verificationItems: 2, verificationFailed: 0 } }, 'REPORT_DISAGREES_WITH_EXIT'],
    ['a non-zero exit is mapped', { childExitCode: 1, report: { exitName: 'VERIFY_FAILED', verificationItems: 2, verificationFailed: 1 } }, 'VERIFY_FAILED'],
    ['a partial report with no verification items', { report: { exitName: 'OK', verificationItems: 0, verificationFailed: 0 } }, 'VERIFICATION_NOT_ALL_PASS'],
    ['a failing verification item behind an OK exit', { report: { exitName: 'OK', verificationItems: 2, verificationFailed: 1 } }, 'VERIFICATION_NOT_ALL_PASS'],
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
  const base = { manifestDigest: DIGEST, targetSystemId: '7', schemaHead: 'h', finishedAt: new Date('2026-10-20T10:00:00Z'), verdict: 'OK', loadExit: 'OK' as const, targetUnchanged: true, teardownComplete: true, report: { file: 'r.json', sha256: 'a'.repeat(64), verificationItems: 2, verificationFailed: 0 } }
  assert.equal(buildRehearsalRecord(base).verdict, 'OK')
  // Mutation: build 'OK' from args.verdict alone and every arm below is green.
  const arms: Array<Partial<typeof base> & { report?: null }> = [{ report: null }, { loadExit: null as never }, { targetUnchanged: false }, { teardownComplete: false }]
  for (const over of arms) assert.notEqual(buildRehearsalRecord({ ...base, ...over }).verdict, 'OK', JSON.stringify(over))
  precondition(t, 'record arms', arms.length)
})

test('a child report is valid only if it is this load\'s report with a documented exit and a verification list', (t) => {
  assert.deepEqual(validateChildReport(goodReport(), DIGEST), { exitName: 'OK', verificationItems: 2, verificationFailed: 0 })
  assert.deepEqual(validateChildReport(goodReport({ verification: [{ result: 'pass' }, { result: 'fail' }, {}] }), DIGEST), { exitName: 'OK', verificationItems: 3, verificationFailed: 2 })
  const bad: unknown[] = [null, 'x', [], goodReport({ tool: 'other' }), goodReport({ manifestDigest: 'e'.repeat(64) }), goodReport({ exit: { name: 'WHATEVER' } }), goodReport({ exit: null }), goodReport({ verification: 'pass' }), (() => { const r = goodReport(); delete (r as Record<string, unknown>).verification; return r })()]
  for (const parsed of bad) assert.equal(validateChildReport(parsed, DIGEST), null, JSON.stringify(parsed))
  precondition(t, 'report arms', bad.length)
})

test('the apply re-validates what an OK record binds: fields, then the report file itself', (t) => {
  const record = { verdict: 'OK', loadExit: 'OK', targetUnchanged: true, teardownComplete: true, report: { file: 'r.json', sha256: 'a'.repeat(64), verificationItems: 2, verificationFailed: 0 } }
  assert.deepEqual(checkRecordBinding(record), [])
  const clone = (over: Record<string, unknown>) => ({ ...record, ...over })
  const badFields: unknown[] = [
    null, {}, clone({ loadExit: 'VERIFY_FAILED' }), clone({ loadExit: null }), clone({ targetUnchanged: false }), clone({ targetUnchanged: undefined }), clone({ teardownComplete: false }), clone({ report: null }), clone({ report: undefined }),
    clone({ report: { ...record.report, file: '../r.json' } }), clone({ report: { ...record.report, file: 'r.csv' } }), clone({ report: { ...record.report, sha256: 'xyz' } }),
    clone({ report: { ...record.report, verificationItems: 0 } }), clone({ report: { ...record.report, verificationFailed: 1 } }), clone({ report: { ...record.report, verificationFailed: undefined } }),
  ]
  for (const bad of badFields) assert.ok(checkRecordBinding(bad).length > 0, JSON.stringify(bad))
  const sha = 'a'.repeat(64)
  assert.deepEqual(checkRecordReportFile(record, sha, goodReport(), DIGEST), [])
  const fileArms: Array<[string, string, unknown]> = [
    ['the file changed', 'b'.repeat(64), goodReport()],
    ['another load', sha, goodReport({ manifestDigest: 'e'.repeat(64) })],
    ['not OK inside', sha, goodReport({ exit: { name: 'VERIFY_FAILED' } })],
    ['a failing item inside', sha, goodReport({ verification: [{ result: 'pass' }, { result: 'fail' }] })],
    ['a different item count', sha, goodReport({ verification: [{ result: 'pass' }] })],
    ['unparseable', sha, null],
  ]
  for (const [label, hash, parsed] of fileArms) assert.equal(checkRecordReportFile(record, hash, parsed, DIGEST).length, 1, label)
  assert.equal(checkRecordReportFile({ ...record, report: null }, sha, goodReport(), DIGEST).length, 1)
  precondition(t, 'binding arms', badFields.length + fileArms.length + 1)
})

test('the record the command writes is accepted by the gate it feeds, and by nothing weaker', async () => {
  const prepared = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore' })
  const record = buildRehearsalRecord({ manifestDigest: prepared.manifestDigest, targetSystemId: 'sys-1', schemaHead: 'h', finishedAt: new Date(), verdict: 'OK', loadExit: 'OK', targetUnchanged: true, teardownComplete: true, report: { file: 'r.json', sha256: 'a'.repeat(64), verificationItems: 1, verificationFailed: 0 } })
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
const scratch = mkdtempSync('/var/tmp/first-load-apply-cli-unit-')
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
  assert.deepEqual(checkRecordSchema({ schemaHead: '20261001000000_x' }, '20261001000000_x'), [])
  const arms: unknown[] = [{ schemaHead: '20261002000000_y' }, {}, { schemaHead: '' }, { schemaHead: 5 }, null, 'x', []]
  for (const record of arms) assert.equal(checkRecordSchema(record, '20261001000000_x').length, 1, JSON.stringify(record))
  precondition(t, 'schema arms', arms.length)
})
