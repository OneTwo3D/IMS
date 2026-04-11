'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'

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
  await requirePermission('settings.company')
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
  await requirePermission('settings.company')
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
// Single source of truth for all document number prefixes used across the
// system. Consumers (sales orders, purchase orders, invoices, credit notes,
// and each shopping connector's order import) read these keys directly from
// the Setting table, so the same values apply everywhere.
//
// The structure splits into:
//   - Core prefixes: SO, PO, Invoice, Credit Note (always present)
//   - Connector prefixes: one { orderPrefix, invPrefix } pair per supported
//     shopping connector. Declared in lib/connectors/shopping-registry.ts.

import { SHOPPING_CONNECTORS, type ShoppingConnectorId } from '@/lib/connectors/shopping-registry'

type CoreNumberingKey = 'so_prefix' | 'po_prefix' | 'inv_prefix' | 'cn_prefix'

export type NumberingFormats = {
  so_prefix: string   // Manual IMS sales order references
  po_prefix: string   // Purchase order references
  inv_prefix: string  // Manual invoice numbers (accounting connector)
  cn_prefix: string   // Credit note numbers
  connectors: Record<string, { orderPrefix: string; invPrefix: string }>
}

const CORE_DEFAULTS: Record<CoreNumberingKey, string> = {
  so_prefix: 'SO-',
  po_prefix: 'PO-',
  inv_prefix: 'INV-',
  cn_prefix: 'CN-',
}

/** Legacy Setting keys we transparently read as fallbacks during migration. */
const CORE_LEGACY_KEYS: Record<CoreNumberingKey, string[]> = {
  so_prefix: ['numbering_so_prefix'],
  po_prefix: ['numbering_po_prefix'],
  inv_prefix: ['numbering_inv_prefix', 'manual_invoice_prefix'],
  cn_prefix: ['numbering_cn_prefix'],
}

export async function getNumberingFormats(): Promise<NumberingFormats> {
  await requireAuth()

  const connectorKeys = SHOPPING_CONNECTORS.flatMap((c) => [
    c.orderKey, c.invKey,
    ...(c.legacyOrderKeys ?? []), ...(c.legacyInvKeys ?? []),
  ])
  const keys: string[] = [
    ...(Object.keys(CORE_DEFAULTS) as CoreNumberingKey[]),
    ...Object.values(CORE_LEGACY_KEYS).flat(),
    ...connectorKeys,
  ]
  const rows = await db.setting.findMany({ where: { key: { in: keys } } })
  const map = new Map(rows.map((r) => [r.key, r.value]))

  // Resolve core prefixes with legacy fallback
  const core: Record<CoreNumberingKey, string> = { ...CORE_DEFAULTS }
  for (const k of Object.keys(CORE_DEFAULTS) as CoreNumberingKey[]) {
    const direct = map.get(k)
    if (direct !== undefined) { core[k] = direct; continue }
    for (const legacy of CORE_LEGACY_KEYS[k]) {
      const v = map.get(legacy)
      if (v !== undefined) { core[k] = v; break }
    }
  }

  // Resolve connector prefixes with legacy fallback
  const connectors: Record<string, { orderPrefix: string; invPrefix: string }> = {}
  for (const c of SHOPPING_CONNECTORS) {
    const orderPrefix =
      map.get(c.orderKey)
      ?? c.legacyOrderKeys?.map((k) => map.get(k)).find((v) => v !== undefined)
      ?? c.defaultOrder
    const invPrefix =
      map.get(c.invKey)
      ?? c.legacyInvKeys?.map((k) => map.get(k)).find((v) => v !== undefined)
      ?? c.defaultInv
    connectors[c.id] = { orderPrefix, invPrefix }
  }

  return { ...core, connectors }
}

export async function saveNumberingFormats(data: NumberingFormats): Promise<{ success: boolean }> {
  await requirePermission('settings.company')

  const writes: Array<{ key: string; value: string }> = [
    { key: 'so_prefix', value: data.so_prefix },
    { key: 'po_prefix', value: data.po_prefix },
    { key: 'inv_prefix', value: data.inv_prefix },
    { key: 'cn_prefix', value: data.cn_prefix },
  ]

  for (const c of SHOPPING_CONNECTORS) {
    const cp = data.connectors[c.id]
    if (!cp) continue
    writes.push({ key: c.orderKey, value: cp.orderPrefix })
    writes.push({ key: c.invKey, value: cp.invPrefix })
  }

  const ops = writes.map((w) =>
    db.setting.upsert({ where: { key: w.key }, create: { key: w.key, value: w.value }, update: { value: w.value } }),
  )
  await db.$transaction(ops)
  logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: 'Updated document numbering formats' })
  revalidatePath('/settings/company')
  revalidatePath('/sync')
  return { success: true }
}

// Re-export so client components can consume the registry via the server action module boundary
export async function getShoppingConnectors(): Promise<
  Array<{ id: ShoppingConnectorId; label: string; available: boolean }>
> {
  return SHOPPING_CONNECTORS.map((c) => ({ id: c.id, label: c.label, available: c.available }))
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
  await requirePermission('settings.company')
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
  await requirePermission('settings.company')
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
  await requirePermission('settings.company')
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
