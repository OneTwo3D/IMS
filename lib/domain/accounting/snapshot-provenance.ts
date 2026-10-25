/**
 * Which parser wrote a stored Trial Balance balance. No database client is imported here.
 *
 * Version 2 reads YTD Debit minus YTD Credit by header name, under the refusals documented in help-docs/xero-sync.md. A row with
 * NO version (or any other number) was written by the earlier parser, which shifted values between columns, so it is not a value:
 * every reader treats it as ABSENT until the date is pulled again (the pull upserts by connector + account + date + currency and
 * overwrites the version). Nothing is deleted or backfilled.
 */
export const XERO_TRIAL_BALANCE_PARSER_VERSION = 2
