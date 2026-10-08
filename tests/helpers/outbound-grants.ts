/**
 * Test helper: declare, in THIS process's environment, the destinations a test may write to - the same
 * way an installation does (lib/security/outbound-write-grant.ts reads only the environment).
 * Every grant is restored by `restoreOutboundGrants()`; call it in an `after` hook.
 */
const NAMES = ['WC_WRITEBACK_ALLOWED_ORIGIN', 'MINTSOFT_WRITE_ALLOWED', 'XERO_WRITE_ALLOWED_TENANT'] as const
type GrantName = (typeof NAMES)[number]

const original = new Map<GrantName, string | undefined>(NAMES.map((name) => [name, process.env[name]]))

export function setOutboundGrant(name: GrantName, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

export function grantXeroWrites(tenantId: string): void {
  setOutboundGrant('XERO_WRITE_ALLOWED_TENANT', tenantId)
}

export function restoreOutboundGrants(): void {
  for (const name of NAMES) setOutboundGrant(name, original.get(name))
}
