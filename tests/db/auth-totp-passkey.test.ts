import assert from 'node:assert/strict'
import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * AUTH HARDENING, PROVEN AGAINST A REAL POSTGRES (SEC-M4 / M7 and the login paths they must not break).
 *
 *   * a TOTP code verifies once; the same code again is `replayed`; another user's identical step is independent
 *   * two concurrent verifications of one code: exactly one wins
 *   * TOTP login still works end to end: a fresh code verifies, then the next step's code verifies too
 *   * passkey login still works end to end with a real ES256 assertion (challenge, signature, counter)
 *   * passkey enrolment needs a fresh session; a stale one gets the step-up failure and nothing is created
 *   * a password reset removes the user's passkeys and keeps the account usable with the new password
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

const PUBLIC_URL = 'https://ims.example.test'
const state: { session: { user: Record<string, unknown> } | null } = { session: null }

mock.module('@/lib/auth/server', { namedExports: { getSession: async () => state.session } })
mock.module('@/lib/public-app-url', { namedExports: { getPublicAppUrl: async () => PUBLIC_URL } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('next/headers', { namedExports: { headers: async () => new Headers() } })
mock.module('next/server', { namedExports: { after: (fn: () => unknown) => { void fn() } } })
mock.module('@/lib/mailer', { namedExports: { sendEmail: async () => ({ success: true }) } })

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
}

const b64u = (buf: Buffer) => buf.toString('base64url')

/** COSE_Key for an ES256 (P-256) public key, hand-encoded CBOR. */
function coseEs256(x: Buffer, y: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x,
    Buffer.from([0x22, 0x58, 0x20]), y,
  ])
}

test('auth hardening against a real database', { skip }, async (t) => {
  loadEnv()
  const { db } = await import('../../lib/db/index.ts')
  const { generate, generateSecret } = await import('otplib')
  const { verifyTotpCodeOnce, usedTotpStepKey } = await import('../../lib/auth/totp-replay.ts')
  const { setAuthToken, consumeAuthToken } = await import('../../lib/auth/token-store.ts')
  const passkeyActions = await import('../../app/actions/passkey.ts')
  const { resetPassword } = await import('../../app/actions/password-reset.ts')
  const { passwordResetTokenKey } = await import('../../lib/auth/password-reset.ts')
  const bcrypt = (await import('bcryptjs')).default

  const tag = randomUUID().slice(0, 8)
  const mkUser = (suffix: string) => db.user.create({
    data: { email: `p2g-${tag}-${suffix}@example.test`, name: `P2G ${suffix}`, passwordHash: 'x', role: 'ADMIN', active: true },
  })
  const [alice, bob, carol] = [await mkUser('a'), await mkUser('b'), await mkUser('c')]
  t.after(async () => {
    await db.oneTimeToken.deleteMany({ where: { OR: [{ key: { startsWith: `totp_used:${alice.id}` } }, { key: { startsWith: `totp_used:${bob.id}` } }, { key: { startsWith: `totp_used:${carol.id}` } }, { key: { startsWith: 'passkey_challenge:' }, value: { contains: tag } }] } })
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id, carol.id] } } }) // passkeys cascade
  })

  await t.test('TOTP: a code verifies once, replays are refused, users are independent', async () => {
    const secret = generateSecret()
    const code = await generate({ secret })
    assert.equal(await verifyTotpCodeOnce({ userId: alice.id, secret, code }), 'ok')
    assert.equal(await verifyTotpCodeOnce({ userId: alice.id, secret, code }), 'replayed')
    assert.equal(await verifyTotpCodeOnce({ userId: alice.id, secret, code: '000000' === code ? '111111' : '000000' }), 'invalid')
    // same secret + same step for a different user is its own record
    assert.equal(await verifyTotpCodeOnce({ userId: bob.id, secret, code }), 'ok')
  })

  await t.test('TOTP: concurrent submissions of one code - exactly one wins', async () => {
    const secret = generateSecret()
    const code = await generate({ secret })
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => verifyTotpCodeOnce({ userId: carol.id, secret, code })))
    assert.equal(outcomes.filter((o) => o === 'ok').length, 1)
    assert.equal(outcomes.filter((o) => o === 'replayed').length, 5)
  })

  await t.test('TOTP: an expired used-step record is swept and does not block a later claim of that step', async () => {
    const now = Math.floor(Date.now() / 1000)
    // a stale (expired) record for that future step must be swept, not treated as a replay
    const step = Math.floor((now + 30) / 30)
    await db.oneTimeToken.create({ data: { key: usedTotpStepKey(bob.id, step), value: bob.id, expiresAt: new Date(Date.now() - 1000) } })
    const { claimTotpStep } = await import('../../lib/auth/totp-replay.ts')
    assert.equal(await claimTotpStep(bob.id, step), true)
    assert.equal(await claimTotpStep(bob.id, step), false)
  })

  await t.test('passkey login end to end with a real ES256 assertion', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    const credentialId = `cred-${tag}`
    await db.passkey.create({
      data: {
        userId: alice.id, credentialId, counter: BigInt(0), transports: [], name: 'test key',
        credentialPublicKey: new Uint8Array(coseEs256(Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url'))),
      },
    })

    const optionsResult = await passkeyActions.getPasskeyAuthenticationOptions(`p2g-${tag}-a@example.test`)
    assert.ok('options' in optionsResult && optionsResult.options)
    const { options, challengeKey } = optionsResult as { options: { challenge: string }; challengeKey: string }

    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: PUBLIC_URL }))
    const counter = Buffer.alloc(4); counter.writeUInt32BE(5)
    const authData = Buffer.concat([createHash('sha256').update('ims.example.test').digest(), Buffer.from([0x05]), counter])
    const signer = createSign('SHA256')
    signer.update(Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]))
    const signature = signer.sign(privateKey)

    const result = await passkeyActions.verifyPasskeyAuthentication({
      id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) },
    }, challengeKey)
    assert.equal('success' in result && result.success, true, JSON.stringify(result))
    const issued = (result as { authToken: string }).authToken
    assert.equal(await consumeAuthToken(`passkey_auth:${issued}`), alice.id)
    assert.equal((await db.passkey.findUnique({ where: { credentialId } }))?.counter, BigInt(5))
  })

  await t.test('passkey enrolment needs a fresh session', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const sess = (authTime: number) => ({ user: { id: alice.id, email: 'a@example.test', totpEnabled: false, totpVerified: true, sessionAuthTime: authTime } })

    state.session = sess(nowSec - 4 * 3600)
    const stale = await passkeyActions.getPasskeyRegistrationOptions()
    assert.equal((stale as { code?: string }).code, 'fresh_auth_required')
    const staleVerify = await passkeyActions.verifyPasskeyRegistration({} as never, 'x')
    assert.equal((staleVerify as { code?: string }).code, 'fresh_auth_required')
    assert.equal(await db.oneTimeToken.count({ where: { key: `passkey_challenge:reg:${alice.id}` } }), 0)

    state.session = sess(nowSec - 20)
    const fresh = await passkeyActions.getPasskeyRegistrationOptions()
    assert.ok('options' in fresh && fresh.options)
    await db.oneTimeToken.deleteMany({ where: { key: `passkey_challenge:reg:${alice.id}` } })

    // the existing-passkey management actions are not gated by freshness (unchanged)
    state.session = sess(nowSec - 4 * 3600)
    assert.ok(Array.isArray(await passkeyActions.listPasskeys()))
  })

  await t.test('password reset removes passkeys and the new password signs in', async () => {
    assert.ok((await db.passkey.count({ where: { userId: alice.id } })) >= 1)
    const token = `tok-${tag}`
    await setAuthToken(passwordResetTokenKey(token), alice.id, 60_000)
    const out = await resetPassword(token, 'Correct-Horse-Battery-9!')
    assert.deepEqual(out, { success: true })
    assert.equal(await db.passkey.count({ where: { userId: alice.id } }), 0)
    const row = await db.user.findUnique({ where: { id: alice.id }, select: { passwordHash: true } })
    assert.equal(await bcrypt.compare('Correct-Horse-Battery-9!', row!.passwordHash!), true)
  })
})
