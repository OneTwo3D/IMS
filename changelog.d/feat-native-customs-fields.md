### Customs data from WooCommerce's native fields

- The WooCommerce product import now reads the HS code, country of origin and customs description from WooCommerce's native customs fields first, falling back per field to the older product attributes. While a shorter description awaits approval in the store, the previous longer text in the store's legacy customs-description field is used for the description. The existing "store value wins, blank never clears" behaviour is unchanged.
- The customs description limit is now 35 characters (WooCommerce's native limit; the warehouse's own limit is 50), and characters WooCommerce rejects (angle brackets, emoji, symbols such as the trademark sign) are dropped. The AI HS classifier is asked for at most 35 characters.
- Imported variations now get their own customs fields too (on create and update): the variation's value, else the parent's, under the same "store value wins, blank never clears" rule. A new variation with no origin anywhere takes the China default, as a new parent does. Before this, variations never received customs data from the import.
- No migration. IMS writes no customs data back to WooCommerce.
