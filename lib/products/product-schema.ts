import { z } from 'zod'
import { ProductType } from '@/app/generated/prisma/client'
import { PRODUCT_CATEGORY_NAME_MAX_LENGTH } from '@/lib/products/categories'
import { toIsoCountryCode } from '@/lib/countries'

// Product create/update form schema. Kept in a plain module (NOT the 'use server' action file) so it can be
// exported and unit-tested — a 'use server' module may only export async functions (Next.js server-boundary
// rule, which `tsc` does not catch but `next build` fails on).
export const productSchema = z.object({
  sku: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  categoryName: z.string().max(PRODUCT_CATEGORY_NAME_MAX_LENGTH).optional().nullable(),
  description: z.string().optional(),
  type: z.nativeEnum(ProductType),
  parentId: z.string().optional().nullable(),
  preferredSupplierId: z.string().optional().nullable(),
  preferredSupplierLocked: z.boolean().default(false),
  barcode: z.string().optional().nullable(),
  mpn: z.string().max(100).optional().nullable(),
  hsCode: z.string().optional().nullable(),
  // bhdm.7: the dropdown is not a trust boundary (FormData is client-controlled). Normalise + validate here:
  // blank -> null, a recognised country (name/alias/code) -> canonical uppercase ISO-2, and a nonblank
  // unrecognised or reserved value (EU/ZZ/!!) is rejected rather than stored verbatim and forwarded to the WMS.
  countryOfOrigin: z.string().max(64).optional().nullable().transform((value, ctx) => {
    if (value == null) return null
    const trimmed = value.trim()
    if (trimmed === '') return null
    const iso = toIsoCountryCode(trimmed)
    if (!iso) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unrecognised country of origin "${trimmed}"` })
      return z.NEVER
    }
    return iso
  }),
  customsDescription: z.string().optional().nullable(),
  weight: z.string().optional().nullable(),
  salesPriceBase: z.string().optional().nullable(),
  salePriceBase: z.string().optional().nullable(),
  salesPriceTaxInclusive: z.boolean().default(false),
  taxCategory: z.enum(['STANDARD', 'REDUCED', 'SECOND_REDUCED', 'ZERO', 'EXEMPT']).default('STANDARD'),
  stockUnit: z.string().default('pcs'),
  oversellAllowed: z.boolean().default(true),
  imageUrl: z.string().optional().nullable(),
  widthCm: z.string().optional().nullable(),
  heightCm: z.string().optional().nullable(),
  depthCm: z.string().optional().nullable(),
  active: z.boolean().default(true),
  lifecycleStatus: z.enum(['DRAFT', 'ACTIVE', 'EOL', 'ARCHIVED']).default('ACTIVE'),
  leadTimeDays: z.string().optional().nullable(),
})
