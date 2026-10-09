'use server'

// The shape the first-load importers really use: the capability is a unique symbol, which cannot cross the RPC boundary.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used only in a type position
declare const SYSTEM_IMPORT: unique symbol
type SystemImportContext = { readonly systemImportToken: typeof SYSTEM_IMPORT; readonly runId: string; readonly operator: string }

export async function importThings(formData: FormData, system?: SystemImportContext) {
  return { formData, system }
}
