/**
 * Customer identity email key (CRM foundation). Pure functions, no I/O.
 *
 * `normaliseIdentityEmail` is the STRICT key: NFC, trim, lower-case the whole address. Two customers with the same strict key are the
 * same person unless they carry different WooCommerce ids or are anonymised (that rule lives in the resolver, not here).
 *
 * `looseIdentityEmail` additionally folds plus-tags and gmail dots. It is for SUGGESTIONS only and must never merge anything on its own.
 */
import { isPlaceholderEmail } from '@/lib/connectors/woocommerce/sync/anonymisation'

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

/** The identity key of an email address, or null when it is empty, malformed (not exactly one `@`, internal whitespace) or a placeholder. */
export function normaliseIdentityEmail(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null
  const key = input.normalize('NFC').trim().toLowerCase()
  if (key === '') return null
  if (/\s/u.test(key)) return null
  const parts = key.split('@')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null
  if (isPlaceholderEmail(key)) return null
  return key
}

/** The identity key with a `+tag` dropped from the local part; for gmail.com/googlemail.com also dots dropped and the domain folded to gmail.com. */
export function looseIdentityEmail(input: string | null | undefined): string | null {
  const key = normaliseIdentityEmail(input)
  if (key === null) return null
  const [rawLocal, domain] = key.split('@') as [string, string]
  let local = rawLocal.split('+')[0]!
  let outDomain = domain
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '')
    outDomain = 'gmail.com'
  }
  if (local === '') return null
  return `${local}@${outDomain}`
}
