### Edit products by CSV round trip (inventory)

- **Added: Edit by CSV on the Inventory list.** Select products (or none, for everything matching the current filter) and pick the columns to edit from a picker. IMS downloads a CSV pre-filled with the current values for exactly that selection, variants included. Upload it back to see a per-product diff of what would change, then apply.
- **Update-only, and a blank is never a clear.** A blank cell leaves the field unchanged, a column absent from the file is not touched, an unknown SKU is rejected, and `__CLEAR__` empties a field, accepted only for nullable fields. Unrecognised values (a boolean, a number, a country, a category, a supplier) are row errors rather than silent defaults, and a row with any error writes nothing for that product.
- **Same follow-up as the editor.** Applied in batches of at most 250 products, each in one transaction and one set-based statement; each changed product then gets the storefront metadata push, stock sync, warehouse product sync (with the `sync` permission) and HS-proposal invalidation that the product editor performs. Nothing writes to a vendor directly.
- **Scale.** Files of up to 50,000 rows / 25 MB, uploaded through a route handler instead of a server action; one SKU lookup per 1,000 rows. A test pins the round-trip count for thousands of rows.
- **Permissions.** Needs inventory edit; the price columns also need inventory prices, for download and for a file that contains them.
- **Changed: the exporter's formula guard is undone on upload** for this path, so a description such as `=SUM(A1)` or `-10% off` round-trips unchanged.
- Help document: Products (Edit by CSV).
