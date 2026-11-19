/**
 * COMPANY GROUP lookup (CRM foundation): the OTHER customers that belong to the same company as a customer. Read-only; the keys and their rules are in
 * company-key.ts. The SQL below only finds candidates; every candidate is re-checked in TypeScript with `sameCompany`, so the two can only disagree by
 * missing an exotic spelling, never by joining a wrong company.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { companyKeys, sameCompany } from '@/lib/domain/crm/company-key'

export const COMPANY_GROUP_LIMIT = 50

export interface CompanyPeer {
  id: string
  fullName: string
  email: string | null
  company: string | null
}

export interface CompanyGroup {
  /** The keys the customer is grouped by: shown so an operator can see WHY two customers are grouped. */
  nameKey: string | null
  domain: string | null
  peers: CompanyPeer[]
  /** True when more than COMPANY_GROUP_LIMIT customers matched. */
  truncated: boolean
}

type Reader = Pick<Prisma.TransactionClient, '$queryRaw' | 'customer'>

const COMPANY_NAME_KEY_SQL = Prisma.sql`lower(btrim(regexp_replace(replace(replace("company", '.', ''), ',', ''), '\\s+', ' ', 'g')))`

export async function loadCompanyGroup(db: Reader, customerId: string, excludeIds: string[]): Promise<CompanyGroup> {
  const self = await db.customer.findUnique({ where: { id: customerId }, select: { company: true, email: true, gdprAnonymisedAt: true } })
  if (!self || self.gdprAnonymisedAt) return { nameKey: null, domain: null, peers: [], truncated: false }
  const keys = companyKeys(self)
  if (keys.nameKey === null && keys.domain === null) return { ...keys, peers: [], truncated: false }
  const exclude = [...new Set([customerId, ...excludeIds])]
  const candidates = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "customers"
    WHERE "gdprAnonymisedAt" IS NULL AND "id" NOT IN (${Prisma.join(exclude)})
      AND (
        (${keys.nameKey}::text IS NOT NULL AND "company" IS NOT NULL AND ${COMPANY_NAME_KEY_SQL} = ${keys.nameKey}::text)
        OR (${keys.domain}::text IS NOT NULL AND "email" IS NOT NULL AND lower(split_part(btrim("email"), '@', 2)) = ${keys.domain}::text)
      )
    ORDER BY "id"
    LIMIT ${COMPANY_GROUP_LIMIT * 4 + 1}`
  const rows = candidates.length === 0 ? [] : await db.customer.findMany({
    where: { id: { in: candidates.map((c) => c.id) }, gdprAnonymisedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true, company: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
  })
  const matching = rows.filter((r) => sameCompany(keys, companyKeys(r)))
  return {
    ...keys,
    peers: matching.slice(0, COMPANY_GROUP_LIMIT).map((r) => ({ id: r.id, fullName: `${r.firstName} ${r.lastName}`.trim(), email: r.email, company: r.company })),
    truncated: matching.length > COMPANY_GROUP_LIMIT || candidates.length > COMPANY_GROUP_LIMIT * 4,
  }
}
