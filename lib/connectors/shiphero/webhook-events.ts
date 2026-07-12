import type { Prisma } from '@/app/generated/prisma/client'
import type { ShipheroWebhookEventType } from './webhook-validation'

export type ShipheroWebhookEventRecord = {
  id: string
  processedAt: Date | null
}

export type PersistShipheroWebhookEventInput = {
  eventType: ShipheroWebhookEventType
  externalEventId: string
  externalOrderId: string | null
  statusRank: number | null
  payload: Prisma.InputJsonValue
}

export type PersistShipheroWebhookEventResult =
  | { status: 'created'; eventId: string }
  | { status: 'updated'; eventId: string }
  | { status: 'duplicate'; eventId: string }

export type ShipheroWebhookEventRepository = {
  createEvent(input: PersistShipheroWebhookEventInput): Promise<{ id: string }>
  findEvent(externalEventId: string): Promise<ShipheroWebhookEventRecord | null>
  updatePendingEvent(id: string, input: PersistShipheroWebhookEventInput): Promise<boolean>
}

type PersistShipheroWebhookEventOptions = {
  isUniqueConstraintError: (error: unknown) => boolean
}

async function updateIfPending(
  repository: ShipheroWebhookEventRepository,
  event: ShipheroWebhookEventRecord,
  input: PersistShipheroWebhookEventInput,
): Promise<PersistShipheroWebhookEventResult | null> {
  if (event.processedAt) {
    return { status: 'duplicate', eventId: event.id }
  }
  if (await repository.updatePendingEvent(event.id, input)) {
    return { status: 'updated', eventId: event.id }
  }

  const latest = await repository.findEvent(input.externalEventId)
  if (!latest) return null
  if (latest.processedAt) {
    return { status: 'duplicate', eventId: latest.id }
  }
  if (await repository.updatePendingEvent(latest.id, input)) {
    return { status: 'updated', eventId: latest.id }
  }
  return null
}

/**
 * Idempotent staging on (connector, externalEventId). A re-delivered event that
 * hasn't processed yet refreshes its payload and stays PENDING; one already
 * processed is reported as a duplicate. Mirrors the Mintsoft pattern, including
 * the concurrent-create race handled via the unique-constraint catch.
 */
export async function persistShipheroWebhookEvent(
  repository: ShipheroWebhookEventRepository,
  input: PersistShipheroWebhookEventInput,
  options: PersistShipheroWebhookEventOptions,
): Promise<PersistShipheroWebhookEventResult> {
  const existing = await repository.findEvent(input.externalEventId)
  if (existing) {
    const result = await updateIfPending(repository, existing, input)
    if (result) return result
  }

  try {
    const created = await repository.createEvent(input)
    return { status: 'created', eventId: created.id }
  } catch (error) {
    if (!options.isUniqueConstraintError(error)) {
      throw error
    }
    const concurrent = await repository.findEvent(input.externalEventId)
    if (concurrent) {
      const result = await updateIfPending(repository, concurrent, input)
      if (result) return result
    }
    throw error
  }
}
