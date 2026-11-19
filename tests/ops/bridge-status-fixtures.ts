export const BRIDGE_HEADER_FOR_TESTS = '# bridge_writers_status v1'

type Options = { generatedAt?: string; lastTrigger?: string; units?: Record<string, string>; extraUnit?: string }

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
    `last_trigger: ${options.lastTrigger ?? '2026-11-30T23:55:01Z'}`,
    '',
  ].join('\n')
}
