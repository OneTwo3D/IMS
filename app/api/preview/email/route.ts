import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getBranding } from '@/lib/pdf'
import { renderEmailHtml, getSampleEmailData, type EmailTemplateType } from '@/lib/email-template'

const VALID_TYPES: EmailTemplateType[] = ['invoice', 'sales_order', 'purchase_order', 'rfq', 'credit_note', 'packing_slip', 'manufacturing_order']

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const type = req.nextUrl.searchParams.get('type') as EmailTemplateType | null
  if (!type || !VALID_TYPES.includes(type)) return NextResponse.json({ error: 'Invalid type' }, { status: 400 })

  const branding = await getBranding()
  const sampleData = getSampleEmailData(type)
  const html = await renderEmailHtml(branding, sampleData, type)

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    },
  })
}
