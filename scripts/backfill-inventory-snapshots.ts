#!/usr/bin/env tsx

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import { db } from '../lib/db/index'
import { backfillInventorySnapshots } from '../lib/domain/inventory/inventory-snapshot'

function readArg(name: string): string | null {
  const prefix = `--${name}=`
  const inline = process.argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)

  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0) return process.argv[index + 1] ?? null
  return null
}

function usage(): never {
  console.error([
    'Usage: tsx scripts/backfill-inventory-snapshots.ts --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run] [--yes] [--allow-production] [--include-reservations] [--strict-reservations]',
    '',
    'Seeds daily inventory_snapshots from current StockLevel/CostLayer state,',
    'then replays StockMovement rows backwards by day using movement value fields.',
    'When --include-reservations is set, also writes reservation snapshots only',
    'for days whose reservation sources have not changed after that UTC day.',
  ].join('\n'))
  process.exit(1)
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function confirmBackfill(message: string): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    const answer = (await rl.question(`${message}\nContinue? [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  const fromDate = readArg('from')
  if (!fromDate) usage()
  const dryRun = hasFlag('dry-run')
  const yes = hasFlag('yes')
  const allowProduction = hasFlag('allow-production')
  const includeReservationSnapshots = hasFlag('include-reservations')
  const strictReservations = hasFlag('strict-reservations')

  if (process.env.NODE_ENV === 'production' && !allowProduction) {
    throw new Error('Refusing to run inventory snapshot backfill in production without --allow-production')
  }

  if (!dryRun && !yes) {
    const confirmed = await confirmBackfill(
      [
        `About to write inventory snapshots from ${fromDate} to ${readArg('to') ?? 'today'}.`,
        includeReservationSnapshots
          ? 'Reservation snapshot backfill is enabled. Unsupported days will be skipped and reported in reservationBackfill.warnings; run with --dry-run first to preview skipped dates.'
          : 'Reservation snapshot backfill is disabled.',
        'Use --dry-run to preview without writes.',
      ].join(' '),
    )
    if (!confirmed) {
      console.log('Inventory snapshot backfill cancelled.')
      return
    }
  }

  const result = await backfillInventorySnapshots({
    fromDate,
    toDate: readArg('to') ?? undefined,
    dryRun,
    includeReservationSnapshots,
  })

  console.log(JSON.stringify(result, null, 2))
  if (result.missingValueMovementCount > 0) {
    console.warn(
      `${result.missingValueMovementCount} movement(s) lacked value fields; historical value replay kept value unchanged for those rows.`,
    )
  }
  if (strictReservations && result.reservationBackfill.warnings.length > 0) {
    process.exitCode = 2
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void db.$disconnect()
  })
