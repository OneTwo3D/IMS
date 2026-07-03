/**
 * Deterministic keyword → CN8 rules for HS classification (6igm.1). Port of the hs-code-woo
 * plugin's keyword-rules.php. Used as a fail-safe fallback when the Claude classifier tier is
 * unavailable, so a product still gets a plausible (declarable) code rather than none.
 *
 * Rules are matched in order against the lower-cased product text; the first rule with any
 * matching pattern wins. Keep this list in rough sync with the plugin's keyword-rules.php.
 */
export const KEYWORD_DEFAULT_CODE = '84859090'
export const KEYWORD_DEFAULT_DESCRIPTION = 'component for FDM 3D printer'

export type HsKeywordRule = {
  patterns: string[]
  cnCode: string
  customsDescription: string
}

export const HS_KEYWORD_RULES: readonly HsKeywordRule[] = [
  { patterns: ['harness', 'loom', 'wiring harness', 'cable harness'], cnCode: '85444290', customsDescription: 'wiring harness for 3D printer' },
  { patterns: ['filament', 'abs spool', 'asa spool', 'petg spool', 'pla spool'], cnCode: '39169090', customsDescription: 'plastic monofilament for 3D printing' },
  { patterns: ['3d printer kit', 'printer kit', 'complete kit', 'voron kit', 'vzbot kit'], cnCode: '84852000', customsDescription: 'FDM 3D printer, self-build kit' },
  { patterns: ['t-shirt', 't shirt', 'tee shirt'], cnCode: '61091000', customsDescription: 'cotton T-shirt, knitted' },
  { patterns: ['hoodie', 'sweatshirt'], cnCode: '61102099', customsDescription: 'cotton hooded sweatshirt, knitted' },
  { patterns: ['mug', 'ceramic cup'], cnCode: '69120089', customsDescription: 'ceramic mug' },
  { patterns: ['activated carbon', 'carbon pellet', 'carbon pellets', 'carbon granules'], cnCode: '38021000', customsDescription: 'activated carbon air-filter media' },
  { patterns: ['activated alumina'], cnCode: '38029000', customsDescription: 'activated alumina air-filter media' },
  { patterns: ['potassium permanganate', 'permanganate media'], cnCode: '38249996', customsDescription: 'potassium-permanganate air-filter media' },
  { patterns: ['stepper motor', 'nema17', 'nema 17', 'motor kit'], cnCode: '85011099', customsDescription: 'electric stepper motor' },
  { patterns: ['fan', 'blower'], cnCode: '84145995', customsDescription: 'cooling fan for 3D printer' },
  { patterns: ['thermistor', 'temperature sensor', 'temp sensor', 'pt100', 'pt1000'], cnCode: '90251900', customsDescription: 'temperature sensor for 3D printer' },
  { patterns: ['screw', 'bolt', 'm3x', 'm4x', 'm5x', 'cap head', 'button head', 'socket head'], cnCode: '73181595', customsDescription: 'steel screw or bolt, threaded' },
  { patterns: ['nut', 't-nut', 'tnut', 'hex nut'], cnCode: '73181639', customsDescription: 'steel nut, threaded' },
  { patterns: ['heat insert', 'threaded insert', 'brass insert'], cnCode: '73181900', customsDescription: 'brass threaded insert' },
  { patterns: ['washer', 'pin', 'dowel', 'shaft'], cnCode: '73182900', customsDescription: 'steel washer or pin, non-threaded' },
  { patterns: ['connector', 'plug', 'socket', 'terminal', 'jst', 'molex', 'microfit', 'micro-fit'], cnCode: '85366990', customsDescription: 'electrical connector, up to 1000 V' },
  { patterns: ['wire', 'cable', 'silicone cable'], cnCode: '85444993', customsDescription: 'insulated electrical wire, up to 80 V' },
  { patterns: ['nozzle'], cnCode: '84859090', customsDescription: 'brass nozzle, 3D-printer extruder' },
  { patterns: ['hotend', 'hot end', 'heatbreak', 'heat break', 'heater block'], cnCode: '84859090', customsDescription: 'hotend heat-block assembly, 3D printer' },
  { patterns: ['controller board', 'control board', 'mainboard', 'manta', 'octopus', 'skr', 'ebb', 'toolhead board'], cnCode: '85371098', customsDescription: 'electronic control board for 3D printer' },
  { patterns: ['pcb', 'printed circuit'], cnCode: '85340019', customsDescription: 'bare printed circuit board' },
  { patterns: ['cnc', 'machined', 'mandala roseworks', 'mandala rose works'], cnCode: '84859090', customsDescription: 'CNC-machined component for 3D printer' },
  { patterns: ['frame', 'extrusion', 'misumi', 'lrs frame'], cnCode: '84859090', customsDescription: 'frame component for 3D printer' },
  { patterns: ['heater pad', 'silicone heater', 'bed heater'], cnCode: '84859090', customsDescription: 'silicone heater pad, 3D-printer bed' },
  { patterns: ['pei sheet', 'pei build', 'build plate', 'print surface', 'spring steel sheet'], cnCode: '84859090', customsDescription: 'spring-steel build sheet, 3D printer' },
  { patterns: ['bearing', 'ball bearing', 'linear bearing', 'lm8uu'], cnCode: '84821010', customsDescription: 'ball bearing, up to 30 mm' },
  { patterns: ['timing belt', 'gt2 belt', 'drive belt', 'synchronous belt', 'belt'], cnCode: '40103900', customsDescription: 'synchronous (timing) belt, rubber' },
  { patterns: ['linear rail', 'linear guide', 'pulley', 'idler'], cnCode: '84859090', customsDescription: 'motion component for 3D printer' },
]

export type HsKeywordMatch = { cnCode: string; customsDescription: string; matched: boolean }

/**
 * First keyword rule whose pattern appears in `text` (case-insensitive), else the default
 * "3D printer component" code. `matched` distinguishes a real hit from the default fallback.
 */
export function classifyByKeyword(text: string): HsKeywordMatch {
  const hay = text.toLowerCase()
  for (const rule of HS_KEYWORD_RULES) {
    if (rule.patterns.some((p) => p && hay.includes(p))) {
      return { cnCode: rule.cnCode, customsDescription: rule.customsDescription, matched: true }
    }
  }
  return { cnCode: KEYWORD_DEFAULT_CODE, customsDescription: KEYWORD_DEFAULT_DESCRIPTION, matched: false }
}
