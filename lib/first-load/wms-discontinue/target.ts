/**
 * THE IMS SIDE OF THE FIRST-LOAD WMS ARCHIVE WRITE: what the command reads from, and records in, the IMS database the first load was applied to.
 * PURE STATEMENTS over an injected query port (the script opens the connection; this module imports no database client).
 *
 * THE PROOF THAT THE IMPORT HAPPENED (#1126 R1 LOW). The archive follows the import, never a sheet that might not have been imported. The proof chosen is
 * the IMS state itself, read-only, rather than a digest of the applied run: every SKU to be written must exist as an IMS product whose lifecycle is
 * ARCHIVED in the target database. A digest would only prove that some run was applied; the products' lifecycle proves that THIS decision reached IMS
 * and is still in force (an operator who changed the product back since is not overruled in the WMS). The target is confirmed the same way as
 * first-load:apply: named by an env file, and confirmed by what the server says about itself (--expect-db, --expect-system-id).
 *
 * ONE RUN AT A TIME per target (#1128 R1 LOW-3): the script's connection (lib/db/first-load-archive-target.ts) is built by the session-lock factory and
 * takes the advisory lock FIRST_LOAD_WMS_ARCHIVE_LOCK_KEY before anything is read; the command refuses when another run holds it.
 *
 * ONE READ ONLY REPEATABLE READ transaction reads the server's identity, the switch and the products; nothing else is read.
 *
 * THE RECORD. Each write is recorded in `activity_logs` (entity PRODUCT, the IMS product id), in its own transaction: the attempt before the request is
 * sent, then the verified write or the failure, with the SKU, the WMS product id, the discontinued flag before and after, the operator, the plan token
 * and the sheet id. These INSERTs are the only statements that write.
 */
import type { ArchiveWriteRecord } from './execute'

export const ARCHIVE_TARGET_STATEMENTS = {
  begin: 'BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ',
  identity: `select current_database() as db, (select system_identifier::text from pg_control_system()) as sid`,
  switch: 'select "value" from "settings" where "key" = $1',
  products: 'select "id", "sku", "lifecycleStatus"::text as lifecycle from "products" where "sku" = any($1::text[])',
  rollback: 'ROLLBACK',
  /** The switch, read again before each write, outside any transaction. */
  switchAgain: 'select "value" as value from "settings" where "key" = $1',
  writeBegin: 'BEGIN',
  record: `insert into "activity_logs" ("id", "userId", "entityType", "entityId", "action", "tag", "level", "description", "metadata") values ($1, null, 'PRODUCT', $2, $3, 'import', $4::"ActivityLogLevel", $5, $6::jsonb)`,
  commit: 'COMMIT',
} as const

export const ARCHIVE_ACTIVITY_ACTIONS = {
  ATTEMPT: 'first_load_wms_archive_attempt',
  VERIFIED: 'first_load_wms_archive_verified',
  FAILED: 'first_load_wms_archive_failed',
} as const

export interface ArchiveTargetPort {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}

export interface ArchiveTargetRead {
  database: string
  systemId: string
  /** The stored value of the switch, or null when no row exists (the default, OFF). */
  switchValue: string | null
  /** The IMS products found under exactly the SKUs asked for. */
  products: Map<string, { id: string; lifecycle: string }>
}

/** The switch, read again: true only when its row reads exactly 'true'. */
export async function archiveSwitchStillOn(port: ArchiveTargetPort, switchKey: string): Promise<boolean> {
  const rows = (await port.query<{ value: string }>(ARCHIVE_TARGET_STATEMENTS.switchAgain, [switchKey])).rows
  return rows.length === 1 && rows[0]!.value === 'true'
}

export async function readArchiveTarget(port: ArchiveTargetPort, switchKey: string, skus: readonly string[]): Promise<ArchiveTargetRead> {
  await port.query(ARCHIVE_TARGET_STATEMENTS.begin)
  try {
    const id = (await port.query<{ db: string; sid: string }>(ARCHIVE_TARGET_STATEMENTS.identity)).rows[0]
    if (!id) throw new Error('the server did not report its identity')
    const sw = (await port.query<{ value: string }>(ARCHIVE_TARGET_STATEMENTS.switch, [switchKey])).rows
    const rows = (await port.query<{ id: string; sku: string; lifecycle: string }>(ARCHIVE_TARGET_STATEMENTS.products, [[...skus]])).rows
    const products = new Map<string, { id: string; lifecycle: string }>()
    for (const r of rows) products.set(r.sku, { id: r.id, lifecycle: r.lifecycle })
    return { database: id.db, systemId: id.sid, switchValue: sw.length === 1 ? sw[0]!.value : null, products }
  } finally {
    await port.query(ARCHIVE_TARGET_STATEMENTS.rollback)
  }
}

/** The SKUs to be written whose import is not proven: no IMS product under exactly the SKU, or one whose lifecycle is not ARCHIVED. */
export function unprovenImports(read: Pick<ArchiveTargetRead, 'products'>, skus: readonly string[]): string[] {
  return skus.filter((sku) => read.products.get(sku)?.lifecycle !== 'ARCHIVED').map((sku) => {
    const product = read.products.get(sku)
    return product === undefined ? `${sku}: no IMS product under exactly this SKU` : `${sku}: the IMS lifecycle is ${product.lifecycle}, not ARCHIVED`
  })
}

export function archiveRecordDescription(entry: ArchiveWriteRecord): string {
  const what = `${entry.wms} product ${entry.wmsProductId} (SKU ${entry.sku})`
  if (entry.outcome === 'ATTEMPT') return `First-load archive: setting ${what} discontinued (owner decision Archived, plan ${entry.planToken}), run by ${entry.operator}`
  if (entry.outcome === 'VERIFIED') return `First-load archive: ${what} set discontinued and verified (discontinued false -> true), run by ${entry.operator}`
  return `First-load archive: the write to ${what} did not verify, run stopped: ${entry.problem ?? 'unknown'} (discontinued after: ${entry.discontinuedAfter === null ? 'not read' : String(entry.discontinuedAfter)}), run by ${entry.operator}`
}

/** Writes one activity-log entry in its own transaction. Throws when it could not (the transaction is rolled back). */
export async function recordArchiveWrite(port: ArchiveTargetPort, newId: () => string, entry: ArchiveWriteRecord): Promise<void> {
  await port.query(ARCHIVE_TARGET_STATEMENTS.writeBegin)
  try {
    const metadata = {
      sku: entry.sku,
      wms: entry.wms,
      wmsProductId: entry.wmsProductId,
      discontinuedBefore: entry.discontinuedBefore,
      discontinuedAfter: entry.discontinuedAfter,
      operator: entry.operator,
      planToken: entry.planToken,
      sheetId: entry.sheetId,
      stepEvidence: entry.stepEvidence,
      outcome: entry.outcome,
      problem: entry.problem,
    }
    await port.query(ARCHIVE_TARGET_STATEMENTS.record, [newId(), entry.imsProductId, ARCHIVE_ACTIVITY_ACTIONS[entry.outcome], entry.outcome === 'FAILED' ? 'ERROR' : 'INFO', archiveRecordDescription(entry), JSON.stringify(metadata)])
    await port.query(ARCHIVE_TARGET_STATEMENTS.commit)
  } catch (error) {
    await port.query(ARCHIVE_TARGET_STATEMENTS.rollback).catch(() => undefined)
    throw error
  }
}
