import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { renderCronJobCommand } from '../../lib/crontab-sync.ts'
import { withTempDir } from './temp-dir.ts'

/**
 * THE OLD `curl -H "Authorization: Bearer $CRON_SECRET"` CRON LINES ARE REWRITTEN BY EVERY UPGRADE PATH (Codex round 3).
 *
 * 1. install.sh used to be the only script that rewrote them, so a host upgraded through update.sh or deploy.sh kept
 *    the bearer in `ps` on every job run. The rewrite is now ONE shared function (scripts/lib/crontab-lock.sh) that all
 *    three scripts call; update.sh and deploy.sh refuse to report completion if old lines remain.
 * 2. A value substituted into a job line (log path, slug) must be inserted verbatim: `${cmd//@LOG@/${path}}` expands an
 *    `&` in the path (bash 5.2 patsub_replacement) and turned /var/log/acme&sons/cron.log into
 *    /var/log/acme@LOG@sons/cron.log.
 *
 * Every arm runs the SHIPPED shell (the lib sourced as-is, and the real call site lifted out of update.sh / deploy.sh)
 * against a fake crontab file, prints its precondition, and has a mutation that turns it red.
 */

const ROOT = process.cwd()
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')
const LIB_PATH = join(ROOT, 'scripts/lib/crontab-lock.sh')
const CRONLIB = read('scripts/lib/crontab-lock.sh')
const UPDATE = read('scripts/update.sh')
const DEPLOY = read('scripts/deploy.sh')
const INSTALL = read('scripts/install.sh')

const ENV_FILE = '/opt/one-two-inventory/.env'
const LOG_FILE = '/var/log/one-two-inventory/cron.log'

const LEGACY_RUNTIME = (sched: string, slug: string, env: string, log: string) =>
  `${sched}  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '${env}' | cut -d= -f2- | tr -d '"') && [ -n "$CRON_SECRET" ] && curl -sf -o /dev/null -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/${slug}" >> '${log}' 2>&1`
const LEGACY_LITERAL = (sched: string, slug: string, log: string) =>
  `${sched}   curl -sf -o /dev/null -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/${slug}" >> '${log}' 2>&1`

function legacyCrontab(mode: 'runtime' | 'literal', o: { before?: string[]; after?: string[]; env?: string; log?: string } = {}): string {
  const env = o.env ?? ENV_FILE
  const log = o.log ?? LOG_FILE
  const jobs = mode === 'runtime'
    ? [LEGACY_RUNTIME('0 2 * * *', 'backup', env, log), LEGACY_RUNTIME('*/7 * * * *', 'delivery-status', env, log), LEGACY_RUNTIME('30 4 * * 1', 'wc-reconcile', env, log)]
    : [LEGACY_LITERAL('0 2 * * *', 'backup', log), LEGACY_LITERAL('*/7 * * * *', 'delivery-status', log), LEGACY_LITERAL('30 4 * * 1', 'wc-reconcile', log)]
  return [
    ...(o.before ?? []),
    '# --- OTI CRON START ---',
    '# Managed by One Two Inventory — do not edit manually',
    ...(mode === 'literal' ? ['CRON_SECRET="legacy-literal-secret"'] : [`# CRON_SECRET is read from ${env} at runtime — rotating it needs no crontab re-sync.`]),
    'BASE_URL="http://localhost:3000/api/cron"',
    '',
    '# Database Backup', jobs[0], '',
    '# Delivery Status Check', jobs[1], '',
    '# WooCommerce Reconciliation', jobs[2], '',
    '# --- OTI CRON END ---',
    ...(o.after ?? []),
  ].join('\n') + '\n'
}

const legacyCount = (text: string) => text.split('-H "Authorization: Bearer').length - 1

interface RigOptions { failWrite?: boolean; ignoreWrite?: boolean; lockConflict?: boolean; readFail?: boolean; noCrontab?: boolean; dryRun?: boolean }
interface RigResult { after: string; out: string; status: number; complete: boolean; died: boolean }

/** Run `body` in a bash that has sourced the REAL crontab-lock.sh (from `lib`), with the crontab client faked by a file. */
function rig(dir: string, crontab: string, body: string, opts: RigOptions = {}, lib: string = CRONLIB): RigResult {
  const fake = join(dir, 'crontab.txt')
  if (!opts.noCrontab) writeFileSync(fake, crontab)
  const libPath = join(dir, 'crontab-lock.sh')
  writeFileSync(libPath, lib)
  const script = [
    'set -uo pipefail',
    `source ${JSON.stringify(libPath)}`,
    `FAKE=${JSON.stringify(fake)}; APP_USER=ims; DRY_RUN=${opts.dryRun ? 'true' : 'false'}; CURRENT_STEP=x`,
    'die() { echo "DIE: $*"; exit 9; }',
    'info() { echo "info: $*"; }; success() { echo "success: $*"; }; ok() { echo "ok: $*"; }',
    'require_crontab_command() { return 0; }',
    `read_crontab_for() { CRONTAB_READ_TEXT=""; CRONTAB_READ_PRESENT=false; CRONTAB_READ_REASON=""; ${opts.readFail ? 'CRONTAB_READ_REASON="the fake crontab read failed"; return 1;' : ''} [[ -f "$FAKE" ]] || return 0; CRONTAB_READ_TEXT="$(cat "$FAKE")"; CRONTAB_READ_PRESENT=true; }`,
    opts.ignoreWrite
      ? 'write_crontab_for() { return 0; }'
      : opts.failWrite
        ? 'write_crontab_for() { CRONTAB_WRITE_REASON="the crontab client rejected the write"; return 1; }'
        : 'write_crontab_for() { printf \'%s\\n\' "$2" > "$FAKE"; }',
    opts.lockConflict ? 'CRONTAB_LOCK_CONFLICT=75; with_crontab_lock() { return 75; }' : 'with_crontab_lock() { "$@"; }',
    body,
    'echo COMPLETE',
  ].join('\n')
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  const out = r.stdout + r.stderr
  let after = ''
  try { after = readFileSync(fake, 'utf8') } catch { /* no crontab */ }
  return { after, out, status: r.status ?? -1, complete: /^COMPLETE$/m.test(out), died: /^DIE: /m.test(out) }
}

/** The real call site, lifted out of a script: from its CURRENT_STEP line to the `fi` that closes the dry-run guard. */
function callSite(source: string, file: string): string {
  const start = source.indexOf('CURRENT_STEP="rewrite-legacy-cron"')
  assert.notEqual(start, -1, `precondition: ${file} has the rewrite-legacy-cron step`)
  const end = source.indexOf('\nfi\n', start)
  assert.notEqual(end, -1)
  return source.slice(start, end + 4)
}

const SCRIPTS = [
  { file: 'scripts/update.sh', source: UPDATE, unfence: /^unfence_cron$/m, done: /^DEPLOY_OK=true$/m },
  { file: 'scripts/deploy.sh', source: DEPLOY, unfence: /^unfence_cron$/m, done: /^DEPLOY_OK=true$/m },
] as const

/** A job line's command: everything after the five schedule fields and the spacing that follows (the rewrite keeps the old spacing). */
const commandsOf = (crontab: string) => crontab.split('\n').map((l) => l.replace(/^\S+(?:\s+\S+){4}\s+/, ''))

const slugSchedule = (crontab: string, slug: string) => (crontab.split('\n').find((l) => l.includes(`$BASE_URL/${slug}"`)) ?? '').match(/^(\S+(?:\s+\S+){4})\s/)?.[1]

// ---------------------------------------------------------------------------
// 1. update.sh and deploy.sh
// ---------------------------------------------------------------------------

for (const s of SCRIPTS) {
  test(`[o3d-kb3dq] ${s.file}: the call site sits after the cron restore and before completion, and runs the shared rewrite`, () => {
    const site = callSite(s.source, s.file)
    const at = s.source.indexOf(site)
    const unfence = s.source.search(s.unfence)
    const done = s.source.search(s.done)
    console.log(`  ${s.file}: unfence_cron @${unfence}, rewrite call site @${at}, DEPLOY_OK=true @${done}; call site is ${site.split('\n').length} lines`)
    assert.ok(unfence > 0 && at > unfence, 'the rewrite runs after the cron restore (the crontab is live again)')
    assert.ok(done > at, 'and before the run can report completion')
    assert.equal(site.split('ensure_cron_bearer_off_argv').length - 1, 1, 'it calls the shared function once')
    assert.match(site, /if ! \$DRY_RUN; then/, 'and never in a dry run')
    // the function lives in the lib only
    assert.equal(CRONLIB.split('\nensure_cron_bearer_off_argv() {').length - 1, 1)
    assert.ok(!s.source.includes('migrate_legacy_cron_lines()'), `${s.file} holds no copy of the rewrite`)
  })

  test(`[o3d-kb3dq] ${s.file}: legacy lines are rewritten (schedules kept, unrelated lines kept, idempotent) before completion`, async () => {
    for (const mode of ['runtime', 'literal'] as const) {
      await withTempDir('ims-cron-up-', async (dir) => {
        const unrelated = ['MAILTO=ops@example.test', '17 3 * * * /usr/local/bin/operator-job --keep']
        const before = legacyCrontab(mode, { before: [unrelated[0]], after: [unrelated[1]] })
        const site = callSite(s.source, s.file)
        const r = rig(dir, before, site)
        console.log(`  ${s.file} ${mode}: legacy lines before ${legacyCount(before)}, after ${legacyCount(r.after)}; status ${r.status} complete=${r.complete}`)
        assert.equal(legacyCount(before), 3, 'precondition: three legacy lines in')
        assert.equal(r.status, 0, r.out)
        assert.ok(r.complete)
        assert.equal(legacyCount(r.after), 0, 'no legacy bearer argument is left')
        for (const [slug, sched] of [['backup', '0 2 * * *'], ['delivery-status', '*/7 * * * *'], ['wc-reconcile', '30 4 * * 1']] as const) {
          assert.equal(slugSchedule(r.after, slug), sched, `the (custom) schedule of ${slug} is kept`)
        }
        for (const line of unrelated) assert.ok(r.after.split('\n').includes(line), `${line} is preserved`)
        assert.ok(r.after.includes('BASE_URL="http://localhost:3000/api/cron"'))
        if (mode === 'literal') assert.ok(r.after.split('\n').includes('CRON_SECRET="legacy-literal-secret"'))
        assert.match(r.out, /Rewrote the managed cron jobs/)
        // the rewritten line is the app renderer's own text
        const prefix = mode === 'runtime' ? `CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '${ENV_FILE}' | cut -d= -f2- | tr -d '"'); ` : ''
        assert.ok(commandsOf(r.after).includes(renderCronJobCommand({ prefix, slug: 'backup', logPath: LOG_FILE })), 'byte-identical to lib/crontab-sync.ts')
        // idempotent: a second run changes nothing and says nothing
        const second = rig(dir, r.after, site)
        assert.equal(second.after, r.after)
        assert.ok(!/Rewrote the managed/.test(second.out))
      })
    }
  })

  test(`[o3d-kb3dq] ${s.file}: refuses to complete when legacy lines remain (rejected write, unwritten write, unknown shape, lock conflict, unreadable crontab)`, async () => {
    const site = callSite(s.source, s.file)
    const cases: Array<[string, string, RigOptions, string]> = [
      ['rejected write', legacyCrontab('runtime'), { failWrite: true }, 'the crontab client rejected the write'],
      ['accepted but not written (read-back catches it)', legacyCrontab('runtime'), { ignoreWrite: true }, 'still holds the old curl -H bearer lines'],
      ['unknown line shape', legacyCrontab('runtime').replace('"$BASE_URL/backup" >>', '"$BASE_URL/backup" --max-time 5 >>'), {}, 'cannot rewrite'],
      ['lock conflict leaving old lines', legacyCrontab('runtime'), { lockConflict: true }, 'Authorization/Bearer header as a curl argument'],
      ['unreadable crontab', legacyCrontab('runtime'), { readFail: true }, 'could not be read'],
    ]
    for (const [name, crontab, opts, reason] of cases) {
      await withTempDir('ims-cron-up-refuse-', async (dir) => {
        const r = rig(dir, crontab, site, opts)
        console.log(`  ${s.file} ${name}: status ${r.status} died=${r.died} complete=${r.complete}; legacy lines left ${legacyCount(r.after)}`)
        assert.equal(r.status, 9, `${name}: the run ends`)
        assert.ok(r.died && !r.complete, `${name}: completion is never reached`)
        assert.match(r.out, /Authorization\/Bearer header as a curl argument/)
        assert.ok(r.out.includes(reason), `${name}: the message says why (${reason})`)
        assert.match(r.out, /Save & Apply/, 'and names the way out')
        if (name === 'unknown line shape') assert.equal(r.after, crontab, 'a shape it cannot rewrite leaves the crontab untouched')
      })
    }
    // the passes: nothing legacy / no managed block / a lock conflict with nothing to rewrite / no crontab at all
    await withTempDir('ims-cron-up-clean-', async (dir) => {
      const clean = 'MAILTO=a@b.test\n# --- OTI CRON START ---\nBASE_URL="x"\n0 2 * * *  case "$CRON_SECRET" in x) ;; esac\n# --- OTI CRON END ---\n'
      for (const [name, crontab, opts] of [['already rewritten', clean, {}], ['lock conflict, nothing legacy', clean, { lockConflict: true }], ['no managed block', 'MAILTO=a@b.test\n', {}], ['no crontab', '', { noCrontab: true }]] as const) {
        const r = rig(dir, crontab, site, opts)
        console.log(`  ${s.file} ${name}: status ${r.status} complete=${r.complete}`)
        assert.ok(r.complete && r.status === 0, `${name}: continues\n${r.out}`)
        if (!('noCrontab' in opts)) assert.equal(r.after, crontab, `${name}: byte-identical`)
      }
      // a managed-shape bearer line OUTSIDE the block is NOT rewritten (its $BASE_URL is undefined there) but it still exposes the secret: refused
      const outside = `${LEGACY_LITERAL('1 1 * * *', 'x', '/tmp/l')}\n# --- OTI CRON START ---\nBASE_URL="x"\n# --- OTI CRON END ---\n`
      const r = rig(dir, outside, site)
      assert.ok(r.died && !r.complete && r.after === outside, 'outside the block: refused, untouched')
    })
  })

  test(`[o3d-kb3dq] ${s.file}: a dry run changes nothing`, async () => {
    await withTempDir('ims-cron-up-dry-', async (dir) => {
      const before = legacyCrontab('runtime')
      const r = rig(dir, before, callSite(s.source, s.file), { dryRun: true })
      console.log(`  ${s.file} dry run: legacy lines ${legacyCount(r.after)} (unchanged) complete=${r.complete}`)
      assert.equal(r.after, before)
      assert.ok(r.complete)
    })
  })

  test(`[o3d-kb3dq] MUTATION (${s.file}): the call removed from the script leaves the old lines and completes, so the arms above CAN fail`, async () => {
    const mutated = s.source.replace(/^ {2}ensure_cron_bearer_off_argv "[^"]*"$/m, '  :')
    assert.notEqual(mutated, s.source, 'precondition: the call line was found and replaced')
    await withTempDir('ims-cron-up-mut-', async (dir) => {
      const r = rig(dir, legacyCrontab('runtime'), callSite(mutated, s.file))
      console.log(`  mutated ${s.file}: legacy lines left ${legacyCount(r.after)}, complete=${r.complete}`)
      assert.equal(legacyCount(r.after), 3)
      assert.ok(r.complete, 'it completes with the bearer still in ps -- the defect the arms above exist to catch')
    })
  })
}

test('[o3d-kb3dq] MUTATION (lib): the refusal turned into a pass leaves a completed run with old lines', async () => {
  const mutated = CRONLIB.replace('  if [[ "${legacy_left}" != "0" ]]; then\n    die ', '  if false; then\n    die ')
  assert.notEqual(mutated, CRONLIB)
  await withTempDir('ims-cron-lib-mut-', async (dir) => {
    const r = rig(dir, legacyCrontab('runtime'), callSite(UPDATE, 'scripts/update.sh'), { failWrite: true }, mutated)
    console.log(`  refusal removed: complete=${r.complete} legacy lines left ${legacyCount(r.after)}`)
    assert.ok(r.complete && legacyCount(r.after) === 3)
  })
  const mutated2 = CRONLIB.replace('    count_legacy_cron_lines "${CRONTAB_READ_TEXT}"\n    if [[ "${CRON_LEGACY_COUNT}" -ne 0 ]]; then', '    count_legacy_cron_lines ""\n    if [[ "${CRON_LEGACY_COUNT}" -ne 0 ]]; then')
  assert.notEqual(mutated2, CRONLIB)
  await withTempDir('ims-cron-lib-mut2-', async (dir) => {
    const r = rig(dir, legacyCrontab('runtime'), callSite(UPDATE, 'scripts/update.sh'), { ignoreWrite: true }, mutated2)
    console.log(`  read-back verification blinded: complete=${r.complete} legacy lines left ${legacyCount(r.after)}`)
    assert.ok(r.complete && legacyCount(r.after) === 3, 'a write that did not take effect is reported as done')
  })
})

test('[o3d-kb3dq] install.sh keeps its own use of the shared functions (no private copy to drift)', () => {
  for (const name of ['cron_job_command_into', 'migrate_legacy_cron_lines', 'count_legacy_cron_lines', 'rewrite_legacy_cron_block_locked', 'die_if_legacy_cron_lines_remain']) {
    assert.ok(!INSTALL.includes(`\n${name}() {`), `install.sh does not define ${name}`)
    assert.equal(CRONLIB.split(`\n${name}() {`).length - 1, 1, `the lib defines ${name} once`)
  }
  assert.ok(INSTALL.includes('rewrite_legacy_cron_block_locked "${existing}"'))
  assert.ok(INSTALL.includes('die_if_legacy_cron_lines_remain "this installer"'))
})

// ---------------------------------------------------------------------------
// 2. values with & \ % space " in a job line
// ---------------------------------------------------------------------------

const NASTY_PATHS = [
  '/var/log/acme&sons/cron.log',
  '/var/log/a&&b/&/cron.log',
  '/var/log/back\\slash/cron.log',
  '/var/log/back\\\\double/cron.log',
  '/var/log/trailing\\',
  '/var/log/100%/cron.log',
  '/var/log/with space/cron.log',
  '/var/log/dq"uote/cron.log',
  '/var/log/$HOME/`id`/cron.log',
  '/var/log/@LOG@/@SLUG@/cron.log',
  '/var/log/a\\&b/cron.log',
]

const runShell = (script: string) => spawnSync('bash', ['-c', ['set -uo pipefail', `source ${JSON.stringify(LIB_PATH)}`, script].join('\n')], { encoding: 'utf8' })

test('[o3d-kb3dq] PRECONDITION: this bash has patsub_replacement on, and the pattern-replacement construction DOES corrupt an `&` (so the arms below can fail)', () => {
  const r = runShell(`shopt patsub_replacement; echo "BASH=\${BASH_VERSION}"; t='>> @LOG@ 2>&1'; v='/var/log/acme&sons/cron.log'; echo "naive: \${t//@LOG@/\${v}}"; echo "shipped:"; cron_job_command backup '/var/log/acme&sons/cron.log' ''`)
  console.log(r.stdout.trim().split('\n').map((l) => '  ' + l).join('\n'))
  assert.match(r.stdout, /patsub_replacement\s+on/, 'precondition: the default bash behaviour that makes `&` special in a replacement')
  assert.match(r.stdout, /naive: >> \/var\/log\/acme@LOG@sons\/cron\.log 2>&1/, 'the pattern-replacement construction corrupts the path')
  assert.ok(r.stdout.includes("'/var/log/acme&sons/cron.log' 2>&1"), 'the shipped renderer keeps it')
})

test('[o3d-kb3dq] fresh rendering: every log path / slug / env path comes out verbatim and equals the app renderer byte for byte', () => {
  let n = 0
  for (const logPath of NASTY_PATHS.filter((p) => !/[$`]/.test(p))) {
    for (const envFile of ['', ENV_FILE, '/opt/a&b/.env']) {
      for (const slug of ['backup', 'a&b', 'x\\y', '@LOG@']) {
        const r = runShell(`cron_job_command ${JSON.stringify(slug)} ${JSON.stringify(logPath)} ${JSON.stringify(envFile)}`)
        assert.equal(r.status, 0, r.stderr)
        const prefix = envFile === '' ? '' : `CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '${envFile}' | cut -d= -f2- | tr -d '"'); `
        const expected = renderCronJobCommand({ prefix, slug, logPath })
        n += 1
        assert.equal(r.stdout, expected, `${JSON.stringify({ logPath, envFile, slug })}`)
      }
    }
  }
  console.log(`  fresh renders compared with lib/crontab-sync.ts: ${n} combinations (log paths without $ or backtick x 3 env paths x 4 slugs)`)
  assert.ok(n >= 100)
})

test('[o3d-kb3dq] fresh rendering of $ and backtick values (passed in the environment, not through shell quoting)', () => {
  let n = 0
  for (const logPath of NASTY_PATHS.filter((p) => /[$`@]/.test(p))) {
    const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB_PATH)}; cron_job_command "$SLUG" "$LOGP" "$ENVP"`], { encoding: 'utf8', env: { ...process.env, SLUG: 'backup', LOGP: logPath, ENVP: ENV_FILE } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, renderCronJobCommand({ prefix: `CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '${ENV_FILE}' | cut -d= -f2- | tr -d '"'); `, slug: 'backup', logPath }))
    n += 1
  }
  console.log(`  $ / backtick / placeholder-looking paths rendered verbatim: ${n}`)
  assert.ok(n >= 2)
})

test('[o3d-kb3dq] MIGRATION keeps a log path with & \\ % space " byte for byte (and the env path), both secret modes', async () => {
  const site = callSite(UPDATE, 'scripts/update.sh')
  let n = 0
  for (const logPath of NASTY_PATHS.filter((p) => !/[$`'\n]/.test(p) && !/@/.test(p))) {
    for (const envFile of [ENV_FILE, '/opt/a&b c/.env']) {
      for (const mode of ['runtime', 'literal'] as const) {
        await withTempDir('ims-cron-amp-', async (dir) => {
          const before = legacyCrontab(mode, { log: logPath, env: envFile })
          const r = rig(dir, before, site)
          assert.equal(legacyCount(before), 3, 'precondition: legacy lines in')
          assert.equal(r.status, 0, `${JSON.stringify({ logPath, envFile, mode })}\n${r.out}`)
          assert.equal(legacyCount(r.after), 0)
          const prefix = mode === 'runtime' ? `CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '${envFile}' | cut -d= -f2- | tr -d '"'); ` : ''
          for (const [slug, sched] of [['backup', '0 2 * * *'], ['delivery-status', '*/7 * * * *'], ['wc-reconcile', '30 4 * * 1']] as const) {
            assert.ok(commandsOf(r.after).includes(renderCronJobCommand({ prefix, slug, logPath })), `${JSON.stringify({ logPath, mode, slug })}: the redirect target is the original path`)
            assert.equal(slugSchedule(r.after, slug), sched)
          }
          assert.ok(!r.after.includes('@LOG@') || logPath.includes('@LOG@'), 'no placeholder text leaked into the job')
          n += 1
        })
      }
    }
  }
  console.log(`  migrated crontabs checked: ${n}`)
  assert.ok(n >= 36)
})

test('[o3d-kb3dq] MUTATION: the pattern-replacement construction back in cron_job_command_into corrupts `&` (fresh AND migrated), so the arms above CAN fail', async () => {
  const mutated = CRONLIB.replace(/  while \[\[ -n "\$\{template\}" \]\]; do[\s\S]*?\n  done\n/, '  command="${template//@SLUG@/${slug}}"\n  command="${command//@LOG@/${logfile}}"\n')
  assert.notEqual(mutated, CRONLIB, 'precondition: the walk was found and replaced')
  const libPath = join(ROOT, 'scripts/lib/crontab-lock.sh')
  void libPath
  await withTempDir('ims-cron-amp-mut-', async (dir) => {
    const p = join(dir, 'mutated-lib.sh')
    writeFileSync(p, mutated)
    const r = spawnSync('bash', ['-c', `source ${JSON.stringify(p)}; cron_job_command backup '/var/log/acme&sons/cron.log' ''`], { encoding: 'utf8' })
    console.log(`  mutated: ${r.stdout.slice(-60)}`)
    assert.ok(r.stdout.includes('acme@LOG@sons'), 'fresh rendering is corrupted')
    const m = rig(dir, legacyCrontab('runtime', { log: '/var/log/acme&sons/cron.log' }), callSite(UPDATE, 'scripts/update.sh'), {}, mutated)
    console.log(`  mutated migration: ${m.after.split('\n').filter((l) => l.includes('acme')).length} job lines mention acme; corrupted: ${m.after.includes('acme@LOG@sons')}`)
    assert.ok(m.after.includes('acme@LOG@sons'), 'migration is corrupted')
  })
})

// ---------------------------------------------------------------------------
// 3. audit: no shell script substitutes a variable value as a pattern REPLACEMENT
// ---------------------------------------------------------------------------

/** `${name/pat/repl}` and `${name//pat/repl}` (the pattern may hold `\X`, `$'..'`, brackets; it ends at the first unescaped /). */
const REPLACEMENT_EXPANSION = /\$\{[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\/\/?((?:\\.|\$'(?:[^'\\]|\\.)*'|\[[^\]]*\]|[^/}\\])*)\/((?:\\.|\$'(?:[^'\\]|\\.)*'|[^}\\])*)\}/g

function replacementFindings(files: Record<string, string>): { total: number; unsafe: string[] } {
  let total = 0
  const unsafe: string[] = []
  for (const [file, text] of Object.entries(files)) {
    text.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('#')) return
      for (const m of line.matchAll(REPLACEMENT_EXPANSION)) {
        total += 1
        const repl = m[2]
        // unsafe: the replacement expands a variable / command (its value would be interpreted: & \ ...), or holds a bare `&`
        if (/\$[A-Za-z_{(]|`/.test(repl.replace(/\$'(?:[^'\\]|\\.)*'/g, '')) || /(?<!\\)&/.test(repl)) unsafe.push(`${file}:${i + 1}: ${m[0]}`)
      }
    })
  }
  return { total, unsafe }
}

function shellFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(join(ROOT, 'scripts'))) if (f.endsWith('.sh')) out[`scripts/${f}`] = read(`scripts/${f}`)
  for (const f of readdirSync(join(ROOT, 'scripts/lib'))) if (f.endsWith('.sh')) out[`scripts/lib/${f}`] = read(`scripts/lib/${f}`)
  return out
}

test('[o3d-kb3dq] AUDIT: no ${var/pat/repl} or ${var//pat/repl} in scripts/*.sh or scripts/lib/*.sh has a variable (or bare &) in its replacement', () => {
  const files = shellFiles()
  const { total, unsafe } = replacementFindings(files)
  console.log(`  ${Object.keys(files).length} shell files; ${total} pattern-replacement expansions found; unsafe replacement: ${unsafe.length}`)
  assert.ok(Object.keys(files).length >= 15 && total >= 15, 'precondition: the scan sees the scripts and finds the known expansions')
  assert.deepEqual(unsafe, [])
})

test('[o3d-kb3dq] MUTATION (audit): the rule flags the shapes that were wrong', () => {
  const bad = {
    'x.sh': [
      'command="${command//@LOG@/${logfile}}"',
      'x="${x/foo/$bar}"',
      'y="${y//a/b&c}"',
      'z="${z//a/`id`}"',
    ].join('\n'),
  }
  const r = replacementFindings(bad)
  console.log(`  trunk shape: ${r.total} expansions, ${r.unsafe.length} flagged`)
  assert.equal(r.total, 4)
  assert.equal(r.unsafe.length, 4)
  const good = replacementFindings({ 'y.sh': ['a="${a//-/_}"', 'b="${b//$\'\\n\'/\\\\n}"', 'c="${c//\\\\/\\\\\\\\}"', 'd="${e//[\\\\\\"]/}"'].join('\n') })
  assert.equal(good.total, 4)
  assert.deepEqual(good.unsafe, [])
})

// ---------------------------------------------------------------------------
// 4. the UNMARKED jobs older installers wrote (Codex round 4), and the general detector
// ---------------------------------------------------------------------------
//
// Shapes found in `git log -- scripts/install.sh` (every revision that wrote a cron line):
//   47e4016e..0ff23a66, 1adfde71, ba14fecb, 3835651d  `<sched> curl -fsS http://localhost:<port>/api/cron/<slug> > /dev/null 2>&1`
//                                       no Authorization header, no secret: nothing on argv. NOT a finding; left alone.
//   80bb3700, d3ebd53a  (UNMARKED)       `<sched> CRON_SECRET=$(grep -m 1 '^CRON_SECRET=' '<env>' | cut -d= -f2-) && curl -fsS -H "Authorization: Bearer ${CRON_SECRET}" http://localhost:<port>/api/cron/<slug> > /dev/null 2>&1`
//                                       REWRITTEN (also accepted with $CRON_SECRET, a `tr -d` and a `[ -n ]` guard).
//   c831a8bc..d9007b1d  (MARKED)        `... && [ -n "$CRON_SECRET" ] && curl -sf -o /dev/null -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/<slug>" >> '<log>' 2>&1` (and the app's literal mode) REWRITTEN (rounds 2-3).
//   anything else running curl with an Authorization/Bearer header argument, in or out of the block, a literal secret
//   included: REFUSED by the general detector (the line number is named; the line is never printed).

const HIST = (sched: string, slug: string, o: { env?: string; port?: number; braces?: boolean; redirect?: boolean } = {}) =>
  `${sched} CRON_SECRET=$(grep -m 1 '^CRON_SECRET=' '${o.env ?? ENV_FILE}' | cut -d= -f2-) && curl -fsS -H "Authorization: Bearer ${o.braces === false ? '$CRON_SECRET' : '${CRON_SECRET}'}" http://localhost:${o.port ?? 3000}/api/cron/${slug}${o.redirect === false ? '' : ' > /dev/null 2>&1'}`
const HIST_NOAUTH = (sched: string, slug: string) => `${sched} curl -fsS http://localhost:3000/api/cron/${slug} > /dev/null 2>&1`

/** The stdin-form command the rewrite must produce for a historical line, built here independently of the shell. */
const histExpected = (env: string, url: string, redirect: string) =>
  `CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '${env}' | cut -d= -f2- | tr -d '"'); case "$CRON_SECRET" in ''|*\\\\*) echo "cron-auth: CRON_SECRET is missing or unusable (empty, or holds a backslash); ${url} was not run" ;; *) echo "header = \\"Authorization: Bearer $CRON_SECRET\\"" | curl -sf -o /dev/null -K - "${url}" ;; esac${redirect}`

/** Run a crontab command the way cron does (`sh -c`) with a curl stand-in that records its argv and its stdin. */
function runCronCommand(dir: string, command: string, env: Record<string, string>): { argv: string; stdin: string; ran: boolean } {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const argvLog = join(dir, 'curl-argv.log')
  const stdinLog = join(dir, 'curl-stdin.log')
  writeFileSync(join(bin, 'curl'), ['#!/bin/sh', `echo "curl $*" >> ${JSON.stringify(argvLog)}`, `cat >> ${JSON.stringify(stdinLog)}`].join('\n') + '\n')
  chmodSync(join(bin, 'curl'), 0o755)
  spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CRON_SECRET: '', ...env } })
  const rd = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  return { argv: rd(argvLog), stdin: rd(stdinLog), ran: rd(argvLog) !== '' }
}

const exposed = (text: string) => text.split('\n').filter((l) => !l.trim().startsWith('#') && /curl.*\s(-H|--header)\b.*(Bearer|Authorization)/i.test(l)).length

for (const s of SCRIPTS) {
  test(`[o3d-kb3dq] ${s.file}: UNMARKED historical jobs (both secret spellings) are rewritten in place, inside and outside the block, with everything else kept`, async () => {
    const site = callSite(s.source, s.file)
    await withTempDir('ims-cron-hist-', async (dir) => {
      const before = [
        'MAILTO=ops@example.test',
        HIST('0 6 * * *', 'fx-rates'),
        HIST('*/15 * * * *', 'delivery-status', { braces: false, env: '/srv/ims one/.env'.replace(' ', '_'), port: 3100 }),
        HIST_NOAUTH('0 3 * * *', 'activity-cleanup'),
        '17 3 * * * /usr/local/bin/operator-job --keep',
        '# curl -H "Authorization: Bearer old" http://x  (a comment is not a job)',
        ...legacyCrontab('runtime').trimEnd().split('\n'),
        HIST('5 5 * * 5', 'backup'),
        '',
      ].join('\n')
      console.log(`  ${s.file}: precondition: ${exposed(before)} exposing lines in (4 unmarked/marked historical + managed legacy x3 = 6 expected)`)
      assert.equal(exposed(before), 6)
      const r = rig(dir, before, site)
      assert.equal(r.status, 0, r.out)
      assert.ok(r.complete)
      assert.equal(exposed(r.after), 0, 'no bearer header argument remains anywhere')
      const lines = r.after.split('\n')
      assert.ok(lines.includes(`0 6 * * * ${histExpected(ENV_FILE, 'http://localhost:3000/api/cron/fx-rates', ' > /dev/null 2>&1')}`), 'schedule, env path, URL and redirect kept (${CRON_SECRET} form)')
      assert.ok(lines.includes(`*/15 * * * * ${histExpected('/srv/ims_one/.env', 'http://localhost:3100/api/cron/delivery-status', ' > /dev/null 2>&1')}`), '$CRON_SECRET form, other port and env path')
      assert.ok(lines.includes(`5 5 * * 5 ${histExpected(ENV_FILE, 'http://localhost:3000/api/cron/backup', ' > /dev/null 2>&1')}`), 'a historical job AFTER the managed block')
      for (const keep of ['MAILTO=ops@example.test', HIST_NOAUTH('0 3 * * *', 'activity-cleanup'), '17 3 * * * /usr/local/bin/operator-job --keep', '# curl -H "Authorization: Bearer old" http://x  (a comment is not a job)', 'BASE_URL="http://localhost:3000/api/cron"']) {
        assert.ok(lines.includes(keep), `kept: ${keep}`)
      }
      assert.equal(slugSchedule(r.after, 'backup'), '0 2 * * *', 'the managed legacy job is rewritten too, schedule kept')
      const second = rig(dir, r.after, site)
      assert.equal(second.after, r.after, 'idempotent')
    })
  })

  test(`[o3d-kb3dq] ${s.file}: a rewritten historical job RUNS under sh with the secret on no command line`, async () => {
    const site = callSite(s.source, s.file)
    await withTempDir('ims-cron-hist-run-', async (dir) => {
      const envFile = join(dir, '.env')
      writeFileSync(envFile, `CRON_SECRET=${'hist-canary-71c2'}\n`)
      const r = rig(dir, `${HIST('0 6 * * *', 'fx-rates', { env: envFile })}\n`, site)
      assert.equal(r.status, 0, r.out)
      const command = r.after.trim().replace(/^\S+(?:\s+\S+){4}\s+/, '')
      const ran = runCronCommand(dir, command, {})
      console.log(`  curl argv: ${JSON.stringify(ran.argv.trim())}; header on stdin: ${ran.stdin.includes('Authorization: Bearer hist-canary-71c2')}`)
      assert.ok(ran.ran && !ran.argv.includes('hist-canary-71c2') && ran.stdin.includes('Authorization: Bearer hist-canary-71c2'))
      assert.ok(ran.argv.includes('http://localhost:3000/api/cron/fx-rates'))
    })
  })

  test(`[o3d-kb3dq] ${s.file}: any OTHER bearer-header curl line (literal secret, extra flag, single quotes, --header, wrong shape) is refused by line number, never printed`, async () => {
    const site = callSite(s.source, s.file)
    const SECRET = 'literal-canary-5e90aa'
    const odd = [
      `0 6 * * * curl -fsS -H "Authorization: Bearer ${SECRET}" http://localhost:3000/api/cron/fx-rates > /dev/null 2>&1`,
      `0 3 * * * curl -fsS -H 'Authorization: Bearer ${SECRET}' http://localhost:3000/api/cron/backup`,
      `0 2 * * * curl -fsS --header "Authorization: Bearer ${SECRET}" http://localhost:3000/api/cron/wc-reconcile`,
      HIST('0 4 * * *', 'x').replace('curl -fsS', 'curl -fsS --max-time 5'),
      `*/5 * * * * sh -c 'curl -H "Authorization: Bearer ${SECRET}" http://x'`,
    ]
    for (const [i, line] of odd.entries()) {
      await withTempDir('ims-cron-hist-odd-', async (dir) => {
        const before = ['MAILTO=a@b.test', HIST('0 6 * * *', 'fx-rates'), line, ''].join('\n')
        const r = rig(dir, before, site)
        console.log(`  ${s.file} odd shape ${i}: status ${r.status} died=${r.died}; message names line 3: ${/line\(s\) 3\b/.test(r.out)}; secret printed: ${r.out.includes(SECRET)}`)
        assert.equal(r.status, 9)
        assert.ok(r.died && !r.complete)
        assert.match(r.out, /line\(s\) 3 /, 'the line number is named')
        assert.ok(!r.out.includes(SECRET) && !r.out.includes('curl -fsS'), 'and the line content is not')
        assert.equal(r.after, before, 'nothing is half-rewritten: the crontab is untouched')
      })
    }
    // the detector does not fire on the stdin form, on a no-auth curl or on a comment
    await withTempDir('ims-cron-hist-ok-', async (dir) => {
      const fine = [HIST_NOAUTH('0 3 * * *', 'x'), `0 6 * * * ${histExpected(ENV_FILE, 'http://localhost:3000/api/cron/fx-rates', ' > /dev/null 2>&1')}`, `# 1 1 * * * curl -H "Authorization: Bearer ${SECRET}" http://x`, ''].join('\n')
      const r = rig(dir, fine, site)
      assert.ok(r.complete && r.after === fine)
    })
  })
}

test('[o3d-kb3dq] MUTATION: the historical-shape rewrite removed => the old unmarked jobs are REFUSED instead of rewritten (rewrite arm red); the general detector blinded => a literal-secret line completes', async () => {
  const noHist = CRONLIB.replace('    elif cron_line_exposes_bearer "${line}" && [[ "${line}" =~ ${re_hist} ]]; then', '    elif false; then')
  assert.notEqual(noHist, CRONLIB)
  const blind = CRONLIB.replace('  [[ "${line}" =~ ${CRON_EXPOSURE_RE} ]]\n}', '  return 1\n}')
  assert.notEqual(blind, CRONLIB)
  const site = callSite(UPDATE, 'scripts/update.sh')
  await withTempDir('ims-cron-hist-mut-', async (dir) => {
    const hist = `${HIST('0 6 * * *', 'fx-rates')}\n`
    const a = rig(dir, hist, site, {}, noHist)
    console.log(`  rewrite removed: died=${a.died} complete=${a.complete}, bearer lines left ${exposed(a.after)}`)
    assert.ok(a.died && !a.complete && exposed(a.after) === 1, 'the rewrite arm\'s expectation (status 0, 0 lines left) is false')
    const literal = `0 6 * * * curl -fsS -H "Authorization: Bearer ${'literal' + '-canary'}" http://localhost:3000/api/cron/fx-rates\n`
    const b = rig(dir, literal, site, {}, blind)
    console.log(`  detector blinded: died=${b.died} complete=${b.complete}, bearer lines left ${exposed(b.after)}`)
    assert.ok(b.complete && !b.died && exposed(b.after) === 1, 'the refusal arm\'s expectation (die) is false')
  })
})

// ---------------------------------------------------------------------------
// 5. first rollout: the documented update runs the PREDECESSOR driver (Codex round 5)
// ---------------------------------------------------------------------------
//
// The standing root-owned driver is a copy of an OLDER update.sh. It deploys the new code but its tail has no
// rewrite step, so nothing in the new release's scripts runs. The fix cannot be code in the new update.sh (the old
// driver never executes it); it is the documented first-rollout path (run the release's own scripts from a
// root-fetched directory) and a check that tells the operator whether the old lines are still scheduled. The test
// simulates the predecessor tail (this release's script with the rewrite step removed, which is what the predecessor
// is), shows it completes with the lines intact, runs the check taken FROM THE DOCS, then runs the documented remedy.

const docsText = read('docs/installation.md')
const ROLLOUT_HEADING = '### First rollout of the release that takes the cron bearer off the command line'
const rolloutSection = (() => {
  const i = docsText.indexOf(ROLLOUT_HEADING)
  assert.notEqual(i, -1, 'precondition: the docs carry the first-rollout section')
  const j = docsText.indexOf('\nTo see what is standing', i)
  return docsText.slice(i, j)
})()
/** The documented check, lifted from the docs: the code line that starts with `sudo crontab`. */
const checkCommand = (() => {
  const m = rolloutSection.split('\n').find((l) => l.startsWith('sudo crontab -u imsapp -l | grep'))
  assert.ok(m, 'precondition: the docs carry the check command')
  return m!
})()

function runDocumentedCheck(dir: string, crontab: string): string {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(dir, 'live-crontab.txt'), crontab)
  // `sudo` and `crontab` stand-ins: the documented line is run as written
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n')
  writeFileSync(join(bin, 'crontab'), `#!/bin/sh\ncat ${JSON.stringify(join(dir, 'live-crontab.txt'))}\n`)
  chmodSync(join(bin, 'sudo'), 0o755)
  chmodSync(join(bin, 'crontab'), 0o755)
  const r = spawnSync('bash', ['-c', checkCommand], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } })
  return r.stdout
}

for (const s of SCRIPTS) {
  test(`[o3d-kb3dq] FIRST ROLLOUT (${s.file}): the predecessor driver leaves the old lines and reports success; the documented check sees them; the documented remedy clears them`, async () => {
    const predecessorTail = s.source.replace(callSite(s.source, s.file), '')
    assert.notEqual(predecessorTail, s.source, 'precondition: the predecessor is this script without the rewrite step')
    assert.ok(!predecessorTail.includes('ensure_cron_bearer_off_argv "'), 'and it has no call to the rewrite')
    await withTempDir('ims-cron-rollout-', async (dir) => {
      const SECRET = 'rollout-canary-3b7d'
      const legacy = legacyCrontab('runtime', { before: ['MAILTO=ops@example.test'] }) + `0 6 * * * curl -fsS -H "Authorization: Bearer ${SECRET}" http://localhost:3000/api/cron/fx-rates\n`
      // 1. the standing (predecessor) driver: nothing in its tail touches the crontab
      const predecessor = rig(dir, legacy, 'echo "(predecessor tail: no rewrite step)"')
      assert.ok(predecessor.complete && predecessor.status === 0)
      assert.equal(predecessor.after, legacy, 'the old driver completes with the crontab as it was')
      // 2. the documented check, as printed in the docs, finds them and prints numbers only
      const flagged = runDocumentedCheck(dir, predecessor.after)
      console.log(`  ${s.file}: documented check after the predecessor run prints: ${JSON.stringify(flagged)}`)
      assert.match(flagged, /^(\d+\n)+$/, 'only line numbers')
      const expectedLines = legacy.split('\n').flatMap((l, i) => (!l.startsWith('#') && l.includes('Bearer') ? [i + 1] : []))
      assert.equal(expectedLines.length, 4, 'precondition: three managed legacy jobs and one literal-secret job')
      assert.deepEqual(flagged.trim().split('\n').map(Number), expectedLines)
      assert.ok(!flagged.includes(SECRET))
      // 3. the documented remedy: this release's own script (root-fetched copy), whose tail has the step
      const remedy = rig(dir, predecessor.after, callSite(s.source, s.file))
      assert.ok(remedy.died && !remedy.complete && remedy.status === 9, 'a literal-secret line it cannot rewrite is refused, naming it')
      // and without the unrecognised line it completes and the check is empty
      const clean = legacyCrontab('runtime', { before: ['MAILTO=ops@example.test'] })
      const fixed = rig(dir, clean, callSite(s.source, s.file))
      assert.ok(fixed.complete && fixed.status === 0)
      assert.equal(runDocumentedCheck(dir, fixed.after), '', 'the documented check prints nothing once the lines are rewritten')
    })
  })
}

test('[o3d-kb3dq] the first-rollout docs name both ways out and the digest option', () => {
  console.log(`  rollout section: ${rolloutSection.split('\n').length} lines`)
  for (const needle of ['PREDECESSOR', 'install.sh', 'update.sh', 'IMS_DRIVER_SHA256', 'never the lines', '#supported-bootstrap']) {
    assert.ok(rolloutSection.includes(needle), `the section mentions ${needle}`)
  }
})
