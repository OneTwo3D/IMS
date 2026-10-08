/**
 * THE FIRST-INSTALL BLOCKERS A DISPOSABLE-HOST REHEARSAL FOUND IN scripts/install.sh (and the two
 * sibling entrypoints), PINNED SO THEY CANNOT COME BACK.
 *
 * Nothing here runs install.sh. Each arm either lifts the SHIPPED function/statement text into a
 * `bash` of its own (the same technique tests/scripts/install-shell-rig.ts uses) or reads the
 * shipped text and asserts a universal property of it. Every arm prints the precondition it
 * reached; each names the ONE mutation that turns it red (all were run against the shipped files
 * and restored from a copy).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import ts from 'typescript'

import { runProductionPreflight } from '../../scripts/preflight-production.ts'
import { shippedFunction } from './real-postgres-cluster.ts'
import { withTempDir } from './temp-dir.ts'

const REPO = process.cwd()
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const INSTALL = read('scripts/install.sh')
const UPDATE = read('scripts/update.sh')
const DEPLOY = read('scripts/deploy.sh')

/** Code lines only (comments and blanks dropped), keeping the 1-based line number. */
function code(source: string): Array<{ n: number; text: string }> {
  return source
    .split('\n')
    .map((text, i) => ({ n: i + 1, text }))
    .filter((l) => l.text.trim() !== '' && !/^\s*#/.test(l.text))
}

function bash(program: string): { status: number; out: string } {
  try {
    const out = execFileSync('bash', ['-c', program], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' } as unknown as NodeJS.ProcessEnv,
    })
    return { status: 0, out }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

// ---------------------------------------------------------------------------
// F5 -- a first install raises no fence, so the start step must not ask to release one
// ---------------------------------------------------------------------------

const RELEASE_FN = shippedFunction(INSTALL, 'release_db_connections')
const RESOLVE_FN = shippedFunction(INSTALL, 'resolve_fence_script')

/**
 * The shipped release_db_connections() (and, optionally, the shipped resolve_fence_script()) with
 * everything they call stubbed. `resolver: 'real'` keeps the shipped resolver, which is what refuses
 * on a first install; `'stub'` replaces it with one that records the call and refuses, which is how
 * an arm shows that the release REACHED the helper.
 */
function releaseProgram(flag: 'true' | 'false', resolver: 'real' | 'stub', skipCheck = true): string {
  const fn = skipCheck ? RELEASE_FN : RELEASE_FN.replace(/  if \$\{FIRST_INSTALL_NO_CREDENTIALED_FENCE\}; then\n[\s\S]*?\n  fi\n/, '')
  assert.ok(skipCheck || fn !== RELEASE_FN, 'precondition: the skip block was found to remove')
  return [
    'set -uo pipefail',
    'exec 2>&1',
    'info() { echo "INFO: $*"; }',
    'error() { echo "ERROR: $*"; }',
    'die() { error "$*"; exit 1; }',
    `FIRST_INSTALL_NO_CREDENTIALED_FENCE=${flag}`,
    resolver === 'real' ? RESOLVE_FN : 'resolve_fence_script() { echo "RESOLVER_CALLED" >&2; return 1; }',
    fn,
  ].join('\n')
}

const asked = (program: string) => bash(`${program}\nrelease_db_connections; echo "RELEASE_RC=$?"`)

test('F5 precondition: without the skip, the shipped release fails on a first install (the rig can see the defect)', () => {
  // Trunk's behaviour, reproduced by cutting the skip out of the shipped function: the first-install
  // flag is set, the real resolver refuses, and the release reports failure -- which the start step
  // turned into `Refusing to start the application`.
  const r = asked(releaseProgram('true', 'real', false))
  console.log(`  F5 precondition (skip removed): ${JSON.stringify(r.out.trim().split('\n').map((l) => l.slice(0, 90)))}`)
  assert.match(r.out, /RELEASE_RC=1/, `the unskipped release must fail on a first install:\n${r.out}`)
  assert.match(r.out, /performs NO credentialed fence execution/, 'and it fails on the first-install refusal, not on something else')
})

test('F5: on a first install the shipped release succeeds without reaching the fence helper', () => {
  const r = asked(releaseProgram('true', 'real'))
  console.log(`  F5 first-install arm: ${JSON.stringify(r.out.trim().split('\n').map((l) => l.slice(0, 110)))}`)
  assert.match(r.out, /RELEASE_RC=0/, `the release must succeed on a first install:\n${r.out}`)
  assert.doesNotMatch(r.out, /Cannot release|performs NO credentialed fence/, 'and print no refusal')
  assert.match(r.out, /INFO: This run created the database itself and fenced nothing/, 'and say why nothing was lifted')
  // Isolating arm: with the resolver replaced by a recorder, a first install must never call it.
  const iso = asked(releaseProgram('true', 'stub'))
  assert.doesNotMatch(iso.out, /RESOLVER_CALLED/, `the helper is never asked on a first install:\n${iso.out}`)
  assert.match(iso.out, /RELEASE_RC=0/)
})

test('F5: when no first-install exemption was taken the release still reaches the helper, and its refusal still fails it', () => {
  const r = asked(releaseProgram('false', 'stub'))
  console.log(`  F5 update arm: ${JSON.stringify(r.out.trim().split('\n').map((l) => l.slice(0, 110)))}`)
  assert.match(r.out, /RESOLVER_CALLED/, `the release must reach the helper when the flag is false:\n${r.out}`)
  assert.match(r.out, /RELEASE_RC=1/, 'and a refusal must remain a failed release')
  assert.doesNotMatch(r.out, /This run created the database itself and fenced nothing/, 'and must not claim there was nothing to lift')
})

test('F5: the flag is armed in exactly one place, and the start step still demands a successful release', () => {
  const lines = code(INSTALL)
  const arms = lines.filter((l) => /^\s*FIRST_INSTALL_NO_CREDENTIALED_FENCE=true\b/.test(l.text))
  const falses = lines.filter((l) => /FIRST_INSTALL_NO_CREDENTIALED_FENCE=false/.test(l.text))
  const fnStart = INSTALL.split('\n').findIndex((t) => t.startsWith('first_install_fence_policy() {')) + 1
  const fnEnd = INSTALL.split('\n').findIndex((t, i) => i + 1 > fnStart && t === '}') + 1
  console.log(`  F5 static: armed at line(s) ${arms.map((a) => a.n)} (first_install_fence_policy spans ${fnStart}-${fnEnd}); initialised false at ${falses.map((a) => a.n)}`)
  assert.equal(arms.length, 1, 'the flag is set to true in exactly one statement')
  assert.ok(arms[0].n > fnStart && arms[0].n < fnEnd, 'and that statement is inside first_install_fence_policy()')
  assert.equal(falses.length, 1, 'and it is initialised false exactly once (nothing clears it later)')

  const enable = lines.find((l) => l.text === 'systemctl enable "${APP_NAME}.service"')
  const step = lines.find((l) => l.text === 'release_db_connections \\' && l.n > (enable?.n ?? 1e9))
  const remove = lines.find((l) => l.n > (step?.n ?? 1e9) && l.text === 'remove_reboot_fence')
  const start = lines.find((l) => l.text === 'systemctl start "${APP_NAME}.service"')
  console.log(`  F5 static order: enable=${enable?.n} release=${step?.n} remove_reboot_fence=${remove?.n} start=${start?.n}`)
  assert.ok(enable && step && remove && start, 'precondition: all four statements found')
  assert.ok(enable.n < step.n && step.n < remove.n && remove.n < start.n, 'enable, release, reboot-fence removal, start -- in that order')
  assert.match(INSTALL.split('\n')[step.n], /^\s*\|\| die "Refusing to start the application while it has no CONNECT on its own database\."$/, 'and a failed release still ends the run')
  // The skip is the first thing the shipped function does, ahead of the resolver that refuses.
  const body = RELEASE_FN.split('\n')
  const skip = body.findIndex((t) => t === '  if ${FIRST_INSTALL_NO_CREDENTIALED_FENCE}; then')
  const resolve = body.findIndex((t) => t.includes('"$(resolve_fence_script)"'))
  console.log(`  F5 static: in release_db_connections the skip is at body line ${skip}, the resolver call at ${resolve}`)
  assert.ok(skip > 0 && resolve > skip, 'the skip precedes the resolver call')
})

// ---------------------------------------------------------------------------
// F1 -- every value the .env template interpolates must be defined before it is
// ---------------------------------------------------------------------------

test('F1: every ${NAME} the .env template interpolates is assigned by a prompt or statement earlier in the script', () => {
  const body = shippedFunction(INSTALL, 'render_app_env_file')
  const names = [...new Set([...body.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]))]
  const lines = INSTALL.split('\n')
  const fnLine = lines.findIndex((t) => t.startsWith('render_app_env_file() {')) + 1
  const unassigned: string[] = []
  for (const name of names) {
    const assigned = lines.some(
      (t, i) =>
        i + 1 < fnLine &&
        !/^\s*#/.test(t) &&
        (new RegExp(`^\\s*(prompt|prompt_yn|capture)\\s+${name}\\b`).test(t) ||
          new RegExp(`^\\s*(readonly\\s+|local\\s+|declare\\s+(-[a-zA-Z]+\\s+)?)?${name}=`).test(t) ||
          new RegExp(`printf -v ${name}\\b`).test(t)),
    )
    if (!assigned) unassigned.push(name)
  }
  console.log(`  F1 precondition: ${names.length} distinct variables interpolated by render_app_env_file(); unassigned: ${JSON.stringify(unassigned)}`)
  assert.ok(names.length >= 15, 'precondition: the template was actually parsed')
  assert.ok(names.includes('NEXT_PUBLIC_TURNSTILE_SITE_KEY') && names.includes('TURNSTILE_SECRET_KEY'), 'precondition: the two reported variables are among them')
  assert.deepEqual(unassigned, [], 'every interpolated name must be defined, or the set -u .env write dies after packages and the user exist')
})

test('F1: the Turnstile prompts leave both variables defined (empty) under set -u, and honour an exported value', () => {
  const promptLines = INSTALL.split('\n').filter((t) => /^prompt (NEXT_PUBLIC_TURNSTILE_SITE_KEY|TURNSTILE_SECRET_KEY)\b/.test(t))
  assert.equal(promptLines.length, 2, 'precondition: both prompts found')
  const program = (exports: string) =>
    ['set -uo pipefail', 'NON_INTERACTIVE=true', shippedFunction(INSTALL, 'prompt'), exports, ...promptLines,
      'echo "SITE=[${NEXT_PUBLIC_TURNSTILE_SITE_KEY}] SECRET=[${TURNSTILE_SECRET_KEY}]"'].join('\n')
  const empty = bash(program(''))
  const given = bash(program('export NEXT_PUBLIC_TURNSTILE_SITE_KEY=site-abc TURNSTILE_SECRET_KEY=sec-xyz'))
  console.log(`  F1 behaviour: unset -> ${empty.out.trim()}; exported -> ${given.out.trim()}`)
  assert.equal(empty.status, 0, empty.out)
  assert.match(empty.out, /SITE=\[\] SECRET=\[\]/)
  assert.match(given.out, /SITE=\[site-abc\] SECRET=\[sec-xyz\]/)
  // They are collected in the configuration phase, i.e. before the first package is installed.
  const idx = (re: RegExp) => code(INSTALL).find((l) => re.test(l.text))?.n ?? -1
  const prompts = idx(/^prompt NEXT_PUBLIC_TURNSTILE_SITE_KEY/)
  const collected = INSTALL.split('\n').findIndex((t) => t.includes('Configuration collected. Starting installation')) + 1
  console.log(`  F1 order: prompt at line ${prompts}, "Configuration collected" at ${collected}`)
  assert.ok(prompts > 0 && prompts < collected, 'asked before "Configuration collected", which precedes every package install')
})

// ---------------------------------------------------------------------------
// F4 -- a blank default admin email must not leave the password unbound
// ---------------------------------------------------------------------------

function adminPromptBlock(): string {
  const lines = INSTALL.split('\n')
  const start = lines.findIndex((t) => t.startsWith('prompt DEFAULT_ADMIN_NAME '))
  assert.notEqual(start, -1, 'precondition: the admin prompts exist')
  const end = lines.findIndex((t, i) => i > start && t === 'fi')
  assert.notEqual(end, -1)
  return lines.slice(start, end + 1).join('\n')
}

test('F4: with a blank default admin email, DEFAULT_ADMIN_PASSWORD is defined (empty) under set -u', () => {
  const block = adminPromptBlock()
  console.log(`  F4 precondition: admin prompt block is ${block.split('\n').length} lines`)
  const run = (env: string) =>
    bash(['set -uo pipefail', 'NON_INTERACTIVE=true', shippedFunction(INSTALL, 'prompt'), env, block,
      'echo "PW=[${DEFAULT_ADMIN_PASSWORD}] NOTIFY=[${NOTIFICATION_EMAIL:-}]"'].join('\n'))
  const blank = run('')
  console.log(`  F4 blank email: ${blank.out.trim()}`)
  assert.equal(blank.status, 0, `blank email must not abort under set -u:\n${blank.out}`)
  assert.match(blank.out, /PW=\[\]/)
  // An exported password with no email names an account nothing will create: it is discarded.
  const stray = run('export DEFAULT_ADMIN_PASSWORD=left-over')
  assert.match(stray.out, /PW=\[\]/, `a stray exported password is discarded when no admin is requested:\n${stray.out}`)
  // The control: with an email, the password is asked for (exported value honoured) and the arm is not vacuous.
  const withEmail = run('export DEFAULT_ADMIN_EMAIL=a@example.invalid DEFAULT_ADMIN_PASSWORD=chosen-pw')
  console.log(`  F4 with email: ${withEmail.out.trim()}`)
  assert.match(withEmail.out, /PW=\[chosen-pw\] NOTIFY=\[a@example.invalid\]/)
})

// ---------------------------------------------------------------------------
// F6 -- the bootstrap says "sent" only when a message was sent
// ---------------------------------------------------------------------------

test('F6: provision-instance.mjs prints "sent" only on the value sendProvisioningEmail returns', async () => {
  const { sendProvisioningEmail } = (await import('../../scripts/provision-instance.mjs')) as {
    sendProvisioningEmail: (o: unknown) => Promise<boolean>
  }
  const logged: string[] = []
  const realLog = console.log
  console.log = (...args: unknown[]) => { logged.push(args.join(' ')) }
  let result: boolean
  try {
    result = await sendProvisioningEmail({ smtp: { host: '', fromEmail: '' }, notificationEmail: 'ops@example.invalid', admin: {}, domain: 'd' })
  } finally {
    console.log = realLog
  }
  console.log(`  F6 precondition: incomplete SMTP -> returned ${result}, logged ${JSON.stringify(logged)}`)
  assert.equal(result, false, 'nothing was attempted, so it must not report a send')
  assert.equal(logged.length, 1)
  assert.match(logged[0], /Skipping provisioning email/)
  const src = read('scripts/provision-instance.mjs')
  const sentLine = src.split('\n').findIndex((t) => t.includes('Provisioning email sent')) + 1
  const guard = src.split('\n')[sentLine - 2]
  console.log(`  F6 static: line ${sentLine - 1} is ${JSON.stringify(guard.trim())}`)
  assert.match(guard, /^\s*if \(emailSent\) \{$/, 'the success line is guarded by the helper\'s own result')
  assert.match(src, /const emailSent = await sendProvisioningEmail\(/)
})

// ---------------------------------------------------------------------------
// F3 -- the build step's heap ceiling, in all three entrypoints
// ---------------------------------------------------------------------------

const BUILD_FN = shippedFunction(INSTALL, 'build_node_options')

test('F3: the three entrypoints carry byte-identical build_node_options()', () => {
  console.log(`  F3 precondition: function is ${BUILD_FN.split('\n').length} lines`)
  assert.equal(shippedFunction(UPDATE, 'build_node_options'), BUILD_FN, 'update.sh differs from install.sh')
  assert.equal(shippedFunction(DEPLOY, 'build_node_options'), BUILD_FN, 'deploy.sh differs from install.sh')
})

test('F3: build_node_options() yields the documented ceiling, honours the override, and refuses nonsense', () => {
  const ask = (nodeOptions: string, override: string) =>
    bash(['exec 2>&1', BUILD_FN, `NODE_OPTIONS='${nodeOptions}' IMS_BUILD_MAX_OLD_SPACE_MB='${override}' build_node_options; echo " rc=$?"`].join('\n'))
  const table: Array<[string, string, string]> = [
    ['', '', '--max-old-space-size=6144 rc=0'],
    ['--trace-warnings', '', '--trace-warnings --max-old-space-size=6144 rc=0'],
    ['--max-old-space-size=3072', '', '--max-old-space-size=3072 rc=0'],
    ['', '8192', '--max-old-space-size=8192 rc=0'],
    ['--max-old-space-size=3072 --trace-warnings', '8192', '--trace-warnings --max-old-space-size=8192 rc=0'],
  ]
  for (const [nodeOptions, override, want] of table) {
    const got = ask(nodeOptions, override).out.trim()
    console.log(`  F3 NODE_OPTIONS=[${nodeOptions}] IMS_BUILD_MAX_OLD_SPACE_MB=[${override}] -> ${got}`)
    assert.equal(got, want)
  }
  for (const bad of ['12', 'lots', '8192; touch x', '-1', '0900']) {
    const r = ask('', bad)
    console.log(`  F3 refusal for [${bad}] -> ${r.out.trim().split('\n')[0]}`)
    assert.match(r.out, /rc=1/, `${bad} must be refused`)
    assert.match(r.out, /IMS_BUILD_MAX_OLD_SPACE_MB must be a whole number/)
  }
})

test('F3: each entrypoint hands the ceiling to the build and only the build, validated before anything is changed', () => {
  for (const [name, source] of [['install.sh', INSTALL], ['update.sh', UPDATE], ['deploy.sh', DEPLOY]] as const) {
    const lines = code(source)
    const builds = lines.filter((l) => /\bnpm run build\b/.test(l.text) || (/^\s*(run )?(run_as_user_db|as_app_user_db)\b/.test(l.text) && /NODE_OPTIONS/.test(l.text)))
    const buildCalls = lines.filter((l) => /\bnpm run build\b/.test(l.text) && !/would run/.test(l.text) && !/echo/.test(l.text))
    console.log(`  F3 ${name}: npm run build at line(s) ${buildCalls.map((l) => l.n)}`)
    assert.equal(buildCalls.length, 1, `${name}: exactly one real build invocation`)
    const idx = lines.indexOf(buildCalls[0])
    const stmt = [lines[idx - 1].text, lines[idx].text].join(' ')
    assert.match(stmt, /(^|\s)NODE_OPTIONS="\$\{BUILD_NODE_OPTIONS\}" (run run_as_user_db|run_as_user_db|as_app_user_db)\b/, `${name}: the build is run with NODE_OPTIONS set from the validated value`)
    assert.ok(builds.length >= 1)
    assert.equal(lines.filter((l) => /\bexport NODE_OPTIONS\b/.test(l.text)).length, 0, `${name}: NODE_OPTIONS is not exported for the whole run`)
    const validate = lines.find((l) => /^BUILD_NODE_OPTIONS="\$\(build_node_options\)"/.test(l.text))
    assert.ok(validate, `${name}: validated up front`)
    assert.ok(validate.n < buildCalls[0].n, `${name}: validation precedes the build`)
  }
  // install.sh specifically: before any package, account or directory is touched.
  const lines = code(INSTALL)
  const validate = lines.find((l) => /^BUILD_NODE_OPTIONS="\$\(build_node_options\)"/.test(l.text))!
  const firstChange = lines.find((l) => /\b(apt-get install|useradd)\b/.test(l.text))!
  console.log(`  F3 install.sh: validation at ${validate.n}, first package/account change at ${firstChange.n}`)
  assert.ok(validate.n < firstChange.n)
})

// ---------------------------------------------------------------------------
// F7 -- the stock installed .env satisfies the production preflight's storage rules
// ---------------------------------------------------------------------------

test('F7: the installer defines, writes and creates INVOICE_PDF_STORAGE_DIR under the state directory', () => {
  const lines = code(INSTALL)
  const def = lines.find((l) => /^INVOICE_PDF_STORAGE_DIR="\$\{DATA_DIR\}\/invoice-pdfs"$/.test(l.text))
  const env = lines.find((l) => l.text === 'INVOICE_PDF_STORAGE_DIR=${INVOICE_PDF_STORAGE_DIR}')
  const make = lines.find((l) => /^own_service_subdir "\$\{DATA_DIR\}" 022 "\$\{INVOICE_PDF_STORAGE_DIR\}" "\$\{APP_USER\}" 750$/.test(l.text))
  const chown = lines.find((l) => /^chown_state_tree "\$\{DATA_DIR\}"/.test(l.text))
  console.log(`  F7 static: default=${def?.n} env-line=${env?.n} create=${make?.n} state-tree chown=${chown?.n}`)
  assert.ok(def && env && make && chown, 'precondition: all four statements found')
  assert.ok(make.n < chown.n, 'created before the state tree is handed to the application account')
})

test('F7: the production preflight passes the storage rules for the directory and variable the installer produces', async () => {
  // The value the installer writes, computed by the shipped assignment (DATA_DIR pointed at a scratch root).
  await withTempDir('ims-first-install-f7-', async (root) => {
    const assignment = INSTALL.split('\n').find((t) => /^INVOICE_PDF_STORAGE_DIR="/.test(t))
    assert.ok(assignment, 'precondition: the installer assigns INVOICE_PDF_STORAGE_DIR')
    const state = join(root, 'state')
    const written = bash(`DATA_DIR='${state}'\n${assignment}\nprintf '%s' "$INVOICE_PDF_STORAGE_DIR"`).out
    assert.equal(written, join(state, 'invoice-pdfs'))
    const env = (dir: string): Record<string, string> => ({
      UPLOAD_STORAGE_DIR: join(root, 'uploads'),
      PUBLIC_UPLOAD_STORAGE_DIR: join(root, 'public-uploads'),
      BACKUP_DIR: join(root, 'backups'),
      INVOICE_PDF_STORAGE_DIR: dir,
      NODE_ENV: 'production',
      AUTH_SECRET: 'auth_secret_value_with_32_chars_ok',
      DATABASE_URL: 'postgresql://imsuser:password@localhost:5432/ims',
      NEXT_PUBLIC_APP_URL: 'https://localhost:3001',
      AUTH_URL: 'https://localhost:3001',
      CRON_SECRET: 'cron_secret_value_with_32_chars_ok',
      SETTINGS_ENCRYPTION_KEY: 'settings_key_value_with_32_chars',
      FILE_SCAN_MODE: 'disabled',
      ALLOW_DATABASE_RESTORE: 'false',
      ALLOW_DATABASE_RESTORE_UPLOAD: 'false',
    })
    for (const d of ['uploads/invoices', 'uploads/quarantine/invoices', 'public-uploads/avatars', 'public-uploads/branding', 'backups']) {
      mkdirSync(join(root, d), { recursive: true })
    }
    // CONTROL: the variable is written but the directory was not created -- the second failure the rehearsal saw.
    const missing = await runProductionPreflight({ env: env(written) })
    const missingFails = missing.checks.filter((c) => c.status === 'fail').map((c) => c.id)
    console.log(`  F7 control (directory absent): failing checks ${JSON.stringify(missingFails)}`)
    assert.ok(missingFails.includes('invoicePdfStorage'), 'the rig can see the missing directory')
    // The installer's end state: created, mode 750 (own_service_subdir ... 750).
    mkdirSync(written, { recursive: true })
    chmodSync(written, 0o750)
    const ok = await runProductionPreflight({ env: env(written) })
    const failing = ok.checks.filter((c) => c.status === 'fail').map((c) => c.id)
    console.log(`  F7 installer end state: failing checks ${JSON.stringify(failing)}, ok=${ok.ok}`)
    assert.deepEqual(failing, [])
    assert.equal(ok.ok, true)
  })
})

// ---------------------------------------------------------------------------
// F2 -- lib/invoice-pdf.ts must not make `next build` (Turbopack) list the project directory
// ---------------------------------------------------------------------------

test('F2: every build-time path expression in lib/invoice-pdf.ts carries a turbopackIgnore marker on its first argument', () => {
  const file = 'lib/invoice-pdf.ts'
  const text = read(file)
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const FS = new Set(['access', 'mkdir', 'lstat', 'readFile', 'realpath', 'rename', 'writeFile'])
  const PATH = new Set(['resolve', 'join', 'dirname'])
  const isPathCall = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'path' && PATH.has(n.expression.name.text)
  /** The leftmost leaf: a nested path.* call hands its own first argument up. */
  const leaf = (n: ts.Expression): ts.Expression => (isPathCall(n) && n.arguments[0] ? leaf(n.arguments[0]) : n)
  const marked = (n: ts.Node): boolean =>
    // The trivia between the previous token and this node's first token (a comment on the same line as
    // the opening parenthesis is a TRAILING comment to the compiler API, so range helpers would miss it).
    /^\s*\/\*\s*turbopackIgnore:\s*true\s*\*\/\s*$/.test(text.slice(n.getFullStart(), n.getStart()))

  const checked: string[] = []
  const unmarked: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : undefined
      const isFs = callee !== undefined && FS.has(callee)
      if ((isFs || isPathCall(n)) && n.arguments[0]) {
        const where = `${(callee ?? (n.expression as ts.PropertyAccessExpression).name.text)}@L${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`
        const first = leaf(n.arguments[0])
        checked.push(where)
        if (!marked(first)) unmarked.push(where)
      }
      // rename(a, b): the second path is also a path.
      if (callee === 'rename' && n.arguments[1]) {
        checked.push(`rename#2@L${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`)
        if (!marked(leaf(n.arguments[1]))) unmarked.push(`rename#2@L${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  console.log(`  F2 precondition: ${checked.length} fs/path calls examined: ${checked.join(' ')}`)
  console.log(`  F2 unmarked: ${JSON.stringify(unmarked)}`)
  assert.ok(checked.length >= 14, 'precondition: the calls were found (fs and path, including the cwd fallback)')
  assert.ok(checked.some((c) => c.startsWith('join@')) && checked.some((c) => c.startsWith('readFile@')), 'precondition: both kinds present')
  assert.deepEqual(unmarked, [], 'an unmarked call lets Turbopack list the whole project directory, which panics on the root-owned 0700 .ims-publish directory')
})

test('F2: the fix leaves publish_durable_file\'s mode check alone (no scripts change touches the staging mode)', () => {
  // The mode requirement is what a permanent chmod 755 workaround broke; it must still be demanded.
  for (const [name, source] of [['install.sh', INSTALL], ['update.sh', UPDATE], ['deploy.sh', DEPLOY]] as const) {
    const fn = shippedFunction(source, 'publish_durable_file')
    const checks = fn.split('\n').filter((t) => /\[\[ "\$meta" == "\$\{self\}\|700\|\$\{parent%%:\*\}" \]\] \|\| exit 1/.test(t))
    console.log(`  F2 ${name}: publish_durable_file owner+mode-700 staging checks: ${checks.length}`)
    assert.equal(checks.length, 1, `${name}: publish_durable_file still demands an own-uid, mode-700 staging directory`)
  }
})
