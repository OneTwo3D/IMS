import {
  buildOutboxIdempotencyKey,
  enqueueIntegrationOutbox,
  INTEGRATION_OUTBOX_STATUS,
  type IntegrationOutboxClient,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'
import {
  INTEGRATION_OUTBOX_OPERATIONS,
  parseIntegrationOutboxPayload,
  type XeroAccountingOutboxPayload,
} from '@/lib/domain/integrations/outbox-registry'

export const XERO_OUTBOX_CONNECTOR = 'xero'
export const XERO_ACCOUNTING_POST_OPERATION = INTEGRATION_OUTBOX_OPERATIONS.xero.postAccountingEvent

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
  return parseIntegrationOutboxPayload<XeroAccountingOutboxPayload>({
    connector: XERO_OUTBOX_CONNECTOR,
    operation: XERO_ACCOUNTING_POST_OPERATION,
    payloadJson: row.payloadJson,
    rowId: row.id,
  })
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
  const payload = parseXeroAccountingOutboxPayload({
    id: buildXeroAccountingOutboxIdempotencyKey(options.accountingSyncLogId),
    payloadJson: buildXeroAccountingOutboxPayload(options.accountingSyncLogId),
  })
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

  if (row.status === INTEGRATION_OUTBOX_STATUS.PROCESSING) {
    await client.integrationOutbox.updateMany({
      where: { id: row.id, status: INTEGRATION_OUTBOX_STATUS.PROCESSING, lockedAt: row.lockedAt },
      data: {
        payloadJson: payload,
        lastError: null,
        ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
      },
    })
    return await client.integrationOutbox.findUnique({ where: { id: row.id } }) ?? row
  }

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
