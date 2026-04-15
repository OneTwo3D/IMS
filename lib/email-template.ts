import { db } from '@/lib/db'
import type { Branding } from '@/lib/pdf'

export type EmailTemplateType = 'invoice' | 'sales_order' | 'purchase_order' | 'rfq' | 'credit_note' | 'packing_slip' | 'manufacturing_order'

type EmailData = {
  recipientName: string
  recipientEmail: string
  reference: string
  date: string
  subject: string
  bodyLines: string[]
  ctaLabel?: string
  ctaUrl?: string
}

const SAMPLE_DATA: Record<EmailTemplateType, EmailData> = {
  invoice: {
    recipientName: 'John Smith',
    recipientEmail: 'john@acme-mfg.co.uk',
    reference: 'INV-2026-00042',
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    subject: 'Invoice INV-2026-00042',
    bodyLines: [
      'Please find attached your invoice INV-2026-00042 for £629.40.',
      'Payment is due within 30 days of the invoice date.',
      'If you have any questions regarding this invoice, please don\'t hesitate to contact us.',
    ],
  },
  sales_order: {
    recipientName: 'John Smith',
    recipientEmail: 'john@acme-mfg.co.uk',
    reference: 'SO-2026-00107',
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    subject: 'Order Confirmation SO-2026-00107',
    bodyLines: [
      'Thank you for your order SO-2026-00107.',
      'We\'re processing your order and will notify you once it has been dispatched.',
      'Your order total is £533.49.',
    ],
  },
  purchase_order: {
    recipientName: 'Supplier Team',
    recipientEmail: 'orders@filament-supplies.de',
    reference: 'PO-20260405-X7K2',
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    subject: 'Purchase Order PO-20260405-X7K2',
    bodyLines: [
      'Please find attached our purchase order PO-20260405-X7K2.',
      'Please confirm receipt and expected delivery date at your earliest convenience.',
    ],
  },
  rfq: {
    recipientName: 'Sales Team',
    recipientEmail: 'sales@filament-supplies.de',
    reference: 'RFQ-20260405-R3Q1',
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    subject: 'Request for Quotation',
    bodyLines: [
      'Please find attached our request for quotation.',
      'We would appreciate your best pricing, lead time, and shipping costs for the items listed.',
      'Please respond within 5 business days.',
    ],
  },
  credit_note: {
    recipientName: 'John Smith',
    recipientEmail: 'john@acme-mfg.co.uk',
    reference: 'CN-2026-00003',
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    subject: 'Credit Note CN-2026-00003',
    bodyLines: [
      'Please find attached credit note CN-2026-00003 for £284.85.',
      'This credit has been applied to your account.',
    ],
  },
  packing_slip: {
    recipientName: 'Warehouse',
    recipientEmail: 'warehouse@acme-mfg.co.uk',
    reference: 'SO-2026-00107',
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    subject: 'Packing Slip for SO-2026-00107',
    bodyLines: [
      'The packing slip for order SO-2026-00107 is attached.',
    ],
  },
  manufacturing_order: {
    recipientName: 'Production Team',
    recipientEmail: 'production@acme-mfg.co.uk',
    reference: 'MO-20260405-X7K2',
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    subject: 'Manufacturing Order MO-20260405-X7K2',
    bodyLines: [
      'Please find attached manufacturing order MO-20260405-X7K2.',
      'This order is for the assembly of 50 units of PLA Filament Black 1kg.',
      'Please confirm receipt and provide an estimated completion date.',
    ],
  },
}

export function getSampleEmailData(type: EmailTemplateType): EmailData {
  return SAMPLE_DATA[type]
}

export async function renderEmailHtml(
  branding: Branding,
  data: EmailData,
  templateType?: EmailTemplateType,
): Promise<string> {
  // Fetch document template for custom notes
  let tpl: { headerNote: string | null; footerNote: string | null } | null = null
  if (templateType) {
    tpl = await db.documentTemplate.findUnique({
      where: { type: templateType },
      select: { headerNote: true, footerNote: true },
    })
  }

  // Fetch email settings for from name
  const fromSetting = await db.setting.findUnique({ where: { key: 'email_from_name' } })
  const fromName = fromSetting?.value || branding.companyName

  const logoHtml = branding.documentLogoUrl
    ? `<img src="${process.env.NEXT_PUBLIC_APP_URL}${branding.documentLogoUrl}" alt="${branding.companyName}" style="max-height:50px;max-width:200px;margin-bottom:16px;" />`
    : branding.logoUrl
      ? `<img src="${process.env.NEXT_PUBLIC_APP_URL}${branding.logoUrl}" alt="${branding.companyName}" style="max-height:40px;max-width:40px;margin-bottom:16px;" />`
      : ''

  const bodyHtml = data.bodyLines.map((l) => `<p style="margin:0 0 12px;color:#333;font-size:15px;line-height:1.5;">${escapeHtml(l)}</p>`).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

<!-- Header -->
<tr><td style="background:${branding.primaryColor};padding:24px 32px;">
  ${logoHtml ? `<div style="margin-bottom:8px;">${logoHtml}</div>` : ''}
  <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">${escapeHtml(data.subject)}</h1>
  <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Ref: ${escapeHtml(data.reference)} &middot; ${escapeHtml(data.date)}</p>
</td></tr>

<!-- Body -->
<tr><td style="padding:32px;">
  <p style="margin:0 0 16px;color:#333;font-size:15px;">Dear ${escapeHtml(data.recipientName)},</p>
  ${tpl?.headerNote ? `<div style="background:#f8f9fa;border-left:3px solid ${branding.accentColor};padding:12px 16px;margin:0 0 20px;border-radius:0 4px 4px 0;"><p style="margin:0;color:#555;font-size:14px;">${escapeHtml(tpl.headerNote)}</p></div>` : ''}
  ${bodyHtml}
  <p style="margin:0 0 12px;color:#333;font-size:15px;">The document is attached to this email as a PDF.</p>
  ${tpl?.footerNote ? `<div style="border-top:1px solid #eee;padding-top:16px;margin-top:20px;"><p style="margin:0;color:#888;font-size:13px;">${escapeHtml(tpl.footerNote)}</p></div>` : ''}
  <p style="margin:24px 0 0;color:#333;font-size:15px;">Kind regards,<br/><strong>${escapeHtml(fromName)}</strong></p>
</td></tr>

<!-- Footer -->
<tr><td style="background:#f8f9fa;padding:20px 32px;border-top:1px solid #eee;">
  <p style="margin:0;color:#888;font-size:12px;text-align:center;">
    ${escapeHtml(branding.companyName)}${branding.address ? ` &middot; ${escapeHtml(branding.address.replace(/\n/g, ', '))}` : ''}
    ${branding.vatNumber ? `<br/>VAT: ${escapeHtml(branding.vatNumber)}` : ''}
    ${branding.phone ? ` &middot; ${escapeHtml(branding.phone)}` : ''}
    ${branding.email ? ` &middot; ${escapeHtml(branding.email)}` : ''}
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
