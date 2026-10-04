/**
 * The command line: every exit code in the table is produced by a real run, the output is idempotent and equals the
 * golden files, and a dry run writes nothing.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { REPORT_JSON_NAME, REPORT_MD_NAME, runCli } from '../../lib/first-load/cli.ts'
import { EXIT_CODES, EXIT_CODE_TABLE } from '../../lib/first-load/spec.ts'
import { FIXTURE_DIR, precondition } from './helpers.ts'

const scratch = mkdtempSync(path.join(tmpdir(), 'first-load-cli-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let counter = 0
const fresh = (label: string) => path.join(scratch, `${label}-${++counter}`)

async function cli(args: string[], deps = {}) {
  let stdout = ''
  let stderr = ''
  const code = await runCli(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) }, deps)
  return { code, stdout, stderr }
}

function copyFixture(): string {
  const dir = fresh('fixture')
  cpSync(FIXTURE_DIR, dir, { recursive: true })
  return dir
}

const MANIFEST = path.join(FIXTURE_DIR, 'manifest.json')
const GOLDEN = path.join(FIXTURE_DIR, 'expected')

test('exit 0: the fixture run writes the five import files and the report; output equals the golden files byte for byte', async (t) => {
  const out = fresh('out')
  const { code, stdout } = await cli(['--manifest', MANIFEST, '--out', out, '--run-id', 'fixture'])
  assert.equal(code, EXIT_CODES.OK)
  const written = readdirSync(out).sort()
  precondition(t, 'files written', written.length)
  assert.deepEqual(written, [...readdirSync(GOLDEN).sort(), REPORT_JSON_NAME, REPORT_MD_NAME].sort())
  let compared = 0
  for (const name of readdirSync(GOLDEN)) {
    assert.equal(readFileSync(path.join(out, name), 'utf8'), readFileSync(path.join(GOLDEN, name), 'utf8'), name)
    compared++
  }
  precondition(t, 'golden files compared', compared)
  assert.match(stdout, /TOTAL\s+64\s+57\s+7\s+0\s+0/, 'the accounting table is printed')
  assert.match(stdout, /Verdict: PASS/)
})

test('idempotence: running twice into fresh directories gives identical bytes in every file, report included', async (t) => {
  const a = fresh('a')
  const b = fresh('b')
  assert.equal((await cli(['--manifest', MANIFEST, '--out', a, '--run-id', 'same'])).code, 0)
  assert.equal((await cli(['--manifest', MANIFEST, '--out', b, '--run-id', 'same'])).code, 0)
  const names = readdirSync(a).sort()
  precondition(t, 'files compared', names.length)
  assert.deepEqual(readdirSync(b).sort(), names)
  for (const name of names) assert.equal(readFileSync(path.join(a, name), 'utf8'), readFileSync(path.join(b, name), 'utf8'), name)
})

test('--dry-run: exit 0, prints the report and the accounting table, writes nothing anywhere', async (t) => {
  const before = readdirSync(scratch).length
  const { code, stdout } = await cli(['--manifest', MANIFEST, '--dry-run'])
  assert.equal(code, EXIT_CODES.OK)
  precondition(t, 'report characters printed', stdout.length)
  assert.match(stdout, /Mode: dry run \(no file was written\)/)
  assert.match(stdout, /No blocking finding was found in the datasets supplied\. This is a dry run, so no import file was written\./)
  assert.equal(readdirSync(scratch).length, before)
})

test('exit 1: a blocking finding writes the report but NO import file', async (t) => {
  const dir = copyFixture()
  writeFileSync(path.join(dir, 'qoblex/bom-lines.csv'), `${readFileSync(path.join(dir, 'qoblex/bom-lines.csv'), 'utf8')}LEG-01,TABLE-01,1,2\n`)
  const out = fresh('blocked')
  const { code, stdout } = await cli(['--manifest', path.join(dir, 'manifest.json'), '--out', out])
  assert.equal(code, EXIT_CODES.BLOCKING_FINDINGS)
  const written = readdirSync(out).sort()
  precondition(t, 'files written', written.length)
  assert.deepEqual(written, [REPORT_JSON_NAME, REPORT_MD_NAME])
  const report = JSON.parse(readFileSync(path.join(out, REPORT_JSON_NAME), 'utf8'))
  assert.equal(report.verdict, 'BLOCKED')
  assert.deepEqual(report.recipes.cycles.length, 1)
  assert.match(stdout, /No import file was produced/)
  assert.match(readFileSync(path.join(out, REPORT_MD_NAME), 'utf8'), /No import file is produced for a BLOCKED run/)
})

test('exit 2: usage and manifest errors read and write nothing', async (t) => {
  const cases: string[][] = [
    [],
    ['--bogus'],
    ['--manifest'],
    ['--manifest', MANIFEST],
    ['--manifest', MANIFEST, '--out', fresh('x'), '--dry-run'],
    ['--manifest', MANIFEST, '--dry-run', '--run-id', 'bad id!'],
    ['--manifest', path.join(scratch, 'no-such-manifest.json'), '--dry-run'],
  ]
  precondition(t, 'usage cases', cases.length)
  for (const args of cases) assert.equal((await cli(args)).code, EXIT_CODES.USAGE, args.join(' '))
  const dir = copyFixture()
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const writeManifest = (m: unknown) => writeFileSync(path.join(dir, 'm.json'), JSON.stringify(m))
  writeManifest({ ...manifest, surprise: true })
  assert.equal((await cli(['--manifest', path.join(dir, 'm.json'), '--dry-run'])).code, EXIT_CODES.USAGE)
  writeManifest({ ...manifest, inputs: [...manifest.inputs, manifest.inputs[0]] })
  assert.equal((await cli(['--manifest', path.join(dir, 'm.json'), '--dry-run'])).code, EXIT_CODES.USAGE, 'a dataset listed twice')
  writeManifest({ ...manifest, transferKeyPrefix: null })
  const noPrefix = await cli(['--manifest', path.join(dir, 'm.json'), '--dry-run'])
  assert.equal(noPrefix.code, EXIT_CODES.USAGE, 'a missing key prefix is a configuration error')
  assert.match(noPrefix.stderr, /transferKeyPrefix must be set/)
  writeManifest({ ...manifest, baseCurrency: undefined })
  assert.equal((await cli(['--manifest', path.join(dir, 'm.json'), '--dry-run'])).code, EXIT_CODES.USAGE, 'the base currency is never assumed')
})

test('exit 3: a missing file, a bad column map, a drifted header or invalid UTF-8 each stop the run before anything is written', async (t) => {
  const out = fresh('unusable')
  const run = async (mutate: (dir: string) => void) => {
    const dir = copyFixture()
    mutate(dir)
    return cli(['--manifest', path.join(dir, 'manifest.json'), '--out', out])
  }
  const results = [
    await run((dir) => rmSync(path.join(dir, 'qoblex/suppliers.csv'))),
    await run((dir) => writeFileSync(path.join(dir, 'maps/qoblex.map.json'), '{ not json')),
    await run((dir) => writeFileSync(path.join(dir, 'qoblex/products.csv'), readFileSync(path.join(dir, 'qoblex/products.csv'), 'utf8').replace('Item Code', 'Item code'))),
    await run((dir) => writeFileSync(path.join(dir, 'woocommerce/products.csv'), Buffer.concat([Buffer.from('ID,SKU,Product type\n1,'), Buffer.from([0xff, 0xfe]), Buffer.from(',simple\n')]))),
  ]
  precondition(t, 'unusable-input cases', results.length)
  for (const result of results) assert.equal(result.code, EXIT_CODES.INPUT_UNUSABLE, result.stderr)
  assert.ok(!existsSync(out), 'nothing was created')
  assert.match(results[2].stderr, /A similar header exists/)
})

test('exit 4: a non-empty output directory is refused and left exactly as it was', async (t) => {
  const out = fresh('occupied')
  mkdirSync(out)
  writeFileSync(path.join(out, 'keep.txt'), 'mine')
  const { code, stderr } = await cli(['--manifest', MANIFEST, '--out', out])
  precondition(t, 'files in the directory', readdirSync(out).length)
  assert.equal(code, EXIT_CODES.OUTPUT_FAILED)
  assert.deepEqual(readdirSync(out), ['keep.txt'])
  assert.equal(readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'mine')
  assert.match(stderr, /not empty; nothing was written/)
})

test('exit 5: a failed self-check of the tool is reported as INTERNAL and nothing is written', async (t) => {
  const out = fresh('internal')
  const { prepare } = await import('../../lib/first-load/transform.ts')
  const broken = (input: Parameters<typeof prepare>[0]) => {
    const result = prepare(input)
    return { ...result, outputs: [], report: { ...result.report, selfCheckFailures: ['simulated'] }, blocking: true }
  }
  const { code } = await cli(['--manifest', MANIFEST, '--out', out], { prepare: broken })
  precondition(t, 'simulated self-check failures', 1)
  assert.equal(code, EXIT_CODES.INTERNAL)
  assert.ok(!readdirSync(out).some((name) => name.endsWith('.csv') && name !== REPORT_JSON_NAME), 'no import file')
})

test('--help prints the one exit-code table', async (t) => {
  const { code, stdout } = await cli(['--help'])
  precondition(t, 'exit-code rows', EXIT_CODE_TABLE.length)
  assert.equal(code, 0)
  for (const row of EXIT_CODE_TABLE) assert.ok(stdout.includes(`  ${row.code}  ${row.name}: ${row.meaning}`), row.name)
})

test('the script itself: a real process exits with the table\'s code (0 for the fixture, 2 for no arguments)', (t) => {
  const script = path.join(process.cwd(), 'scripts/first-load-prepare.ts')
  const ok = spawnSync(process.execPath, ['--import', 'tsx', script, '--manifest', MANIFEST, '--dry-run'], { cwd: process.cwd(), encoding: 'utf8' })
  const usage = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: process.cwd(), encoding: 'utf8' })
  precondition(t, 'processes run', 2)
  assert.equal(ok.status, EXIT_CODES.OK, ok.stderr)
  assert.equal(usage.status, EXIT_CODES.USAGE, usage.stderr)
})
