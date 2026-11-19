### Security, WooCommerce and onboarding fixes (P2 batch AL)
- Connector requests no longer carry vendor credential headers (the Mintsoft `ms-apikey`, `x-api-key` and similar) onto another origin when a redirect is followed, and a 307/308 redirect to another origin is refused instead of replaying the request body (the Mintsoft key-minting login).
- The WooCommerce stock push drain claims one queued job at a time, when its attempt starts, and stops claiming when its time budget is spent, so a job at the back of a batch can no longer age past its lease before it starts.
- A WooCommerce credentials rebind that aborts a stock push part-way is now reported on the result and listed first on the manual sync screen, instead of being the last entry of an error list the screen truncates to 20.
- The daily stock reconcile no longer stalls on a product whose error can never clear (a variant with no parent SKU, an ambiguous SKU, a kit cycle, an external id collision): the error is still reported, but the window is handled and the pass moves on. Transient errors still hold the window.
- A second partial refund of a part-shipped kit no longer raises a second return expectation for components already on an earlier in-transit refund's document.
- The onboarding Integrations step's Continue gate is decided by one rule fed from props, with no state copy or child-reported override.
