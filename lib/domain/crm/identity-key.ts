/**
 * Customer identity email key (CRM foundation). Pure functions, no I/O.
 *
 * `normaliseIdentityEmail` is the STRICT key: NFC, trim (every Unicode white-space character), ASCII lower-case. `looseIdentityEmail` additionally folds a
 * `+tag` and, for gmail.com / googlemail.com, dots. The cluster resolver (lib/domain/crm/cluster-resolver.ts) JOINS two customers whose LOOSE keys are equal
 * (owner decisions 2026-11-18 and 2026-11-19: the folded forms are aliases of one mailbox, so they are one person, whatever storefront ids they carry;
 * an operator UNMERGE overrides). The strict key is used by reports and the company-domain key.
 *
 * LOWER-CASING IS ASCII ONLY, on purpose. The database finds candidates with the SQL twin of this fold (function crm_loose_identity_key, migration
 * 20261119140100), and PostgreSQL's lower() under the "C" collation is ASCII only and byte-deterministic; a Unicode lower-case here would make the two
 * disagree for a non-ASCII address and an erasure could miss a record. Everything else (NFC, white space, the folds) is identical on both sides, and
 * tests/db/crm-identity.test.ts holds them to the same answers. Domain names that carry non-ASCII letters travel as punycode (ASCII), so this loses nothing in
 * practice.
 */
import { isPlaceholderEmail } from '@/lib/connectors/woocommerce/sync/anonymisation'

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

/** The identity key of an email address, or null when it is empty, malformed (not exactly one `@`, internal whitespace) or a placeholder. */
export function normaliseIdentityEmail(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null
  const key = input.normalize('NFC').trim().replace(/[A-Z]/g, (ch) => ch.toLowerCase())
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
