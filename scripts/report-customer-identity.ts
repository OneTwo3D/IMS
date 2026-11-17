/**
 * READ-ONLY report: how the customer identity email key would group today's customers and customerless orders (CRM foundation).
 *
 * Every query runs inside ONE `REPEATABLE READ` transaction that is set `READ ONLY` before the first read. It prints COUNTS ONLY: never an
 * email, a name or any other personal data. A run against production needs the owner's approval.
 *
 *   runuser -u ims -- env HOME=/tmp npx tsx scripts/report-customer-identity.ts [--json]
 */
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { buildCustomerIdentityReport, type IdentityReportTx } from '@/lib/domain/crm/identity-report'

async function main() {
  const report = await db.$transaction(
    (tx) => buildCustomerIdentityReport(tx as unknown as IdentityReportTx),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 600_000, maxWait: 20_000 },
  )
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`Customer identity report (read-only, counts only) @ ${new Date().toISOString()}`)
  for (const [key, value] of Object.entries(report)) {
    if (typeof value === 'number') console.log(`  ${key.padEnd(48)} ${value}`)
    else for (const [k, v] of Object.entries(value)) console.log(`  ${`${key}.${k}`.padEnd(48)} ${v}`)
  }
  console.log('\nNothing was written.')
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'report failed')
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
