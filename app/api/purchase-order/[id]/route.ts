import { NextResponse } from 'next/server'
import { requireApiAuth, type AuthSession } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { buildPurchaseOrderPdf } from '@/lib/purchase-order-pdf'

type PoPdfRouteDependencies = {
  authorize: () => Promise<AuthSession | NextResponse>
  hasPermission: typeof hasPermission
  buildPdf: (id: string) => Promise<{ buffer: Buffer; reference: string } | null>
}

const defaultDependencies: PoPdfRouteDependencies = {
  authorize: requireApiAuth,
  hasPermission,
  buildPdf: buildPurchaseOrderPdf,
}

/** The priced purchase order PDF. Buyers only: it carries our costs, so supplier-portal users (who may read the RFQ) are refused. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handlePurchaseOrderPdfGet(await params)
}

/** @internal Exported for tests; production callers use the route GET handler. */
export async function handlePurchaseOrderPdfGet(
  params: { id: string },
  overrides: Partial<PoPdfRouteDependencies> = {},
) {
  const deps = { ...defaultDependencies, ...overrides }
  const session = await deps.authorize()
  if (session instanceof NextResponse) return session
  if (!deps.hasPermission(session.user.role, 'purchasing')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const pdf = await deps.buildPdf(params.id)
  if (!pdf) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return new NextResponse(new Uint8Array(pdf.buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="PO-${pdf.reference}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
}
