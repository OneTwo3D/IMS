-- Store symbol position (PREFIX / POSTFIX) together with each currency so
-- display rules live in the database, not hard-coded in the frontend.

CREATE TYPE "CurrencySymbolPos" AS ENUM ('PREFIX', 'POSTFIX');

ALTER TABLE "currencies"
  ADD COLUMN "symbolPosition" "CurrencySymbolPos" NOT NULL DEFAULT 'PREFIX';

-- Seed known postfix currencies. Most European currencies render the symbol
-- after the amount (e.g. "23.99 €", "125 kr"). Anything not listed here
-- defaults to PREFIX which covers GBP, USD, CAD, AUD, JPY, CHF, CNY, HKD,
-- SGD, NZD, INR, BRL, MXN, ZAR etc.
UPDATE "currencies" SET "symbolPosition" = 'POSTFIX'
  WHERE "code" IN ('EUR','SEK','NOK','DKK','PLN','CZK','HUF','BGN','RON','HRK','ISK');
