/**
 * THE COMMAND LINES OF `npm run eu-vat:preflight` (read only) AND `npm run eu-vat:seed` (dry run unless --apply --confirm <digest>), WITHOUT THEIR SIDE EFFECTS: argument parsing, exit codes
 * and rendering. Pure. The environment whitelist, the owner check and the credential-shaped-argument refusal are those of `npm run vat:diff` (lib/tax/vat-difference-cli.ts).
 */
import { accountAllowed, buildVatDiffEnv } from '@/lib/tax/vat-difference-cli'
import { PREFLIGHT_CODES, type EuVatSeedApplyResult, type PreflightResult, type SeedApplyPlan } from '@/lib/tax/eu-vat-preflight'

export { accountAllowed, buildVatDiffEnv as buildEuVatEnv }

export const EU_VAT_PREFLIGHT_COMMAND = 'npm run eu-vat:preflight'
export const EU_VAT_SEED_COMMAND = 'npm run eu-vat:seed'

export const EU_VAT_CLI_CODES = {
  BAD_ARGUMENTS: 'the arguments are not exactly the ones this command takes (run with --help)',
  CREDENTIAL_ARGUMENT: 'an argument looks like it carries a credential; no credential is ever taken from the command line',
  ACCOUNT_NOT_ALLOWED: 'the account running the command is neither root nor the owner of the checkout',
  DATABASE_URL_MISSING: 'DATABASE_URL is not set',
  INTERNAL: 'the command failed before it reached an outcome; nothing is known to have been written unless the output says so',
} as const
export type EuVatCliCode = keyof typeof EU_VAT_CLI_CODES

const CREDENTIAL_SHAPE = /[a-z][a-z0-9+.-]*:\/\/|[?&=](?:password|passwd|pwd|secret|token|key)|(?:password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]/i

export type EuVatArgs = { apply: boolean; confirm: string | null; json: boolean; help: boolean }

/** `allowApply` is false for the preflight, which takes only --json and --help. */
export function parseEuVatArgs(argv: readonly string[], allowApply: boolean): EuVatArgs | { code: EuVatCliCode } {
  const flags = new Set<string>()
  let confirm: string | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (allowApply && arg === '--confirm') {
      const value = argv[i + 1]
      if (confirm !== null || value === undefined || !/^[0-9a-f]{64}$/.test(value)) return { code: value !== undefined && CREDENTIAL_SHAPE.test(value) ? 'CREDENTIAL_ARGUMENT' : 'BAD_ARGUMENTS' }
      confirm = value
      i += 1
      continue
    }
    if (!(arg === '--json' || arg === '--help' || (allowApply && arg === '--apply'))) return { code: CREDENTIAL_SHAPE.test(arg) ? 'CREDENTIAL_ARGUMENT' : 'BAD_ARGUMENTS' }
    if (flags.has(arg)) return { code: 'BAD_ARGUMENTS' }
    flags.add(arg)
  }
  const apply = flags.has('--apply')
  // --apply needs the digest of the dry run, and the digest means nothing without --apply.
  if (apply !== (confirm !== null)) return { code: 'BAD_ARGUMENTS' }
  return { apply, confirm, json: flags.has('--json'), help: flags.has('--help') }
}

export const EU_VAT_PREFLIGHT_EXIT_CODES = [
  { code: 0, name: 'ready', meaning: 'No error finding (advisories, if any, are listed).' },
  { code: 1, name: 'findings', meaning: 'At least one error finding: something is missing or mismatched.' },
  { code: 2, name: 'refused', meaning: 'The stored Xero tax-rate list could not be proven (missing, stale, not stamped, or another organisation), so nothing was judged.' },
  { code: 3, name: 'internal', meaning: 'The command could not start or failed (bad argument, account not allowed, database not given).' },
] as const
export const EU_VAT_SEED_EXIT_CODES = [
  { code: 0, name: 'nothing-to-do-or-applied', meaning: 'A dry run with nothing to change, or the apply was written.' },
  { code: 1, name: 'dry-run-lists-work', meaning: 'A dry run, and the plan has rates to set. Nothing was written.' },
  { code: 2, name: 'refused', meaning: 'The apply was refused (missing or wrong digest, a rate changed or was replaced, nothing to apply). Nothing was written.' },
  { code: 3, name: 'internal', meaning: 'The command could not start or failed.' },
] as const

export function euVatPreflightExitCode(result: PreflightResult): 0 | 1 | 2 {
  if (result.status === 'refused') return 2
  return result.ready ? 0 : 1
}
export function euVatSeedExitCode(result: EuVatSeedApplyResult): 0 | 1 | 2 {
  if (result.applied) return 0
  if (result.refusal !== null) return result.refusal.code === 'NOTHING_TO_APPLY' ? 0 : 2
  return result.plan.changes.length === 0 ? 0 : 1
}

export function renderEuVatPreflightUsage(): string {
  return [
    `Usage: ${EU_VAT_PREFLIGHT_COMMAND} -- [--json]`,
    'Read-only. Compares the declaration lib/tax/eu-vat-seed.json with the IMS database and the STORED copy of Xero\'s tax-rate list and reports what is missing or mismatched.',
    'It never calls Xero or WooCommerce, never writes a tax rate to Xero and never writes to the database. An error finding blocks readiness; an advisory is listed and does not.',
    '',
    'Exit codes:',
    ...EU_VAT_PREFLIGHT_EXIT_CODES.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
    '',
    'Findings:',
    ...Object.entries(PREFLIGHT_CODES).map(([code, meaning]) => `  ${code}: ${meaning}`),
  ].join('\n')
}

export function renderEuVatSeedUsage(): string {
  return [
    `Usage: ${EU_VAT_SEED_COMMAND} -- [--apply --confirm <digest>] [--json]`,
    'Sets schemePostingTaxType and reportingCategory (IOSS or VOEC) on the IMS rates that lib/tax/eu-vat-seed.json declares, and nothing else: it creates no rate, edits no mapping, changes no account',
    'setting and never calls Xero or WooCommerce. It is a DRY RUN unless --apply --confirm <digest> is given, where the digest is the one the dry run printed. Nothing runs it automatically.',
    'A rate is touched only through the WooCommerce mapping that names it, and only when the mapping\'s record of the store rate equals the declaration\'s. Run it after the tax import, the adoption',
    'and `npm run tax:rekey`; then run `npm run eu-vat:preflight`.',
    '',
    'Exit codes:',
    ...EU_VAT_SEED_EXIT_CODES.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
  ].join('\n')
}

export function renderEuVatPreflightText(result: PreflightResult): string {
  if (result.status === 'refused') return [`REFUSED: the stored Xero tax-rate list is not proven: ${result.reason}`, 'Nothing was judged and nothing was written.'].join('\n')
  const lines = [
    `Seed version ${result.seedVersion}; Xero list read ${result.xeroListFetchedAt}`,
    `${result.counts.declaredRates} declared WooCommerce rate(s): ${result.counts.errors} error(s), ${result.counts.advisories} advisory(ies). ${result.ready ? 'READY: no error finding.' : 'NOT READY.'}`,
  ]
  for (const code of Object.keys(PREFLIGHT_CODES)) {
    const rows = result.findings.filter((f) => f.code === code)
    if (rows.length === 0) continue
    lines.push('', `== ${code} [${rows[0]!.severity}] (${rows.length}): ${PREFLIGHT_CODES[code as keyof typeof PREFLIGHT_CODES]}`)
    for (const f of rows) lines.push(`  ${f.subject}: ${f.detail}`)
  }
  return lines.join('\n')
}

function renderPlan(plan: SeedApplyPlan): string[] {
  const lines = [`Seed version ${plan.seedVersion}: ${plan.changes.length} rate(s) to set, ${plan.unchanged} already set, ${plan.skipped.length} skipped.`]
  for (const c of plan.changes) lines.push(`  ${c.imsName} (Woo ${c.wooId}): ${c.from.schemePostingTaxType ?? 'null'} / ${c.from.reportingCategory ?? 'null'}  ->  ${c.to.schemePostingTaxType ?? 'null'} / ${c.to.reportingCategory ?? 'null'}`)
  for (const s of plan.skipped) lines.push(`  SKIPPED Woo ${s.wooId} ${s.reason}: ${s.detail}`)
  lines.push('', `Plan digest: ${plan.digest}`)
  return lines
}

export function renderEuVatSeedText(result: EuVatSeedApplyResult, apply: boolean): string {
  const lines = renderPlan(result.plan)
  if (result.applied) lines.push('', `Applied: ${result.written} rate(s) written.`)
  else if (result.refusal !== null) lines.push('', `REFUSED: ${result.refusal.code}`, result.refusal.detail, 'Nothing was written.')
  else lines.push('', apply ? 'Nothing was written.' : `DRY RUN: nothing was written. To apply exactly this plan: ${EU_VAT_SEED_COMMAND} -- --apply --confirm ${result.plan.digest}`)
  return lines.join('\n')
}
