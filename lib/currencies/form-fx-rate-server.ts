import { isMissingFxRateError } from './fx-select'
import { missingFormFxRate, type FormFxRate } from './form-fx-rate'

/** Server side only (imports the Prisma-backed lookup types): maps a lookup failure to the form state. Only a missing-rate refusal is a state; anything else is rethrown. */
export function formFxRateFromError(currency: string, error: unknown): FormFxRate {
  if (isMissingFxRateError(error)) return missingFormFxRate(currency)
  throw error
}
