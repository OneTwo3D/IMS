### Fixed
- Xero daily sync: the GR/IR accrual window grouped journals with the removed UTC-day helper, which broke the build after journal days moved to business-local dates. It now uses the business day, like every other journal day in the daily sync.
