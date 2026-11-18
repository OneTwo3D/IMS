import { handleUpload } from '@/lib/order-attachment-routes'

export const runtime = 'nodejs'

export async function POST(req: Request, { params }: { params: Promise<{ kind: string; orderId: string }> }) {
  return handleUpload(req, await params)
}
