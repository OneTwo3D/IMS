/** Dependency-free, so a client component can read it without pulling the Decimal engine into the browser bundle. */
export const MARGIN_BLOCK_ERROR_PREFIX = 'MARGIN_BELOW_MINIMUM'

/** The refusal as an operator should read it: the machine prefix is for the screen to recognise, not to print. */
export function marginBlockMessageForDisplay(error: string): string {
  return error.startsWith(MARGIN_BLOCK_ERROR_PREFIX) ? error.slice(MARGIN_BLOCK_ERROR_PREFIX.length).replace(/^:\s*/, '') : error
}
