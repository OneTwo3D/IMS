/**
 * THE MINTSOFT SUPPLIER WIRE CONTRACT, IN ONE PLACE.
 *
 * SOURCE. The published Mintsoft swagger (GET /swagger/docs/v1, V1, read from the local copy kept with the first-load analysis; NO request
 * was made to the live tenant for this feature). In Mintsoft a "supplier" is a `ProductSupplier`:
 *
 *   GET  /api/Product/Suppliers   "List Product Suppliers: Get paged list of Product Suppliers". Query: ClientId (admin users only), PageNo
 *                                 (default 1), Limit (default 100, MAX 100). Answers an array of ProductSupplier.
 *   PUT  /api/Product/Suppliers   "Create New Product Supplier". Body: ProductSupplier. Answers a ToolkitResult { ID, Success, Message, ... }.
 *                                 There is no update route in the swagger, which is why IMS can never overwrite an existing supplier.
 *   NewASN.ProductSupplierId      int32. The ASN's supplier. `NewASN.Supplier` (string, max 250) is a free-text name and is NOT used: an id is
 *                                 what makes the ASN carry the real supplier record.
 *   ProductSupplier               ID, Name, ContactName, ContactNumber, AddressLine1..3, Town, County, Postcode, CountryId, ContactEmail,
 *                                 Active, Code, CurrencyId, ClientId, LastUpdated, LastUpdatedByUser. No VAT number field.
 *
 * UNVERIFIED AGAINST THE LIVE TENANT (a swagger is a contract, not proof; this tenant has already answered differently from its swagger, see
 * o3d-vcw8). Every name below is isolated here so a correction is a one-line change, and the CONTROLLED-RUN STEP in docs/mintsoft.md
 * ("Mintsoft suppliers") must be done by the owner before `mintsoft_asn_supplier_required` is turned on at step M:
 *   1. ONE read of GET /api/Product/Suppliers (owner-sanctioned, read-only) to confirm the paging, the field names and that a client user sees
 *      its own suppliers (and whether `ClientId` must be omitted for a client user, as it must be on NewASN).
 *   2. ONE create of an ASN carrying `ProductSupplierId` on STAGE (or the sanctioned test tenant), read back with GET /api/ASN/{id} to see the
 *      supplier on the ASN, then DELETE /api/ASN/{id}.
 *   3. Only then, and only if the owner wants IMS to create suppliers, ONE `PUT /api/Product/Suppliers` with a throwaway name.
 */

/** The list endpoint (a READ). */
export const MINTSOFT_SUPPLIER_LIST_PATH = '/api/Product/Suppliers'
/** The create endpoint (a WRITE; the same path, PUT). */
export const MINTSOFT_SUPPLIER_CREATE_PATH = '/api/Product/Suppliers'

/** UNVERIFIED (live): the supplier field on NewASN. */
export const MINTSOFT_ASN_SUPPLIER_FIELD = 'ProductSupplierId'

/** Mintsoft's documented maximum page size for the list. A larger Limit is refused or silently clamped, so it is never configured. */
export const MINTSOFT_SUPPLIER_PAGE_LIMIT = 100
/** A hard ceiling on pages walked in one sync: a tenant with more than this many suppliers is refused loudly rather than half-read. */
export const MINTSOFT_SUPPLIER_MAX_PAGES = 200
/** The pause between page requests (milliseconds). The sync is a background read of a shared live tenant. */
export const MINTSOFT_SUPPLIER_PAGE_PAUSE_MS = 400

/** UNVERIFIED (live): the ProductSupplier field names read from a list row. */
export const MINTSOFT_SUPPLIER_FIELDS = {
  id: 'ID',
  name: 'Name',
  code: 'Code',
  email: 'ContactEmail',
  active: 'Active',
  contactName: 'ContactName',
  phone: 'ContactNumber',
  addressLine1: 'AddressLine1',
  addressLine2: 'AddressLine2',
  town: 'Town',
  county: 'County',
  postcode: 'Postcode',
  /** Mintsoft's ProductSupplier has no VAT field; if a tenant adds one it is read from here. */
  vat: 'VATNumber',
} as const

/** The name the owner decided transfer ASNs carry (2026-11-19). The default of the transfer-supplier setting's display, never auto-created. */
export const MINTSOFT_TRANSFER_SUPPLIER_NAME = 'One Two Enterprises Ltd'
