import { Prisma } from '@/app/generated/prisma/client'

/**
 * P2002 fixtures for the two shapes a unique-constraint violation actually arrives in (o3d-5od).
 *
 * Before o3d-5od every test in this repo hand-built `meta: { target: [...] }`. That shape is
 * NOT what production produces: `lib/db/index.ts` uses `@prisma/adapter-pg`, and under that
 * driver adapter `meta.target` is `undefined` and the column list arrives at
 * `meta.driverAdapterError.cause.constraint.fields` — quoted, for identifiers Postgres would
 * have to quote. The suite therefore validated a shape that never occurs and kept passing while
 * five idempotency guards were dead in production.
 *
 * Prefer `adapterUniqueViolation` for anything asserting real behaviour; `legacyUniqueViolation`
 * exists so the query-engine shape stays covered too.
 */

/** Quote a column the way Postgres does: only when the identifier is not all-lowercase. */
function quoteIfNeeded(column: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(column) ? column : `"${column}"`
}

/**
 * The REAL production shape: Prisma 7 + `@prisma/adapter-pg`.
 *
 * Verified live against `onetwo3d_ims_dev` with a rolled-back transaction — see
 * lib/db/prisma-unique-violation.ts for the captured payload.
 */
export function adapterUniqueViolation(
  columns: string[],
  options: { modelName?: string; constraintName?: string } = {},
): Prisma.PrismaClientKnownRequestError {
  const constraintName = options.constraintName
    ?? `${(options.modelName ?? 'model').toLowerCase()}_${columns.join('_')}_key`
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed',
    {
      code: 'P2002',
      clientVersion: 'test',
      meta: {
        ...(options.modelName ? { modelName: options.modelName } : {}),
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23505',
            originalMessage: `duplicate key value violates unique constraint "${constraintName}"`,
            kind: 'UniqueConstraintViolation',
            constraint: { fields: columns.map(quoteIfNeeded) },
          },
        },
      },
    },
  )
}

/** The classic query-engine shape, kept so the `meta.target` fallback stays covered. */
export function legacyUniqueViolation(target: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  })
}
