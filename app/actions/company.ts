'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth } from '@/lib/auth/server'

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
  await requireAuth()
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
  await requireAuth()
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
  await requireAuth()
  await db.organisation.updateMany({ data: { logoUrl } })
  logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: logoUrl ? 'Updated company logo' : 'Removed company logo' })
  revalidatePath('/settings')
  revalidatePath('/settings/company')
  return { success: true }
}

// ---------------------------------------------------------------------------
// Numbering Formats
// ---------------------------------------------------------------------------
//
// These are the single source of truth for all document number prefixes used
// across the system. Consumers (sales orders, purchase orders, invoices,
// credit notes, WooCommerce sync) read these keys directly from the Setting
// table so the same values apply everywhere.
//
// DB keys are stored flat (no 'numbering_' prefix) to make consumption simple.

export type NumberingFormats = {
  so_prefix: string       // Manual IMS sales order references
  po_prefix: string       // Purchase order references
  inv_prefix: string      // Manual invoice numbers (accounting connector)
  wc_order_prefix: string // Prepended to WooCommerce order numbers in IMS
  wc_inv_prefix: string   // WooCommerce invoice numbers (accounting connector)
  cn_prefix: string       // Credit note numbers
}

const NUMBERING_DEFAULTS: NumberingFormats = {
  so_prefix: 'SO-',
  po_prefix: 'PO-',
  inv_prefix: 'INV-',
  wc_order_prefix: '',
  wc_inv_prefix: 'INWC-',
  cn_prefix: 'CN-',
}

/**
 * Legacy key migration map. If a new flat key is absent but an old key is
 * present, we transparently read the old value so upgrading deployments keep
 * their existing prefixes until the user next saves the Numbering tab.
 */
const LEGACY_KEY_MAP: Record<keyof NumberingFormats, string[]> = {
  so_prefix: ['numbering_so_prefix'],
  po_prefix: ['numbering_po_prefix'],
  inv_prefix: ['numbering_inv_prefix', 'manual_invoice_prefix'],
  wc_order_prefix: ['order_number_prefix'],
  wc_inv_prefix: ['wc_invoice_prefix'],
  cn_prefix: ['numbering_cn_prefix'],
}

export async function getNumberingFormats(): Promise<NumberingFormats> {
  await requireAuth()
  const keys: string[] = [
    ...(Object.keys(NUMBERING_DEFAULTS) as (keyof NumberingFormats)[]),
    ...Object.values(LEGACY_KEY_MAP).flat(),
  ]
  const rows = await db.setting.findMany({ where: { key: { in: keys } } })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const result = { ...NUMBERING_DEFAULTS }
  for (const k of Object.keys(result) as (keyof NumberingFormats)[]) {
    const direct = map.get(k)
    if (direct !== undefined) {
      result[k] = direct
      continue
    }
    for (const legacy of LEGACY_KEY_MAP[k]) {
      const v = map.get(legacy)
      if (v !== undefined) { result[k] = v; break }
    }
  }
  return result
}

export async function saveNumberingFormats(data: NumberingFormats): Promise<{ success: boolean }> {
  await requireAuth()
  const ops = Object.entries(data).map(([k, v]) =>
    db.setting.upsert({
      where: { key: k },
      create: { key: k, value: v },
      update: { value: v },
    }),
  )
  await db.$transaction(ops)
  logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: 'Updated document numbering formats' })
  revalidatePath('/settings/company')
  revalidatePath('/sync')
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
  await requireAuth()
  const keys = Object.keys(EMAIL_DEFAULTS).map((k) => `email_${k}`)
  const rows = await db.setting.findMany({ where: { key: { in: keys } } })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const result = { ...EMAIL_DEFAULTS }
  for (const k of Object.keys(result) as (keyof EmailSettings)[]) {
    const v = map.get(`email_${k}`)
    if (v) result[k] = v
  }
  if (result.smtp_pass) {
    result.smtp_pass = result.smtp_pass.slice(0, 3) + '***'
  }
  return result
}

export async function saveEmailSettings(data: EmailSettings): Promise<{ success: boolean }> {
  await requireAuth()
  const ops = Object.entries(data)
    .filter(([k, v]) => !(k === 'smtp_pass' && v.endsWith('***')))
    .map(([k, v]) =>
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
  await requireAuth()
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
  await requireAuth()
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
  await requireAuth()
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
  await requireAuth()
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
