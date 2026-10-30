import pg from 'pg'

import { pgConnectionConfig } from '../../lib/db/database-url-schema.mjs'

/**
 * The database tests of the WooCommerce tax-rate writer change what the planner sees as a whole (they switch the other active tax rates off for their run and restore them), and
 * `npm run test:db` runs test files in parallel processes on one database. They therefore take one session advisory lock, named by a hash of a test-only string, for the length of a test world.
 */
export async function withWooTaxWorldLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = new pg.Client({ ...pgConnectionConfig(process.env.DATABASE_URL), application_name: 'woo-tax-test-world' })
  await client.connect()
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('woo-tax-test-world'))`)
    return await fn()
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('woo-tax-test-world'))`).catch(() => undefined)
    await client.end().catch(() => undefined)
  }
}
