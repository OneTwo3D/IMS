import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { getBranding } from '@/lib/pdf'
import { renderEmailHtml, getSampleEmailData, type EmailTemplateType } from '@/lib/email-template'

const VALID_TYPES: EmailTemplateType[] = ['invoice', 'sales_order', 'purchase_order', 'rfq', 'credit_note', 'packing_slip', 'manufacturing_order']

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'settings')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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
