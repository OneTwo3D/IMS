'use server'

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server'
import { randomBytes } from 'crypto'
import { headers } from 'next/headers'
import { db } from '@/lib/db'
import { getSession } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import { consumeAuthToken, setAuthToken } from '@/lib/auth/token-store'
import { getPublicAppUrl } from '@/lib/public-app-url'
import { checkRateLimit } from '@/lib/security/rate-limit'
import { getClientIp, isTrustedProxyConfigured } from '@/lib/request-ip'

const RP_NAME = 'onetwoInventory'

/**
 * Returns the current session only if it is *fully* authenticated. A
 * password-only session that has not yet cleared the TOTP challenge
 * (`totpEnabled && !totpVerified`) is rejected: allowing it to enroll or manage
 * passkeys would let a password-holding attacker register their own
 * authenticator and sign in with it, bypassing the second factor entirely.
 */
async function getVerifiedSession() {
  const session = await getSession()
  if (!session?.user?.id) return null
  if (session.user.totpEnabled && !session.user.totpVerified) return null
  return session
}

async function getPasskeyOriginConfig(): Promise<{ rpId: string; origin: string } | { error: string }> {
  const publicAppUrl = await getPublicAppUrl()
  if (!publicAppUrl) return { error: 'Public app URL is not configured.' }

  try {
    const parsed = new URL(publicAppUrl)
    return { rpId: parsed.hostname, origin: publicAppUrl }
  } catch {
    return { error: 'Public app URL is invalid.' }
  }
}

async function setChallenge(key: string, challenge: string) {
  await setAuthToken(`passkey_challenge:${key}`, challenge, PASSKEY_CEREMONY_TTL_MS)
}

async function getChallenge(key: string): Promise<string | null> {
  return consumeAuthToken(`passkey_challenge:${key}`)
}

// --- Registration ---

export async function getPasskeyRegistrationOptions() {
  const session = await getVerifiedSession()
  if (!session?.user?.id) return { error: 'Unauthorized' }
  const originConfig = await getPasskeyOriginConfig()
  if ('error' in originConfig) return { error: originConfig.error }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, passkeys: { select: { credentialId: true } } },
  })
  if (!user) return { error: 'User not found' }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: originConfig.rpId,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.name,
    attestationType: 'none',
    excludeCredentials: user.passkeys.map((p) => ({
      id: p.credentialId,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  })

  await setChallenge(`reg:${user.id}`, options.challenge)

  return { options }
}

export async function verifyPasskeyRegistration(
  response: RegistrationResponseJSON,
  name?: string,
) {
  const session = await getVerifiedSession()
  if (!session?.user?.id) return { error: 'Unauthorized' }
  const originConfig = await getPasskeyOriginConfig()
  if ('error' in originConfig) return { error: originConfig.error }

  const challenge = await getChallenge(`reg:${session.user.id}`)
  if (!challenge) return { error: 'Challenge expired. Please try again.' }

  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: originConfig.origin,
      expectedRPID: originConfig.rpId,
    })

    if (!verification.verified || !verification.registrationInfo) {
      return { error: 'Verification failed.' }
    }

    const { credential } = verification.registrationInfo

    await db.$transaction([
      db.passkey.create({
        data: {
          userId: session.user.id,
          credentialId: credential.id,
          credentialPublicKey: Buffer.from(credential.publicKey),
          counter: BigInt(credential.counter),
          transports: response.response.transports ?? [],
          name: name || 'Passkey',
        },
      }),
      db.user.update({
        where: { id: session.user.id },
        data: { sessionVersion: { increment: 1 } },
      }),
    ])

    await logActivity({ entityType: 'USER', tag: 'auth', action: 'passkey_registered', description: `Registered passkey: ${name || 'Passkey'}` })
    return { success: true }
  } catch (e) {
    console.error('Passkey registration error:', e)
    return { error: 'Registration failed.' }
  }
}

// --- Authentication ---

// This action is public by necessity (it runs before login), so it must also be harmless to call repeatedly:
// each call stores its challenge under its OWN random ceremony key. A shared key (the old `auth:discoverable`
// or `auth:<email>`) let any unauthenticated caller overwrite and so invalidate every login in flight.
//
// Because each call now writes its own row, issuance is bounded by the per-IP rate limit below (at most that many rows
// per IP per TTL) and expired ones are pruned on issue. There is deliberately NO global cap on outstanding ceremonies:
// anonymous callers could fill it and lock every user out of passkey sign-in.
const PASSKEY_CEREMONY_TTL_MS = 5 * 60_000
const PASSKEY_ISSUE_IP_MAX = 30
// Without trusted-proxy resolution every client collapses onto the proxy's address, so the per-IP bucket is
// really a global one and must be wide enough not to lock a whole office out.
const PASSKEY_ISSUE_COLLAPSED_MAX = 300
const PASSKEY_ISSUE_WINDOW_MS = 5 * 60_000
const PASSKEY_CHALLENGE_KEY_PREFIX = 'passkey_challenge:auth:'

export async function getPasskeyAuthenticationOptions() {
  const originConfig = await getPasskeyOriginConfig()
  if ('error' in originConfig) return { error: originConfig.error }

  const ip = getClientIp(await headers()) ?? 'unknown'
  const limit = await checkRateLimit(
    `passkey-options-ip:${ip}`,
    isTrustedProxyConfigured() ? PASSKEY_ISSUE_IP_MAX : PASSKEY_ISSUE_COLLAPSED_MAX,
    PASSKEY_ISSUE_WINDOW_MS,
    { failClosed: true },
  )
  if (!limit.allowed) return { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' }

  const now = new Date()
  await db.oneTimeToken.deleteMany({
    where: { key: { startsWith: PASSKEY_CHALLENGE_KEY_PREFIX }, expiresAt: { lt: now } },
  })
  const challengeKey = `auth:${randomBytes(16).toString('hex')}`

  const options = await generateAuthenticationOptions({
    rpID: originConfig.rpId,
    userVerification: 'preferred',
  })

  await setChallenge(challengeKey, options.challenge)

  return { options, challengeKey }
}

export async function verifyPasskeyAuthentication(
  response: AuthenticationResponseJSON,
  challengeKey: string,
) {
  const originConfig = await getPasskeyOriginConfig()
  if ('error' in originConfig) return { error: originConfig.error }
  const challenge = await getChallenge(challengeKey)
  if (!challenge) return { error: 'Challenge expired. Please try again.' }

  // Find the passkey by credential ID
  const passkey = await db.passkey.findUnique({
    where: { credentialId: response.id },
    include: { user: { select: { id: true, email: true, name: true, role: true, pictureUrl: true, totpEnabled: true, active: true } } },
  })

  if (!passkey || !passkey.user.active) {
    return { error: 'Passkey not found or account inactive.' }
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: originConfig.origin,
      expectedRPID: originConfig.rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: passkey.credentialPublicKey,
        counter: Number(passkey.counter),
      },
    })

    if (!verification.verified) {
      return { error: 'Verification failed.' }
    }

    // Update counter
    await db.passkey.update({
      where: { id: passkey.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter) },
    })

    // Generate a one-time auth token that binds this verification to the signIn call.
    // The passkey Credentials provider will consume this token to prevent replay.
    const authToken = randomBytes(32).toString('hex')
    await setAuthToken(`passkey_auth:${authToken}`, passkey.user.id, 60_000) // 60s TTL

    return {
      success: true,
      authToken,
      user: {
        id: passkey.user.id,
        email: passkey.user.email,
        name: passkey.user.name,
        role: passkey.user.role,
        pictureUrl: passkey.user.pictureUrl,
        totpEnabled: passkey.user.totpEnabled,
      },
    }
  } catch (e) {
    console.error('Passkey auth error:', e)
    return { error: 'Authentication failed.' }
  }
}

// --- Management ---

export async function listPasskeys() {
  const session = await getVerifiedSession()
  if (!session?.user?.id) return []

  return db.passkey.findMany({
    where: { userId: session.user.id },
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
}

export async function renamePasskey(id: string, name: string) {
  const session = await getVerifiedSession()
  if (!session?.user?.id) return { error: 'Unauthorized' }

  await db.passkey.updateMany({
    where: { id, userId: session.user.id },
    data: { name },
  })
  await logActivity({ entityType: 'USER', tag: 'auth', action: 'passkey_renamed', description: `Renamed passkey to: ${name}` })
  return { success: true }
}

export async function deletePasskey(id: string) {
  const session = await getVerifiedSession()
  if (!session?.user?.id) return { error: 'Unauthorized' }

  await db.$transaction([
    db.passkey.deleteMany({
      where: { id, userId: session.user.id },
    }),
    db.user.update({
      where: { id: session.user.id },
      data: { sessionVersion: { increment: 1 } },
    }),
  ])
  await logActivity({ entityType: 'USER', tag: 'auth', action: 'passkey_deleted', description: 'Deleted a passkey' })
  return { success: true }
}
