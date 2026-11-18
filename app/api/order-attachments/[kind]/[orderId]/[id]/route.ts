import { handleDelete, handleDownload } from '@/lib/order-attachment-routes'

export const runtime = 'nodejs'

export async function GET(req: Request, { params }: { params: Promise<{ kind: string; orderId: string; id: string }> }) {
  return handleDownload(req, await params)
}

export async function DELETE(req: Request, { params }: { params: Promise<{ kind: string; orderId: string; id: string }> }) {
  return handleDelete(req, await params)
}
