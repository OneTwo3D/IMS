import type { Prisma } from '@/app/generated/prisma/client'

/**
 * An in-memory stand-in for the `document_number_sequences` statements of lib/domain/numbering/mint.ts, for unit tests whose
 * hand-built Prisma client has to survive a document being numbered. It does not parse SQL: it recognises the four
 * statements by their text and reads the bound values. The real statements run against Postgres in
 * tests/concurrency/document-numbering.concurrent.test.ts.
 */
type Row = { pattern: string | null; scope_key: string | null; counter: number }

export function numberingFake() {
  const rows = new Map<string, Row>()
  // A tagged template reaches the client as (strings, ...values); a Prisma.sql object as one argument.
  const sqlOf = (query: unknown): string => (Array.isArray(query) ? (query as string[]) : ((query as Prisma.Sql).strings ?? [])).join('?')
  const valuesOf = (query: unknown, rest: unknown[]): unknown[] => (Array.isArray(query) ? rest : ((query as Prisma.Sql).values ?? []) as unknown[])
  return {
    rows,
    isNumbering: (query: unknown, ...rest: unknown[]): boolean => sqlOf(query).includes('document_number_sequences')
      // the advisory lock a credit note takes on the yearly counter it shares with the earlier code
      || (sqlOf(query).includes('pg_advisory_xact_lock') && String(valuesOf(query, rest)[0]).startsWith('document_counter:')),
    async queryRaw(query: unknown, ...rest: unknown[]): Promise<Row[]> {
      const row = rows.get(String(valuesOf(query, rest)[0]))
      return row ? [{ ...row }] : []
    },
    async executeRaw(query: unknown, ...rest: unknown[]): Promise<number> {
      const sql = sqlOf(query)
      const values = valuesOf(query, rest)
      if (sql.includes('pg_advisory_xact_lock')) return 0
      if (sql.includes('INSERT INTO document_number_sequences')) {
        const type = String(values[0])
        if (!rows.has(type)) rows.set(type, { pattern: null, scope_key: null, counter: 0 })
        return 1
      }
      if (sql.includes('SET counter')) {
        const row = rows.get(String(values[2]))
        if (!row) throw new Error('numbering fake: update of a row that was never inserted')
        row.counter = Number(values[0])
        row.scope_key = String(values[1])
        return 1
      }
      throw new Error(`numbering fake: unrecognised statement ${sql}`)
    },
  }
}
