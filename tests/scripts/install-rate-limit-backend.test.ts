import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'

import { getConfiguredRateLimitBackendName } from '@/lib/security/rate-limit'
import { RedisRateLimitBackend } from '@/lib/security/rate-limit-redis'

import { ENV_HEREDOC_DEFAULTS } from './install-shell-rig.ts'
import { shippedFunction } from './real-postgres-cluster.ts'
import {
  AWKWARD_PASSWORD,
  sliceOptionalBlock,
  sliceRange,
  startRecordingRedis,
} from './redis-url-wire-harness.ts'
import { createTempDir } from './temp-dir.ts'

const execFileAsync = promisify(execFile)

/**
 * o3d-g42a. `scripts/install.sh` provisioned Redis, set `requirepass` on it, wrote `REDIS_URL`,
 * `REDIS_PASSWORD` and `REDIS_KEY_PREFIX` — and never wrote `RATE_LIMIT_BACKEND`. So
 * `lib/security/rate-limit.ts:23` defaulted to `memory` on every host this installer has ever
 * built, including the ones where the operator answered "Install Redis on this server? y". Redis
 * was provisioned, configured, secured, and then unused. `grep -c RATE_LIMIT scripts/install.sh`
 * returned 0.
 *
 * WHY THIS FILE IS MOSTLY ABOUT NOT WRITING `redis`.
 *
 * The two values are not symmetric and the asymmetry is the whole design:
 *
 *   memory  the counters are per-process. On one replica that is exactly right; on several it is
 *           a weaker limiter than the docs describe. It is also what every installer-built host
 *           has today, so it cannot be a regression.
 *   redis   pointed at a Redis that answers, it is the shared limiter the docs describe. Pointed
 *           at one that does NOT answer, it is a total sign-in lockout: `lib/auth/config.ts`
 *           lines 183 and 192 check the login buckets with `failClosed: true`, and
 *           `checkRateLimit` DENIES when the backend throws.
 *
 * And the wrong value is easy to reach by accident, which is why the obvious implementation is the
 * dangerous one: the external-Redis prompt DEFAULTS `REDIS_URL` to `redis://localhost:6379`, so an
 * operator who answered "n" to "Install Redis on this server?" and pressed Enter through the rest
 * has a non-empty `REDIS_URL` naming a Redis that need not exist. Deriving the backend from
 * "REDIS_URL is non-empty" would therefore hand a brand-new production server a limiter that
 * refuses every login.
 *
 * So the rule under test is: `RATE_LIMIT_BACKEND=redis` is written if and only if (a) the operator
 * OPTED IN — `INSTALL_REDIS=y`, or the explicit external-Redis question — and (b) that exact
 * `REDIS_URL`, with that exact credential, answered `PING` with `PONG` moments before the file was
 * written. Everything else writes `memory`, including every failure this installer cannot classify.
 *
 * HOW IT IS MEASURED. The shipped blocks are executed — the prompt block by the same
 * `sliceRange` markers `install-redis-url.test.ts` uses, the decision and the probe wrapper by
 * name, and the `.env` by the shipped `render_app_env_file`. The probe itself is run against a
 * REAL Redis-speaking socket that demands a password and answers `-NOAUTH` until it is given, so
 * "Redis answered" is a fact about a wire rather than about a stub's opinion. Deleting the probe
 * and writing `redis` on the opt-in alone leaves every "did not answer" test red.
 */

/**
 * POSIX single-quote escaping, so a value the test writes into the shell is the value the shell
 * sees. `AWKWARD_PASSWORD` carries a `"`, a `\\`, a `#`, a `%` and whitespace, and a double-quoted
 * assignment would hand bash a different byte sequence from the one asserted on the wire — a test
 * that measured its own quoting rather than the installer's encoder.
 */
function shq(value: string): string {
  return `'${value.split("'").join(String.raw`'\''`)}'`
}

const REPO = process.cwd()
const SCRIPT = path.join(REPO, 'scripts/install.sh')
const PROBE = path.join(REPO, 'scripts/lib/redis-ping.mjs')

async function installSource(): Promise<string> {
  return readFile(SCRIPT, 'utf8')
}

type Decision = {
  /** The rendered `.env`, exactly as `write_app_env_file` would have published it. */
  envFile: string
  /** Everything the operator was told, i.e. `info`/`success`/`warn`/`error`. */
  transcript: string
  /** The `RATE_LIMIT_BACKEND=` lines in the rendered `.env`, in order. */
  backendLines: string[]
}

/**
 * Run the shipped configuration prompt block, the shipped decision, and the shipped `.env` render.
 *
 * `vars` are shell assignments made BEFORE the prompt block, which is how `--non-interactive`
 * answers a prompt: `prompt`/`prompt_yn` take whatever the variable already holds. Reverting the
 * change under test leaves `resolve_rate_limit_backend` undefined, and the call is then omitted so
 * that the test fails on the `.env` that gets PRODUCED rather than on a missing marker.
 */
async function runInstallerDecision(vars: string, source?: string): Promise<Decision> {
  const src = source ?? await installSource()
  const hasDecision = sliceOptionalBlock(src, 'resolve_rate_limit_backend() {') !== null
  const script = `
    set -euo pipefail
    NON_INTERACTIVE=true
    BOLD=''; RESET=''
    # Everything the operator sees goes to stderr so that the rendered .env, which is captured
    # through a command substitution, cannot pick up a warning and pass a "value is memory|redis"
    # assertion by accident.
    info()    { echo "INFO: $*"  >&2; }
    success() { echo "OK: $*"    >&2; }
    warn()    { echo "WARN: $*"  >&2; }
    error()   { echo "ERROR: $*" >&2; }
    die()     { error "$*"; exit 9; }
    declare -A EXISTING_ENV=()
    ${sliceOptionalBlock(src, 'urlencode() {') ?? ''}
    ${sliceOptionalBlock(src, 'urldecode() {') ?? ''}
    ${sliceOptionalBlock(src, 'mask_secret() {') ?? ''}
    ${sliceOptionalBlock(src, 'redact_url_credentials() {') ?? ''}
    ${sliceOptionalBlock(src, 'redis_url_credential_state() {') ?? ''}
    ${sliceOptionalBlock(src, 'existing_env() {') ?? ''}
    ${sliceOptionalBlock(src, 'prompt() {') ?? ''}
    ${sliceOptionalBlock(src, 'prompt_yn() {') ?? ''}
    ${sliceOptionalBlock(src, 'redis_ping_answers() {') ?? ''}
    ${sliceOptionalBlock(src, 'resolve_rate_limit_backend() {') ?? ''}
    IMS_REDIS_PING_PROBE=${shq(PROBE)}
    ${vars}
    ${sliceRange(src, 'prompt_yn INSTALL_REDIS', 'info "--- WooCommerce')}
    ${hasDecision ? 'resolve_rate_limit_backend' : ''}
    ${ENV_HEREDOC_DEFAULTS}
    ${shippedFunction(src, 'render_app_env_file')}
    printf 'ENVFILE<<<%s>>>' "$(render_app_env_file)"
  `
  const { stdout, stderr } = await execFileAsync('bash', ['-c', script])
  const rendered = /ENVFILE<<<([\s\S]*?)>>>/.exec(stdout)
  assert.ok(rendered, `the block rendered no .env at all: ${stdout}\n${stderr}`)
  const envFile = rendered[1]
  return {
    envFile,
    transcript: stderr,
    backendLines: envFile.split('\n').filter((line) => line.startsWith('RATE_LIMIT_BACKEND=')),
  }
}

/** The one value the shipped `.env` gives `RATE_LIMIT_BACKEND` — and there must be exactly one. */
function backendIn(decision: Decision): string {
  assert.equal(
    decision.backendLines.length, 1,
    `the generated .env must carry exactly one RATE_LIMIT_BACKEND line, got ${JSON.stringify(decision.backendLines)}`,
  )
  return decision.backendLines[0].slice('RATE_LIMIT_BACKEND='.length)
}

/** A port nothing is listening on, so "Redis did not answer" is a fact rather than a setting. */
async function deadPort(): Promise<number> {
  const redis = await startRecordingRedis()
  const { port } = redis
  await redis.close()
  return port
}

// ---------------------------------------------------------------------------
// The lockout. These are the tests the design exists for.
// ---------------------------------------------------------------------------

test('o3d-g42a: pressing Enter through the external-Redis prompts writes memory, not redis', async () => {
  // THE DEFAULT THAT MAKES "REDIS_URL is set" USELESS AS EVIDENCE. `INSTALL_REDIS=n` and no
  // answers at all leaves REDIS_URL at the prompt's own default of redis://localhost:6379 —
  // non-empty, and naming a Redis that need not exist. A backend derived from the URL would write
  // `redis` here, and this host's login page would refuse every credential.
  const decision = await runInstallerDecision('INSTALL_REDIS=n')

  assert.match(decision.envFile, /^REDIS_URL=redis:\/\/localhost:6379$/m, 'precondition: the URL default is non-empty')
  assert.equal(backendIn(decision), 'memory')
})

test('o3d-g42a: opting IN to Redis rate limiting against a Redis that does not answer still writes memory', async () => {
  // The operator asked for it and the URL is wrong. Honouring the request is a sign-in lockout;
  // the installer falls back and SAYS SO, which is the only outcome that is not worse than the bug.
  const port = await deadPort()
  const decision = await runInstallerDecision(
    `INSTALL_REDIS=n\nRATE_LIMIT_REDIS=y\nREDIS_URL=redis://127.0.0.1:${port}`,
  )

  assert.equal(backendIn(decision), 'memory')
  assert.match(decision.transcript, /WARN:.*memory/, 'and the operator is told the request was not honoured')
})

test('o3d-g42a: a LOCAL Redis this installer provisioned is probed too, and a dead one writes memory', async () => {
  // INSTALL_REDIS=y is the strongest opt-in there is — this run installed, configured, secured and
  // started the server. It is still not evidence: `systemctl restart` can succeed against a config
  // the server then refuses, and the requirepass this run wrote can disagree with the URL by one
  // byte (o3d-2sm1.5 r40 is exactly that bug). The probe is what closes the gap between "we
  // started something" and "the application can talk to it".
  const port = await deadPort()
  const decision = await runInstallerDecision(
    `INSTALL_REDIS=y\nREDIS_HOST=127.0.0.1\nREDIS_PORT=${port}`,
  )

  assert.equal(backendIn(decision), 'memory')
})

test('o3d-g42a: a WRONG password writes memory — the probe authenticates, it does not just connect', async () => {
  // A TCP connect proves a socket. The failure this must catch is a Redis that is up and refuses
  // us: `requirepass` and the URL disagreeing is the o3d-tsc0 defect, and its symptom is NOAUTH on
  // every command — which fails closed into a lockout exactly like an absent Redis.
  const redis = await startRecordingRedis({ requirePassword: 'the-real-one' })
  try {
    const decision = await runInstallerDecision(
      `INSTALL_REDIS=y\nREDIS_HOST=127.0.0.1\nREDIS_PORT=${redis.port}\nREDIS_PASSWORD=${shq('not-the-real-one')}`,
    )
    assert.equal(backendIn(decision), 'memory')
    assert.ok(
      redis.commands.some((command) => command[0]?.toUpperCase() === 'AUTH'),
      'precondition: the probe really did try to authenticate',
    )
  } finally {
    await redis.close()
  }
})

// ---------------------------------------------------------------------------
// ...and the case the issue was filed about: Redis provisioned, and now USED.
// ---------------------------------------------------------------------------

test('o3d-g42a: a local Redis that answers PING is written as RATE_LIMIT_BACKEND=redis', async () => {
  const redis = await startRecordingRedis({ requirePassword: AWKWARD_PASSWORD })
  try {
    const decision = await runInstallerDecision(
      `INSTALL_REDIS=y\nREDIS_HOST=127.0.0.1\nREDIS_PORT=${redis.port}\nREDIS_PASSWORD=${shq(AWKWARD_PASSWORD)}`,
    )

    assert.equal(backendIn(decision), 'redis')
    // The credential reached AUTH as the bytes the operator typed, not as the percent-encoded form
    // the URL carries. A probe that agreed only with its own encoder would pass the exit-code
    // assertion above and prove nothing (o3d-tsc0).
    assert.deepEqual(
      redis.commands.filter((command) => command[0]?.toUpperCase() === 'AUTH'),
      [['AUTH', AWKWARD_PASSWORD]],
    )
  } finally {
    await redis.close()
  }
})

test('o3d-g42a: the external-Redis operator can opt in, and a live Redis is then honoured', async () => {
  const redis = await startRecordingRedis({ requirePassword: null })
  try {
    const decision = await runInstallerDecision(
      `INSTALL_REDIS=n\nRATE_LIMIT_REDIS=y\nREDIS_URL=redis://127.0.0.1:${redis.port}`,
    )
    assert.equal(backendIn(decision), 'redis')
  } finally {
    await redis.close()
  }
})

test('o3d-g42a: an existing redis install is PRESERVED across a re-run, and re-probed', async () => {
  // Re-running the installer must not silently downgrade a working multi-replica deployment to a
  // per-process limiter, which is what a prompt hardcoded to `n` would do on every upgrade
  // (o3d-tsc0's whole subject). The recovered value is a DEFAULT, not a bypass: it still has to
  // answer.
  const redis = await startRecordingRedis({ requirePassword: null })
  try {
    const live = await runInstallerDecision(
      `INSTALL_REDIS=n\nEXISTING_ENV[RATE_LIMIT_BACKEND]=redis\nREDIS_URL=redis://127.0.0.1:${redis.port}`,
    )
    assert.equal(backendIn(live), 'redis', 'the operator is not asked again to keep what they have')
  } finally {
    await redis.close()
  }

  const port = await deadPort()
  const dead = await runInstallerDecision(
    `INSTALL_REDIS=n\nEXISTING_ENV[RATE_LIMIT_BACKEND]=redis\nREDIS_URL=redis://127.0.0.1:${port}`,
  )
  assert.equal(backendIn(dead), 'memory', 'a recovered value is still not evidence that Redis answers')
})

// ---------------------------------------------------------------------------
// The value itself, checked by the READER that has to accept it.
// ---------------------------------------------------------------------------

test('o3d-g42a: every value the installer can write is one lib/security/rate-limit.ts accepts', async () => {
  // `getConfiguredRateLimitBackendName` THROWS on anything that is not memory or redis, at
  // startup, before anything is served. So the assertion is not a regex against the .env — it is
  // the production reader being handed what the installer wrote. A typo, a trailing warning, or a
  // capitalisation the parser does not accept fails here rather than on the operator's host.
  const redis = await startRecordingRedis({ requirePassword: null })
  const dead = await deadPort()
  try {
    const written = await Promise.all([
      runInstallerDecision('INSTALL_REDIS=n'),
      runInstallerDecision(`INSTALL_REDIS=y\nREDIS_HOST=127.0.0.1\nREDIS_PORT=${redis.port}`),
      runInstallerDecision(`INSTALL_REDIS=y\nREDIS_HOST=127.0.0.1\nREDIS_PORT=${dead}`),
      runInstallerDecision(`INSTALL_REDIS=n\nRATE_LIMIT_REDIS=y\nREDIS_URL=redis://127.0.0.1:${redis.port}`),
    ])
    const values = written.map(backendIn)
    assert.deepEqual(values, ['memory', 'redis', 'memory', 'redis'], 'precondition: both values are actually reachable')
    for (const value of values) {
      assert.equal(getConfiguredRateLimitBackendName({ RATE_LIMIT_BACKEND: value }), value)
    }
  } finally {
    await redis.close()
  }
})

// ---------------------------------------------------------------------------
// The SECOND reader of the same rule (o3d-g42a, defect 2).
// ---------------------------------------------------------------------------

test('o3d-g42a: install-dev-instance.sh can finally PASS its RATE_LIMIT_BACKEND check', async (t: TestContext) => {
  // scripts/install-dev-instance.sh:78 greps the instance .env for `^RATE_LIMIT_BACKEND=memory`
  // and warns when it is missing. Against an installer-generated .env that line did not exist, so
  // the check could only ever print its warning — it had never once passed, which is the same
  // defect as the missing line, seen from the other end. It is asserted here against a REAL
  // generated .env rather than against a hand-written one, so the two scripts cannot drift apart.
  const check = sliceRange(
    await readFile(path.join(REPO, 'scripts/install-dev-instance.sh'), 'utf8'),
    "grep -qE '^RATE_LIMIT_BACKEND=memory'",
    'say "systemd unit"',
  )
  const dir = await createTempDir('o3d-g42a-devcheck-', t)

  const memory = await runInstallerDecision('INSTALL_REDIS=n')
  assert.equal(backendIn(memory), 'memory', 'precondition')
  await writeFile(path.join(dir, '.env'), memory.envFile)
  const passed = await execFileAsync('bash', ['-c', `set -euo pipefail\nWORKDIR=${shq(dir)}\n${check}`])
  assert.match(passed.stdout, /RATE_LIMIT_BACKEND=memory: ok/)
  assert.ok(!passed.stdout.includes('WARNING'), 'a memory install no longer trips the warning')

  const redis = await startRecordingRedis({ requirePassword: null })
  try {
    const shared = await runInstallerDecision(`INSTALL_REDIS=y\nREDIS_HOST=127.0.0.1\nREDIS_PORT=${redis.port}`)
    assert.equal(backendIn(shared), 'redis', 'precondition')
    await writeFile(path.join(dir, '.env'), shared.envFile)
    const warned = await execFileAsync('bash', ['-c', `set -euo pipefail\nWORKDIR=${shq(dir)}\n${check}`])
    assert.match(warned.stdout, /WARNING: RATE_LIMIT_BACKEND=memory not set/, 'and it still fires on the case it was written for')
  } finally {
    await redis.close()
  }
})

// ---------------------------------------------------------------------------
// The probe is a SECOND READER of `redisConnectionOptions`. Bound to the first one, on the wire.
// ---------------------------------------------------------------------------

/**
 * URL shapes, each paired with the `requirepass` the server on the other end really has.
 *
 * The pairing matters: a fake that accepted any `AUTH` would let a probe sending the WRONG bytes
 * pass, which is the whole property under test. `startRecordingRedis` refuses like the real server
 * does — `-WRONGPASS` for the wrong secret, `-ERR Client sent AUTH, but no password is set` for a
 * credential sent to a server that has none — so each row here is a server that can say no.
 */
const AWKWARD_URLS: Array<{ password: string | null; url(port: number): string }> = [
  { password: null, url: (port) => `redis://127.0.0.1:${port}` },
  { password: null, url: (port) => `redis://127.0.0.1:${port}/7` },
  { password: AWKWARD_PASSWORD, url: (port) => `redis://:${encodeURIComponent(AWKWARD_PASSWORD)}@127.0.0.1:${port}` },
  { password: AWKWARD_PASSWORD, url: (port) => `redis://someuser:${encodeURIComponent(AWKWARD_PASSWORD)}@127.0.0.1:${port}/3` },
]

/** Run something against a recording Redis, and close it whether or not that something threw. */
async function againstRedis<T>(
  password: string | null,
  run: (port: number) => Promise<T>,
): Promise<{ commands: string[][]; value: T }> {
  const redis = await startRecordingRedis({ requirePassword: password })
  try {
    const value = await run(redis.port)
    return { commands: redis.commands, value }
  } finally {
    // A server left listening keeps the test process alive after the runner has reported, which
    // presents as a hung suite rather than as a failed assertion.
    await redis.close()
  }
}

test('o3d-g42a: the probe connects with the SAME credentials the application does', async () => {
  // scripts/lib/redis-ping.mjs cannot import lib/security/rate-limit-redis.ts — it runs before
  // `npm install` and outside the TypeScript build — so it carries a transcription of
  // `redisConnectionOptions`. Two readers of one rule is the standing hazard, and inspection is
  // not a bind: a probe that decoded the userinfo differently would report PONG about a connection
  // the application never makes, and the operator's reward would be a lockout on a URL that
  // "tested fine".
  //
  // So the two are measured against the same third party: the AUTH and SELECT commands as they
  // ARRIVE, for URLs carrying a username, a database index, and a password made of every character
  // that has broken an encoder. Nothing here knows how either side encodes anything.
  const setupOf = (commands: string[][]) =>
    commands.filter((command) => ['AUTH', 'SELECT'].includes(command[0]?.toUpperCase() ?? ''))

  for (const shape of AWKWARD_URLS) {
    const probed = await againstRedis(shape.password, async (port) => {
      await execFileAsync('node', [PROBE], {
        env: { ...process.env, IMS_REDIS_PING_URL: shape.url(port), IMS_REDIS_PING_PASSWORD: '', IMS_REDIS_PING_TIMEOUT_MS: '5000' },
      })
    })

    const served = await againstRedis(shape.password, async (port) => {
      const backend = new RedisRateLimitBackend(shape.url(port))
      const result = await backend.check('login:o3d-g42a', 5, 60_000)
      assert.equal(result.allowed, true, 'precondition: the application really did complete a check')
    })

    assert.deepEqual(
      setupOf(probed.commands), setupOf(served.commands),
      `the probe and the application disagree about ${shape.url(0).replace(/:[^:@/]*@/, ':***@')}`,
    )
    // ...and the agreement is not two empty lists. Two of the four rows carry a credential and one
    // carries a database index, so the comparison has something to be wrong about.
    assert.ok(
      probed.commands.some((command) => command[0]?.toUpperCase() === 'PING'),
      'the probe must actually have reached PING',
    )
  }

  // The shapes above between them exercise AUTH-with-username, AUTH-without, and SELECT. If a
  // future edit trims them to the credential-free case the comparison becomes vacuous, so the
  // corpus itself is asserted rather than assumed.
  assert.equal(AWKWARD_URLS.filter((shape) => shape.password !== null).length, 2)
  assert.equal(AWKWARD_URLS.filter((shape) => /\/\d+$/.test(shape.url(1))).length, 2)
})

test('o3d-g42a: the AUTH and SELECT the probe sends are the decoded userinfo, not the URL text', async () => {
  const redis = await startRecordingRedis({ requirePassword: AWKWARD_PASSWORD })
  try {
    const url = `redis://someuser:${encodeURIComponent(AWKWARD_PASSWORD)}@127.0.0.1:${redis.port}/5`
    await execFileAsync('node', [PROBE], {
      env: { ...process.env, IMS_REDIS_PING_URL: url, IMS_REDIS_PING_PASSWORD: '', IMS_REDIS_PING_TIMEOUT_MS: '5000' },
    })
    assert.deepEqual(redis.commands, [
      ['AUTH', 'someuser', AWKWARD_PASSWORD],
      ['SELECT', '5'],
      ['PING'],
    ])
  } finally {
    await redis.close()
  }
})

// ---------------------------------------------------------------------------
// The probe's own verdict, per outcome.
// ---------------------------------------------------------------------------

async function probeStatus(env: Record<string, string>): Promise<number> {
  try {
    await execFileAsync('node', [PROBE], { env: { ...process.env, IMS_REDIS_PING_TIMEOUT_MS: '4000', ...env } })
    return 0
  } catch (error) {
    return (error as { code?: number }).code ?? -1
  }
}

test('o3d-g42a: the probe exits 0 only on PONG', async () => {
  const answering = await startRecordingRedis({ requirePassword: null })
  try {
    assert.equal(await probeStatus({ IMS_REDIS_PING_URL: `redis://127.0.0.1:${answering.port}`, IMS_REDIS_PING_PASSWORD: '' }), 0)
  } finally {
    await answering.close()
  }

  const guarded = await startRecordingRedis({ requirePassword: 'shibboleth' })
  try {
    // No credential at all: the server answers -NOAUTH, which is what a `requirepass` the URL does
    // not know about looks like — and is precisely the state that locks sign-in out.
    assert.equal(await probeStatus({ IMS_REDIS_PING_URL: `redis://127.0.0.1:${guarded.port}`, IMS_REDIS_PING_PASSWORD: '' }), 1)
    // The wrong credential: -WRONGPASS.
    assert.equal(await probeStatus({ IMS_REDIS_PING_URL: `redis://:wrong@127.0.0.1:${guarded.port}`, IMS_REDIS_PING_PASSWORD: '' }), 1)
    // The REDIS_PASSWORD fallback is honoured exactly as the application honours it.
    assert.equal(await probeStatus({ IMS_REDIS_PING_URL: `redis://127.0.0.1:${guarded.port}`, IMS_REDIS_PING_PASSWORD: 'shibboleth' }), 0)
  } finally {
    await guarded.close()
  }

  assert.equal(await probeStatus({ IMS_REDIS_PING_URL: `redis://127.0.0.1:${await deadPort()}`, IMS_REDIS_PING_PASSWORD: '' }), 1)
  assert.equal(await probeStatus({ IMS_REDIS_PING_URL: 'http://127.0.0.1:6379', IMS_REDIS_PING_PASSWORD: '' }), 1)
  assert.equal(await probeStatus({ IMS_REDIS_PING_URL: '', IMS_REDIS_PING_PASSWORD: '' }), 2, 'no URL is a usage error, not a verdict')
})

test('o3d-g42a: the probe never prints the credential it was given', async () => {
  // This text lands in the installer transcript and in whatever an operator pastes into a bug
  // report. The failure modes it describes (NOAUTH, WRONGPASS, connection refused) are all
  // reached WITH the password in hand.
  const guarded = await startRecordingRedis({ requirePassword: 'shibboleth' })
  try {
    const url = `redis://:${encodeURIComponent(AWKWARD_PASSWORD)}@127.0.0.1:${guarded.port}`
    let stderr = ''
    try {
      await execFileAsync('node', [PROBE], {
        env: { ...process.env, IMS_REDIS_PING_URL: url, IMS_REDIS_PING_PASSWORD: '', IMS_REDIS_PING_TIMEOUT_MS: '4000' },
      })
      assert.fail('a wrong password must not exit 0')
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? '')
    }
    assert.ok(stderr.length > 0, 'it says something')
    assert.ok(!stderr.includes(AWKWARD_PASSWORD), 'but not the password')
    assert.ok(!stderr.includes(encodeURIComponent(AWKWARD_PASSWORD)), 'nor its encoded form')
  } finally {
    await guarded.close()
  }
})

test('o3d-g42a: an unreachable probe is "no", not "yes" — the fallback is structural', async () => {
  // `node` missing, the helper deleted by a partial deploy, an execution error nobody predicted:
  // every one of them is an absence of evidence, and absence of evidence writes `memory`. The
  // probe path is pointed at something that does not exist, which is the cheapest way to reach
  // that branch without breaking the rest of the shell.
  const src = await installSource()
  const decision = await runInstallerDecision(
    'INSTALL_REDIS=y\nREDIS_HOST=127.0.0.1\nREDIS_PORT=6379\nIMS_REDIS_PING_PROBE=/nonexistent/redis-ping.mjs',
    src,
  )
  assert.equal(backendIn(decision), 'memory')
})
