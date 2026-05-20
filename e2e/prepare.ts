import { config as loadDotenv } from 'dotenv'
import bcrypt from 'bcryptjs'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../app/generated/prisma/client'
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
  E2E_SUPPLIER_EMAIL,
  E2E_SUPPLIER_ID,
  E2E_SUPPLIER_PASSWORD,
} from './test-data'

loadDotenv({ path: '.env.local', override: false })
loadDotenv({ path: '.env', override: false })

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const db = new PrismaClient({ adapter })

async function main() {
  const [adminPasswordHash, supplierPasswordHash] = await Promise.all([
    bcrypt.hash(E2E_ADMIN_PASSWORD, 12),
    bcrypt.hash(E2E_SUPPLIER_PASSWORD, 12),
  ])

  await db.organisation.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      name: 'onetwoInventory',
      baseCurrency: 'GBP',
      financialYearStartMonth: 5,
      financialYearStartDay: 1,
      country: 'GB',
    },
  })

  await db.warehouse.upsert({
    where: { code: 'DEFAULT' },
    update: {},
    create: {
      code: 'DEFAULT',
      name: 'Default',
      type: 'STANDARD',
      availableForSale: true,
      syncToStore: false,
      isDefault: true,
      defaultReturnWarehouse: false,
    },
  })

  await db.warehouse.upsert({
    where: { code: 'CBG' },
    update: {
      name: 'Cambridge',
      type: 'STANDARD',
      availableForSale: true,
      syncToStore: false,
      isDefault: false,
      defaultReturnWarehouse: false,
      active: true,
    },
    create: {
      code: 'CBG',
      name: 'Cambridge',
      type: 'STANDARD',
      availableForSale: true,
      syncToStore: false,
      isDefault: false,
      defaultReturnWarehouse: false,
      active: true,
    },
  })

  await db.warehouse.upsert({
    where: { code: 'E2E-SECOND' },
    update: {
      name: 'E2E Secondary',
      type: 'STANDARD',
      availableForSale: true,
      syncToStore: false,
      isDefault: false,
      defaultReturnWarehouse: false,
    },
    create: {
      code: 'E2E-SECOND',
      name: 'E2E Secondary',
      type: 'STANDARD',
      availableForSale: true,
      syncToStore: false,
      isDefault: false,
      defaultReturnWarehouse: false,
    },
  })

  await db.supplier.upsert({
    where: { id: E2E_SUPPLIER_ID },
    update: {
      name: 'E2E Supplier',
      contactName: 'Supplier User',
      email: E2E_SUPPLIER_EMAIL,
      currency: 'GBP',
      active: true,
    },
    create: {
      id: E2E_SUPPLIER_ID,
      name: 'E2E Supplier',
      contactName: 'Supplier User',
      email: E2E_SUPPLIER_EMAIL,
      currency: 'GBP',
      active: true,
    },
  })

  await db.customer.upsert({
    where: { id: 'e2e-customer' },
    update: {
      firstName: 'E2E',
      lastName: 'Customer',
      email: 'customer@example.com',
      company: 'OneTwo3D E2E Customer',
      active: true,
      archived: false,
      gdprAnonymisedAt: null,
    },
    create: {
      id: 'e2e-customer',
      firstName: 'E2E',
      lastName: 'Customer',
      email: 'customer@example.com',
      company: 'OneTwo3D E2E Customer',
      active: true,
      archived: false,
    },
  })

  await db.user.upsert({
    where: { email: E2E_ADMIN_EMAIL },
    update: {
      name: 'Admin',
      passwordHash: adminPasswordHash,
      role: 'ADMIN',
      active: true,
      totpEnabled: false,
      totpSecret: null,
      pendingTotpSecret: null,
    },
    create: {
      email: E2E_ADMIN_EMAIL,
      name: 'Admin',
      passwordHash: adminPasswordHash,
      role: 'ADMIN',
      active: true,
      totpEnabled: false,
    },
  })

  await db.user.upsert({
    where: { email: E2E_SUPPLIER_EMAIL },
    update: {
      name: 'Supplier User',
      passwordHash: supplierPasswordHash,
      role: 'SUPPLIER',
      supplierId: E2E_SUPPLIER_ID,
      active: true,
      totpEnabled: false,
      totpSecret: null,
      pendingTotpSecret: null,
    },
    create: {
      email: E2E_SUPPLIER_EMAIL,
      name: 'Supplier User',
      passwordHash: supplierPasswordHash,
      role: 'SUPPLIER',
      supplierId: E2E_SUPPLIER_ID,
      active: true,
      totpEnabled: false,
    },
  })

  console.log(`Prepared E2E admin user: ${E2E_ADMIN_EMAIL}`)
  console.log(`Prepared E2E supplier user: ${E2E_SUPPLIER_EMAIL}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
