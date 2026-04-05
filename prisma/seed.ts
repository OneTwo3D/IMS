/**
 * Development seed — creates default warehouses, currencies, tax rates,
 * organisation record, and a test admin user.
 *
 * Run with: npm run db:seed
 */
import 'dotenv/config'
import { PrismaClient } from '../app/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcryptjs'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const db = new PrismaClient({ adapter })

async function main() {
  console.log('Seeding database...')

  // Organisation
  await db.organisation.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      name: 'OneTwo3D Ltd',
      baseCurrency: 'GBP',
      financialYearStartMonth: 5,
      financialYearStartDay: 1,
      country: 'GB',
    },
  })

  // Warehouses
  const warehouses = [
    { code: 'EAR2', name: 'Earith 2',    type: 'STANDARD'   as const, availableForSale: true,  syncToWoocommerce: true,  isDefault: true,  defaultReturnWarehouse: false },
    { code: 'CBG',  name: 'Cambridge',   type: 'STANDARD'   as const, availableForSale: true,  syncToWoocommerce: true,  isDefault: false, defaultReturnWarehouse: false },
    { code: 'RES',  name: 'Restock',     type: 'RESTOCK'    as const, availableForSale: false, syncToWoocommerce: false, isDefault: false, defaultReturnWarehouse: false },
    { code: 'QUA',  name: 'Quarantine',  type: 'QUARANTINE' as const, availableForSale: false, syncToWoocommerce: false, isDefault: false, defaultReturnWarehouse: true  },
  ]
  for (const wh of warehouses) {
    await db.warehouse.upsert({ where: { code: wh.code }, update: {}, create: wh })
  }
  console.log(`  ✓ ${warehouses.length} warehouses`)

  // Currencies
  const currencies = [
    { code: 'GBP', name: 'British Pound Sterling', symbol: '£', usedFor: 'BOTH'     as const },
    { code: 'EUR', name: 'Euro',                    symbol: '€', usedFor: 'BOTH'     as const },
    { code: 'USD', name: 'US Dollar',               symbol: '$', usedFor: 'BOTH'     as const },
    { code: 'NOK', name: 'Norwegian Krone',          symbol: 'kr', usedFor: 'BOTH'   as const },
    { code: 'SEK', name: 'Swedish Krona',            symbol: 'kr', usedFor: 'PURCHASE' as const },
    { code: 'CAD', name: 'Canadian Dollar',          symbol: 'C$', usedFor: 'PURCHASE' as const },
  ]
  for (const cur of currencies) {
    await db.currency.upsert({ where: { code: cur.code }, update: {}, create: cur })
  }
  console.log(`  ✓ ${currencies.length} currencies`)

  // Tax rates
  const taxRates = [
    { name: 'UK Standard Rate (20%)',   rate: 0.2,  type: 'VAT' as const, countryCode: 'GB', isDefault: true  },
    { name: 'UK Reduced Rate (5%)',     rate: 0.05, type: 'VAT' as const, countryCode: 'GB', isDefault: false },
    { name: 'Zero Rated (0%)',          rate: 0,    type: 'VAT' as const, countryCode: null, isDefault: false },
    { name: 'EU Standard Rate (20%)',   rate: 0.2,  type: 'VAT' as const, countryCode: null, isDefault: false },
  ]
  for (const tr of taxRates) {
    const existing = await db.taxRate.findFirst({ where: { name: tr.name } })
    if (!existing) await db.taxRate.create({ data: tr })
  }
  console.log(`  ✓ ${taxRates.length} tax rates`)

  // Admin user
  const adminEmail = 'admin@example.com'
  const existing = await db.user.findUnique({ where: { email: adminEmail } })
  if (!existing) {
    const passwordHash = await bcrypt.hash('changeme123', 12)
    await db.user.create({
      data: {
        email: adminEmail,
        name: 'Admin',
        passwordHash,
        role: 'ADMIN',
        active: true,
      },
    })
    console.log(`  ✓ Admin user: ${adminEmail} / changeme123`)
  } else {
    console.log(`  ✓ Admin user already exists (${adminEmail})`)
  }

  console.log('Seed complete.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
