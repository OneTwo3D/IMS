import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { csvResponse, toCsv } from '@/lib/csv'
import { hasPermission } from '@/lib/permissions'

const HEADERS = ['timestamp', 'warehouseCode', 'sku', 'productName', 'imsBefore', 'wmsQty', 'imsAfter', 'delta', 'action', 'reason']

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const session = await auth()
  if (!session?.user) return new Response('Unauthorized', { status: 401 })
  if (!hasPermission(session.user.role, 'sync')) return new Response('Forbidden', { status: 403 })

  const { jobId } = await context.params

  const job = await db.wmsSyncJob.findFirst({
    where: {
      id: jobId,
      connector: 'mintsoft',
    },
    select: {
      id: true,
      startedAt: true,
      warehouse: {
        select: {
          code: true,
        },
      },
      lines: {
        orderBy: { id: 'asc' },
        select: {
          sku: true,
          imsQtyBefore: true,
          wmsQty: true,
          imsQtyAfter: true,
          delta: true,
          action: true,
          reason: true,
          product: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  })

  if (!job) {
    return new Response('Not found', { status: 404 })
  }

  const rows = job.lines.map((line) => ({
    timestamp: job.startedAt.toISOString(),
    warehouseCode: job.warehouse?.code ?? '',
    sku: line.sku ?? '',
    productName: line.product?.name ?? '',
    imsBefore: line.imsQtyBefore?.toString() ?? '',
    wmsQty: line.wmsQty?.toString() ?? '',
    imsAfter: line.imsQtyAfter?.toString() ?? '',
    delta: line.delta?.toString() ?? '',
    action: line.action,
    reason: line.reason ?? '',
  }))

  return csvResponse(toCsv(rows, HEADERS), `mintsoft-sync-${job.id}.csv`)
}
