/**
 * THE COMMAND LINE OF `npm run vat:diff`, WITHOUT ITS SIDE EFFECTS: argument parsing, the environment a run keeps, the exit codes and the
 * rendering. Pure. Same style as lib/reconciliation-pack/cli.ts: the account is judged by uid, the environment is a short whitelist, an
 * argument that looks like a credential is refused unseen, and everything printed about a refusal is a closed code.
 */

import { accountAllowed, KEPT_ENV } from '@/lib/reconciliation-pack/cli'
import { VAT_DIFFERENCE_REASONS, VAT_DIFFERENCE_REASON_LIST, type VatDifferenceReport } from '@/lib/tax/vat-difference-report'

export const VAT_DIFF_COMMAND = 'npm run vat:diff'

export const VAT_DIFF_EXIT_CODES = [
  { code: 0, name: 'no-differences', meaning: 'All three systems were read and proven, and they use the same set of VAT rates.' },
  { code: 1, name: 'differences', meaning: 'All three systems were read and proven, and the report lists the differences.' },
  { code: 2, name: 'refused', meaning: 'A side could not be read or proven (the stored Xero list, the IMS data or WooCommerce). Nothing was compared: this is NOT "no differences".' },
  { code: 3, name: 'internal', meaning: 'The command could not start or failed (bad argument, account not allowed, database not given). Nothing was compared.' },
] as const

export const VAT_DIFF_CLI_CODES = {
  BAD_ARGUMENTS: 'the arguments are not exactly "--json" and/or "--help" (no other argument is accepted)',
  CREDENTIAL_ARGUMENT: 'an argument looks like it carries a credential; no credential is ever taken from the command line',
  ACCOUNT_NOT_ALLOWED: 'the account running the command is neither root nor the owner of the checkout',
  DATABASE_URL_MISSING: 'DATABASE_URL is not set',
  INTERNAL: 'the report failed before it reached an outcome; treat as not compared',
} as const
export type VatDiffCliCode = keyof typeof VAT_DIFF_CLI_CODES

const CREDENTIAL_SHAPE = /[a-z][a-z0-9+.-]*:\/\/|[?&=](?:password|passwd|pwd|secret|token|key)|(?:password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]/i

export type VatDiffArgs = { json: boolean; help: boolean }

export function parseVatDiffArgs(argv: readonly string[]): VatDiffArgs | { code: VatDiffCliCode } {
  const flags = new Set<string>()
  for (const arg of argv) {
    if (arg !== '--json' && arg !== '--help') return { code: CREDENTIAL_SHAPE.test(arg) ? 'CREDENTIAL_ARGUMENT' : 'BAD_ARGUMENTS' }
    if (flags.has(arg)) return { code: 'BAD_ARGUMENTS' }
    flags.add(arg)
  }
  return { json: flags.has('--json'), help: flags.has('--help') }
}

/** The only variables a run keeps: the pack's base set, plus the keys that decrypt the stored storefront credentials. Never a PG variable, a grant or a loader variable. */
export const VAT_DIFF_KEPT_ENV = [...KEPT_ENV, 'SETTINGS_ENCRYPTION_KEY', 'ENCRYPTION_KEY'] as const

export function buildVatDiffEnv(parent: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home }
  for (const name of VAT_DIFF_KEPT_ENV) {
    const value = parent[name]
    if (value !== undefined && value !== '') env[name] = value
  }
  return env
}

export { accountAllowed }

export function vatDiffExitCode(report: VatDifferenceReport): 0 | 1 | 2 {
  return report.status === 'refused' ? 2 : report.differences.length === 0 ? 0 : 1
}

export function renderVatDiffUsage(): string {
  return [
    `Usage: ${VAT_DIFF_COMMAND} [-- --json]`,
    '',
    'Read-only. Compares the VAT rates in Xero (the stored, proven copy of its list), IMS (tax rates, components, storefront mappings) and WooCommerce',
    '(GET /wp-json/wc/v3/taxes, every page, with the stored credentials) and lists every difference with a reason code. It writes nothing anywhere.',
    '',
    'Exit codes:',
    ...VAT_DIFF_EXIT_CODES.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
    '',
    'Reason codes:',
    ...VAT_DIFFERENCE_REASON_LIST.map((reason) => `  ${reason}: ${VAT_DIFFERENCE_REASONS[reason]}`),
  ].join('\n')
}

export function renderVatDiffText(report: VatDifferenceReport): string {
  if (report.status === 'refused') {
    return [`REFUSED: ${report.code}${report.wooReason ? ` (${report.wooReason})` : ''}`, report.detail, 'Nothing was compared. This is not "no differences".'].join('\n')
  }
  const lines = [
    `Xero: ${report.xero.types} tax types (${report.xero.active} active), read ${report.xero.fetchedAt}`,
    `IMS: ${report.ims.activeRates} active tax rates, ${report.ims.mappings} WooCommerce mappings`,
    `WooCommerce: ${report.woo.rates} tax rates`,
    report.differences.length === 0 ? 'No differences: the three systems use the same set of VAT rates.' : `${report.differences.length} difference(s):`,
  ]
  for (const difference of report.differences) {
    const values = [['xero', difference.xero], ['ims', difference.ims], ['woo', difference.woo]].filter(([, value]) => value !== null).map(([name, value]) => `${name}=${value}`).join(' ')
    const ids = [difference.xeroTaxType && `xero:${difference.xeroTaxType}`, difference.imsRateId && `ims:${difference.imsRateId}`, difference.wooRateId && `woo:${difference.wooRateId}`].filter(Boolean).join(' ')
    lines.push(`  ${difference.reason}  ${difference.label}  [${ids}]${values ? `  ${values}` : ''}`)
  }
  return lines.join('\n')
}
