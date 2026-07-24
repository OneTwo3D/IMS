/**
 * Fail-closed identity guard for the destructive full-chain fixtures.
 *
 * Several fixtures delete rows outright — batch candidates, seeded tax rates, drift ActivityLog rows — and
 * some restore global Settings. All of that is safe ONLY against the disposable e2e database, so the guard
 * is a POSITIVE allowlist on the database NAME, never a denylist of the databases we happen to remember
 * (stage today, what tomorrow?). A denylist passes for production, a backup, a renamed clone, or a typo.
 *
 * It is also not a substring test: `onetwo3d_ims_e2e` appears inside `onetwo3d_ims_e2e_backup`, and could
 * appear in a host or password. Parsing the URL's pathname pins it to exactly one database. An absent or
 * unparseable URL fails closed.
 */

/** The one database the destructive fixtures may touch. */
export const E2E_DATABASE_NAME = 'onetwo3d_ims_e2e'

/** The database name a connection URL points at, or '' when absent/unparseable. */
export function databaseNameFromUrl(url: string | undefined | null): string {
  if (!url) return ''
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  } catch {
    return ''
  }
}

/**
 * Throw unless DATABASE_URL names the e2e database exactly. `who` names the caller so an abort says which
 * fixture refused, not just that something did.
 */
export function assertE2eDatabase(who: string): void {
  const dbName = databaseNameFromUrl(process.env.DATABASE_URL)
  if (dbName !== E2E_DATABASE_NAME) {
    throw new Error(
      `ABORT: ${who} refuses to run unless DATABASE_URL names the e2e database exactly ` +
        `(${E2E_DATABASE_NAME}); got '${dbName || '(missing or unparseable)'}'.`,
    )
  }
}
