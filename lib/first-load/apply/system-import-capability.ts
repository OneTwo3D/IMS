/**
 * THE SYSTEM-ACTOR CAPABILITY FOR THE FIRST-LOAD IMPORTERS.
 *
 * The first-load apply runner (a CLI, run by an operator on the server) loads the first data into an empty
 * installation by calling the application's own CSV importers. Those are Server Actions: they demand a signed-in
 * session, call `revalidatePath` (which throws outside a Next request), and queue WooCommerce pushes and stock
 * syncs. A CLI has no session, no request, and must not queue a single outbound effect.
 *
 * So the importers take an OPTIONAL trailing context. Holding a context minted here switches three things:
 *   1. the permission check is skipped (the runner is the operator, on the box, with the database credentials);
 *   2. revalidatePath is skipped and the fire-and-forget WooCommerce / stock-sync effects are NOT queued: the ids
 *      they would have touched are RETURNED instead (`deferredEffects`), so the runner can prove nothing was sent;
 *   3. the activity-log row names the actor (run id + operator label) instead of a session user.
 *
 * WHY A SYMBOL. A Server Action argument crosses the RPC boundary, so a boolean or string "I am the system" flag
 * is something any client can send (o3d-43oz). A `symbol` cannot be serialised, so only server-side code that
 * imports it can present it. Anything a client sends in this position fails `isSystemImportContext` and the
 * action takes the ordinary, permission-checked path.
 *
 * WHO MAY IMPORT WHAT is enforced by `npm run check:system-import-capability`:
 *   - `mintSystemImportContext` : only lib/first-load/apply/** , scripts/first-load-apply.ts and tests;
 *   - `SYSTEM_IMPORT` (compared inline, because the Server Action guard scan only credits a skipped permission check that
 *     compares against a module-level `Symbol()` it can resolve), `isSystemImportContext`, `withSystemActor`,
 *     `withSystemOutcome` and the types : those, plus the three importer modules that honour the context.
 *
 * This file is NOT a 'use server' module and must never become one: a Server Action file may export only async
 * functions, and a symbol exported from one would be a build error rather than a quiet capability.
 */
import type { logActivity } from '@/lib/activity-log'
import type { CsvImportExecutionResult, SystemImportOutcome } from '@/lib/csv-import'

type ActivityLogParams = Parameters<typeof logActivity>[0]

export const SYSTEM_IMPORT = Symbol('SYSTEM_IMPORT')

export type SystemImportContext = {
  /** The unforgeable part. Named so the Server Action auth-bypass guard reads its TYPE: it must stay a symbol. */
  readonly systemImportToken: typeof SYSTEM_IMPORT
  readonly runId: string
  readonly operator: string
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const OPERATOR_MAX_LENGTH = 80

export function mintSystemImportContext(args: { runId: string; operator: string }): SystemImportContext {
  // A Next server process sets NEXT_RUNTIME. The capability is for the CLI only, so refuse to mint inside one.
  if (process.env.NEXT_RUNTIME) {
    throw new Error('A system import context cannot be minted inside the web application.')
  }
  if (!RUN_ID_PATTERN.test(args.runId)) {
    throw new Error('A system import context needs a run id of 1-64 letters, digits, dots, dashes or underscores.')
  }
  const operator = args.operator.trim()
  // eslint-disable-next-line no-control-regex
  if (operator.length === 0 || operator.length > OPERATOR_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(operator)) {
    throw new Error(`A system import context needs an operator label of 1-${OPERATOR_MAX_LENGTH} printable characters.`)
  }
  return Object.freeze({ systemImportToken: SYSTEM_IMPORT, runId: args.runId, operator })
}

/** True only for a context that carries the real symbol. Anything else, including a forged look-alike, is false. */
export function isSystemImportContext(value: unknown): value is SystemImportContext {
  return typeof value === 'object'
    && value !== null
    && (value as { systemImportToken?: unknown }).systemImportToken === SYSTEM_IMPORT
}

/**
 * Activity-log parameters for a call made under a context: the actor is recorded in the metadata and the session
 * lookup is skipped. For a call without a context the parameters are returned UNCHANGED (same object).
 */
export function withSystemActor(params: ActivityLogParams, system: unknown): ActivityLogParams {
  if (!isSystemImportContext(system)) return params
  return {
    ...params,
    resolveUser: false,
    metadata: { ...(params.metadata ?? {}), actor: { kind: 'system', runId: system.runId, operator: system.operator } },
  }
}

/**
 * Attach the system-actor outcome to an importer's execution result. Without a context the result is returned as it is
 * (same object), so the web path's response shape does not change.
 */
export function withSystemOutcome(
  result: CsvImportExecutionResult,
  system: unknown,
  facts: { created: string[]; updated: string[]; shoppingMetadataPush?: string[]; stockSync?: string[] },
): CsvImportExecutionResult {
  if (!isSystemImportContext(system)) return result
  const outcome: SystemImportOutcome = {
    actor: { runId: system.runId, operator: system.operator },
    touchedIds: { created: facts.created, updated: facts.updated },
    deferredEffects: { shoppingMetadataPush: facts.shoppingMetadataPush ?? [], stockSync: facts.stockSync ?? [] },
  }
  return { ...result, system: outcome }
}
