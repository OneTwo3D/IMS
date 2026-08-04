/**
 * o3d-iaqy — stop a non-production instance talking to the live accounting organisation.
 *
 * Root cause of o3d-t74p, where the e2e instance posted 553 objects into the live Xero
 * organisation — including 14 payments — over eleven days before anyone noticed. There was no
 * technical barrier at all: the OAuth flow accepts whichever organisation the operator picks on
 * the consent screen and stores it, and nothing ever compared that against what the instance is
 * permitted to talk to. A dev or e2e instance connecting to production is indistinguishable, to
 * the code, from production doing so.
 *
 * NODE_ENV CANNOT BE USED for this. On this deployment the e2e service runs NODE_ENV=production
 * and the stage service runs NODE_ENV=development — the opposite of what the names suggest. Any
 * guard keyed on it would have been wrong in exactly the case that mattered. So the policy is
 * explicit configuration, per instance, and nothing is inferred.
 *
 * ACCOUNTING_ALLOWED_TENANT_IDS, read per connector with an optional connector-specific
 * override, has three states:
 *
 *   unset            — permissive, but every binding is recorded. This is the legacy behaviour
 *                      and is kept as the default ON PURPOSE: a guard that refuses writes the
 *                      moment it ships would stop live invoicing on deploy, which is a worse
 *                      failure than the one it prevents. Production may leave it unset.
 *   a list of ids    — only those tenants/realms may be connected or called.
 *   set but EMPTY    — nothing may be connected or called. This is the explicit fail-closed
 *                      setting for an instance that must never reach a real organisation.
 *
 * Non-production instances MUST set it. That is a deployment obligation this module cannot
 * enforce on its own, and saying so plainly is better than pretending a heuristic covers it.
 */

export type TenantGuardDecision =
  | { allowed: true }
  | { allowed: false; reason: string }

const CONNECTOR_ENV: Record<string, string> = {
  xero: 'XERO_ALLOWED_TENANT_IDS',
  quickbooks: 'QUICKBOOKS_ALLOWED_REALM_IDS',
}

/** Parsed allowlist, or null when unconfigured (permissive). */
export function readTenantAllowlist(
  connector: string,
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const specific = CONNECTOR_ENV[connector]
  // A connector-specific value wins even when empty, so one connector can be locked down
  // without locking down the other.
  const raw = specific !== undefined && env[specific] !== undefined
    ? env[specific]
    : env.ACCOUNTING_ALLOWED_TENANT_IDS
  if (raw === undefined) return null
  return raw.split(',').map((id) => id.trim()).filter((id) => id.length > 0)
}

/**
 * Whether this instance may talk to `tenantId` on `connector`.
 *
 * Called BOTH when a token is about to be persisted and immediately before every remote call.
 * Either alone is insufficient: the connect-time check cannot catch a config change made after
 * connection, or a token restored from a copy of another environment's database, and the
 * call-time check cannot give the operator a useful message at the moment they chose the wrong
 * organisation.
 */
export function checkTenantAllowed(params: {
  connector: string
  tenantId: string | null | undefined
  env?: Record<string, string | undefined>
}): TenantGuardDecision {
  const { connector, tenantId, env } = params
  const allowlist = readTenantAllowlist(connector, env)
  if (allowlist === null) return { allowed: true }

  const id = tenantId?.trim() ?? ''
  if (id.length > 0 && allowlist.includes(id)) return { allowed: true }

  const configured = allowlist.length === 0
    ? 'this instance is configured to reach NO accounting organisation'
    : `this instance may only use: ${allowlist.join(', ')}`
  return {
    allowed: false,
    reason: `Refusing to use ${connector} organisation ${id || '(none)'} — ${configured}. `
      + 'This guard exists because an e2e instance once posted 553 objects, including 14 '
      + 'payments, into the live organisation. If this is deliberate, change the allowlist '
      + `(${CONNECTOR_ENV[connector] ?? 'ACCOUNTING_ALLOWED_TENANT_IDS'}) rather than removing `
      + 'the check.',
  }
}

/** Thrown at the call boundary so a disallowed tenant fails loudly rather than posting. */
export class AccountingTenantNotAllowedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'AccountingTenantNotAllowedError'
  }
}

export function assertTenantAllowed(params: {
  connector: string
  tenantId: string | null | undefined
  env?: Record<string, string | undefined>
}): void {
  const decision = checkTenantAllowed(params)
  if (!decision.allowed) throw new AccountingTenantNotAllowedError(decision.reason)
}
