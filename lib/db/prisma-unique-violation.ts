/**
 * Reading the column list off a Prisma P2002 unique-constraint violation (o3d-5od).
 *
 * WHY THIS EXISTS
 * ---------------
 * `lib/db/index.ts` builds the client with `new PrismaPg(pool)` — the `@prisma/adapter-pg`
 * driver adapter. Under that adapter Prisma does NOT populate the classic `meta.target`.
 * Verified with a rolled-back probe against `onetwo3d_ims_dev` (Prisma + adapter 7.7.0):
 *
 *   code: 'P2002'
 *   meta: {
 *     modelName: 'IntegrationOutbox',
 *     driverAdapterError: {
 *       name: 'DriverAdapterError',
 *       cause: {
 *         originalCode: '23505',
 *         originalMessage: 'duplicate key value violates unique constraint
 *                           "integration_outbox_idempotencyKey_key"',
 *         kind: 'UniqueConstraintViolation',
 *         constraint: { fields: ['"idempotencyKey"'] },
 *       },
 *     },
 *   }
 *   meta.target: undefined
 *
 * Two details bite:
 *   1. `meta.target` is `undefined`, so every `error.meta?.target`-only reader silently
 *      returns false and the idempotency guard it protects never fires.
 *   2. Column names arrive QUOTED when — and only when — Postgres would have to quote the
 *      identifier. `idempotencyKey`/`externalProductId` come back as `'"idempotencyKey"'`,
 *      while all-lowercase columns come back bare (`'sku'`, `'barcode'` — also verified live).
 *      So the quoting must be stripped rather than assumed present or absent.
 *   3. A composite constraint reports every column: the `AccountingEvent`
 *      `@@unique([externalSystem, externalId])` violation yields
 *      `fields: ['"externalSystem"', '"externalId"']`.
 *
 * `meta.target` is still read as a fallback so this keeps working if the adapter is swapped
 * back out for the query engine, and so the documented shape stays valid in test doubles.
 *
 * NOT HANDLED HERE, ON PURPOSE: catching a P2002 *inside* an interactive transaction leaves
 * the transaction aborted (Postgres 25P02) unless the failing statement was wrapped in a
 * savepoint, which Prisma does not do. Making a guard fire is necessary but not sufficient
 * at those call sites — see the `o3d-5od` follow-up issue.
 */

/** Postgres' default names for a single-column unique index/constraint on `field`. */
const CONSTRAINT_NAME_SUFFIXES = ['_key', '_idx', '_unique'] as const

const CONSTRAINT_NAME_IN_MESSAGE = /unique constraint "([^"]+)"/

type UniqueViolationErrorish = {
  code?: unknown
  message?: unknown
  meta?: {
    modelName?: unknown
    target?: unknown
    driverAdapterError?: {
      cause?: {
        constraint?: unknown
        originalMessage?: unknown
      }
    }
  }
}

/**
 * Is this a Prisma unique-constraint violation?
 *
 * Duck-typed rather than `instanceof Prisma.PrismaClientKnownRequestError` so that a
 * re-thrown/serialised copy (webhook workers, `structuredClone` across a boundary, test
 * doubles) still matches. The code is specific enough that false positives are not a concern.
 */
export function isUniqueConstraintViolation(error: unknown): error is UniqueViolationErrorish {
  return typeof error === 'object'
    && error !== null
    && (error as UniqueViolationErrorish).code === 'P2002'
}

/** `'"idempotencyKey"'` → `'idempotencyKey'`. Bare names pass through untouched. */
function normalizeName(raw: unknown): string {
  return String(raw).trim().replace(/^"+|"+$/g, '')
}

function nonEmpty(names: string[]): string[] | null {
  const cleaned = names.filter((name) => name.length > 0)
  return cleaned.length > 0 ? cleaned : null
}

/** `meta.driverAdapterError.cause.constraint` — what the pg driver adapter actually produces. */
function readAdapterConstraint(error: UniqueViolationErrorish): string[] | null {
  const constraint = error.meta?.driverAdapterError?.cause?.constraint
  if (constraint == null) return null
  if (typeof constraint === 'string') return nonEmpty([normalizeName(constraint)])
  if (typeof constraint !== 'object') return null

  const { fields, index } = constraint as { fields?: unknown; index?: unknown }
  if (Array.isArray(fields)) return nonEmpty(fields.map(normalizeName))
  // Some driver adapters report an index name instead of a column list.
  if (typeof index === 'string') return nonEmpty([normalizeName(index)])
  return null
}

/** `meta.target` — the classic query-engine shape: a column array, or a constraint name. */
function readTarget(error: UniqueViolationErrorish): string[] | null {
  const target = error.meta?.target
  if (Array.isArray(target)) return nonEmpty(target.map(normalizeName))
  if (typeof target === 'string') return nonEmpty([normalizeName(target)])
  return null
}

/** Last resort: the constraint name Postgres puts in the raw error text. */
function readConstraintNameFromMessage(error: UniqueViolationErrorish): string[] | null {
  const raw = error.meta?.driverAdapterError?.cause?.originalMessage ?? error.message
  if (typeof raw !== 'string') return null
  const match = CONSTRAINT_NAME_IN_MESSAGE.exec(raw)
  return match ? [match[1]] : null
}

/**
 * The columns (or, failing that, the constraint name) a P2002 names, unquoted.
 *
 * Returns `null` — distinct from an empty list — when the error is not a P2002 at all or
 * identifies nothing. Callers that need to stay conservative can use that to tell "this
 * violation is definitely not mine" apart from "this violation did not say".
 */
export function uniqueConstraintFields(error: unknown): string[] | null {
  if (!isUniqueConstraintViolation(error)) return null
  return readAdapterConstraint(error)
    ?? readTarget(error)
    ?? readConstraintNameFromMessage(error)
}

/**
 * Does `name` refer to `field` — either the column itself, or Postgres' default constraint
 * name for a single-column unique index on it (`<table>_<field>_key`)?
 *
 * Suffix-anchored rather than a substring test so that a *different* column which merely
 * contains the name (`externalRefundIdHash`, `idempotencyKeyDigest`) does not match. The
 * previous per-call-site readers used `String(target).includes(field)`, which did.
 */
function nameRefersToField(name: string, field: string): boolean {
  if (name === field) return true
  return CONSTRAINT_NAME_SUFFIXES.some((suffix) => name.endsWith(`_${field}${suffix}`))
}

/**
 * Does this P2002 name `field` among its violated columns?
 *
 * Accepts a composite violation that includes the field, matching the pre-existing
 * `target.includes(field)` semantics at every call site this replaced. Callers that must
 * reject composites should use `uniqueConstraintFields` and check the length themselves.
 */
export function uniqueViolationTargetsField(
  error: unknown,
  field: string | readonly string[],
): boolean {
  const names = uniqueConstraintFields(error)
  if (!names) return false
  const fields = typeof field === 'string' ? [field] : field
  return names.some((name) => fields.some((candidate) => nameRefersToField(name, candidate)))
}
