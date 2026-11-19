### Mintsoft supplier sync/create races and guards (o3d-ypqzi)
- The supplier list's "last read" time is now the START of the walk, and the missing-sweep spares rows created after it, so an IMS create during a refresh can no longer be marked missing (which led to a duplicate in Mintsoft). Creating a supplier now takes the same lock as the refresh: a create and a refresh never overlap, and two creates are serialised.
- The duplicate guard now blocks from a 55 score (what the page suggests), not 80, unless "create anyway" with a reason.
- With sending the supplier on an ASN on, an ASN is refused (with a task) when the supplier list was last read more than `mintsoft_asn_supplier_cache_max_age_hours` (default 24) ago.
- "Resolve unknown outcome" waits at least 2 minutes after the attempt. A refresh reading a list more than 20% smaller than the last is refused and recorded; an administrator can confirm it. All inert while the create and send switches are off.
