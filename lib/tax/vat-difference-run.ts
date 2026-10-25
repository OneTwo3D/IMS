/**
 * RUN THE VAT DIFFERENCE REPORT: the one orchestration the CLI (`npm run vat:diff`) and the Settings action share. READ ONLY.
 *
 * Order: (1) the IMS rates, the storefront mappings and the proven stored Xero list, in ONE database transaction that is REPEATABLE READ and
 * READ ONLY (the database itself refuses any write in it, and the run refuses to read if the mode is not on); (2) the WooCommerce tax rates,
 * all pages, through the GET-only port, after that transaction has closed (a store walk is paced and must not hold a transaction open);
 * (3) the comparison. A refusal on either side is returned as a refusal, never as a report of no differences.
 *
 * The WooCommerce port is the reconciliation pack's (lib/reconciliation-pack/woo-transport.ts): GET only, to the three read collections of
 * the store's own origin, through the connector fetch seam, with the stored credentials read in a read-only transaction on a connection of
 * its own (lib/reconciliation-pack/woo-credentials.ts). Nothing here can ask for another method or path.
 */

import pg from 'pg'

import { pgConnectionConfig } from '@/lib/db/database-url-schema.mjs'
import type { ImsQueryClient } from '@/lib/reconciliation-pack/ims-readers'
import { readWooCredentials } from '@/lib/reconciliation-pack/woo-credentials'
import { readWooTaxRateDetails, type WooGetPort, type WooSourceOptions } from '@/lib/reconciliation-pack/woo-source'
import { createWooGetPort } from '@/lib/reconciliation-pack/woo-transport'
import type { Prisma } from '@/app/generated/prisma/client'
import { compareVatSets, readImsXeroSnapshot, type VatDifferenceReport } from '@/lib/tax/vat-difference-report'

export type VatRunDb = {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>
}

export type VatRunDeps = {
  db: VatRunDb
  now: () => Date
  woo: WooGetPort
  wooOptions?: WooSourceOptions
}

export async function runVatDifferenceReport(deps: VatRunDeps): Promise<VatDifferenceReport> {
  let read
  try {
    read = await deps.db.$transaction(async (tx) => {
      // The first statement of the transaction: the database then refuses every write in it. A mode that is not on is not read at all.
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const mode = await tx.$queryRawUnsafe<Array<{ transaction_read_only: string }>>('SHOW transaction_read_only')
      if (mode.length !== 1 || mode[0]!.transaction_read_only !== 'on') return null
      return await readImsXeroSnapshot(tx, deps.now())
    }, { timeout: 60_000, maxWait: 20_000 })
  } catch {
    return { status: 'refused', code: 'IMS_UNREADABLE', detail: 'the IMS database could not be read' }
  }
  if (read === null) return { status: 'refused', code: 'IMS_UNREADABLE', detail: 'the IMS read could not be made read-only' }
  if (!read.ok) return { status: 'refused', code: read.code, detail: read.detail }
  const woo = await readWooTaxRateDetails(deps.woo, deps.wooOptions)
  if (!woo.ok) return { status: 'refused', code: 'WOO_READ_FAILED', detail: 'the WooCommerce tax rates could not be read and proven (no credentials, a refused or failed request, or pages that disagree)', wooReason: woo.reason }
  return compareVatSets({ snapshot: read.snapshot, woo: woo.value.rates })
}

export type PgConnection = { client: ImsQueryClient; close: () => Promise<void> }

/** A connection of its own for reading the stored storefront credentials (never the application's client). */
export async function openOwnPgConnection(databaseUrl: string | undefined = process.env.DATABASE_URL): Promise<PgConnection> {
  const client = new pg.Client({ ...pgConnectionConfig(databaseUrl), connectionTimeoutMillis: 10_000, application_name: 'vat-difference-report' })
  await client.connect()
  return { client: client as unknown as ImsQueryClient, close: () => client.end() }
}

/** The GET-only WooCommerce port over the stored credentials, read on the first request only. */
export function createStoredWooPort(open: () => Promise<PgConnection> = () => openOwnPgConnection()): WooGetPort {
  return createWooGetPort({
    readCredentials: async () => {
      const connection = await open()
      try { return await readWooCredentials(connection.client) } finally { await connection.close().catch(() => undefined) }
    },
  })
}
