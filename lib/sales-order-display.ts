export type SalesOrderDisplayLike = {
  id: string
  orderNumber?: string | null
  externalOrderNumber?: string | null
}

export function getSalesOrderReference(order: SalesOrderDisplayLike): string {
  return order.orderNumber ?? order.externalOrderNumber ?? order.id.slice(0, 8)
}
