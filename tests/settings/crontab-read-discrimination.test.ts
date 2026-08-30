import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'

import { isNoCrontabDiagnostic } from '@/lib/crontab-sync'

// ---------------------------------------------------------------------------
// Codex r29 HIGH #1 — ONE DISCRIMINATION RULE, WRITTEN TWICE, HELD TOGETHER BY EXECUTION
//
// `crontab -l` answers "this user has no crontab" with exit 1 and empty stdout — and answers a
// permission failure, an unknown user, a wedged spool and an I/O error exactly the same way. The
// exit status cannot separate them; only the DIAGNOSTIC can, and only when it is matched WHOLE.
//
// That rule now exists in two places, and it has to:
//
//   scripts/lib/crontab-lock.sh  crontab_read_says_no_crontab()  — for the three entrypoints
//   lib/crontab-sync.ts          isNoCrontabDiagnostic()         — for the application
//
// The application cannot reach the shell one. It is bundled into a Next.js server build with no
// shell, no repository checkout beneath it and no way to source a bash function; and moving the
// rule to a shared data file would not help, because the NORMALISATION is the rule — a regex string
// interpreted once by `sed` and once by RegExp is two rules wearing one coat.
//
// So they are kept in agreement by RUNNING BOTH over ONE table. Every case below is put to the
// TypeScript predicate in-process and to the shipped bash function through a real `bash`, and the
// two verdicts must match. Either copy drifting fails this; a case added here is answered by both
// or by neither.
//
// WHAT THIS PINS, and the route:
//   1. LOAD-BEARING. Both implementations give the same verdict on every case
//                     (lib/crontab-sync.ts + scripts/lib/crontab-lock.sh, executed)
//   2. the rule is not vacuous in either direction: the benign diagnostic is accepted, and every
//      near-miss is refused
//   3. MUTATION. A substring match — the plausible wrong implementation — is shown to disagree
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd()
const CRONTAB_LOCK_LIB = join(REPO_ROOT, 'scripts/lib/crontab-lock.sh')

function shellProbe(user: string, stderr: string, lib = CRONTAB_LOCK_LIB) {
  return new Promise<boolean>((resolve, reject) => {
    const proc = spawn('bash', ['-c', [
      'set -uo pipefail',
      `source '${lib}'`,
      `if crontab_read_says_no_crontab "$PROBE_USER" "$PROBE_ERR"; then echo YES; else echo NO; fi`,
    ].join('\n')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PROBE_USER: user, PROBE_ERR: stderr },
    })
    let out = ''
    proc.stdout.on('data', (c) => { out += String(c) })
    proc.on('error', reject)
    proc.on('close', () => {
      const answer = out.trim().split('\n').pop()
      if (answer !== 'YES' && answer !== 'NO') return reject(new Error(`unreadable shell verdict: ${out}`))
      resolve(answer === 'YES')
    })
  })
}

const USER = 'appuser'

/**
 * ONE TABLE, BOTH IMPLEMENTATIONS. The first five rows are the states scripts/lib/crontab-lock.sh
 * records from a real Debian Vixie `crontab`; the rest are the near-misses that decide whether the
 * match is whole or sloppy.
 */
const CASES: Array<[name: string, stderr: string, expected: boolean]> = [
  ['the benign diagnostic, exactly', `no crontab for ${USER}`, true],
  ['…with the crontab: label', `crontab: no crontab for ${USER}`, true],
  ['…with a trailing newline', `no crontab for ${USER}\n`, true],
  ['…with surrounding whitespace', `   no crontab for ${USER}  \n`, true],
  ['…with a CR, as a CRLF pipe delivers it', `no crontab for ${USER}\r\n`, true],
  ['not privileged to use -u', 'must be privileged to use -u', false],
  ['no such user', `crontab:  user '${USER}' unknown`, false],
  ['nothing said at all', '', false],
  ['a DIFFERENT user', 'no crontab for someone-else', false],
  ['the message with a SECOND line after it', `no crontab for ${USER}\nI/O error reading spool`, false],
  ['the message with a second line BEFORE it', `I/O error reading spool\nno crontab for ${USER}`, false],
  ['the message with trailing text on the same line', `no crontab for ${USER} (spool unreadable)`, false],
  ['the message as a substring of a bigger complaint', `warning: no crontab for ${USER} was found, and the spool is unreadable`, false],
  ['a user whose name is a prefix of the real one', 'no crontab for app', false],
]

test('[o3d-batch-ret] the application and the shell answer the SAME rule on every case', async () => {
  for (const [name, stderr, expected] of CASES) {
    const app = isNoCrontabDiagnostic(USER, stderr)
    const shell = await shellProbe(USER, stderr)
    assert.equal(app, expected, `TypeScript disagrees with the rule on "${name}": ${JSON.stringify(stderr)}`)
    assert.equal(shell, expected, `bash disagrees with the rule on "${name}": ${JSON.stringify(stderr)}`)
    assert.equal(app, shell,
      `THE TWO COPIES HAVE DRIFTED on "${name}": TypeScript says ${app}, bash says ${shell}`)
  }

  // NOT VACUOUS IN EITHER DIRECTION: the table really does contain both verdicts, so a predicate
  // that always returned the same thing could not pass.
  assert.ok(CASES.some(([, , e]) => e), 'the table must contain an accepted case')
  assert.ok(CASES.some(([, , e]) => !e), 'the table must contain refused cases')
})

test('[o3d-batch-ret] MUTATION: a substring match — the plausible wrong rule — disagrees on the near-misses', async () => {
  // THE ROUTE, RUN, on both sides. `includes` instead of a whole-string comparison is what
  // "matching the diagnostic" means if nobody says WHOLE, and it accepts a failure that merely
  // mentions the benign message.
  const sloppyApp = (user: string, stderr: string) => stderr.includes(`no crontab for ${user}`)

  const trap = `no crontab for ${USER}\nI/O error reading spool`
  assert.equal(sloppyApp(USER, trap), true, 'the sloppy rule accepts a failure that quotes the message')
  assert.equal(isNoCrontabDiagnostic(USER, trap), false,
    'and the shipped rule refuses it — an I/O error is not an absent crontab')

  // The shell side, mutated in its shipped source so the pre-fix behaviour is RUN rather than
  // described: the whole-string comparison becomes a substring test.
  const src = (await import('node:fs')).readFileSync(CRONTAB_LOCK_LIB, 'utf8')
  const whole = '  [[ "${normalised}" == "no crontab for ${user}" ]]'
  assert.equal(src.split(whole).length - 1, 1,
    'the shell rule must compare the normalised diagnostic WHOLE, exactly once')
  const sloppySrc = src.replace(whole, '  [[ "${normalised}" == *"no crontab for ${user}"* ]]')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const sloppyLib = join(mkdtempSync(join(tmpdir(), 'crontab-rule-')), 'crontab-lock.sh')
  writeFileSync(sloppyLib, sloppySrc)

  assert.equal(await shellProbe(USER, trap, sloppyLib), true,
    'the mutated shell rule accepts it too, so the whole-string comparison is what is doing the work')
  assert.equal(await shellProbe(USER, trap), false,
    'while the shipped one refuses')
})
