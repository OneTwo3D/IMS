export class SupplierPortalAccessError extends Error {
  constructor(message = 'Resource not accessible') {
    super(message)
    this.name = 'SupplierPortalAccessError'
  }
}

export type SupplierPortalContext = {
  userId: string
  supplierId: string
}

export function assertSupplierOwnsResource(
  ctx: SupplierPortalContext,
  resource: { supplierId: string | null | undefined },
): void {
  if (!resource.supplierId || resource.supplierId !== ctx.supplierId) {
    throw new SupplierPortalAccessError()
  }
}
