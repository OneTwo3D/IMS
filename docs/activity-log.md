# Activity Log

## Overview

Every action in the system is recorded in the activity log with a timestamp, the user who performed it, a description, and structured metadata. The activity log provides a complete audit trail of all operations.


## Viewing the Activity Log

Navigate to `/activity` to access the activity log page.

### Filtering by Level

Use the level tabs at the top of the page to filter entries:

- **All** — every log entry
- **Info** — routine operations (order created, stock adjusted, etc.)
- **Warning** — events that may need attention
- **Error** — failures and issues requiring investigation

### Filtering by Tag

Click the tag filter buttons to show only entries from a specific area:

| Tag | Covers |
|---|---|
| sales | Orders, dispatch, refunds, payments, stock reservations |
| purchase | Purchase orders, receiving, returns, invoicing |
| inventory | Product creation and updates, bulk operations, component changes |
| stock | Adjustments, transfers (dispatch and receive), manufacturing production in/out, reservations |
| sync | WooCommerce and Xero synchronisation events |
| settings | All configuration changes |
| auth | Profile updates, password changes, passkey registration and deletion |
| import | CSV imports with record counts |
| manufacturing | Production orders and assembly operations |
| system | Database reset, backup create/restore/upload/delete, scheduled tasks |

### Search

Search the activity log by description, action, entity ID, or user name using the search field.

### Expanding Entries

Click on any row to expand it and view additional details:

- **Entity type** — the type of record affected (e.g. SalesOrder, Product)
- **Entity ID** — the unique identifier of the affected record
- **Action** — the specific action performed (e.g. CREATE, UPDATE, DELETE)
- **Metadata** — full JSON metadata showing exactly what changed

### Pagination

The activity log displays 50 entries per page. Use the pagination controls to navigate through older entries.


## What Gets Logged

### Sales
- Order creation and status changes
- Dispatch and shipping
- Refunds and credit notes
- Payment recording
- Stock reservation changes

### Purchasing
- Purchase order creation and updates
- Goods receiving
- Returns to suppliers
- Supplier invoice recording

### Inventory
- Product creation and updates
- Bulk operations
- Component additions and changes

### Stock
- Stock adjustments (add/remove with reason)
- Transfer dispatch and receipt
- Manufacturing production in and production out
- Stock reservations

### Settings
- All configuration changes across every settings section

### Auth
- Profile updates (name, email, avatar)
- Password changes
- Passkey registration and deletion

### Import
- CSV imports with counts of records created, updated, and skipped

### System
- Database reset
- Backup creation, restoration, upload, and deletion
- Scheduled task execution


## Retention

Activity log retention is configurable per level in **System Settings**. Entries older than the configured period are automatically deleted.

| Level | Default Retention |
|---|---|
| Info | 30 days |
| Warning | 60 days |
| Error | 90 days |

Set the retention period to **0** for any level to keep those entries indefinitely.


## Automatic Cleanup

A daily cron job calls `/api/cron/activity-cleanup` at 03:00 to purge entries that have exceeded their retention period. No manual intervention is required.
