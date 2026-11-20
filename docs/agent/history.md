# History (moved from CLAUDE.md)

Stale feature list from the old CLAUDE.md. CHANGELOG.md and git history are authoritative.

## Recent Features (Latest Commits)

- **Partial Fulfillment:** Ship available items now, allocate and ship the rest later. Allocation panel reappears for unfulfilled lines after partial shipment.
- **PICKING Guard:** Blocks transition to Picking status when no allocations exist, preventing empty picks.
- **Packing Slip Legacy Support:** Packing slip PDF works for orders without shipments (legacy flow) using order lines directly.
- **Xero Sub-Ledger Batch Sync:** Daily batch sync of journal entries to Xero GL (replaces real-time sync for performance)
- **WooCommerce Tax Rate Mapping:** Automatic tax type mapping from WC to Xero during order sync
- **Payment Account Mapping:** UI for configuring payment method → bank account mapping for reconciliation
- **Notifications System:** Email notifications for orders, shipments, and sync events with preference management
- **Invoice Delegation:** Support for delegated invoice generation workflows (finance team can approve before sending)
- **Passkey/WebAuthn Support:** FIDO2 passwordless authentication alongside TOTP 2FA
- **Supplier Portal:** Separate RBAC role for suppliers to view orders and delivery status

