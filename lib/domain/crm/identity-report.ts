/**
 * Read-only customer identity report (CRM foundation). COUNTS ONLY: nothing returned here is an email, a name or any other personal data.
 *
 * `buildCustomerIdentityReport` runs every query inside the transaction it is given and never writes. The caller (scripts/report-customer-identity.ts)
 * opens that transaction REPEATABLE READ and READ ONLY; this module sets READ ONLY again as its first statement so a caller that forgets cannot write.
 */
import { looseIdentityEmail, normaliseIdentityEmail } from '@/lib/domain/crm/identity-key'
import type { ClusterCustomer } from '@/lib/domain/crm/cluster-resolver'

/** The sample of clusters the report lists (ids only). */
export const SAMPLE_CLUSTER_COUNT = 10
export const SAMPLE_CLUSTER_MAX_IDS = 20

export const IDENTITY_REPORT_BATCH = 1000

export interface IdentityReportTx {
  $executeRawUnsafe(sql: string): Promise<unknown>
  customer: {
    findMany(args: {
      take: number
      skip?: number
      cursor?: { id: string }
      orderBy: { id: 'asc' }
      select: {
        id: true
        email: true
        externalCustomerId: true
        gdprAnonymisedAt: true
        shoppingLinks: { where: { connector: string }; select: { externalCustomerId: true } }
      }
    }): Promise<
      Array<{
        id: string
        email: string | null
        externalCustomerId: number | null
        gdprAnonymisedAt: Date | null
        shoppingLinks: Array<{ externalCustomerId: string }>
      }>
    >
  }
  salesOrder: {
    findMany(args: {
      where: { customerId: null }
      take: number
      skip?: number
      cursor?: { id: string }
      orderBy: { id: 'asc' }
      select: { id: true; customerEmail: true; erasedAt: true }
    }): Promise<Array<{ id: string; customerEmail: string | null; erasedAt: Date | null }>>
  }
}

export interface CustomerIdentityReport {
  customersTotal: number
  customersWithWooLink: number
  customersWithoutWooLink: number
  customersAnonymised: number
  customersNullOrPlaceholderEmail: number
  /** Live customers (not anonymised, usable email) bucketed by how many share one strict identity key. */
  strictKeyGroupSizeHistogram: { size1: number; size2: number; size3: number; size4: number; size5Plus: number }
  strictGroupsOfTwoOrMore: number
  strictGroupsByteIdentical: number
  strictGroupsCaseOrWhitespaceOnly: number
  looseGroupsMergingDistinctStrictKeys: number
  plusVariantGroups: number
  gmailDotVariantGroups: number
  strictGroupsWithTwoOrMoreWooIds: number
  ordersWithoutCustomerTotal: number
  ordersWithoutCustomerErased: number
  ordersWithoutCustomerNoEmail: number
  ordersWithoutCustomerEmailMatchesLiveCustomer: number
  ordersWithoutCustomerOtherEmail: number
  /** CLUSTERS AS THE RESOLVER WOULD FORM THEM TODAY (folded email; operator merge rows are not read). */
  derivedClustersOfTwoOrMore: number
  /** Customer records that sit in such a cluster. */
  derivedClusterCustomerRecords: number
  /** The largest derived clusters, by size then first id: CUSTOMER IDS ONLY, capped. No email, name or other personal data. */
  sampleClusters: Array<{ size: number; customerIds: string[] }>
}

export const REPORT_COUNT_KEYS: ReadonlyArray<keyof CustomerIdentityReport> = [
  'customersTotal',
  'customersWithWooLink',
  'customersWithoutWooLink',
  'customersAnonymised',
  'customersNullOrPlaceholderEmail',
  'strictKeyGroupSizeHistogram',
  'strictGroupsOfTwoOrMore',
  'strictGroupsByteIdentical',
  'strictGroupsCaseOrWhitespaceOnly',
  'looseGroupsMergingDistinctStrictKeys',
  'plusVariantGroups',
  'gmailDotVariantGroups',
  'strictGroupsWithTwoOrMoreWooIds',
  'ordersWithoutCustomerTotal',
  'ordersWithoutCustomerErased',
  'ordersWithoutCustomerNoEmail',
  'ordersWithoutCustomerEmailMatchesLiveCustomer',
  'ordersWithoutCustomerOtherEmail',
  'derivedClustersOfTwoOrMore',
  'derivedClusterCustomerRecords',
  'sampleClusters',
]

interface Group {
  size: number
  rawVariants: Set<string>
  wooIds: Set<string>
}

/** Plus-tag removed only: no gmail dot or alias fold. Distinguishes a plus variant from a dot variant inside one loose group. */
function plusFoldedOnly(strictKey: string): string {
  const [local, domain] = strictKey.split('@') as [string, string]
  return `${local.split('+')[0]}@${domain}`
}

export async function buildCustomerIdentityReport(tx: IdentityReportTx): Promise<CustomerIdentityReport> {
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')

  const report: CustomerIdentityReport = {
    customersTotal: 0,
    customersWithWooLink: 0,
    customersWithoutWooLink: 0,
    customersAnonymised: 0,
    customersNullOrPlaceholderEmail: 0,
    strictKeyGroupSizeHistogram: { size1: 0, size2: 0, size3: 0, size4: 0, size5Plus: 0 },
    strictGroupsOfTwoOrMore: 0,
    strictGroupsByteIdentical: 0,
    strictGroupsCaseOrWhitespaceOnly: 0,
    looseGroupsMergingDistinctStrictKeys: 0,
    plusVariantGroups: 0,
    gmailDotVariantGroups: 0,
    strictGroupsWithTwoOrMoreWooIds: 0,
    ordersWithoutCustomerTotal: 0,
    ordersWithoutCustomerErased: 0,
    ordersWithoutCustomerNoEmail: 0,
    ordersWithoutCustomerEmailMatchesLiveCustomer: 0,
    ordersWithoutCustomerOtherEmail: 0,
    derivedClustersOfTwoOrMore: 0,
    derivedClusterCustomerRecords: 0,
    sampleClusters: [],
  }

  const groups = new Map<string, Group>()
  const looseMembers = new Map<string, ClusterCustomer[]>()
  let cursor: { id: string } | undefined
  for (;;) {
    const batch = await tx.customer.findMany({
      take: IDENTITY_REPORT_BATCH,
      ...(cursor ? { skip: 1, cursor } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        email: true,
        externalCustomerId: true,
        gdprAnonymisedAt: true,
        shoppingLinks: { where: { connector: 'woocommerce' }, select: { externalCustomerId: true } },
      },
    })
    if (batch.length === 0) break
    for (const c of batch) {
      report.customersTotal++
      const wooIds = new Set<string>(c.shoppingLinks.map((l) => l.externalCustomerId))
      if (c.externalCustomerId !== null) wooIds.add(String(c.externalCustomerId))
      if (c.shoppingLinks.length > 0) report.customersWithWooLink++
      else report.customersWithoutWooLink++
      const key = normaliseIdentityEmail(c.email)
      if (key === null) report.customersNullOrPlaceholderEmail++
      if (c.gdprAnonymisedAt !== null) {
        report.customersAnonymised++
        continue // anonymised customers never join a live cluster
      }
      if (key === null) continue
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { size: 0, rawVariants: new Set(), wooIds: new Set() }))
      g.size++
      g.rawVariants.add(c.email as string)
      for (const id of wooIds) g.wooIds.add(id)
      const loose = looseIdentityEmail(c.email)
      if (loose !== null) {
        const member: ClusterCustomer = { id: c.id, email: c.email, anonymised: false }
        const list = looseMembers.get(loose)
        if (list) list.push(member)
        else looseMembers.set(loose, [member])
      }
    }
    cursor = { id: batch[batch.length - 1]!.id }
    if (batch.length < IDENTITY_REPORT_BATCH) break
  }

  const looseGroups = new Map<string, Set<string>>()
  for (const [key, g] of groups) {
    const h = report.strictKeyGroupSizeHistogram
    if (g.size === 1) h.size1++
    else if (g.size === 2) h.size2++
    else if (g.size === 3) h.size3++
    else if (g.size === 4) h.size4++
    else h.size5Plus++
    if (g.size >= 2) {
      report.strictGroupsOfTwoOrMore++
      if (g.rawVariants.size === 1) report.strictGroupsByteIdentical++
      else report.strictGroupsCaseOrWhitespaceOnly++
    }
    if (g.wooIds.size >= 2) report.strictGroupsWithTwoOrMoreWooIds++
    const loose = looseIdentityEmail(key)
    if (loose !== null) {
      let s = looseGroups.get(loose)
      if (!s) looseGroups.set(loose, (s = new Set()))
      s.add(key)
    }
  }
  for (const strictKeys of looseGroups.values()) {
    if (strictKeys.size < 2) continue
    report.looseGroupsMergingDistinctStrictKeys++
    const plusFolded = new Set([...strictKeys].map(plusFoldedOnly))
    if (plusFolded.size < strictKeys.size) report.plusVariantGroups++
    if (plusFolded.size > 1) report.gmailDotVariantGroups++
  }

  // The clusters the resolver would form: the derived rule is "equal folded email", so each folded-email group of two or more is one cluster.
  const clusters: string[][] = []
  for (const members of looseMembers.values()) if (members.length >= 2) clusters.push(members.map((m) => m.id).sort())
  report.derivedClustersOfTwoOrMore = clusters.length
  report.derivedClusterCustomerRecords = clusters.reduce((n, c) => n + c.length, 0)
  clusters.sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1))
  report.sampleClusters = clusters.slice(0, SAMPLE_CLUSTER_COUNT).map((c) => ({ size: c.length, customerIds: c.slice(0, SAMPLE_CLUSTER_MAX_IDS) }))

  let orderCursor: { id: string } | undefined
  for (;;) {
    const batch = await tx.salesOrder.findMany({
      where: { customerId: null },
      take: IDENTITY_REPORT_BATCH,
      ...(orderCursor ? { skip: 1, cursor: orderCursor } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, customerEmail: true, erasedAt: true },
    })
    if (batch.length === 0) break
    for (const o of batch) {
      report.ordersWithoutCustomerTotal++
      const key = normaliseIdentityEmail(o.customerEmail)
      if (o.erasedAt !== null) report.ordersWithoutCustomerErased++
      else if (key === null) report.ordersWithoutCustomerNoEmail++
      else if (groups.has(key)) report.ordersWithoutCustomerEmailMatchesLiveCustomer++
      else report.ordersWithoutCustomerOtherEmail++
    }
    orderCursor = { id: batch[batch.length - 1]!.id }
    if (batch.length < IDENTITY_REPORT_BATCH) break
  }

  return report
}
