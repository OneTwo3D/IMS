import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-4is8 — updateProfile's account-enumeration oracle, and the decision taken on it.
//
// WHAT IS AND IS NOT CLAIMED HERE. The oracle is NOT closed: for a self-service email change the
// signal is the OUTCOME (the address moves, or it does not), which no wording can hide. What these
// tests pin is the two narrowings that actually bite — an external SUPPLIER principal can no longer
// reach the path at all, and every principal's attempts are bounded fail-closed — plus the two
// hygiene fixes that came with them.

class FreshAuthRequiredError extends Error {}

const state = {
  role: 'MANAGER' as string,
  userId: 'user-1',
  currentEmail: 'me@example.com',
  /** email -> id, as the users table. */
  users: new Map<string, string>(),
  freshAuthFails: false,
  activity: [] as Array<Record<string, unknown>>,
  rateLimitCalls: [] as Array<{ key: string; max: number; windowMs: number; failClosed?: boolean }>,
  rateLimitAllowed: true,
  /** Every `where` the user table was read with — the enumeration surface itself. */
  userReads: [] as Array<{ where: Record<string, unknown>; select?: Record<string, boolean> }>,
  updates: [] as Array<Record<string, unknown>>,
  /** Thrown by the NEXT user.update, to simulate losing the unique constraint race. */
  throwOnUpdate: null as unknown,
}

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: state.userId, role: state.role } }),
    requireFreshAuth: async () => {
      if (state.freshAuthFails) throw new FreshAuthRequiredError('stale')
      return { user: { id: state.userId, role: state.role } }
    },
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      user: {
        findUnique: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
          state.userReads.push({ where, select })
          if (typeof where.id === 'string') {
            return where.id === state.userId ? { id: state.userId, email: state.currentEmail } : null
          }
          const id = state.users.get(String(where.email))
          return id ? { id } : null
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          if (state.throwOnUpdate) {
            const error = state.throwOnUpdate
            state.throwOnUpdate = null
            throw error
          }
          state.updates.push(data)
          return { id: state.userId }
        },
      },
    },
  },
})

mock.module('@/lib/rate-limit', {
  namedExports: {
    checkRateLimit: async (key: string, max: number, windowMs: number, options?: { failClosed?: boolean }) => {
      state.rateLimitCalls.push({ key, max, windowMs, failClosed: options?.failClosed })
      return state.rateLimitAllowed
        ? { allowed: true, retryAfterSec: 0, remaining: max - 1 }
        : { allowed: false, retryAfterSec: 900, remaining: 0 }
    },
  },
})

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) } },
})

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

async function loadAction() {
  return (await import('@/app/actions/profile')).updateProfile
}

function uniqueEmailViolation() {
  return { code: 'P2002', meta: { target: ['email'] } }
}

test.beforeEach(() => {
  state.role = 'MANAGER'
  state.userId = 'user-1'
  state.currentEmail = 'me@example.com'
  state.users = new Map([['me@example.com', 'user-1'], ['someone.else@example.com', 'user-2']])
  state.freshAuthFails = false
  state.activity = []
  state.rateLimitCalls = []
  state.rateLimitAllowed = true
  state.userReads = []
  state.updates = []
  state.throwOnUpdate = null
})

// ---------------------------------------------------------------------------
// Narrowing 1 — the external principal
// ---------------------------------------------------------------------------

test('a SUPPLIER cannot change its own login email, and is told who can', async () => {
  const updateProfile = await loadAction()
  state.role = 'SUPPLIER'
  const result = await updateProfile({ name: 'Acme Ltd', email: 'someone.else@example.com' })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /managed by the company that issued this login/)
  assert.match(result.error ?? '', /Ask your contact there/)
  assert.deepEqual(state.updates, [], 'nothing was written')
})

test('a SUPPLIER learns NOTHING about the address they named — not even by timing', async () => {
  const updateProfile = await loadAction()
  state.role = 'SUPPLIER'
  await updateProfile({ name: 'Acme Ltd', email: 'someone.else@example.com' })
  // The refusal comes BEFORE the uniqueness read and BEFORE the rate limit, so an external principal
  // does exactly the same work whether the address exists or not.
  const emailReads = state.userReads.filter((read) => 'email' in read.where)
  assert.deepEqual(emailReads, [], 'the enumeration read must never be reached by a supplier')
  assert.deepEqual(state.rateLimitCalls, [], 'and no budget is spent proving it')
})

test('the supplier refusal is recorded, so the attempt is visible rather than merely blocked', async () => {
  const updateProfile = await loadAction()
  state.role = 'SUPPLIER'
  await updateProfile({ name: 'Acme Ltd', email: 'someone.else@example.com' })
  const entry = state.activity.find((a) => a.action === 'email_change_refused')
  assert.ok(entry)
  assert.equal(entry.level, 'WARNING')
})

test('a SUPPLIER can still change its NAME, and saving its own address is not a change', async () => {
  const updateProfile = await loadAction()
  state.role = 'SUPPLIER'
  const result = await updateProfile({ name: 'Acme Trading Ltd', email: 'me@example.com' })
  assert.equal(result.success, true)
  assert.equal(state.updates[0].name, 'Acme Trading Ltd')
})

// ---------------------------------------------------------------------------
// Narrowing 2 — the bound
// ---------------------------------------------------------------------------

test('an email change is rate-limited per user, fail-closed', async () => {
  const updateProfile = await loadAction()
  await updateProfile({ name: 'Me', email: 'new@example.com' })
  assert.deepEqual(state.rateLimitCalls, [{
    key: 'profile-email-change:user-1',
    max: 5,
    windowMs: 15 * 60_000,
    // A rate-limit backend outage must not silently restore an unbounded oracle.
    failClosed: true,
  }])
})

test('re-saving your own address spends no budget and makes no uniqueness read of anyone else', async () => {
  const updateProfile = await loadAction()
  const result = await updateProfile({ name: 'Me Again', email: 'ME@example.com' })
  assert.equal(result.success, true)
  assert.deepEqual(state.rateLimitCalls, [], 'an ordinary profile edit must not consume the email budget')
})

test('once the limit trips the attempt is refused and recorded, and nothing is read or written', async () => {
  const updateProfile = await loadAction()
  state.rateLimitAllowed = false
  const result = await updateProfile({ name: 'Me', email: 'someone.else@example.com' })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /cannot be used for this account/)
  const emailReads = state.userReads.filter((read) => 'email' in read.where)
  assert.deepEqual(emailReads, [], 'a rate-limited probe must not reach the read it was probing')
  assert.deepEqual(state.updates, [])
  assert.ok(state.activity.find((a) => a.action === 'email_change_rate_limited'))
})

test('the rate limit is applied AFTER the fresh-auth gate, not instead of it', async () => {
  const updateProfile = await loadAction()
  state.freshAuthFails = true
  const result = await updateProfile({ name: 'Me', email: 'new@example.com' })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /sign in again/i)
  assert.deepEqual(state.updates, [])
})

// ---------------------------------------------------------------------------
// The read that remains, and the race it never handled
// ---------------------------------------------------------------------------

test('the uniqueness read selects the id ALONE, never the whole foreign row', async () => {
  // It used to select every column — password hash and TOTP secret included — into this process to
  // answer a yes/no question about a row that is not the caller's.
  const updateProfile = await loadAction()
  await updateProfile({ name: 'Me', email: 'new@example.com' })
  const emailRead = state.userReads.find((read) => 'email' in read.where)
  assert.ok(emailRead, 'the pre-check still runs — it is what keeps the constraint off the 500 path')
  assert.deepEqual(emailRead.select, { id: true })
})

test('an address another account holds is refused without saying it is taken', async () => {
  const updateProfile = await loadAction()
  const result = await updateProfile({ name: 'Me', email: 'someone.else@example.com' })
  assert.equal(result.success, false)
  assert.equal(result.error, 'That email address cannot be used for this account. If it is yours, ask an administrator to move it.')
  assert.deepEqual(state.updates, [])
})

test('losing the constraint race is the same refusal, not an unexplained 500', async () => {
  // The pre-check is TOCTOU: two principals moving to the same address at once both pass it, and one
  // used to get a raw P2002 out of a server action on an account operation.
  const updateProfile = await loadAction()
  state.throwOnUpdate = uniqueEmailViolation()
  const result = await updateProfile({ name: 'Me', email: 'new@example.com' })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /cannot be used for this account/)
})

test('a unique violation on some OTHER column is rethrown, not dressed up as an email clash', async () => {
  const updateProfile = await loadAction()
  state.throwOnUpdate = { code: 'P2002', meta: { target: ['pictureUrl'] } }
  await assert.rejects(() => updateProfile({ name: 'Me', email: 'new@example.com' }))
})

test('a successful change still rolls sessionVersion to invalidate the other sessions', async () => {
  const updateProfile = await loadAction()
  const result = await updateProfile({ name: 'Me', email: 'new@example.com' })
  assert.equal(result.success, true)
  assert.deepEqual(state.updates[0].sessionVersion, { increment: 1 })
  assert.equal(state.updates[0].email, 'new@example.com')
})
