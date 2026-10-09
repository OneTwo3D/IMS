'use server'

// The first-load importers' optional trailing context, but with the capability typed as something a client can send.
type ForgeableSystemImportContext = { systemImportToken: boolean; runId: string; operator: string }

export async function importThings(formData: FormData, system?: ForgeableSystemImportContext) {
  return { formData, system }
}
