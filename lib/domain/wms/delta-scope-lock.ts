/**
 * THE DEFAULT SCOPE LOCK FOR A CONNECTOR'S INBOUND-DELTA CURSORS.
 *
 * The cursor read and the cursor write must be serialized against each other and against a reset,
 * and they must agree about WHICH SCOPE the cursors belong to — read the pair across two unlocked
 * statements and a scope change landing in between hands the run an old-scope watermark paired with
 * a new-scope token, which is exactly what makes the compare-and-swap at save time wave the stale
 * advance through (q66in.7.2 r4).
 *
 * A connector whose delta is SCOPED BY CONFIGURATION — Mintsoft's is scoped by ClientId, and moving
 * that ClientId invalidates every cursor — supplies its own lock over the rows that define that
 * scope, via `hooks.deltaScopeLock` on its registry definition. This is the default for every
 * connector that does not: lock the connector's OWN cursor rows, and report a constant scope token,
 * because "this connector's delta" is the whole of its scope.
 *
 * The default still takes a real row lock. The ordering is the point, not the token: without it two
 * concurrent sweeps (or a sweep and a reset) could interleave their read-then-write on the same
 * three rows.
 */

/** The subset of a Prisma transaction client this needs. Structural, so a test can supply it. */
export type WmsDeltaScopeLockTx = {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
}

/**
 * A connector's delta scope, as a TOKEN rather than an object.
 *
 * The generic layer never needs to read a scope, only to tell two of them apart, and a token is the
 * only part of that it can do without knowing what scopes a particular warehouse: returning the
 * token keeps `mintsoftDeltaScopeToken` — and the Mintsoft settings shape it reads — out of the
 * generic sweep entirely.
 */
export type WmsDeltaScopeLock<Tx extends WmsDeltaScopeLockTx = WmsDeltaScopeLockTx> =
  (tx: Tx) => Promise<string>

/** The token a connector with no configured scope binding reports. Constant, and deliberately so. */
export const WMS_DELTA_SCOPE_UNBOUND = 'unbound'

/**
 * Materialise and row-lock the named settings rows, in one canonical (sorted) order.
 *
 * `FOR UPDATE` locks only rows that EXIST, hence the materialise step. Inserting `''` is
 * semantically inert: every reader of a settings key treats an empty value exactly as an absent row.
 */
export async function lockWmsSettingRows(tx: WmsDeltaScopeLockTx, keys: string[]): Promise<void> {
  const sorted = [...keys].sort()
  await tx.$executeRaw`
    INSERT INTO settings (key, value, "updatedAt")
    SELECT k, '', now() FROM unnest(${sorted}::text[]) AS k
    ON CONFLICT (key) DO NOTHING`
  await tx.$queryRaw<Array<{ key: string; value: string | null }>>`
    SELECT key, value FROM settings WHERE key = ANY(${sorted}::text[]) ORDER BY key FOR UPDATE`
}

/**
 * The default scope lock: this connector's own cursor rows, and an unbound scope token.
 *
 * NOTE the lock order. Every path that touches a connector's delta state takes its scope lock
 * FIRST and then reads/writes the cursor rows, so a connector whose scope lock covers OTHER rows
 * (Mintsoft's five dispatch settings) and this default, which covers the cursor rows themselves,
 * both establish the same happens-before. They are never mixed for one connector.
 */
export function defaultWmsDeltaScopeLock(keys: readonly string[]): WmsDeltaScopeLock {
  return async (tx) => {
    await lockWmsSettingRows(tx, [...keys])
    return WMS_DELTA_SCOPE_UNBOUND
  }
}
