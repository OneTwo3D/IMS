import {
  assertTransition,
  canTransition,
  type ShipmentStatus,
  type WorkflowTransitions,
} from './status-types'

export const SHIPMENT_TRANSITIONS = {
  PENDING: ['PICKING'],
  PICKING: ['PACKED'],
  PACKED: ['SHIPPED'],
  SHIPPED: [],
} as const satisfies WorkflowTransitions<ShipmentStatus>

export function canTransitionShipment(
  from: ShipmentStatus,
  to: ShipmentStatus,
): boolean {
  return canTransition(SHIPMENT_TRANSITIONS, from, to)
}

export function assertShipmentTransition(
  from: ShipmentStatus,
  to: ShipmentStatus,
): void {
  assertTransition('shipment', SHIPMENT_TRANSITIONS, from, to)
}
