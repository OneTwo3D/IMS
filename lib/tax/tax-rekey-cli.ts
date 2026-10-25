/**
 * THE COMMAND LINE OF `npm run tax:rekey`, WITHOUT ITS SIDE EFFECTS: argument parsing, exit codes and rendering. Pure. The environment whitelist, the owner check and the
 * credential-shaped-argument refusal are the ones of `npm run vat:diff` (lib/tax/vat-difference-cli.ts): the command holds the application's database client and nothing else.
 */
import { accountAllowed, buildVatDiffEnv } from '@/lib/tax/vat-difference-cli'
import { REKEY_OUTCOMES, REKEY_OUTCOME_MEANING } from '@/lib/tax/tax-rekey-outcomes'
import type { RekeyPlan, TaxRekeyRunResult } from '@/lib/tax/tax-rekey'

export const TAX_REKEY_COMMAND = 'npm run tax:rekey'
export { accountAllowed, buildVatDiffEnv as buildTaxRekeyEnv }

export const TAX_REKEY_EXIT_CODES = [
  { code: 0, name: 'nothing-to-do', meaning: 'Every in-scope rate is ALREADY_CORRECT, or the apply was written (a re-run of an applied plan is also 0).' },
  { code: 1, name: 'plan-lists-work', meaning: 'A preview, and the plan has rates to re-key or rates that cannot be re-keyed (NO_MATCH, AMBIGUOUS, PERCENTAGE_DIFFERS, NAME_MATCHES_INACTIVE). Nothing was written.' },
  { code: 2, name: 'refused', meaning: 'The stored Xero list could not be proven, or the apply was refused (missing/wrong digest, Xero not held, blockers, unposted documents, queued payloads, connection changed). Nothing was written.' },
  { code: 3, name: 'internal', meaning: 'The command could not start or failed (bad argument, account not allowed, database not given).' },
] as const

export const TAX_REKEY_CLI_CODES = {
  BAD_ARGUMENTS: 'the arguments are not exactly "--apply --confirm <64-hex digest>", "--allow-unposted", "--json" and/or "--help" (--confirm and --allow-unposted need --apply)',
  CREDENTIAL_ARGUMENT: 'an argument looks like it carries a credential; no credential is ever taken from the command line',
  ACCOUNT_NOT_ALLOWED: 'the account running the command is neither root nor the owner of the checkout',
  DATABASE_URL_MISSING: 'DATABASE_URL is not set',
  INTERNAL: 'the command failed before it reached an outcome; nothing is known to have been written unless the output says so',
} as const
export type TaxRekeyCliCode = keyof typeof TAX_REKEY_CLI_CODES

const CREDENTIAL_SHAPE = /[a-z][a-z0-9+.-]*:\/\/|[?&=](?:password|passwd|pwd|secret|token|key)|(?:password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]/i

export type TaxRekeyArgs = { apply: boolean; confirm: string | null; allowUnposted: boolean; json: boolean; help: boolean }

export function parseTaxRekeyArgs(argv: readonly string[]): TaxRekeyArgs | { code: TaxRekeyCliCode } {
  const flags = new Set<string>()
  let confirm: string | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--confirm') {
      const value = argv[i + 1]
      if (confirm !== null || value === undefined || !/^[0-9a-f]{64}$/.test(value)) return { code: value !== undefined && CREDENTIAL_SHAPE.test(value) ? 'CREDENTIAL_ARGUMENT' : 'BAD_ARGUMENTS' }
      confirm = value
      i += 1
      continue
    }
    if (arg !== '--apply' && arg !== '--allow-unposted' && arg !== '--json' && arg !== '--help') return { code: CREDENTIAL_SHAPE.test(arg) ? 'CREDENTIAL_ARGUMENT' : 'BAD_ARGUMENTS' }
    if (flags.has(arg)) return { code: 'BAD_ARGUMENTS' }
    flags.add(arg)
  }
  const apply = flags.has('--apply')
  // --apply needs the digest of the preview, and the digest and the flag mean nothing without --apply.
  if (apply !== (confirm !== null) || (!apply && flags.has('--allow-unposted'))) return { code: 'BAD_ARGUMENTS' }
  return { apply, confirm, allowUnposted: flags.has('--allow-unposted'), json: flags.has('--json'), help: flags.has('--help') }
}

export function taxRekeyExitCode(result: TaxRekeyRunResult): 0 | 1 | 2 {
  if (result.refusal !== null) return 2
  if (result.applied) return 0
  const plan = result.plan
  if (plan === null) return 2
  return plan.rows.every((row) => row.outcome === 'ALREADY_CORRECT') ? 0 : 1
}

export function renderTaxRekeyUsage(): string {
  return [
    `Usage: ${TAX_REKEY_COMMAND} -- [--apply --confirm <digest> [--allow-unposted]] [--json]`,
    '',
    'Xero numbers its custom tax codes (TAX001..TAXnnn) per organisation, so IMS rates created against another organisation (a Demo one) carry codes that mean other rates in the',
    'live organisation. This ties each active IMS rate with a custom code to the live Xero type of the SAME NAME (never by code), with the same percentage, ACTIVE, country-consistent.',
    'Without --apply it is a read-only PREVIEW: it prints the plan and its digest and writes nothing. With --apply --confirm <digest> (the digest the preview printed) it re-keys, in',
    'one transaction: a new rate with the live code, the old one deactivated (never edited), supplier defaults and WooCommerce mappings re-pointed. Documents already sent to Xero are not touched.',
    'Not-cancelled orders and purchase orders (posted or not) referencing a re-keyed rate can still post its old code, so they refuse the apply unless --allow-unposted (their lines are then re-pointed); unposted refund lines storing the old code (migrated on the flag only when the code means the old rate alone), queued payloads carrying the old code always refuse it.',
    'A re-key is a pre-go-live operation: an apply is refused (XERO_NOT_HELD) unless the producer-side hold is enforced for xero and Xero is not live (no outbound grant, no live-from instant), read from this command\'s environment as the application\'s producers read theirs.',
    'It reads the stored copy of Xero\'s list (the proven one) and never calls Xero or WooCommerce.',
    '',
    'Exit codes:',
    ...TAX_REKEY_EXIT_CODES.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
    '',
    'Outcomes:',
    ...REKEY_OUTCOMES.map((outcome) => `  ${outcome}: ${REKEY_OUTCOME_MEANING[outcome]}`),
  ].join('\n')
}

function renderPlan(plan: RekeyPlan): string[] {
  const lines = [
    `Xero list: ${plan.list.rowCount} types, read ${plan.list.fetchedAt}`,
    `IMS: ${plan.inScope} active rate(s) with a custom code looked at, ${plan.outOfScope} left alone (no code or a Xero built-in)`,
    `Outcomes: ${REKEY_OUTCOMES.map((outcome) => `${outcome}=${plan.counts[outcome]}`).join(' ')}`,
  ]
  for (const outcome of REKEY_OUTCOMES) {
    const rows = plan.rows.filter((row) => row.outcome === outcome)
    if (rows.length === 0 || outcome === 'ALREADY_CORRECT') continue
    lines.push('', `== ${outcome} (${rows.length}): ${REKEY_OUTCOME_MEANING[outcome]}`)
    for (const row of rows) {
      const live = row.target === null ? '' : `  -> ${row.target.taxType} "${row.target.name}" ${row.target.percent ?? '(no percentage)'}%`
      const refs = plan.references[row.imsRateId]
      const refText = refs === undefined ? '' : `  [suppliers ${refs.suppliers}, storefront mappings ${refs.storefrontMappings}${refs.isDefault ? ', DEFAULT RATE' : ''}, never-posted orders ${refs.unpostedSalesOrders} sales / ${refs.unpostedPurchaseOrders} purchase, already-posted orders ${refs.postedSalesOrders} sales / ${refs.postedPurchaseOrders} purchase, pending refund lines ${refs.pendingRefundLines}${refs.refundSnapshotConflict ? ' (CODE SHARED WITH ANOTHER RATE)' : ''}, queued payloads ${refs.queuedSyncRows + refs.queuedEvents}]`
      for (const c of row.clearedComponents) lines.push(`    component "${c.name}" keeps no code: ${c.taxType} is not a live ACTIVE type, the new row gets none`)
      lines.push(`  ${row.name} [${row.usedFor}${row.countryCode ? ` ${row.countryCode}` : ''}] ${row.currentCode} ${row.imsPercent}%${live}  (${row.matchedBy ?? 'no name match'}: ${row.reason})${refText}`)
    }
  }
  for (const blocker of plan.blockers) lines.push('', `BLOCKER ${blocker.code} ${blocker.taxType}: ${blocker.detail}`)
  lines.push('', `Plan digest: ${plan.digest}`)
  return lines
}

export function renderTaxRekeyText(result: TaxRekeyRunResult): string {
  const lines: string[] = []
  if (result.refusal !== null) lines.push(`REFUSED: ${result.refusal.code}`, result.refusal.detail, 'Nothing was written.')
  if (result.plan !== null) lines.push(...(lines.length > 0 ? [''] : []), ...renderPlan(result.plan))
  lines.push('', `Xero hold: ${result.hold.held ? 'HELD' : 'NOT HELD'} - ${result.hold.detail}${result.hold.held ? '' : ' (an apply is refused: a re-key runs only while Xero writes are held)'}`)
  if (result.applied && result.refusal === null) {
    lines.push('')
    if (result.written === null || result.written.created.length === 0) lines.push('Applied: nothing to re-key (a re-run changes nothing).')
    else {
      const w = result.written
      lines.push(`Applied: ${w.created.length} rate(s) re-keyed (new row created, old row deactivated); re-pointed ${w.suppliersRepointed} supplier default(s), ${w.mappingsRepointed} storefront mapping(s), ${w.salesLinesRepointed} sales line(s), ${w.purchaseLinesRepointed} purchase line(s), ${w.refundLinesRepointed} pending refund line(s).`)
      for (const c of w.created) lines.push(`  ${c.name}: ${c.fromCode} -> ${c.toCode}`)
      lines.push('Run npm run vat:diff to confirm the percentage differences are gone.')
    }
  }
  return lines.join('\n')
}
