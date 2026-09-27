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

// .env MUST load before lib/db is imported — that module builds its pg Pool from
// process.env.DATABASE_URL at import time.
config({ path: '.env.local', quiet: true })
config({ quiet: true })

/**
 * SAY WHICH DATABASE THIS IS, BEFORE WRITING TO IT.
 *
 * This runs during a load window, by hand, against whatever `DATABASE_URL` resolves to — and this repo
 * has already been bitten twice by that resolution not being what the operator believed: a probe table
 * created in the gate's scratch database, and a socket-form URL that lost its `?host=` and silently
 * retargeted the shared cluster. A repair command is the worst place for that surprise, so it prints
 * the server's OWN answer (not the URL it was handed, which is the thing that can lie) and says
 * whether the database carries the disposable-scratch stamp.
 *
 * It does NOT refuse an unstamped database: repairing production is the entire purpose. Being loud is
 * the point — an operator who sees the wrong database name here can stop before the write.
 */
async function announceTarget(db: {
  $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>
}): Promise<string> {
  const rows = (await db.$queryRaw`
    SELECT current_database()::text AS database,
           current_user::text       AS username,
           COALESCE(inet_server_addr()::text, 'local socket') AS host,
           COALESCE(inet_server_port()::text, '?')            AS port,
           COALESCE(shobj_description(oid, 'pg_database'), '') AS comment
    FROM pg_database WHERE datname = current_database()
  `) as Array<{ database: string; username: string; host: string; port: string; comment: string }>
  const row = rows[0]
  if (!row) return 'unknown'
  const { DISPOSABLE_DATABASE_MARKER_PREFIX } = await import('../lib/disposable-database-marker')
  const disposable = row.comment.includes(`${DISPOSABLE_DATABASE_MARKER_PREFIX}(${row.database})`)
  console.error(
    `TARGET DATABASE: ${row.database}  (host ${row.host}:${row.port}, user ${row.username})\n`
    + (disposable
      ? '  This database is STAMPED DISPOSABLE — a scratch database, safe to change.\n'
      : '  This database is NOT stamped disposable. Treat it as REAL DATA.\n'),
  )
  return row.database
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
async function confirmTarget(targetDatabase: string): Promise<boolean> {
  const expected = argValue('--expect-db')
  if (expected !== undefined) {
    if (expected === targetDatabase) return true
    console.error(
      `REFUSED: --expect-db said "${expected}" but this connection is to "${targetDatabase}". `
      + 'Nothing was written. A cloned database holds the same BOM ids, so the id you passed cannot '
      + 'tell these apart -- check DATABASE_URL before retrying.',
    )
    return false
  }

  if (!process.stdin.isTTY) {
    console.error(
      `REFUSED: about to write to "${targetDatabase}", but there is nobody to confirm it and no `
      + '--expect-db was given. Nothing was written. Re-run with --expect-db '
      + `${targetDatabase} if that is genuinely the database you mean.`,
    )
    return false
  }

  process.stderr.write(`Type the database name "${targetDatabase}" to proceed, or anything else to abort: `)
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
  if (typed === targetDatabase) return true
  console.error(`REFUSED: you typed "${typed}", which is not "${targetDatabase}". Nothing was written.`)
  return false
}

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag)
  return at === -1 ? undefined : process.argv[at + 1]
}

async function main() {
  const { db } = await import('../lib/db/index')
  const { findBomRecipeDrift } = await import('../lib/products/bom-recipe')
  const { deactivateDuplicateBomRecipe, describeBomRecipeRepair } = await import(
    '../lib/products/bom-recipe-repair'
  )

  const targetDatabase = await announceTarget(db)

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
  if (!dryRun && !(await confirmTarget(targetDatabase))) return 3

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
        database: targetDatabase,
        // RE-CHECKED INSIDE THE TRANSACTION. Everything above happened on a different statement, and
        // a check before the transaction can be defeated by anything that changes which server the
        // connection reaches in between -- which is the whole reason this banner exists.
        expectDatabase: targetDatabase,
      })
      if (dryRun) throw Object.assign(new Error(SENTINEL), { result })
      return result
    })
  } catch (error) {
    if (error instanceof Error && error.message === SENTINEL) {
      const result = (error as Error & { result: Awaited<ReturnType<typeof deactivateDuplicateBomRecipe>> }).result
      console.log(`DRY RUN — nothing was written.\n${describeBomRecipeRepair(result)}`)
      if (result.kind === 'wrong-database') return 3
      return result.kind === 'claimed' || result.kind === 'sole-recipe-for-other-parent' ? 2 : 0
    }
    throw error
  }

  const line = describeBomRecipeRepair(outcome)
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
