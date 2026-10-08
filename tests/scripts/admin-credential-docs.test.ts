import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * THE OPERATOR TEXT ABOUT THE ADMIN CREDENTIAL TELLS THE TRUTH (owner decision C3).
 *
 * Until C3 the runbook, the banners, the wrappers and `.env.example` said that the admin database
 * credential lives in the application's `.env` and that the fence helper runs as the application
 * user. Both are retired. These are UNIVERSAL ABSENCE checks, not existence checks: a correction sitting
 * beside a stale claim satisfies an `includes`, so each retired sentence is asserted to occur NOWHERE.
 *
 * `ADMIN_TEXT_ROOT` points the scan at another tree, which is how the same checks are shown red on
 * trunk.
 */

const ROOT = process.env.ADMIN_TEXT_ROOT ?? process.cwd()
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8')

/** Joined so a sentence wrapped across two source lines is still one sentence. */
const flatten = (text: string) => text.replace(/\s*\n\s*/g, ' ')

const SCRIPTS = ['scripts/install.sh', 'scripts/deploy.sh', 'scripts/update.sh', 'scripts/lib/db-fence-protected.sh', 'scripts/provision-ims-tenant.sh'] as const
const DOCS = ['docs/installation.md', 'docs/development.md'] as const

/** Each retired sentence, as a RegExp over whitespace-flattened text, with why it is false now. */
const RETIRED: ReadonlyArray<{ say: RegExp; why: string }> = [
  { say: /runs the helper \*\*as the application user\*\*/i, why: 'the wrappers and the entrypoints run the helper as root' },
  { say: /The helper is executed \*\*as the application user\*\*/i, why: 'the helper runs as root through db_fence_exec_root()' },
  { say: /because the fence runs\s+\*\*as the application user\*\*/i, why: 'the fence runs as root; nothing needs the application account to release a record' },
  { say: /reads the credential from \$\{APP_DIR\}\/\.env itself/i, why: 'the wrappers read the root credential file, never the application .env' },
  { say: /Set it in \$\{APP_DIR\}\/\.env/i, why: 'the credential is not an application setting and may not be kept in that file' },
  { say: /takes\s+`?DEPLOY_ADMIN_DATABASE_URL`? from its own environment or from `?APP_DIR\/\.env`?/i, why: 'the wrappers take it from the invocation or the root file' },
  { say: /for the length of a cutover, so during that window the application account can issue any SQL/i, why: 'the application account is never handed the credential' },
  { say: /connects as the admin and runs as the application role/i, why: 'the migration connects as the migration role' },
  { say: /migration will connect as the deploy admin and RUN AS/i, why: 'the migration connects as the migration role' },
  { say: /DEPLOY_ADMIN_DATABASE_URL is not set, so (?:this|the) (?:deploy|update|run)/i, why: 'the one operator text names the root file and the invocation (db_admin_credential_instruction)' },
]

test('[o3d-1bgr] no retired sentence about where the credential lives or who runs the helper survives (universal absence)', () => {
  const offenders: string[] = []
  let scanned = 0
  for (const file of [...SCRIPTS, ...DOCS, '.env.example']) {
    const text = flatten(read(file))
    scanned += 1
    for (const { say, why } of RETIRED) {
      const hit = say.exec(text)
      if (hit) offenders.push(`${file}: "${hit[0].slice(0, 90)}" -- retired: ${why}`)
    }
  }
  console.log(`scanned ${scanned} files for ${RETIRED.length} retired sentences; offenders ${offenders.length}`)
  for (const line of offenders.slice(0, 8)) console.log(`  ${line}`)
  assert.equal(scanned, SCRIPTS.length + DOCS.length + 1, 'precondition: every named file was read')
  assert.deepEqual(offenders, [])
})

test('[o3d-1bgr] the scan CAN fail: it flags each retired sentence in a sample (precondition)', () => {
  const samples = [
    'the wrapper takes `DEPLOY_ADMIN_DATABASE_URL` from its own environment or from `APP_DIR/.env` with the same one-key reader, and runs the helper **as the application user**.',
    'DEPLOY_ADMIN_DATABASE_URL is not set, so this update has no privileged connection. Set it in ${APP_DIR}/.env (a superuser).',
    'So the migration **connects as the admin and runs as the application role**: the deploy composes',
    'The helper is executed **as the application user** on every in-script path',
  ].map(flatten)
  const flagged = RETIRED.filter(({ say }) => samples.some((sample) => say.test(sample)))
  console.log(`${flagged.length} of ${RETIRED.length} retired sentences matched in the samples`)
  assert.ok(flagged.length >= 6, `the samples must trip the patterns (tripped ${flagged.length})`)
})

test('[o3d-1bgr] .env.example documents no admin credential and says where it lives instead', () => {
  const lines = read('.env.example').split('\n')
  const assignments = lines.filter((line) => /^\s*#?\s*DEPLOY_ADMIN_DATABASE_URL\s*=/.test(line))
  console.log(`.env.example: ${lines.length} lines, ${assignments.length} assignment(s) of the admin credential`)
  assert.ok(lines.length > 100, 'precondition: the whole file was read')
  assert.deepEqual(assignments, [], 'not even commented out: a template that offers the key invites it into the application file')
  assert.match(flatten(read('.env.example')), /root-only credential file \(see "Database identities" in docs\/installation\.md\)/)
})

test('[o3d-1bgr] the runbook has a Database identities section: three identities, the root file path, the migration role SQL', () => {
  const text = read('docs/installation.md')
  const start = text.indexOf('#### Database identities')
  assert.notEqual(start, -1, 'precondition: the section exists')
  const section = text.slice(start, text.indexOf('\n#', start + 10) === -1 ? undefined : text.indexOf('\n###', start + 10))
  console.log(`Database identities section: ${section.split('\n').length} lines`)
  assert.ok(section.includes('/etc/ims-db-admin/deploy-admin.env'), 'it names the root credential file')
  assert.match(section, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/, 'and the migration role SQL')
  assert.match(section, /SET ROLE NONE/, 'and says what actually escapes the role option')
  for (const identity of ['application role', 'migration role', 'deploy admin']) {
    assert.ok(section.includes(`**${identity}**`) || section.toLowerCase().includes(identity), `it names the ${identity}`)
  }
})

test('[o3d-1bgr] the scripts state where the credential lives only through the one function (no per-site restatement)', () => {
  const offenders: string[] = []
  for (const file of SCRIPTS) {
    read(file).split('\n').forEach((line, index) => {
      if (/^\s*#/.test(line)) return
      // A sentence that tells an operator where the credential is kept, written out in a script
      // rather than produced by db_admin_credential_instruction().
      if (/credential[^"]{0,80}(?:is|lives|kept) (?:in|at) \$\{?APP_DIR/.test(line) || /Set it in \$\{?APP_DIR/.test(line)) {
        offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 110)}`)
      }
    })
  }
  console.log(`scripts scanned: ${SCRIPTS.length}; per-site restatements of where the credential lives: ${offenders.length}`)
  assert.deepEqual(offenders, [])
  const library = read('scripts/lib/db-fence-protected.sh')
  const calls = SCRIPTS.map((file) => (read(file).match(/db_admin_credential_instruction/g) ?? []).length)
  console.log(`db_admin_credential_instruction mentioned per script: ${calls.join(', ')}`)
  assert.ok(library.includes('db_admin_credential_instruction() {'), 'precondition: the one function exists')
  assert.ok(calls.slice(0, 3).every((n) => n >= 3), 'and every entrypoint uses it for its refusals and banners')
})
