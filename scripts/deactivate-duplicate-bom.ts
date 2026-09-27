/**
 * o3d-zjsb5.9 round 10: DEACTIVATE A DUPLICATE MANUFACTURING BOM, as a command.
 *
 * THE PROBLEM THIS EXISTS FOR. IMS refuses to write a product's recipe while a SECOND active `Bom`
 * holds recipe lines for that same product, because planning adds up every active recipe and would
 * over-order. The refusal names the duplicate — and until this script there was no way to act on it:
 * a `Bom` has no page and no server action writes to one, so the only remedy was hand-editing
 * production data. During a first load that means a blocked catalogue import inside the quiescent
 * window, which is the worst possible moment to be reaching for `psql`.
 *
 * Usage:
 *   tsx scripts/deactivate-duplicate-bom.ts --list
 *       Show every duplicate the consistency check knows about, with the id to pass below.
 *   tsx scripts/deactivate-duplicate-bom.ts --bom <id> --dry-run
 *       Say what would happen. Writes nothing.
 *   tsx scripts/deactivate-duplicate-bom.ts --bom <id> --expect-db <name>
 *       Deactivate it. The recipe LINES ARE KEPT, so completed build orders still report correctly.
 *       The target database must be CONFIRMED: pass `--expect-db <name>`, or run it on a TTY and type
 *       the name when asked. Without either it refuses (exit 3) and writes nothing — a cloned database
 *       holds the same BOM ids, so the id alone cannot tell two servers apart.
 *
 * It REFUSES (exit 2) when the BOM is a product's live recipe, or when it is the last active recipe
 * of some other BOM-typed product — deactivating in either case would make that product silently
 * unplannable, which is the defect the refusal exists to prevent, moved to a different product.
 *
 * SAFE TO RE-RUN: an already-inactive BOM reports so and exits 0.
 */
import { config } from 'dotenv'

import {
  type ServerIdentity,
  compareServerIdentity,
  describeServerIdentity,
  readServerIdentity,
  unverifiablePins,
} from '../lib/products/bom-recipe-repair'

// .env MUST load before lib/db is imported — that module builds its pg Pool from
// process.env.DATABASE_URL at import time.
config({ path: '.env.local', quiet: true })
config({ quiet: true })

/**
 * SAY WHICH SERVER THIS IS, BEFORE WRITING TO IT.
 *
 * Prints the SERVER'S OWN composite identity — database, address, port, cluster system_identifier — not
 * the URL it was handed, because the URL is the thing that can lie. Also says whether the database
 * carries the disposable-scratch stamp.
 *
 * It does NOT refuse an unstamped database: repairing production is the entire purpose. Being loud is
 * the point — an operator who sees the wrong server here can stop before the write.
 */
async function announceTarget(db: Parameters<typeof readServerIdentity>[0]): Promise<ServerIdentity> {
  const identity = await readServerIdentity(db)
  const stamped = await db.$queryRaw<Array<{ comment: string | null }>>`
    SELECT shobj_description(oid, 'pg_database') AS comment
    FROM pg_database WHERE datname = current_database()
  `
  const { DISPOSABLE_DATABASE_MARKER_PREFIX } = await import('../lib/disposable-database-marker')
  const comment = stamped[0]?.comment ?? ''
  const disposable = comment.includes(`${DISPOSABLE_DATABASE_MARKER_PREFIX}(${identity.database})`)
  console.error(
    `TARGET SERVER: ${describeServerIdentity(identity)}\n`
    + (disposable
      ? '  This database is STAMPED DISPOSABLE — a scratch database, safe to change.\n'
      : '  This database is NOT stamped disposable. Treat it as REAL DATA.\n')
    + (identity.systemIdentifier === 'unavailable'
      ? '  NOTE: system_identifier could not be read on this connection — unusual, since an ordinary\n'
        + '  role can normally read it, so EXECUTE may have been revoked or this may be a managed\n'
        + '  provider that restricts it. A same-name copy on another cluster CANNOT be distinguished\n'
        + '  by it while that is the case.\n'
      : ''),
  )
  return identity
}

/**
 * THE OPERATOR MUST CONFIRM THE TARGET BEFORE A WRITE.
 *
 * Printing the database and then immediately writing is a log line, not a safeguard: by the time the
 * operator reads the name, the transaction has already run. And the BOM id is no protection either --
 * a CLONE of the database contains the same id, so "the id existed, so I must be on the right server"
 * is exactly the reasoning that fails here. `--dry-run` does not help, because it is a separate
 * invocation and constrains nothing about where a later write lands.
 *
 * Two shapes, because both uses are real:
 *   · `--expect-db <name>` for a scripted or logged load-window run, where nobody is at a keyboard;
 *   · a typed confirmation when there is a TTY and no flag.
 * With neither available -- non-interactive and no flag -- it REFUSES and writes nothing, rather than
 * assuming consent from the absence of a human.
 */
/**
 * WHICH ROUTE ESTABLISHED THE TARGET — recorded, because the audit row must state what was actually
 * established rather than which flags happened to appear (round 18).
 */
type IdentityRoute = 'system-identifier' | 'name-only-acknowledged' | 'typed-at-tty'

type Confirmation =
  | { ok: false }
  | {
    ok: true
    pinnedFields: Array<keyof ServerIdentity>
    route: IdentityRoute
    acceptedNameOnly: boolean
  }

/**
 * NAME, HOST AND PORT ARE CLONE-INVARIANT, and this is the whole reason the rule below is written in terms
 * of what is ESTABLISHED rather than which flags were supplied.
 *
 * A restored copy reached at the same address, with the same database name, on the same port has IDENTICAL
 * values for all three. So none of them distinguishes the clone — which was the original finding — and
 * therefore "more pins" is not "stronger". Two clone-invariant pins establish exactly what one does:
 * nothing about which server this is.
 *
 * `system_identifier` is the ONLY field in the composite that differs for a logical restore, and so the
 * only one whose presence changes what has been established. (It does NOT differ for a PHYSICAL clone —
 * pg_basebackup copies it — which is the documented residual in o3d-x23dy and stays documented.)
 *
 * DO NOT "IMPROVE" THIS BY ACCEPTING host + port AS SUFFICIENT. That is the bypass this replaced: adding
 * `--expect-host` with a value copied off the printed banner discharged the acknowledgement and wrote
 * `acceptedNameOnly: false` into the audit row, so the record actively asserted that no acknowledgement was
 * needed at a moment when nothing had identified the target at all.
 */
const CLONE_INVARIANT_FIELDS: ReadonlyArray<keyof ServerIdentity> = ['database', 'host', 'port']

async function confirmTarget(identity: ServerIdentity): Promise<Confirmation> {
  // An operator may pin as much of the composite as they can be sure of. `--expect-db` alone is the
  // friendly form and is NOT sufficient to distinguish a same-name copy — that is why the others exist,
  // and why the limit is spelled out rather than implied.
  const pinned: Partial<ServerIdentity> = {}
  const pinnedFields: Array<keyof ServerIdentity> = []
  const pin = (field: keyof ServerIdentity, value: string | undefined) => {
    if (value === undefined) return
    pinned[field] = value
    pinnedFields.push(field)
  }
  pin('database', argValue('--expect-db'))
  pin('host', argValue('--expect-host'))
  pin('port', argValue('--expect-port'))
  pin('systemIdentifier', argValue('--expect-system-id'))

  if (pinnedFields.length > 0) {
    // A PIN THAT CANNOT BE VERIFIED IS REFUSED, NOT SKIPPED (round 16, HIGH 2). `compareServerIdentity`
    // deliberately skips `systemIdentifier` when either side reads `unavailable` -- correct for the
    // UNPINNED path, where absence of evidence is not evidence of a mismatch -- but letting that one rule
    // serve both cases meant an explicit --expect-system-id was ACCEPTED AND THEN SILENTLY NOT CHECKED.
    // An operator who pins the strongest field and is told nothing when it goes unverified is worse off
    // than one who never pinned it, because they believe they hold a guarantee they do not.
    const unverifiable = unverifiablePins(pinnedFields, { ...identity, ...pinned }, identity)
    if (unverifiable.length > 0) {
      console.error(
        `REFUSED: you pinned ${unverifiable.join(', ')}, but this connection cannot verify it (it reads `
        + '"unavailable"). Nothing was written. An ordinary role can normally read pg_control_system(), so '
        + 'EXECUTE has probably been revoked here — grant it, or drop the pin and pass --accept-name-only '
        + 'to proceed in the weaker mode deliberately.',
      )
      return { ok: false }
    }

    const differences = compareServerIdentity({ ...identity, ...pinned }, identity)
    if (differences.length > 0) {
      console.error(
        'REFUSED: this is not the server you named. Nothing was written.\n'
        + `  you said:  ${differences.map((d) => `${d.field}=${d.expected}`).join(' ')}\n`
        + `  server is: ${describeServerIdentity(identity)}\n`
        + '  Check DATABASE_URL before retrying. A cloned database holds the same BOM ids AND the same\n'
        + '  name, so neither the id nor the name can tell two servers apart.',
      )
      return { ok: false }
    }

    // WHAT WAS ESTABLISHED, not which flags appeared (round 18). Only `system_identifier` can discharge
    // this, because it is the only non-clone-invariant field in the composite — see
    // CLONE_INVARIANT_FIELDS above. Everything else is either an acknowledgement or a refusal.
    //
    // The previous shape asked whether `--expect-db` was the SOLE pin, which made
    // `--expect-db X --expect-host <value from the banner>` a bypass: two clone-invariant pins, no
    // acknowledgement demanded, and an audit row claiming none was needed. Enumerating the bad
    // combinations would have left the next one.
    const establishedByIdentifier = pinnedFields.includes('systemIdentifier')
    const acknowledged = process.argv.includes('--accept-name-only')
    if (!establishedByIdentifier && !acknowledged) {
      const clonePins = pinnedFields.filter((field) => CLONE_INVARIANT_FIELDS.includes(field))
      console.error(
        `REFUSED: you pinned ${clonePins.join(', ')}, but a restored copy of this database has the SAME\n`
        + '  name, the SAME address and the SAME port — so none of those establishes which server you are\n'
        + '  on, however many of them you supply. Nothing was written. Either:\n'
        + `    · pin the cluster:  --expect-system-id ${identity.systemIdentifier}\n`
        + '      using the value RECORDED AT INSTALL, not the one printed above — pasting it back from\n'
        + '      this banner proves only that you can read it;\n'
        + '    · or accept the weaker mode deliberately:  --accept-name-only\n'
        + '      which is recorded in the activity log, so the weaker run is visible afterwards.',
      )
      return { ok: false }
    }
    return {
      ok: true,
      pinnedFields,
      route: establishedByIdentifier ? 'system-identifier' : 'name-only-acknowledged',
      // NEVER asserts an acknowledgement was unnecessary: it is false ONLY when the identifier actually
      // established the target.
      acceptedNameOnly: !establishedByIdentifier,
    }
  }

  if (!process.stdin.isTTY) {
    console.error(
      `REFUSED: about to write to ${describeServerIdentity(identity)}, but there is nobody to confirm `
      + 'it and no --expect-db was given. Nothing was written. Re-run with --expect-db '
      + `${identity.database} if that is genuinely the database you mean.`,
    )
    return { ok: false }
  }

  process.stderr.write(`Type the database name "${identity.database}" to proceed, or anything else to abort: `)
  const typed = await new Promise<string>((resolve) => {
    let buffer = ''
    process.stdin.setEncoding('utf8')
    const onData = (chunk: string) => {
      buffer += chunk
      if (buffer.includes('\n')) {
        process.stdin.off('data', onData)
        process.stdin.pause()
        resolve(buffer.slice(0, buffer.indexOf('\n')).trim())
      }
    }
    process.stdin.on('data', onData)
    process.stdin.resume()
  })
  if (typed !== identity.database) {
    console.error(`REFUSED: you typed "${typed}", which is not "${identity.database}". Nothing was written.`)
    return { ok: false }
  }
  // Typing the name is exactly as strong as --expect-db alone -- the name is clone-invariant -- so it
  // carries the same acknowledgement rather than discharging it.
  return { ok: true, pinnedFields: ['database'], route: 'typed-at-tty', acceptedNameOnly: true }
}

const VALUE_FLAGS = ['--bom', '--expect-db', '--expect-host', '--expect-port', '--expect-system-id']
const BARE_FLAGS = ['--list', '--dry-run', '--accept-name-only']

function validateArgv(argv: string[]): string | null {
  const seen = new Set<string>()
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at]
    if (!token.startsWith('--')) {
      return `unexpected argument "${token}" — every option is a --flag, and values follow their flag`
    }
    // `--flag=value` is rejected rather than accepted, because accepting one spelling and silently
    // dropping the other is how `--dry-run=true` became a write.
    // `--flag=value` would ALREADY be refused by the unknown-option check below, since no known flag
    // contains an `=`. This branch exists for the MESSAGE: "unknown option --dry-run=true" sends an
    // operator hunting for the right flag name when the name was right and only the form was wrong.
    // A mutation proved the point -- deleting this branch changes no exit code, so the test asserts the
    // guidance, which is the only thing it actually provides.
    if (token.includes('=')) {
      const name = token.slice(0, token.indexOf('='))
      if (BARE_FLAGS.includes(name)) {
        return `"${token}" uses --flag=value, but ${name} takes no value — pass just "${name}"`
      }
      if (VALUE_FLAGS.includes(name)) {
        return `"${token}" uses --flag=value; this command takes "${name} <value>" with a space`
      }
      return `unknown option "${name}" (and it was written as --flag=value; values follow their flag `
        + 'with a space)'
    }
    if (!VALUE_FLAGS.includes(token) && !BARE_FLAGS.includes(token)) {
      return `unknown option "${token}". Known options: ${[...BARE_FLAGS, ...VALUE_FLAGS].join(' ')}`
    }
    if (seen.has(token)) return `"${token}" given more than once — which one did you mean?`
    seen.add(token)
    if (VALUE_FLAGS.includes(token)) {
      const value = argv[at + 1]
      if (value === undefined || value.startsWith('--')) return `"${token}" needs a value`
      at += 1
    }
  }
  if (seen.has('--list') && seen.has('--bom')) return '--list and --bom are different modes; pick one'
  if (seen.has('--list') && seen.has('--dry-run')) return '--list writes nothing, so --dry-run is meaningless with it'
  if (!seen.has('--list') && !seen.has('--bom')) return 'nothing to do: pass --list or --bom <id>'

  // THE TARGET DATABASE MUST ALWAYS BE NAMED for a non-interactive write (round 18). Without this,
  // `--expect-host` or `--expect-port` could be supplied ALONE: the run would then never state which
  // database it meant, and because the in-transaction check compares the server against its own preflight
  // reading, an initially wrong target is not caught by it at all. A TTY run is exempt because typing the
  // name at the prompt IS naming it.
  //
  // Checked here rather than after connecting, so a usage mistake cannot reach a database.
  const writing = seen.has('--bom') && !seen.has('--dry-run')
  const pinsSomething = seen.has('--expect-db') || seen.has('--expect-host')
    || seen.has('--expect-port') || seen.has('--expect-system-id')
  if (writing && !process.stdin.isTTY && !seen.has('--expect-db')) {
    return pinsSomething
      ? 'a write must always name the target database: add --expect-db <name>. Pinning only --expect-host '
        + 'or --expect-port never says WHICH database you meant'
      : 'a write must name the target database: add --expect-db <name>'
  }
  return null
}

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag)
  return at === -1 ? undefined : process.argv[at + 1]
}

async function main() {
  // FIRST, before any import that opens a connection.
  const problem = validateArgv(process.argv.slice(2))
  if (problem) {
    console.error(
      `Usage error: ${problem}\n\n`
      + '  tsx scripts/deactivate-duplicate-bom.ts --list\n'
      + '  tsx scripts/deactivate-duplicate-bom.ts --bom <id> --dry-run\n'
      + '  tsx scripts/deactivate-duplicate-bom.ts --bom <id> --expect-db <name>\n'
      + '      [--expect-host <addr>] [--expect-port <n>] [--expect-system-id <n>]\n'
      + '      [--accept-name-only]  (REQUIRED if you pin only --expect-db)\n',
    )
    return 1
  }

  const { db } = await import('../lib/db/index')
  const { findBomRecipeDrift } = await import('../lib/products/bom-recipe')
  const { deactivateDuplicateBomRecipe, describeBomRecipeRepair } = await import(
    '../lib/products/bom-recipe-repair'
  )

  const identity = await announceTarget(db)

  if (process.argv.includes('--list')) {
    const duplicates = (await findBomRecipeDrift(db)).filter((row) => row.kind === 'duplicate-unclaimed-bom')
    if (duplicates.length === 0) {
      console.log('No duplicate manufacturing BOMs found.')
      return 0
    }
    console.error(`${duplicates.length} product(s) with duplicate manufacturing BOM(s):`)
    for (const row of duplicates) console.error(`  ${row.sku}: ${row.detail}`)
    console.error(
      '\nDeactivate one with:  tsx scripts/deactivate-duplicate-bom.ts --bom <id>'
      + '\n(add --dry-run first to see what it would do)',
    )
    return 1
  }

  const bomId = argValue('--bom')
  if (!bomId) {
    console.error(
      'Usage:\n'
      + '  tsx scripts/deactivate-duplicate-bom.ts --list\n'
      + '  tsx scripts/deactivate-duplicate-bom.ts --bom <id> --expect-db <name>\n'
      + '  tsx scripts/deactivate-duplicate-bom.ts --bom <id> --dry-run',
    )
    return 64
  }
  const dryRun = process.argv.includes('--dry-run')

  // The gate applies to the WRITE only. `--list` returned above and `--dry-run` rolls back, so
  // demanding confirmation for either would train operators to type past it.
  let confirmation: Confirmation = {
    ok: true, pinnedFields: [], route: 'name-only-acknowledged', acceptedNameOnly: true,
  }
  if (!dryRun) {
    confirmation = await confirmTarget(identity)
    if (!confirmation.ok) return 3
  }

  // ONE TRANSACTION, so the lock the repair takes actually covers the decision AND the write, and a
  // dry run can compute the real answer and then throw it away rather than asking a different
  // question from the real one.
  const SENTINEL = 'bom-repair-dry-run'
  let outcome
  try {
    outcome = await db.$transaction(async (tx) => {
      const result = await deactivateDuplicateBomRecipe(tx, {
        bomId,
        actor: process.env.SUDO_USER || process.env.USER || undefined,
        database: identity.database,
        // RE-CHECKED INSIDE THE TRANSACTION. Everything above happened on a different statement, and
        // a check before the transaction can be defeated by anything that changes which server the
        // connection reaches in between -- which is the whole reason this banner exists.
        expectIdentity: identity,
        pinnedFields: confirmation.ok ? confirmation.pinnedFields : [],
        acceptedNameOnly: confirmation.ok ? confirmation.acceptedNameOnly : false,
        identityRoute: confirmation.ok ? confirmation.route : null,
        // Established OUTSIDE this transaction, so the optional query never runs inside one where the role
        // cannot read it (round 16, HIGH 3, preferred shape).
        systemIdentifierReadable: identity.systemIdentifier !== 'unavailable',
      })
      if (dryRun) throw Object.assign(new Error(SENTINEL), { result })
      return result
    })
  } catch (error) {
    if (error instanceof Error && error.message === SENTINEL) {
      const result = (error as Error & { result: Awaited<ReturnType<typeof deactivateDuplicateBomRecipe>> }).result
      console.log(`DRY RUN — nothing was written.\n${describeBomRecipeRepair(result)}`)
      if (result.kind === 'wrong-database' || result.kind === 'identity-unverifiable') return 3
      return result.kind === 'claimed' || result.kind === 'sole-recipe-for-other-parent' ? 2 : 0
    }
    throw error
  }

  const line = describeBomRecipeRepair(outcome)
  if (outcome.kind === 'identity-unverifiable') {
    console.error(line)
    return 3
  }
  if (outcome.kind === 'wrong-database') {
    console.error(line)
    return 3
  }
  if (outcome.kind === 'claimed' || outcome.kind === 'sole-recipe-for-other-parent') {
    console.error(line)
    return 2
  }
  if (outcome.kind === 'not-found') {
    console.error(line)
    return 1
  }
  console.log(line)
  return 0
}

main()
  .then(async (code) => {
    const { db } = await import('../lib/db/index')
    await db.$disconnect()
    process.exit(code)
  })
  .catch(async (error) => {
    console.error(error)
    const { db } = await import('../lib/db/index')
    await db.$disconnect()
    process.exit(1)
  })
