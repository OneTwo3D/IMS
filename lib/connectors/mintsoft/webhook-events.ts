import type { Prisma } from '@/app/generated/prisma/client'

export type MintsoftWebhookEventRecord = {
  id: string
  processedAt: Date | null
}

export type PersistMintsoftWebhookEventInput = {
  externalEventId: string
  externalAsnId: string | null
  payload: Prisma.InputJsonValue
}

export type PersistMintsoftWebhookEventResult =
  | {
    status: 'created'
    eventId: string
  }
  | {
    status: 'updated'
    eventId: string
  }
  | {
    status: 'duplicate'
    eventId: string
  }

export type MintsoftWebhookEventRepository = {
  createEvent(input: PersistMintsoftWebhookEventInput): Promise<{ id: string }>
  findEvent(externalEventId: string): Promise<MintsoftWebhookEventRecord | null>
  updatePendingEvent(id: string, input: PersistMintsoftWebhookEventInput): Promise<boolean>
}

type PersistMintsoftWebhookEventOptions = {
  isUniqueConstraintError: (error: unknown) => boolean
}

async function updateIfPending(
  repository: MintsoftWebhookEventRepository,
  event: MintsoftWebhookEventRecord,
  input: PersistMintsoftWebhookEventInput,
): Promise<PersistMintsoftWebhookEventResult | null> {
  if (event.processedAt) {
    return {
      status: 'duplicate',
      eventId: event.id,
    }
  }

  if (await repository.updatePendingEvent(event.id, input)) {
    return {
      status: 'updated',
      eventId: event.id,
    }
  }

  const latest = await repository.findEvent(input.externalEventId)
  if (!latest) return null
  if (latest.processedAt) {
    return {
      status: 'duplicate',
      eventId: latest.id,
    }
  }

  if (await repository.updatePendingEvent(latest.id, input)) {
    return {
      status: 'updated',
      eventId: latest.id,
    }
  }

  return null
}

export async function persistMintsoftWebhookEvent(
  repository: MintsoftWebhookEventRepository,
  input: PersistMintsoftWebhookEventInput,
  options: PersistMintsoftWebhookEventOptions,
): Promise<PersistMintsoftWebhookEventResult> {
  const existing = await repository.findEvent(input.externalEventId)
  if (existing) {
    const result = await updateIfPending(repository, existing, input)
    if (result) return result
  }

  try {
    const created = await repository.createEvent(input)
    return {
      status: 'created',
      eventId: created.id,
    }
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
