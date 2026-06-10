import { createHash, createHmac } from 'node:crypto'

import { db } from '@/lib/db'

export type IntegrationConnectionId = 'xero' | 'woocommerce' | 'mintsoft' | 'smtp'
export type IntegrationConnectionTestStatus = 'success' | 'failed' | 'never'

export type IntegrationConnectionTestState = {
  status: IntegrationConnectionTestStatus
  testedAt: string | null
  message: string
  fingerprint: string | null
}

export type IntegrationConnectionTestGateResult =
  | { ok: true }
  | { ok: false; error: string }

type SettingRepository = {
  findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true } }): Promise<Array<{ key: string; value: string }>>
  upsert(args: {
    where: { key: string }
    create: { key: string; value: string }
    update: { value: string }
  }): Promise<unknown>
  transaction?(operations: Array<() => Promise<unknown>>): Promise<unknown>
}

const TEST_KEYS = ['status', 'tested_at', 'message', 'fingerprint'] as const
const SECRET_FINGERPRINT_MARKER = '__imsConnectionFingerprintSecret'

export type IntegrationConnectionFingerprintSecret = {
  [SECRET_FINGERPRINT_MARKER]: true
  value: string
}

function testSettingKey(id: IntegrationConnectionId, suffix: (typeof TEST_KEYS)[number]): string {
  return `${id}_connection_test_${suffix}`
}

function getFingerprintHmacKey(): string {
  const key = process.env.INTEGRATION_CONNECTION_FINGERPRINT_KEY
    ?? process.env.AUTH_SECRET
    ?? process.env.NEXTAUTH_SECRET
    ?? process.env.SETTINGS_ENCRYPTION_KEY
    ?? process.env.ENCRYPTION_KEY
  if (key) return key
  if (process.env.NODE_ENV === 'production') {
    throw new Error('INTEGRATION_CONNECTION_FINGERPRINT_KEY or AUTH_SECRET is required to fingerprint integration secrets')
  }
  return 'ims-development-connection-fingerprint-key'
}

function isFingerprintSecret(value: unknown): value is IntegrationConnectionFingerprintSecret {
  return Boolean(
    value
      && typeof value === 'object'
      && (value as Partial<IntegrationConnectionFingerprintSecret>)[SECRET_FINGERPRINT_MARKER] === true,
  )
}

export function integrationConnectionFingerprintSecret(value: string | null | undefined): IntegrationConnectionFingerprintSecret {
  return { [SECRET_FINGERPRINT_MARKER]: true, value: value ?? '' }
}

function fingerprintSecretValue(value: string): string {
  return createHmac('sha256', getFingerprintHmacKey()).update(value).digest('hex')
}

function normalizeForFingerprint(value: unknown): unknown {
  if (isFingerprintSecret(value)) return { secretHmac: fingerprintSecretValue(value.value) }
  if (value == null || value === '') return undefined
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeForFingerprint(entry))
      .filter((entry) => entry !== undefined)
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeForFingerprint(entry)])
        .filter((entry): entry is [string, unknown] => entry[1] !== undefined),
    )
  }
  return String(value)
}

/**
 * Builds the durable fingerprint used by integration settings gates.
 *
 * Include every setting that affects connectivity. Secret values must be wrapped
 * with `integrationConnectionFingerprintSecret(...)`; they are HMACed with a
 * server-side key before the fingerprint is stored so a read-only database dump
 * cannot be used for offline password guessing. Absent values (`undefined`,
 * `null`, and empty strings) are normalized out so equivalent empty UI states do
 * not force unnecessary retests.
 */
export function buildIntegrationConnectionFingerprint(parts: Record<string, unknown>): string {
  const normalized = normalizeForFingerprint(parts)
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export function evaluateIntegrationConnectionTestGate(params: {
  state: IntegrationConnectionTestState
  expectedFingerprint: string
  label: string
}): IntegrationConnectionTestGateResult {
  const { state, expectedFingerprint, label } = params
  if (state.status !== 'success') {
    return { ok: false, error: `Test the ${label} connection successfully before enabling it.` }
  }
  if (!state.fingerprint || state.fingerprint !== expectedFingerprint) {
    return { ok: false, error: `Retest the ${label} connection because the saved connection settings changed.` }
  }
  return { ok: true }
}

export async function getIntegrationConnectionTestState(
  id: IntegrationConnectionId,
  repository: Pick<SettingRepository, 'findMany'> = db.setting,
): Promise<IntegrationConnectionTestState> {
  const keys = TEST_KEYS.map((suffix) => testSettingKey(id, suffix))
  const rows = await repository.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  })
  const map = new Map(rows.map((row) => [row.key, row.value]))
  const rawStatus = map.get(testSettingKey(id, 'status'))
  const status: IntegrationConnectionTestStatus = rawStatus === 'success' || rawStatus === 'failed'
    ? rawStatus
    : 'never'

  return {
    status,
    testedAt: map.get(testSettingKey(id, 'tested_at')) ?? null,
    message: map.get(testSettingKey(id, 'message')) ?? '',
    fingerprint: map.get(testSettingKey(id, 'fingerprint')) ?? null,
  }
}

export async function recordIntegrationConnectionTest(
  id: IntegrationConnectionId,
  params: {
    success: boolean
    fingerprint: string
    message: string
    testedAt?: Date
  },
  repository: Pick<SettingRepository, 'upsert' | 'transaction'> = {
    upsert: (args) => db.setting.upsert(args),
    transaction: async (operations) => {
      await db.$transaction(operations.map((operation) => operation() as never))
    },
  },
): Promise<void> {
  const testedAt = params.testedAt ?? new Date()
  const values: Record<(typeof TEST_KEYS)[number], string> = {
    status: params.success ? 'success' : 'failed',
    tested_at: testedAt.toISOString(),
    message: params.message,
    fingerprint: params.fingerprint,
  }

  const operations = TEST_KEYS.map((suffix) => () =>
    repository.upsert({
      where: { key: testSettingKey(id, suffix) },
      create: { key: testSettingKey(id, suffix), value: values[suffix] },
      update: { value: values[suffix] },
    }),
  )
  if (repository.transaction) {
    await repository.transaction(operations)
  } else {
    await Promise.all(operations.map((operation) => operation()))
  }
}

export async function assertIntegrationConnectionTestPassed(
  id: IntegrationConnectionId,
  expectedFingerprint: string,
  label: string,
): Promise<IntegrationConnectionTestGateResult> {
  const state = await getIntegrationConnectionTestState(id)
  return evaluateIntegrationConnectionTestGate({ state, expectedFingerprint, label })
}
