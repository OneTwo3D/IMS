import { createHash } from 'node:crypto'

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
}

const TEST_KEYS = ['status', 'tested_at', 'message', 'fingerprint'] as const

function testSettingKey(id: IntegrationConnectionId, suffix: (typeof TEST_KEYS)[number]): string {
  return `${id}_connection_test_${suffix}`
}

function normalizeForFingerprint(value: unknown): unknown {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((entry) => normalizeForFingerprint(entry))
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeForFingerprint(entry)]),
    )
  }
  return String(value)
}

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
  repository: Pick<SettingRepository, 'upsert'> = db.setting,
): Promise<void> {
  const testedAt = params.testedAt ?? new Date()
  const values: Record<(typeof TEST_KEYS)[number], string> = {
    status: params.success ? 'success' : 'failed',
    tested_at: testedAt.toISOString(),
    message: params.message,
    fingerprint: params.fingerprint,
  }

  await Promise.all(TEST_KEYS.map((suffix) =>
    repository.upsert({
      where: { key: testSettingKey(id, suffix) },
      create: { key: testSettingKey(id, suffix), value: values[suffix] },
      update: { value: values[suffix] },
    }),
  ))
}

export async function assertIntegrationConnectionTestPassed(
  id: IntegrationConnectionId,
  expectedFingerprint: string,
  label: string,
): Promise<IntegrationConnectionTestGateResult> {
  const state = await getIntegrationConnectionTestState(id)
  return evaluateIntegrationConnectionTestGate({ state, expectedFingerprint, label })
}
