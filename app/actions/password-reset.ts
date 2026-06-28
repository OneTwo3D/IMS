'use server'

import { headers } from 'next/headers'
import { after } from 'next/server'
import bcrypt from 'bcryptjs'

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { sendEmail } from '@/lib/mailer'
import { setAuthToken, consumeAuthToken } from '@/lib/auth/token-store'
import { checkRateLimit } from '@/lib/security/rate-limit'
import { getClientIp } from '@/lib/request-ip'
import { validateUserPassword } from '@/lib/security/password-policy'
import { escapeHtml } from '@/lib/email-template'
import {
  PASSWORD_RESET_TTL_MS,
  buildPasswordResetUrl,
  generatePasswordResetToken,
  passwordResetTokenKey,
} from '@/lib/auth/password-reset'

export type PasswordResetResult = { success: true } | { success: false; error: string }

// Returned for every "request" outcome so the endpoint never reveals whether an
// account exists (anti-enumeration) — success, no account, or rate-limited all look alike.
const REQUEST_ACK: PasswordResetResult = { success: true }

/**
 * Step 1 — a logged-out user asks for a reset link. Always acknowledges generically;
 * only actually emails a single-use link when an active account matches.
 */
export async function requestPasswordReset(email: string): Promise<PasswordResetResult> {
  const normalizedEmail = (email ?? '').trim().toLowerCase()
  if (!normalizedEmail || normalizedEmail.length > 254 || !normalizedEmail.includes('@')) {
    return { success: false, error: 'Enter a valid email address.' }
  }

  const ip = getClientIp(await headers()) ?? 'unknown'
  // Per-IP cap guards against email-bombing across many target addresses; the
  // per-email+IP cap guards a single target. Either tripping → silent ack.
  const ipLimit = await checkRateLimit(`pwreset-ip:${ip}`, 20, 15 * 60_000)
  const emailLimit = await checkRateLimit(`pwreset:${normalizedEmail}:${ip}`, 5, 15 * 60_000)
  if (!ipLimit.allowed || !emailLimit.allowed) return REQUEST_ACK

  const user = await db.user.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' }, active: true },
    select: { id: true, email: true, name: true },
  })

  // The lookup above runs identically whether or not the account exists. The token write
  // + email send only happen for a real account, so defer them past the response with
  // after() — that keeps the request's observable latency independent of account existence
  // (anti-enumeration) while still reliably sending the email on a long-lived server.
  if (user) {
    const recipient = { id: user.id, email: user.email, name: user.name }
    after(async () => {
      try {
        const token = generatePasswordResetToken()
        await setAuthToken(passwordResetTokenKey(token), recipient.id, PASSWORD_RESET_TTL_MS)

        const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.AUTH_URL ?? ''
        const resetUrl = buildPasswordResetUrl(baseUrl, token)
        const org = await db.organisation.findFirst({ select: { name: true } })
        const orgName = org?.name || 'One Two Inventory'
        const appName = escapeHtml(orgName)
        // recipient.name is user-controlled; escape it before interpolating into the HTML.
        const greeting = recipient.name ? `Hi ${escapeHtml(recipient.name)},` : 'Hello,'
        const safeUrl = escapeHtml(resetUrl)

        await sendEmail({
          to: recipient.email,
          subject: `Reset your ${orgName} password`,
          html: `
            <p>${greeting}</p>
            <p>We received a request to reset the password for your ${appName} account.</p>
            <p>Click the button below to choose a new password. This link expires in 60 minutes and can be used once.</p>
            <p><a href="${safeUrl}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Reset password</a></p>
            <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${safeUrl}</p>
            <p style="color:#666;font-size:13px">If you didn't request this, you can safely ignore this email — your password stays unchanged.</p>
          `,
        })

        await logActivity({
          entityType: 'USER',
          entityId: recipient.id,
          tag: 'auth',
          action: 'password_reset_requested',
          description: 'Password reset link requested',
        })
      } catch {
        // Best-effort: a send/store failure must not surface (it would leak account existence).
      }
    })
  }

  return REQUEST_ACK
}

/**
 * Step 2 — the user follows the emailed link and submits a new password. The token is
 * single-use (consumed here) and only after the new password passes policy, so a weak
 * password doesn't burn the link.
 */
export async function resetPassword(token: string, newPassword: string): Promise<PasswordResetResult> {
  if (!token) return { success: false, error: 'This reset link is invalid or has expired.' }

  const policyError = validateUserPassword(newPassword ?? '')
  if (policyError) return { success: false, error: policyError }

  const ip = getClientIp(await headers()) ?? 'unknown'
  const limit = await checkRateLimit(`pwreset-confirm:${ip}`, 20, 15 * 60_000)
  if (!limit.allowed) return { success: false, error: 'Too many attempts. Please try again later.' }

  const userId = await consumeAuthToken(passwordResetTokenKey(token))
  if (!userId) {
    return { success: false, error: 'This reset link is invalid or has expired. Request a new one.' }
  }

  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, active: true } })
  if (!user || !user.active) {
    return { success: false, error: 'This account is no longer active.' }
  }

  const passwordHash = await bcrypt.hash(newPassword, 12)
  // Bumping sessionVersion signs out every existing session for this user.
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash, sessionVersion: { increment: 1 } },
  })

  // Invalidate any other outstanding reset links for this user so an older, still-unused
  // link can't reset the password again after this one.
  await db.oneTimeToken
    .deleteMany({ where: { key: { startsWith: 'password_reset:' }, value: user.id } })
    .catch(() => {})

  await logActivity({
    entityType: 'USER',
    entityId: user.id,
    tag: 'auth',
    action: 'password_reset',
    description: 'Password reset via emailed link',
  }).catch(() => {})

  return { success: true }
}
