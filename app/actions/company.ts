'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------

export type OrganisationData = {
  name: string
  legalName: string | null
  vatNumber: string | null
  companyNumber: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  county: string | null
  postcode: string | null
  country: string
  phone: string | null
  email: string | null
  website: string | null
  logoUrl: string | null
  documentLogoUrl: string | null
}

export async function getOrganisation(): Promise<OrganisationData> {
  const org = await db.organisation.findFirst()
  return {
    name: org?.name ?? '',
    legalName: org?.legalName ?? null,
    vatNumber: org?.vatNumber ?? null,
    companyNumber: org?.companyNumber ?? null,
    addressLine1: org?.addressLine1 ?? null,
    addressLine2: org?.addressLine2 ?? null,
    city: org?.city ?? null,
    county: org?.county ?? null,
    postcode: org?.postcode ?? null,
    country: org?.country ?? 'GB',
    phone: org?.phone ?? null,
    email: org?.email ?? null,
    website: org?.website ?? null,
    logoUrl: org?.logoUrl ?? null,
    documentLogoUrl: org?.documentLogoUrl ?? null,
  }
}

export async function updateOrganisation(data: Partial<OrganisationData>): Promise<{ success: boolean; error?: string }> {
  try {
    await db.organisation.updateMany({ data })
    logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: 'Updated company details' })
    revalidatePath('/settings')
    revalidatePath('/settings/company')
    return { success: true }
  } catch (e) {
    logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to update company details: ${e}` })
    return { success: false, error: 'Failed to update company details.' }
  }
}

export async function updateLogoUrl(logoUrl: string | null): Promise<{ success: boolean }> {
  await db.organisation.updateMany({ data: { logoUrl } })
  logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: logoUrl ? 'Updated company logo' : 'Removed company logo' })
  revalidatePath('/settings')
  revalidatePath('/settings/company')
  return { success: true }
}

// ---------------------------------------------------------------------------
// Numbering Formats
// ---------------------------------------------------------------------------

export type NumberingFormats = {
  so_prefix: string
  so_padding: string
  po_prefix: string
  po_padding: string
  inv_prefix: string
  inv_padding: string
  cn_prefix: string
  cn_padding: string
}

const NUMBERING_DEFAULTS: NumberingFormats = {
  so_prefix: 'SO-',
  so_padding: '5',
  po_prefix: 'PO-',
  po_padding: '5',
  inv_prefix: 'INV-',
  inv_padding: '5',
  cn_prefix: 'CN-',
  cn_padding: '5',
}

export async function getNumberingFormats(): Promise<NumberingFormats> {
  const keys = Object.keys(NUMBERING_DEFAULTS).map((k) => `numbering_${k}`)
  const rows = await db.setting.findMany({ where: { key: { in: keys } } })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const result = { ...NUMBERING_DEFAULTS }
  for (const k of Object.keys(result) as (keyof NumberingFormats)[]) {
    const v = map.get(`numbering_${k}`)
    if (v) result[k] = v
  }
  return result
}

export async function saveNumberingFormats(data: NumberingFormats): Promise<{ success: boolean }> {
  const ops = Object.entries(data).map(([k, v]) =>
    db.setting.upsert({
      where: { key: `numbering_${k}` },
      create: { key: `numbering_${k}`, value: v },
      update: { value: v },
    }),
  )
  await db.$transaction(ops)
  logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: 'Updated document numbering formats' })
  revalidatePath('/settings/company')
  return { success: true }
}

// ---------------------------------------------------------------------------
// Email / SMTP settings
// ---------------------------------------------------------------------------

export type EmailSettings = {
  smtp_host: string
  smtp_port: string
  smtp_user: string
  smtp_pass: string
  smtp_secure: string
  from_name: string
  from_email: string
  reply_to: string
  sales_email: string
  purchases_email: string
  support_email: string
}

const EMAIL_DEFAULTS: EmailSettings = {
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_pass: '',
  smtp_secure: 'tls',
  from_name: '',
  from_email: '',
  reply_to: '',
  sales_email: '',
  purchases_email: '',
  support_email: '',
}

export async function getEmailSettings(): Promise<EmailSettings> {
  const keys = Object.keys(EMAIL_DEFAULTS).map((k) => `email_${k}`)
  const rows = await db.setting.findMany({ where: { key: { in: keys } } })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const result = { ...EMAIL_DEFAULTS }
  for (const k of Object.keys(result) as (keyof EmailSettings)[]) {
    const v = map.get(`email_${k}`)
    if (v) result[k] = v
  }
  return result
}

export async function saveEmailSettings(data: EmailSettings): Promise<{ success: boolean }> {
  const ops = Object.entries(data).map(([k, v]) =>
    db.setting.upsert({
      where: { key: `email_${k}` },
      create: { key: `email_${k}`, value: v },
      update: { value: v },
    }),
  )
  await db.$transaction(ops)
  logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: 'Updated email/SMTP settings' })
  revalidatePath('/settings/company')
  return { success: true }
}

// ---------------------------------------------------------------------------
// Branding colours
// ---------------------------------------------------------------------------

export type BrandingColours = {
  primaryColor: string
  accentColor: string
}

export async function getBrandingColours(): Promise<BrandingColours> {
  const [p, a] = await Promise.all([
    db.setting.findUnique({ where: { key: 'brand_primary_color' } }),
    db.setting.findUnique({ where: { key: 'brand_accent_color' } }),
  ])
  return {
    primaryColor: p?.value ?? '#1a1a2e',
    accentColor: a?.value ?? '#0f4c81',
  }
}

export async function saveBrandingColours(data: BrandingColours): Promise<{ success: boolean }> {
  await db.$transaction([
    db.setting.upsert({ where: { key: 'brand_primary_color' }, create: { key: 'brand_primary_color', value: data.primaryColor }, update: { value: data.primaryColor } }),
    db.setting.upsert({ where: { key: 'brand_accent_color' }, create: { key: 'brand_accent_color', value: data.accentColor }, update: { value: data.accentColor } }),
  ])
  logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: 'Updated branding colours' })
  revalidatePath('/settings/company')
  return { success: true }
}

// ---------------------------------------------------------------------------
// Document Templates
// ---------------------------------------------------------------------------

export type DocumentTemplateData = {
  id?: string
  type: string
  headerNote: string
  footerNote: string
  termsText: string
  customFooter: string
  showLogo: boolean
  showVat: boolean
  showPaymentTerms: boolean
  paymentTermsText: string
}

const TEMPLATE_TYPES = ['sales_order', 'purchase_order', 'invoice', 'packing_slip', 'credit_note', 'rfq', 'manufacturing_order']

export async function getDocumentTemplates(): Promise<DocumentTemplateData[]> {
  const rows = await db.documentTemplate.findMany({ orderBy: { type: 'asc' } })
  const map = new Map(rows.map((r) => [r.type, r]))

  return TEMPLATE_TYPES.map((type) => {
    const r = map.get(type)
    return {
      id: r?.id,
      type,
      headerNote: r?.headerNote ?? '',
      footerNote: r?.footerNote ?? '',
      termsText: r?.termsText ?? '',
      customFooter: r?.customFooter ?? '',
      showLogo: r?.showLogo ?? true,
      showVat: r?.showVat ?? true,
      showPaymentTerms: r?.showPaymentTerms ?? false,
      paymentTermsText: r?.paymentTermsText ?? '',
    }
  })
}

export async function saveDocumentTemplate(data: DocumentTemplateData): Promise<{ success: boolean; error?: string }> {
  try {
    await db.documentTemplate.upsert({
      where: { type: data.type },
      create: {
        type: data.type,
        headerNote: data.headerNote || null,
        footerNote: data.footerNote || null,
        termsText: data.termsText || null,
        customFooter: data.customFooter || null,
        showLogo: data.showLogo,
        showVat: data.showVat,
        showPaymentTerms: data.showPaymentTerms,
        paymentTermsText: data.paymentTermsText || null,
      },
      update: {
        headerNote: data.headerNote || null,
        footerNote: data.footerNote || null,
        termsText: data.termsText || null,
        customFooter: data.customFooter || null,
        showLogo: data.showLogo,
        showVat: data.showVat,
        showPaymentTerms: data.showPaymentTerms,
        paymentTermsText: data.paymentTermsText || null,
      },
    })
    const label = data.type.replace(/_/g, ' ')
    logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: `Updated ${label} document template` })
    revalidatePath('/settings/company')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
