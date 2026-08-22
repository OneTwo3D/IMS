'use server'

import { revalidatePath } from 'next/cache'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { requireAuth, requireFreshAuth } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import { isUniqueConstraintViolation, uniqueConstraintFields } from '@/lib/db/prisma-unique-violation'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateUserPassword } from '@/lib/security/password-policy'

// ---------------------------------------------------------------------------
// o3d-4is8 — THE ACCOUNT-ENUMERATION ORACLE IN updateProfile, AND THE DECISION TAKEN ON IT.
//
// THE FINDING (pinned by o3d-512h round 4 in tests/security/authentication-only-self-scoping.test.ts
// as the one non-configuration read in the authentication-only inventory that is not scoped to the
// caller). The uniqueness pre-check is `db.user.findUnique({ where: { email: newEmail } })` — a
// lookup of a row that by definition is NOT the caller's, keyed on a value the caller supplies. No
// field of that row reaches the response, but the OUTCOME does: "Email already in use" tells the
// caller whether an account exists at any address they name. Every principal who can sign in can
// call it, including a SUPPLIER — an external company we issue a login to — and nothing bounded how
// often.
//
// THE OPTIONS ON THE ISSUE WERE: (1) drop the pre-check and handle the unique violation, returning
// the same generic error either way; (2) keep it, rate-limit it, and return a message that does not
// distinguish; (3) accept it and record the acceptance.
//
// WHY OPTION 1 AND THE "GENERIC MESSAGE" HALF OF OPTION 2 ARE THEATRE HERE, and this is the whole
// reason the decision is not the textbook one. For a self-service email CHANGE the oracle is not the
// error text — it is the OUTCOME. An address nobody holds succeeds and the caller's login email
// moves; an address somebody holds fails and it does not. The caller observes that difference
// whatever words are attached, so wording the failure vaguely removes no signal at all and only
// makes a legitimate typo harder to understand. Genuinely closing the oracle would need the change
// to be applied only after a confirmation link sent to the new address — a real feature, not a
// patch, and out of scope here.
//
// WHAT WAS DONE INSTEAD, being the two things that actually bite:
//
//   1. NARROWED BY PRINCIPAL. A SUPPLIER may no longer change their own login email. Supplier logins
//      are issued by staff (app/actions/users.ts:createUser) and their email is maintained by staff
//      (updateUser, behind requireFreshAdmin + settings.users) — so this removes a capability
//      external principals never needed, and with it the ONLY untrusted class that could reach the
//      oracle at all. The refusal names the remedy rather than being a dead end.
//
//   2. BOUNDED BY RATE LIMIT. Every email-change ATTEMPT by any principal is counted, fail-closed,
//      at the same cap requestPasswordReset uses for a single target address. An internal account
//      that is compromised can no longer walk a list at speed, and each refusal is recorded against
//      the user so the attempt is visible in the activity log rather than only in aggregate.
//
// The read itself stays — it is what keeps the unique constraint from surfacing as a 500 — but it is
// narrowed to `select: { id: true }` (it used to load the whole row, password hash and TOTP secret
// included, to answer a yes/no question), and the update now ALSO handles the unique violation,
// because the pre-check is inherently TOCTOU: two principals moving to the same address at once
// raced past it and one of them got an unexplained 500.
//
// NON_SELF_SCOPED_READS in tests/security/authentication-only-self-scoping.test.ts is pinned by
// deepEqual, so the entry for 'profile.ts:updateProfile' must be updated when that branch
// (o3d-batch-authz) and this one meet — the read is still there, so the entry stays, but its
// justification changes from "left as a product decision" to the decision recorded above. That file
// does not exist on this branch, so it could not be edited here.
// ---------------------------------------------------------------------------

/**
 * The cap on email-change ATTEMPTS per user. Matches requestPasswordReset's per-target cap
 * (5 / 15 minutes) — the codebase's own settled figure for "how often may somebody probe one
 * address". failClosed, because a rate-limit backend outage must not silently restore an unbounded
 * oracle; a legitimate email change can wait for the backend to come back.
 */
const EMAIL_CHANGE_ATTEMPT_LIMIT = 5
const EMAIL_CHANGE_ATTEMPT_WINDOW_MS = 15 * 60_000

/**
 * The message returned for both "taken" and "rate-limited".
 *
 * Not a claim that the two are indistinguishable — see the block comment: the outcome distinguishes
 * them regardless. It is here so the two refusals do not read as different KINDS of failure, and so
 * an operator who has genuinely mistyped a colleague's address is told what to do about it.
 */
const EMAIL_UNAVAILABLE_ERROR = 'That email address cannot be used for this account. If it is yours, ask an administrator to move it.'

export async function updateProfile(data: { name: string; email: string }): Promise<{ success: boolean; error?: string }> {
  const session = await requireAuth()
  const userId = session.user.id

  if (!data.name.trim()) return { success: false, error: 'Name is required' }
  if (!data.email.trim()) return { success: false, error: 'Email is required' }

  const newEmail = data.email.trim().toLowerCase()
  const current = await db.user.findUnique({ where: { id: userId }, select: { email: true } })
  if (!current) return { success: false, error: 'User not found' }
  const emailChanging = newEmail !== current.email.toLowerCase()

  if (emailChanging) {
    // o3d-4is8, narrowing 1. An external principal has no business changing the login address we
    // issued them, and refusing it here removes the only untrusted class that could reach the
    // uniqueness read below. Refused BEFORE the rate limit is consumed and before any read is made,
    // so a supplier learns nothing at all — not even timing — and NOT silently: the refusal names
    // who can do it for them.
    if (session.user.role === 'SUPPLIER') {
      await logActivity({
        entityType: 'USER',
        entityId: userId,
        tag: 'auth',
        action: 'email_change_refused',
        level: 'WARNING',
        description: 'A supplier login attempted to change its own email address',
      })
      return {
        success: false,
        error: 'Your sign-in email is managed by the company that issued this login and cannot be '
          + 'changed here. Ask your contact there to update it for you.',
      }
    }

    // Changing the login email is a sensitive account operation: require a recently-authenticated
    // session and roll sessionVersion to invalidate other sessions once the email moves.
    try {
      await requireFreshAuth()
    } catch {
      return { success: false, error: 'Please sign in again to change your email address.' }
    }

    // o3d-4is8, narrowing 2. Counted per USER rather than per IP: the caller is authenticated, so the
    // account is the meaningful subject and an IP key would be trivially rotated around. Consumed
    // only on a real CHANGE — re-saving your own address must not spend the budget, or an ordinary
    // profile edit would lock a user out of a capability they were not using.
    const attempt = await checkRateLimit(
      `profile-email-change:${userId}`,
      EMAIL_CHANGE_ATTEMPT_LIMIT,
      EMAIL_CHANGE_ATTEMPT_WINDOW_MS,
      { failClosed: true },
    )
    if (!attempt.allowed) {
      await logActivity({
        entityType: 'USER',
        entityId: userId,
        tag: 'auth',
        action: 'email_change_rate_limited',
        level: 'WARNING',
        description: `Too many email-change attempts (limit ${EMAIL_CHANGE_ATTEMPT_LIMIT} per `
          + `${EMAIL_CHANGE_ATTEMPT_WINDOW_MS / 60_000} minutes)`,
      })
      return { success: false, error: EMAIL_UNAVAILABLE_ERROR }
    }
  }

  // The uniqueness pre-check. It stays because it is what keeps the constraint from surfacing as a
  // 500 — but it selects the ID ALONE. It used to select the whole row (password hash, TOTP secret,
  // everything) into this process to answer a yes/no question about a row that is not the caller's.
  const existing = await db.user.findUnique({ where: { email: newEmail }, select: { id: true } })
  if (existing && existing.id !== userId) return { success: false, error: EMAIL_UNAVAILABLE_ERROR }

  try {
    await db.user.update({
      where: { id: userId },
      data: {
        name: data.name.trim(),
        email: newEmail,
        ...(emailChanging ? { sessionVersion: { increment: 1 } } : {}),
      },
    })
  } catch (error) {
    // The pre-check is inherently TOCTOU — two principals moving to the same address at once both
    // pass it and one loses at the constraint. That used to be an unexplained 500 on an account
    // operation; it is the same refusal as losing to an existing account, which is what it is.
    const fields = isUniqueConstraintViolation(error) ? uniqueConstraintFields(error) : null
    if (fields?.some((field) => field.toLowerCase().includes('email'))) {
      return { success: false, error: EMAIL_UNAVAILABLE_ERROR }
    }
    throw error
  }
  revalidatePath('/profile')
  await logActivity({
    entityType: 'USER',
    entityId: userId,
    tag: 'auth',
    action: emailChanging ? 'email_changed' : 'updated',
    description: emailChanging ? 'Changed account email' : 'Updated profile',
  })
  return { success: true }
}

export async function changePassword(data: { currentPassword: string; newPassword: string }): Promise<{ success: boolean; error?: string }> {
  const session = await requireAuth()
  const userId = session.user.id

  const policyError = validateUserPassword(data.newPassword ?? '')
  if (policyError) return { success: false, error: policyError }

  const user = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
  if (!user) return { success: false, error: 'User not found' }

  const match = await bcrypt.compare(data.currentPassword, user.passwordHash)
  if (!match) return { success: false, error: 'Current password is incorrect' }

  const passwordHash = await bcrypt.hash(data.newPassword, 12)
  await db.user.update({
    where: { id: userId },
    data: { passwordHash, sessionVersion: { increment: 1 } },
  })
  await logActivity({ entityType: 'USER', entityId: userId, tag: 'auth', action: 'password_changed', description: 'Changed password' })
  return { success: true }
}

export async function updatePictureUrl(pictureUrl: string | null): Promise<{ success: boolean }> {
  const session = await requireAuth()
  await db.user.update({ where: { id: session.user.id }, data: { pictureUrl } })
  revalidatePath('/profile')
  await logActivity({ entityType: 'USER', entityId: session.user.id, tag: 'auth', action: 'updated', description: 'Updated profile picture' })
  return { success: true }
}

export async function getProfileData() {
  const session = await requireAuth()
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, role: true, pictureUrl: true, totpEnabled: true, createdAt: true },
  })
  if (!user) return null
  return { ...user, createdAt: user.createdAt.toISOString() }
}
