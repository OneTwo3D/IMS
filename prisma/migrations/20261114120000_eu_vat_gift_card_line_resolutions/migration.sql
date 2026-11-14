-- Additive: an operator's gift-card answer for one WooCommerce order line whose flag the plugin could not settle. New table only; no existing row is touched.
CREATE TABLE "eu_vat_gift_card_line_resolutions" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_line_item_id" INTEGER NOT NULL,
    "is_gift_card" BOOLEAN NOT NULL,
    "resolved_by_user_id" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eu_vat_gift_card_line_resolutions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "eu_vat_gift_card_line_resolutions_line_key" ON "eu_vat_gift_card_line_resolutions"("connector", "external_order_id", "external_line_item_id");
