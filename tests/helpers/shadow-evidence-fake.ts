import type { Prisma } from '@/app/generated/prisma/client'

/**
 * A `$queryRaw` double for `findDurableShadowRecords` (lib/domain/outbound-shadow/durable-evidence.ts).
 *
 * It does not parse SQL. It reads the statement's BOUND VALUES (destination, subject type, ids, prefixes, operations) and
 * evaluates them against the records it was given, so a reader that stops asking, asks for the wrong subject, or the wrong
 * destination gets a different answer. The real statement is exercised against Postgres in tests/db/durable-shadow-evidence.test.ts.
 */
export type FakeShadowRecord = { id?: string; destination: string; operation: string; subject_type: string; subject_id: string; occurrences?: number }

export function shadowEvidenceFake(records: readonly FakeShadowRecord[] = []) {
  const asked: Array<{ values: unknown[] }> = []
  const queryRaw = async (query: unknown): Promise<unknown[]> => {
    const values = ((query as Prisma.Sql).values ?? []) as unknown[]
    asked.push({ values })
    const strings = values.filter((value): value is string => typeof value === 'string')
    return records
      .filter((record) => strings.includes(record.destination)
        && strings.includes(record.subject_type)
        && strings.some((value) => value === record.subject_id || (value.length < record.subject_id.length && record.subject_id.startsWith(value) && value.endsWith('-'))))
      // the operation restriction applies only when an operation is among the bound values for this subject
      .filter((record) => {
        const operations = strings.filter((value) => /^[a-z]+\.[a-z_.-]+$/i.test(value) && value !== record.subject_id && value !== record.destination && value !== record.subject_type)
        return operations.length === 0 || operations.includes(record.operation)
      })
      .map((record) => ({ id: record.id ?? `shadow-${record.subject_id}`, operation: record.operation, subject_type: record.subject_type, subject_id: record.subject_id, occurrences: record.occurrences ?? 1 }))
  }
  return { queryRaw, asked }
}
