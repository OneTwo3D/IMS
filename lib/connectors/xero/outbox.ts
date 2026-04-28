import {
  buildOutboxIdempotencyKey,
  enqueueIntegrationOutbox,
  INTEGRATION_OUTBOX_STATUS,
  type IntegrationOutboxClient,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'

export const XERO_OUTBOX_CONNECTOR = 'xero'
export const XERO_ACCOUNTING_POST_OPERATION = 'accounting.post'

export type XeroAccountingOutboxPayload = {
  accountingSyncLogId: string
}

export function buildXeroAccountingOutboxIdempotencyKey(accountingSyncLogId: string): string {
  return buildOutboxIdempotencyKey(
    XERO_OUTBOX_CONNECTOR,
    XERO_ACCOUNTING_POST_OPERATION,
    accountingSyncLogId,
  )
}

export function buildXeroAccountingOutboxPayload(accountingSyncLogId: string): XeroAccountingOutboxPayload {
  return { accountingSyncLogId }
}

export function parseXeroAccountingOutboxPayload(row: { id: string; payloadJson: unknown }): XeroAccountingOutboxPayload {
  const payload = row.payloadJson
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Xero accounting outbox payload for ${row.id} must be an object`)
  }
  const data = payload as Record<string, unknown>
  if (typeof data.accountingSyncLogId !== 'string' || !data.accountingSyncLogId.trim()) {
    throw new Error(`Xero accounting outbox payload for ${row.id} is missing accountingSyncLogId`)
  }
  return { accountingSyncLogId: data.accountingSyncLogId }
}

export async function scheduleXeroAccountingOutbox(
  client: IntegrationOutboxClient,
  options: {
    accountingSyncLogId: string
    nextAttemptAt?: Date | null
    attempts?: number
    resetAttempts?: boolean
  },
): Promise<IntegrationOutboxRow> {
  const payload = buildXeroAccountingOutboxPayload(options.accountingSyncLogId)
  const row = await enqueueIntegrationOutbox({
    connector: XERO_OUTBOX_CONNECTOR,
    operation: XERO_ACCOUNTING_POST_OPERATION,
    idempotencyKey: buildXeroAccountingOutboxIdempotencyKey(options.accountingSyncLogId),
    payloadJson: payload,
    nextAttemptAt: options.nextAttemptAt ?? null,
  }, { client })

  const resetAttempts = options.resetAttempts
    || row.status === INTEGRATION_OUTBOX_STATUS.SUCCEEDED
    || row.status === INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED

  if (row.status === INTEGRATION_OUTBOX_STATUS.PROCESSING) return row

  await client.integrationOutbox.updateMany({
    where: { id: row.id, status: { not: INTEGRATION_OUTBOX_STATUS.PROCESSING } },
    data: {
      connector: XERO_OUTBOX_CONNECTOR,
      operation: XERO_ACCOUNTING_POST_OPERATION,
      idempotencyKey: buildXeroAccountingOutboxIdempotencyKey(options.accountingSyncLogId),
      payloadJson: payload,
      status: INTEGRATION_OUTBOX_STATUS.PENDING,
      nextAttemptAt: options.nextAttemptAt ?? null,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
      ...(options.attempts === undefined && resetAttempts ? { attempts: 0 } : {}),
    },
  })

  return await client.integrationOutbox.findUnique({ where: { id: row.id } }) ?? row
}
