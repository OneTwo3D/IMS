import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * Passkey challenge issuance is public, so it must not let an anonymous caller invalidate a login in flight:
 * every call stores its challenge under its own ceremony key instead of one shared key.
 */
const store = new Map<string, { value: string; expiresAt: Date }>()

mock.module('@/lib/db', {
  namedExports: {
    db: {
      oneTimeToken: {
        upsert: async ({ where, create }: { where: { key: string }; create: { key: string; value: string; expiresAt: Date } }) => { store.set(where.key, create) },
        findUnique: async ({ where }: { where: { key: string } }) => (store.has(where.key) ? { key: where.key, ...store.get(where.key)! } : null),
        delete: async ({ where }: { where: { key: string } }) => { store.delete(where.key) },
        deleteMany: async () => ({ count: 0 }),
      },
    },
  },
})
mock.module('@/lib/auth/server', { namedExports: { getSession: async () => null } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('@/lib/public-app-url', { namedExports: { getPublicAppUrl: async () => 'https://ims.example.test' } })

test('a second anonymous challenge request does not invalidate the first ceremony', async () => {
  const { getPasskeyAuthenticationOptions } = await import('../../app/actions/passkey')
  const first = await getPasskeyAuthenticationOptions()
  const second = await getPasskeyAuthenticationOptions()
  assert.ok('challengeKey' in first && 'challengeKey' in second)
  if (!('challengeKey' in first) || !('challengeKey' in second)) return
  assert.notEqual(first.challengeKey, second.challengeKey)
  const { consumeAuthToken } = await import('../../lib/auth/token-store')
  assert.equal(await consumeAuthToken(`passkey_challenge:${first.challengeKey}`), first.options?.challenge)
  assert.equal(await consumeAuthToken(`passkey_challenge:${second.challengeKey}`), second.options?.challenge)
})

test('two anonymous requests never share a challenge slot', async () => {
  const { getPasskeyAuthenticationOptions } = await import('../../app/actions/passkey')
  const a = await getPasskeyAuthenticationOptions()
  const b = await getPasskeyAuthenticationOptions()
  assert.ok('challengeKey' in a && 'challengeKey' in b)
  if ('challengeKey' in a && 'challengeKey' in b) assert.notEqual(a.challengeKey, b.challengeKey)
})
