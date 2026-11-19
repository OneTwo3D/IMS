export const BRIDGE_HEADER_FOR_TESTS = '# bridge_writers_status v1'

type Options = { generatedAt?: string; lastTrigger?: string; units?: Record<string, string>; extraUnit?: string; journalExit?: number | null; journalReadable?: 0 | 1 | null; journalPersistent?: 0 | 1 | null; journalEarliest?: string | null }

/** A well-formed report (all three units masked and inactive). */
export function sampleReport(options: Options = {}): string {
  const masked = 'LoadState=masked ActiveState=inactive UnitFileState=masked'
  const units = ['wc-mintsoft-order-sweep.timer', 'wc-mintsoft-order-sweep.service', 'wc-mintsoft-webhook.service']
  return [
    BRIDGE_HEADER_FOR_TESTS,
    'host: bridge-host',
    `generated_at: ${options.generatedAt ?? '2026-12-20T11:55:00Z'}`,
    ...units.map((unit) => `unit: ${unit} ${options.units?.[unit] ?? masked}`),
    ...(options.extraUnit ? [`unit: ${options.extraUnit} ${masked}`] : []),
    // The default carries `journal_exit: 0`, as the script prints it; `journalExit: null` is a report from an older script.
    ...(options.journalExit === null ? [] : [`journal_exit: ${options.journalExit ?? 0}`]),
    // The defaults are a readable, persistent journal reaching back to October; `null` leaves the line out (an older script).
    ...(options.journalReadable === null ? [] : [`journal_readable: ${options.journalReadable ?? 1}`]),
    ...(options.journalPersistent === null ? [] : [`journal_persistent: ${options.journalPersistent ?? 1}`]),
    ...(options.journalEarliest === null ? [] : [`journal_earliest: ${options.journalEarliest ?? '2026-10-01T00:00:00Z'}`]),
    'boot_id: 0123456789abcdef0123456789abcdef',
    'boot_started: 2026-12-01T00:00:00Z',
    `last_trigger: ${options.lastTrigger ?? '2026-11-30T23:55:01Z'}`,
    '',
  ].join('\n')
}
