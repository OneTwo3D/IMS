import { Prisma } from '@/app/generated/prisma/client'

export function isIdempotencyKeyUniqueError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
  const target = error.meta?.target
  return Array.isArray(target)
    ? target.includes('idempotencyKey')
    : String(target).includes('idempotencyKey')
}
