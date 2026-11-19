import { pathToFileURL } from 'node:url'

import {
  SWITCH_BY_MAX,
  SWITCH_REASON_MAX,
  readSwitch,
  resolveSwitchKey,
  validateSwitchValue,
  writeSwitch,
  adminRefusal,
  crossKeyRefusal,
  type SwitchWriteClient,
} from '@/lib/domain/settings/system-switches'

/**
 * `npm run settings:get -- --key <k>`   read only: the stored value, the default, the last audit entry and who wrote it.
 * `npm run settings:set -- --key <k> --value <v> --by <name> --reason "<text>" [--yes]`
 *     without --yes: a dry run showing the current and proposed values, writing nothing;
 *     with --yes: the settings row and an activity-log entry (who, why, old, new) in ONE transaction, then a read-back.
 *
 * The Mintsoft supplier switches are ADMIN with a fresh sign-in in the screen. A shell has no session, so ADMIN authority is ASSUMED from shell
 * access, and writing one needs --confirm-admin as well as --yes; the audit entry records the operator (--by) and that ADMIN was assumed.
 *
 * Only the allowlisted system-managed switches in lib/domain/settings/system-switches.ts; credentials are refused. Never prints a secret.
 * Exit codes: 0 ok, 3 usage or refused input, 5 failed.
 */

type Logger = Pick<typeof console, 'log' | 'error'>
type CliDb = SwitchWriteClient & Parameters<typeof readSwitch>[0]

export type SettingsCliOptions = {
  mode: 'get' | 'set'
  argv?: string[]
  db?: CliDb
  stdout?: Pick<Logger, 'log'>
  stderr?: Pick<Logger, 'error'>
  disconnect?: () => Promise<void>
  /** Test seam for the storefront e-mail turn-on interlock (environment, clock, the store's native e-mail read). Absent = the live ones. */
  interlock?: import('@/lib/domain/storefront-customer-email/switch-on-interlock').InterlockDeps
}

export async function runSettingsCli(options: SettingsCliOptions): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  const args = options.argv ?? process.argv.slice(2)
  const usage = options.mode === 'get'
    ? 'Usage: npm run settings:get -- --key <key>'
    : 'Usage: npm run settings:set -- --key <key> --value <value> --by <name> --reason "<text>" [--yes] [--confirm-admin]'

  const values: Record<string, string> = {}
  let yes = false
  let confirmAdmin = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--yes' && options.mode === 'set') { yes = true; continue }
    if (arg === '--confirm-admin' && options.mode === 'set') { confirmAdmin = true; continue }
    const allowed = options.mode === 'get' ? ['--key'] : ['--key', '--value', '--by', '--reason']
    if (!allowed.includes(arg)) { stderr.error(usage); return 3 }
    const value = args[i + 1]
    if (value === undefined || (value.startsWith('--') && arg !== '--reason') || arg.slice(2) in values) { stderr.error(usage); return 3 }
    values[arg.slice(2)] = value
    i += 1
  }

  const resolved = resolveSwitchKey(values.key)
  if (!resolved.ok) { stderr.error(resolved.error); return 3 }
  const def = resolved.def

  let proposed = ''
  let by = ''
  let reason = ''
  if (options.mode === 'set') {
    if (values.value === undefined) { stderr.error(usage); return 3 }
    const valid = validateSwitchValue(def, values.value)
    if (!valid.ok) { stderr.error(valid.error); return 3 }
    proposed = valid.value
    by = (values.by ?? '').trim()
    reason = (values.reason ?? '').trim()
    if (!by || by.length > SWITCH_BY_MAX || by.includes('@')) { stderr.error(`--by must be a name (1-${SWITCH_BY_MAX} characters, not an e-mail address).`); return 3 }
    if (!reason || reason.length > SWITCH_REASON_MAX) { stderr.error(`--reason is required (1-${SWITCH_REASON_MAX} characters).`); return 3 }
  }

  try {
    const db = options.db ?? ((await import('@/lib/db')).db as unknown as CliDb)
    const current = await readSwitch(db, def)
    if (options.mode === 'get') {
      stdout.log(`${def.key}`)
      stdout.log(`  stored:    ${current.stored === null ? '(no row)' : current.stored}`)
      stdout.log(`  effective: ${current.effective}`)
      stdout.log(`  default:   ${current.defaultValue}`)
      const a = current.lastAudit
      stdout.log(a
        ? `  last audit: ${a.at.toISOString()} by ${a.by ?? 'unknown'}: ${a.oldValue ?? '(unset)'} -> ${a.newValue ?? '?'} (${a.reason ?? 'no reason recorded'})`
        : '  last audit: none (never set through settings:set)')
      return 0
    }

    const refusal = await crossKeyRefusal(db, def, proposed)
    if (refusal) { stderr.error(refusal); return 3 }
    if (def.turnOnInterlock === 'storefront-customer-email' && proposed === 'true' && current.stored !== 'true') {
      // Turning customer e-mail for storefront orders ON: refused unless step W is live and WooCommerce's native e-mails are off (the same rule as the screen).
      const { storefrontEmailSwitchOnRefusal } = await import('@/lib/domain/storefront-customer-email/switch-on-interlock')
      const interlock = await storefrontEmailSwitchOnRefusal(options.interlock)
      if (interlock) { stderr.error(interlock); return 3 }
    }
    if (def.adminOnly && yes && !confirmAdmin) { stderr.error(adminRefusal(def)); return 3 }
    if (!yes) {
      if (def.adminOnly) stdout.log(`${def.key} is an ADMIN switch in the screen; writing it needs --yes --confirm-admin (ADMIN authority is assumed from shell access).`)
      stdout.log(`Dry run. ${def.key}: current ${current.stored === null ? `(no row, default ${def.defaultValue})` : current.stored}, proposed ${proposed}${current.stored === proposed ? ' (no change)' : ''}.`)
      stdout.log(`By ${by}: ${reason}`)
      stdout.log('Nothing written; add --yes to apply.')
      return 0
    }
    const result = await writeSwitch(db, { def, value: proposed, by, reason, adminConfirmed: confirmAdmin })
    if (!result.ok) { stderr.error(result.error); return 3 }
    if (!result.changed) { stdout.log(`${def.key} is already ${proposed}; nothing written, no audit entry added.`); return 0 }
    const back = await readSwitch(db, def)
    if (back.stored !== proposed) { stderr.error(`Read-back of ${def.key} returned a different value than was written.`); return 5 }
    stdout.log(`Set ${def.key}: ${result.oldValue ?? '(unset)'} -> ${back.stored}. Audit entry written; read back OK.`)
    return 0
  } catch (error) {
    // Never print the error object: it can carry connection details. The message class is enough to act on.
    stderr.error(`The switch could not be ${options.mode === 'get' ? 'read' : 'set'}${error instanceof Error && error.name ? ` (${error.name})` : ''}. Nothing was committed.`)
    return 5
  } finally {
    if (options.disconnect) await options.disconnect()
    else if (!options.db) {
      const { db } = await import('@/lib/db')
      await db.$disconnect()
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] === 'get' ? 'get' : 'set'
  runSettingsCli({ mode, argv: process.argv.slice(3) }).then((code) => process.exit(code), () => process.exit(5))
}
