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
import { db } from '@/lib/db'
import { auth } from '@/lib/auth'
import { logActivity } from '@/lib/activity-log'
import { setAuthToken } from '@/lib/auth/token-store'

const RP_NAME = 'OneTwo3D IMS'
const RP_ID = process.env.NEXT_PUBLIC_APP_URL
  ? new URL(process.env.NEXT_PUBLIC_APP_URL).hostname
  : 'localhost'
const ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

// In-memory challenge store (short-lived, per-request)
// In production with multiple instances, use Redis. For single-instance this is fine.
const challengeStore = new Map<string, { challenge: string; expires: number }>()

function setChallenge(key: string, challenge: string) {
  challengeStore.set(key, { challenge, expires: Date.now() + 5 * 60 * 1000 })
}

function getChallenge(key: string): string | null {
  const entry = challengeStore.get(key)
  if (!entry) return null
  challengeStore.delete(key)
  if (Date.now() > entry.expires) return null
  return entry.challenge
}

// --- Registration ---

export async function getPasskeyRegistrationOptions() {
  const session = await auth()
  if (!session?.user?.id) return { error: 'Unauthorized' }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, passkeys: { select: { credentialId: true } } },
  })
  if (!user) return { error: 'User not found' }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
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

  setChallenge(`reg:${user.id}`, options.challenge)

  return { options }
}

export async function verifyPasskeyRegistration(
  response: RegistrationResponseJSON,
  name?: string,
) {
  const session = await auth()
  if (!session?.user?.id) return { error: 'Unauthorized' }

  const challenge = getChallenge(`reg:${session.user.id}`)
  if (!challenge) return { error: 'Challenge expired. Please try again.' }

  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    })

    if (!verification.verified || !verification.registrationInfo) {
      return { error: 'Verification failed.' }
    }

    const { credential } = verification.registrationInfo

    await db.passkey.create({
      data: {
        userId: session.user.id,
        credentialId: credential.id,
        credentialPublicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: response.response.transports ?? [],
        name: name || 'Passkey',
      },
    })

    logActivity({ entityType: 'USER', tag: 'auth', action: 'passkey_registered', description: `Registered passkey: ${name || 'Passkey'}` })
    return { success: true }
  } catch (e) {
    console.error('Passkey registration error:', e)
    return { error: 'Registration failed.' }
  }
}

// --- Authentication ---

export async function getPasskeyAuthenticationOptions(email?: string) {
  const allowCredentials: { id: string }[] = []
  const challengeKey = email ? `auth:${email}` : `auth:discoverable`

  if (email) {
    const user = await db.user.findUnique({
      where: { email },
      select: { passkeys: { select: { credentialId: true, transports: true } } },
    })
    if (user?.passkeys.length) {
      for (const p of user.passkeys) {
        allowCredentials.push({ id: p.credentialId })
      }
    }
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
    userVerification: 'preferred',
  })

  setChallenge(challengeKey, options.challenge)

  return { options, challengeKey }
}

export async function verifyPasskeyAuthentication(
  response: AuthenticationResponseJSON,
  challengeKey: string,
) {
  const challenge = getChallenge(challengeKey)
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
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
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
    setAuthToken(`passkey_auth:${authToken}`, passkey.user.id, 60_000) // 60s TTL

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
  const session = await auth()
  if (!session?.user?.id) return []

  return db.passkey.findMany({
    where: { userId: session.user.id },
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
}

export async function renamePasskey(id: string, name: string) {
  const session = await auth()
  if (!session?.user?.id) return { error: 'Unauthorized' }

  await db.passkey.updateMany({
    where: { id, userId: session.user.id },
    data: { name },
  })
  logActivity({ entityType: 'USER', tag: 'auth', action: 'passkey_renamed', description: `Renamed passkey to: ${name}` })
  return { success: true }
}

export async function deletePasskey(id: string) {
  const session = await auth()
  if (!session?.user?.id) return { error: 'Unauthorized' }

  await db.passkey.deleteMany({
    where: { id, userId: session.user.id },
  })
  logActivity({ entityType: 'USER', tag: 'auth', action: 'passkey_deleted', description: 'Deleted a passkey' })
  return { success: true }
}
