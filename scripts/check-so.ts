import { db } from '../lib/db'

async function main() {
  const rates = await db.taxRate.findMany({
    where: { active: true },
    select: { id: true, name: true, rate: true, accountingTaxType: true, countryCode: true, taxCategory: true, usedFor: true },
    orderBy: [{ countryCode: 'asc' }, { taxCategory: 'asc' }],
  })
  console.log('=== ACTIVE TAX RATES ===')
  console.log(JSON.stringify(rates, null, 2))
  await db.$disconnect()
}
main()
