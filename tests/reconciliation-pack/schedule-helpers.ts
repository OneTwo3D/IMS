import assert from 'node:assert/strict'

import { DEFAULT_PACK_REPORT_DIR, PACK_EXIT_CODES, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN } from '../../lib/reconciliation-pack/constants'
import type { ScheduledRunRecord } from '../../lib/reconciliation-pack/schedule'
import { PACK_SCHEDULE_RECORD_FIELDS, PACK_SCHEDULE_RUN_ID_RE } from '../../lib/reconciliation-pack/schedule-constants'

const GRAMMAR: Record<string, (value: unknown) => boolean> = {
  schemaVersion: (v) => v === 1,
  scheduleRunId: (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
  outcome: (v) => v === 'published' || v === 'refused' || v === 'failed',
  code: (v) => typeof v === 'string' && /^(?:all-pass|fail|inconclusive|[A-Z][A-Z_]{1,63})$/.test(v),
  codeMeaning: (v) => typeof v === 'string' && v.length > 0 && v.length < 600 && !/[\u0000-\u001f]/.test(v),
  exitCode: (v) => v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255),
  exitMeaning: (v) => v === null || (typeof v === 'string' && PACK_EXIT_CODES.some((row) => row.meaning === v)),
  phase: (v) => v === null || v === 'P0' || v === 'P1' || v === 'P2',
  vendorReads: (v) => typeof v === 'boolean',
  runId: (v) => v === null || (typeof v === 'string' && PACK_SCHEDULE_RUN_ID_RE.test(v)),
  sequence: (v) => v === null || (Number.isSafeInteger(v) && (v as number) >= 1),
  reportJson: (v) => v === null || (typeof v === 'string' && new RegExp(`^${DEFAULT_PACK_REPORT_DIR}/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}/${PACK_REPORT_JSON}$`).test(v)),
  reportMarkdown: (v) => v === null || (typeof v === 'string' && new RegExp(`^${DEFAULT_PACK_REPORT_DIR}/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}/${PACK_REPORT_MARKDOWN}$`).test(v)),
  durationMs: (v) => Number.isInteger(v) && (v as number) >= 0,
}

/** Walk a record: every key has a documented field, every value matches its grammar. */
export function assertClosedRecord(record: ScheduledRunRecord): void {
  const documented = PACK_SCHEDULE_RECORD_FIELDS.map((row) => row.field).sort()
  assert.deepEqual(Object.keys(record).sort(), documented)
  for (const [key, value] of Object.entries(record)) assert.ok(GRAMMAR[key]!(value), `${key} = ${JSON.stringify(value)}`)
}

