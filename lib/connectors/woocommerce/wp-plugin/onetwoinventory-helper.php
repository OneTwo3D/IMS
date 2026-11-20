<?php
/**
 * Plugin Name: onetwoInventory Helper
 * Plugin URI:  https://github.com/OneTwo3D/IMS
 * Description: Companion plugin for One Two Inventory. Adds invoice download
 *              buttons to WooCommerce, and accepts FX rate pushes from IMS so
 *              the storefront's multi-currency display matches the rates used
 *              in IMS and Xero.
 * Version:     1.5.3
 * Author:      One Two Enterprises Ltd
 * Requires PHP: 7.4
 * Requires at least: 6.0
 *
 * Modules included:
 *   1. Invoice Buttons — adds invoice PDF / accounting links to My Account
 *      orders and the wp-admin order screen, reading order meta written by
 *      One Two Inventory.
 *   2. FX Rate Receiver — RETIRED in 1.3.0: POST /wp-json/oti/v1/fx-rates refuses every push (410 oti_fx_push_retired)
 *      and writes nothing, because Aelia is the master. Rates stored by earlier versions are
 *      surfaced to the Aelia Currency Switcher (and other plugins via filter)
 *      so the storefront converts at the same rate as IMS and Xero.
 *      A second, GET-only endpoint GET /wp-json/oti/v1/aelia-rates READS Aelia's own
 *      rate table (base currency, per-currency rate, markup, set_manually, decimals and
 *      Aelia's own last-update time) so IMS can take Aelia as the exchange-rate master.
 *      It writes nothing, anywhere.
 *   1b. Warehouse (WMS) Status — renders the live WMS order status that IMS pushes
 *      onto the WC order as `_oti_wms_*` meta: an order-edit meta box + an orders-list
 *      "Warehouse" column. Read-only; WMS-neutral.
 *   3. Partial-Shipment Receiver — signed REST endpoint
 *      POST /wp-json/oti/v1/order/{id}/partial-shipment that IMS posts each
 *      despatched part of a split fulfilment to (WMS-neutral: Mintsoft or any future WMS,
 *      ...). Mirrors the part into the wphub-partial-shipment tables (storefront
 *      partial-shipment UI + customer emails) and transitions the order to
 *      partial-shipped / completed.
 *   4. TrackShip Re-fire — signed REST endpoint
 *      POST /wp-json/oti/v1/order/{id}/trackship-refire that IMS asks, per shipped
 *      order, to make sure TrackShip holds a shipment for every tracking number
 *      and, when it does not, to fire TrackShip's own `send_order_to_trackship`
 *      action again (the call TrackShip makes when an order ships and which has
 *      no retry of its own). Writes nothing itself: TrackShip does the writing.
 *   5. Incumbents probe (1.5.0) — signed, READ-ONLY route GET /wp-json/oti/v1/incumbents
 *      that reports whether the legacy bridge plugin (slug wc-mintsoft-sync) and Xeroom's
 *      order note are still writing: whether the bridge's REST routes are registered, its
 *      order-sync switch, its product webhook, pending product-sync jobs, the latest
 *      `_mintsoft_*` write time, and the o3d_xeroom_order_note_off option. Writes nothing.
 *   6. Withdrawal outcome (1.5.0) — signed route POST /wp-json/oti/v1/order/{id}/withdrawal-outcome
 *      that IMS posts the outcome of a customer's EU withdrawal request to (an order note, and
 *      a rejection of the request when the goods have already gone). Replaces the bridge
 *      plugin's /wdraw-outcome at the Mintsoft switchover step.
 */

defined('ABSPATH') || exit;

/* ============================================================
 * Module 1 — Invoice Buttons
 * ============================================================ */

if (!function_exists('oti_get_order_meta')) {
    function oti_get_order_meta(int $order_id, string $key): string
    {
        if (function_exists('wc_get_order')) {
            $order = wc_get_order($order_id);
            if ($order) {
                return (string) $order->get_meta($key);
            }
        }
        return (string) get_post_meta($order_id, $key, true);
    }
}

if (!function_exists('oti_order_has_invoice_pdf')) {
    function oti_order_has_invoice_pdf(int $order_id): bool
    {
        return oti_get_order_meta($order_id, '_ims_invoice_pdf_available') === 'yes'
            && oti_invoice_pdf_endpoint() !== '';
    }
}

if (!function_exists('oti_invoice_download_url')) {
    function oti_invoice_download_url(int $order_id): string
    {
        return wp_nonce_url(
            rest_url(OTI_FX_NAMESPACE . '/invoice-pdf/' . $order_id),
            'oti_invoice_pdf_' . $order_id,
            '_wpnonce'
        );
    }
}

// Customer: "Invoice" button on My Account orders list
add_filter('woocommerce_my_account_my_orders_actions', function (array $actions, $order) {
    $order_id = $order->get_id();
    if (oti_order_has_invoice_pdf($order_id)) {
        $actions['invoice_pdf'] = [
            'url'  => esc_url(oti_invoice_download_url($order_id)),
            'name' => __('Invoice', 'woocommerce'),
        ];
    }
    return $actions;
}, 10, 2);

// Customer: "Download Invoice" button on order detail page
add_action('woocommerce_order_details_after_order_table', function ($order) {
    $order_id = $order->get_id();
    if (!oti_order_has_invoice_pdf($order_id)) return;

    printf(
        '<p class="oti-invoice-download"><a href="%s" class="button" target="_blank" rel="noopener noreferrer">%s</a></p>',
        esc_url(oti_invoice_download_url($order_id)),
        esc_html__('Download Invoice PDF', 'woocommerce')
    );
});

// Admin: Invoice meta box on order edit screen
add_action('add_meta_boxes', function () {
    $screen = class_exists(\Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController::class)
        && wc_get_container()->get(\Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController::class)->custom_orders_table_usage_is_enabled()
        ? wc_get_page_screen_id('shop-order')
        : 'shop_order';

    add_meta_box(
        'oti_invoice_meta_box',
        __('Invoice', 'woocommerce'),
        'oti_render_invoice_meta_box',
        $screen,
        'side',
        'default'
    );
});

if (!function_exists('oti_render_invoice_meta_box')) {
    function oti_render_invoice_meta_box($post_or_order): void
    {
        $order_id = $post_or_order instanceof WP_Post ? $post_or_order->ID : $post_or_order->get_id();

        $has_pdf        = oti_order_has_invoice_pdf($order_id);
        $accounting_url = oti_get_order_meta($order_id, '_accounting_invoice_url');

        if (!$has_pdf && !$accounting_url) {
            echo '<p>' . esc_html__('No invoice available yet.', 'woocommerce') . '</p>';
            return;
        }

        if ($has_pdf) {
            printf(
                '<p><a href="%s" class="button" target="_blank" rel="noopener noreferrer">%s</a></p>',
                esc_url(oti_invoice_download_url($order_id)),
                esc_html__('Download PDF', 'woocommerce')
            );
        }

        if ($accounting_url) {
            printf(
                '<p><a href="%s" class="button" target="_blank" rel="noopener noreferrer">%s</a></p>',
                esc_url($accounting_url),
                esc_html__('View in Accounting', 'woocommerce')
            );
        }
    }
}

/* ============================================================
 * Module 1b — Warehouse (WMS) status display
 * ============================================================
 *
 * One Two Inventory pushes the live WMS order status onto the WC order as
 * WMS-neutral `_oti_wms_*` meta (any WMS connector: see the IMS wms-status push).
 * Here we render it: an order-edit meta box + an orders-list column. Read-only.
 */

add_action('add_meta_boxes', function () {
    $screen = class_exists(\Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController::class)
        && wc_get_container()->get(\Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController::class)->custom_orders_table_usage_is_enabled()
        ? wc_get_page_screen_id('shop-order')
        : 'shop_order';

    add_meta_box(
        'oti_wms_status_meta_box',
        __('Warehouse (WMS)', 'woocommerce'),
        'oti_render_wms_status_meta_box',
        $screen,
        'side',
        'default'
    );
});

if (!function_exists('oti_render_wms_status_meta_box')) {
    function oti_render_wms_status_meta_box($post_or_order): void
    {
        $order_id  = $post_or_order instanceof WP_Post ? $post_or_order->ID : $post_or_order->get_id();
        $status    = oti_get_order_meta($order_id, '_oti_wms_status');
        $label     = oti_get_order_meta($order_id, '_oti_wms_status_label');
        $connector = oti_get_order_meta($order_id, '_oti_wms_connector');
        $deeplink  = oti_get_order_meta($order_id, '_oti_wms_deeplink');

        if ($status === '') {
            echo '<p>' . esc_html__('No warehouse status yet.', 'woocommerce') . '</p>';
            return;
        }

        printf(
            '<p><strong>%s:</strong> %s</p>',
            esc_html($connector !== '' ? $connector : __('WMS', 'woocommerce')),
            esc_html($label !== '' ? $label : $status)
        );
        if ($deeplink !== '') {
            printf(
                '<p><a href="%s" class="button" target="_blank" rel="noopener noreferrer">%s</a></p>',
                esc_url($deeplink),
                esc_html__('Open in warehouse', 'woocommerce')
            );
        }
    }
}

if (!function_exists('oti_wms_status_column')) {
    /** Insert a "Warehouse" column after the order status column. */
    function oti_wms_status_column(array $columns): array
    {
        $out = [];
        foreach ($columns as $key => $label) {
            $out[$key] = $label;
            if ($key === 'order_status') {
                $out['oti_wms_status'] = __('Warehouse', 'woocommerce');
            }
        }
        if (!isset($out['oti_wms_status'])) {
            $out['oti_wms_status'] = __('Warehouse', 'woocommerce');
        }
        return $out;
    }
}

if (!function_exists('oti_wms_status_column_value')) {
    function oti_wms_status_column_value(int $order_id): void
    {
        $status = oti_get_order_meta($order_id, '_oti_wms_status');
        $label  = oti_get_order_meta($order_id, '_oti_wms_status_label');
        echo $status !== '' ? esc_html($label !== '' ? $label : $status) : '—';
    }
}

// Legacy CPT orders screen.
add_filter('manage_edit-shop_order_columns', 'oti_wms_status_column');
add_action('manage_shop_order_posts_custom_column', function ($column, $post_id) {
    if ($column === 'oti_wms_status') {
        oti_wms_status_column_value((int) $post_id);
    }
}, 10, 2);

// HPOS orders screen.
add_filter('manage_woocommerce_page_wc-orders_columns', 'oti_wms_status_column');
add_action('manage_woocommerce_page_wc-orders_custom_column', function ($column, $order) {
    if ($column === 'oti_wms_status') {
        $order_id = ($order instanceof WC_Order) ? $order->get_id() : (int) $order;
        oti_wms_status_column_value($order_id);
    }
}, 10, 2);

/* ============================================================
 * Module 2 — FX Rate Receiver
 * ============================================================
 *
 * Endpoint: POST /wp-json/oti/v1/fx-rates
 *
 * Authentication: HMAC-SHA256 of the raw request body, computed with the
 * shared secret stored in the wp_option `oti_fx_shared_secret`. The secret is
 * the same value as `WC_WEBHOOK_SECRET` in IMS — the admin pastes it in once
 * via Settings → onetwoInventory below.
 *
 * Request body shape (JSON):
 *   {
 *     "rates": [
 *       { "fromCurrency": "GBP", "toCurrency": "EUR", "rate": 1.18, "fetchedAt": "2026-04-25T06:00:00Z" },
 *       ...
 *     ]
 *   }
 *
 * Stored as a wp_option so it survives reboots and plugin reactivation.
 * Aelia Currency Switcher consumes via the filter integration below.
 */

const OTI_FX_OPTION       = 'oti_fx_rates';
const OTI_FX_SECRET_OPT   = 'oti_fx_shared_secret';
const OTI_FX_BASE_OPT     = 'oti_fx_base_currency';
const OTI_FX_LASTPUSH_OPT = 'oti_fx_last_push';
const OTI_INVOICE_PDF_SECRET_OPT = 'oti_invoice_pdf_shared_secret';
const OTI_IMS_INVOICE_PDF_BASE_URL_OPT = 'oti_ims_invoice_pdf_base_url';
const OTI_FX_NAMESPACE    = 'oti/v1';
// Aelia Currency Switcher keeps ALL of its settings in this one option; the per-currency table is under 'exchange_rates'.
const OTI_AELIA_SETTINGS_OPT = 'wc_aelia_currency_switcher';

add_action('rest_api_init', function () {
    register_rest_route(OTI_FX_NAMESPACE, '/fx-rates', [
        'methods'             => 'POST',
        'permission_callback' => 'oti_verify_fx_signature',
        'callback'            => 'oti_handle_fx_push',
    ]);
    // READ ONLY: returns Aelia's own rate table. Same HMAC check as the other signed routes (the signature of an empty body for a GET).
    register_rest_route(OTI_FX_NAMESPACE, '/aelia-rates', [
        'methods'             => 'GET',
        'permission_callback' => 'oti_verify_fx_signature',
        'callback'            => 'oti_handle_aelia_rates_read',
    ]);
    register_rest_route(OTI_FX_NAMESPACE, '/invoice-pdf/(?P<order_id>\d+)', [
        'methods'             => 'GET',
        'permission_callback' => 'oti_can_download_invoice_pdf',
        'callback'            => 'oti_proxy_invoice_pdf',
        'args'                => [
            'order_id' => [
                'required'          => true,
                'sanitize_callback' => 'absint',
            ],
        ],
    ]);
    register_rest_route(OTI_FX_NAMESPACE, '/order/(?P<order_id>\d+)/partial-shipment', [
        'methods'             => 'POST',
        // Its own verifier (1.5.3): the signature binds timestamp, method, path (so the order id), a single-use nonce and the body. The body-only
        // X-OTI-Signature an older IMS sends is NOT accepted any more.
        'permission_callback' => 'oti_verify_partial_shipment_signature',
        'callback'            => 'oti_handle_partial_shipment',
        'args'                => [
            'order_id' => [
                'required'          => true,
                'sanitize_callback' => 'absint',
            ],
        ],
    ]);
    register_rest_route(OTI_FX_NAMESPACE, '/order/(?P<order_id>\d+)/trackship-refire', [
        'methods'             => 'POST',
        // Same HMAC-of-raw-body check as the other signed routes (the verifier is generic).
        // Its own verifier: the signature binds method, path (so the order id), body and a timestamp, and the nonce in the body is single-use.
        'permission_callback' => 'oti_verify_trackship_refire_signature',
        'callback'            => 'oti_handle_trackship_refire',
        'args'                => [
            'order_id' => [
                'required'          => true,
                'sanitize_callback' => 'absint',
            ],
        ],
    ]);
    // READ ONLY. Its own verifier: the signature binds method, path, timestamp and a single-use nonce, inside a 60 second window.
    register_rest_route(OTI_FX_NAMESPACE, '/incumbents', [
        'methods'             => 'GET',
        'permission_callback' => 'oti_verify_incumbents_signature',
        'callback'            => 'oti_handle_incumbents',
    ]);
    register_rest_route(OTI_FX_NAMESPACE, '/order/(?P<order_id>\d+)/withdrawal-outcome', [
        'methods'             => 'POST',
        'permission_callback' => 'oti_verify_withdrawal_outcome_signature',
        'callback'            => 'oti_handle_withdrawal_outcome',
        'args'                => [
            'order_id' => [
                'required'          => true,
                'sanitize_callback' => 'absint',
            ],
        ],
    ]);
});

if (!function_exists('oti_verify_fx_signature')) {
    function oti_verify_fx_signature(WP_REST_Request $request)
    {
        $secret = get_option(OTI_FX_SECRET_OPT, '');
        if (!is_string($secret) || $secret === '') {
            return new WP_Error(
                'oti_fx_no_secret',
                'onetwoInventory shared secret not configured',
                ['status' => 401]
            );
        }

        $signature = $request->get_header('x-oti-signature');
        if (!$signature) {
            return new WP_Error('oti_fx_missing_sig', 'Missing X-OTI-Signature header', ['status' => 401]);
        }

        $body = $request->get_body();
        $expected = hash_hmac('sha256', (string) $body, $secret);

        if (!hash_equals($expected, (string) $signature)) {
            return new WP_Error('oti_fx_bad_sig', 'Invalid signature', ['status' => 401]);
        }
        return true;
    }
}

if (!function_exists('oti_handle_fx_push')) {
    /**
     * RETIRED (plugin 1.3.0). Aelia is the exchange-rate master and IMS no longer pushes rates, so this receiver refuses EVERY write:
     * HTTP 410 with the code `oti_fx_push_retired`, and it writes nothing (no Aelia option, no `oti_fx_*` option, no cache flush).
     * The signature is still checked first (permission_callback), so an unsigned request is still a 401. The refusal fences any IMS
     * push, whatever state its client-side lock is in.
     */
    function oti_handle_fx_push(WP_REST_Request $request)
    {
        return new WP_Error(
            'oti_fx_push_retired',
            'The exchange-rate push is retired: Aelia is the exchange-rate master. Nothing was stored.',
            ['status' => 410]
        );
    }
}

if (!function_exists('oti_aelia_last_update_iso')) {
    /**
     * Aelia's own last-update time of its rate table as an ISO-8601 UTC string, or null when it cannot be read.
     * Returns [iso|null, name of the settings key it was read from|null].
     *
     * @param array<string,mixed> $settings
     * @return array{0:?string,1:?string}
     */
    function oti_aelia_last_update_iso(array $settings): array
    {
        foreach (['exchange_rates_last_update', 'exchange_rates_update_time', 'exchange_rates_last_updated'] as $key) {
            if (!isset($settings[$key]) || $settings[$key] === '' || $settings[$key] === null) continue;
            $raw = $settings[$key];
            if (is_numeric($raw)) {
                $ts = (int) $raw;
            } else {
                $ts = strtotime((string) $raw . ((preg_match('/(Z|[+-]\d{2}:?\d{2})$/', (string) $raw) === 1) ? '' : ' UTC'));
            }
            if ($ts === false || $ts <= 0) continue;
            return [gmdate('Y-m-d\TH:i:s\Z', $ts), $key];
        }
        return [null, null];
    }
}

if (!function_exists('oti_handle_aelia_rates_read')) {
    /**
     * GET /wp-json/oti/v1/aelia-rates. READ ONLY: no update_option, no delete_option, no database write.
     *
     * Returns Aelia's rate table EXACTLY as Aelia holds it. `rate` is the rate BEFORE markup and `markup` is Aelia's
     * `rate_markup` (an absolute amount that Aelia adds to the rate for storefront prices). The two are returned
     * separately and never combined here; the combination is a storefront price uplift and is not an exchange rate.
     */
    function oti_handle_aelia_rates_read(WP_REST_Request $request)
    {
        $settings = get_option(OTI_AELIA_SETTINGS_OPT, null);
        if (!is_array($settings) || !isset($settings['exchange_rates']) || !is_array($settings['exchange_rates'])) {
            return new WP_Error('oti_aelia_not_found', 'Aelia Currency Switcher settings not found', ['status' => 404]);
        }

        $out = [];
        foreach ($settings['exchange_rates'] as $code => $row) {
            if (!is_array($row)) continue;
            $entry = [
                'currency'     => strtoupper((string) $code),
                'rate'         => isset($row['rate']) ? trim((string) $row['rate']) : null,
                'markup'       => isset($row['rate_markup']) ? trim((string) $row['rate_markup']) : null,
                'set_manually' => !empty($row['set_manually']),
            ];
            if (isset($row['exchange_rate_decimals']) && is_numeric($row['exchange_rate_decimals'])) {
                $entry['decimals'] = (int) $row['exchange_rate_decimals'];
            } elseif (isset($row['decimals']) && is_numeric($row['decimals'])) {
                $entry['decimals'] = (int) $row['decimals'];
            }
            $out[] = $entry;
        }

        [$updated, $updated_key] = oti_aelia_last_update_iso($settings);

        return new WP_REST_Response([
            'ok'                 => true,
            'base'               => strtoupper((string) get_option('woocommerce_currency', '')),
            'last_update'        => $updated,
            'last_update_source' => $updated_key,
            'rates'              => $out,
        ]);
    }
}

if (!function_exists('oti_ps_parts_done')) {
    /** Read the deduped, int-normalised list of already-recorded part numbers. */
    function oti_ps_parts_done($order): array
    {
        $done = $order->get_meta('_oti_wms_parts_done');
        if (is_array($done)) {
            return array_values(array_filter(array_map('intval', $done)));
        }
        if (is_string($done) && $done !== '') {
            return array_values(array_filter(array_map('intval', explode(',', $done))));
        }
        return [];
    }
}

if (!function_exists('oti_ps_status_eligible')) {
    /**
     * May the partial-shipment route CHANGE this order's status? (1.3.1)
     *
     * Moving an order to completed / partial-shipped is a promotion that fires the store's
     * customer email and download machinery, so it is right only for an order the store still
     * holds as in flight: processing, or partial-shipped (our own status from an earlier part).
     * Anything else, cancelled, refunded, on-hold, pending, failed, or an order an operator
     * completed by hand, is left exactly where it is. Fails closed: an unrecognised custom
     * status is NOT eligible. A store that runs a custom in-flight status (for example
     * ready-to-ship) opts it in through the `oti_partial_shipment_status_eligible` filter.
     * Slug is the WooCommerce slug with or without its `wc-` prefix.
     */
    function oti_ps_status_eligible($status): bool
    {
        $slug = strtolower(trim((string) $status));
        if (strpos($slug, 'wc-') === 0) {
            $slug = substr($slug, 3);
        }
        $eligible = in_array($slug, ['processing', 'partial-shipped'], true);
        // Strictly boolean true: a filter returning the string 'false', '0', 1 or null must not opt in.
        return apply_filters('oti_partial_shipment_status_eligible', $eligible, $slug) === true;
    }
}

if (!function_exists('oti_handle_partial_shipment')) {
    /**
     * WMS-neutral partial-shipment writeback. IMS posts each despatched part of a
     * split fulfilment here (Mintsoft or any future WMS — the route does not care
     * which WMS produced it). We mirror the part into the wphub-partial-shipment
     * tables (the storefront's partial-shipment UI + customer emails), stamp split
     * metadata, and transition the WC order to partial-shipped / completed
     * ONLY while the order is still in flight (see oti_ps_status_eligible); a cancelled,
     * refunded, on-hold or hand-completed order keeps its status.
     *
     * Body: { part:int, total_parts:int, tracking_number?:str, shipment_num?:str,
     *         items:[{ sku:str, qty:int }] }
     *
     * Idempotent per (order, part): the IMS poll re-sends despatched parts until
     * the order is fully reconciled, so an already-recorded part is a no-op.
     */
    function oti_handle_partial_shipment(WP_REST_Request $request)
    {
        if (!function_exists('wc_get_order')) {
            return new WP_Error('oti_ps_no_wc', 'WooCommerce not active', ['status' => 500]);
        }
        $order_id = absint($request['order_id']);
        $order = wc_get_order($order_id);
        if (!$order) {
            return new WP_Error('oti_ps_not_found', 'Order not found', ['status' => 404]);
        }

        $payload      = $request->get_json_params();
        $part         = (int) ($payload['part'] ?? 0);
        $total        = (int) ($payload['total_parts'] ?? 0);
        $tracking     = sanitize_text_field((string) ($payload['tracking_number'] ?? ''));
        $shipment_num = sanitize_text_field((string) ($payload['shipment_num'] ?? ''));
        $raw_items    = $payload['items'] ?? [];
        if ($part <= 0 || $total <= 0 || !is_array($raw_items) || empty($raw_items)) {
            return new WP_Error('oti_ps_bad_payload', 'Malformed partial-shipment payload', ['status' => 400]);
        }

        // Serialise the ENTIRE read-check-insert-write per order under one named
        // lock. The idempotency check (parts_done), the shipment_id counter, AND
        // the parts_done / status write must all be inside the lock — otherwise two
        // concurrent posts can both pass the duplicate check and double-insert a
        // part, or start from the same stale parts_done and clobber each other's
        // completion bookkeeping. A named lock (not the WC object) is the only thing
        // both critical regions can share. 5s acquire budget; the route is a
        // standalone REST call so a plain transaction wraps the INSERTs (no SAVEPOINT).
        global $wpdb;
        $lock_name = 'oti_partial_ship_' . $order_id;
        if ((int) $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, %d)', $lock_name, 5)) !== 1) {
            return new WP_Error('oti_ps_lock', 'Could not acquire partial-shipment lock', ['status' => 409]);
        }
        try {
            // Re-load inside the lock so parts_done reflects any part a concurrent
            // request committed before we acquired the lock (defeats WC's order cache).
            $order = wc_get_order($order_id);
            if (!$order) {
                return new WP_Error('oti_ps_not_found', 'Order not found', ['status' => 404]);
            }

            // Idempotency — skip a part already recorded.
            $done = oti_ps_parts_done($order);
            if (in_array($part, $done, true)) {
                return new WP_REST_Response(['ok' => true, 'duplicate' => true, 'part' => $part], 200);
            }

            // Map SKU → WC line item id (first match wins; same-SKU duplicate lines
            // are aggregated by the WMS side anyway).
            $items_by_sku = [];
            foreach ($order->get_items() as $item_id => $item) {
                $product = $item->get_product();
                if (!$product) continue;
                $sku = trim((string) $product->get_sku());
                if ($sku !== '' && !isset($items_by_sku[$sku])) {
                    $items_by_sku[$sku] = $item_id;
                }
            }
            $to_ship = [];
            foreach ($raw_items as $row) {
                if (!is_array($row)) continue;
                $sku = trim(sanitize_text_field((string) ($row['sku'] ?? '')));
                $qty = max(0, (int) ($row['qty'] ?? 0));
                if ($sku === '' || $qty <= 0 || !isset($items_by_sku[$sku])) continue;
                $to_ship[(int) $items_by_sku[$sku]] = $qty;
            }
            if (empty($to_ship)) {
                // Stamp split metadata so the badge still appears, but nothing to record.
                $order->update_meta_data('_oti_wms_total_parts', $total);
                $order->update_meta_data('_oti_wms_this_part', $part);
                $order->save();
                return new WP_Error('oti_ps_no_sku_match', 'No SKUs matched WC line items', ['status' => 422]);
            }

            // Per-order shipment_id counter + INSERT, atomically.
            $wpdb->query('START TRANSACTION');
            $last = (int) $wpdb->get_var($wpdb->prepare(
                "SELECT MAX(shipment_id) FROM {$wpdb->prefix}partial_shipment WHERE order_id = %d",
                $order_id
            ));
            $next_shipment_id = $last + 1;
            $ok = $wpdb->insert($wpdb->prefix . 'partial_shipment', [
                'order_id'      => $order_id,
                'shipment_id'   => $next_shipment_id,
                'shipment_url'  => '',
                'shipment_num'  => $shipment_num !== '' ? $shipment_num : $tracking,
                'shipment_date' => (string) current_time('timestamp', 0),
            ], ['%d', '%d', '%s', '%s', '%s']);
            if (!$ok) {
                $wpdb->query('ROLLBACK');
                error_log(sprintf('[OTI] partial_shipment INSERT failed for WC %d: %s', $order_id, $wpdb->last_error));
                return new WP_Error('oti_ps_insert', 'partial_shipment insert failed', ['status' => 500]);
            }
            $shipment_pk = (int) $wpdb->insert_id;
            $rows = [];
            $vals = [];
            foreach ($to_ship as $iid => $q) {
                $rows[] = '(%d, %d, %d)';
                $vals[] = $shipment_pk;
                $vals[] = (int) $iid;
                $vals[] = (int) $q;
            }
            $sql = "INSERT INTO {$wpdb->prefix}partial_shipment_items (shipment_id, item_id, item_qty) VALUES "
                 . implode(', ', $rows);
            if ($wpdb->query($wpdb->prepare($sql, $vals)) === false) {
                $wpdb->query('ROLLBACK');
                error_log(sprintf('[OTI] partial_shipment_items INSERT failed for WC %d shipment %d: %s', $order_id, $shipment_pk, $wpdb->last_error));
                return new WP_Error('oti_ps_items', 'partial_shipment_items insert failed', ['status' => 500]);
            }
            $wpdb->query('COMMIT');

            // Split metadata + parts_done (deduped, sorted) — computed from the fresh
            // $done read above, still under the lock, so completion can't be clobbered.
            $done[] = $part;
            $done = array_values(array_unique(array_map('intval', $done)));
            sort($done);
            $order->update_meta_data('_oti_wms_total_parts', $total);
            $order->update_meta_data('_oti_wms_this_part', $part);
            $order->update_meta_data('_oti_wms_parts_done', $done);
            $all_done = (count($done) >= $total);

            $order->add_order_note(sprintf(
                'WMS split despatch: Part %d/%d shipped via %s (%d line item(s))%s',
                $part, $total,
                $tracking !== '' ? $tracking : '(no tracking)',
                count($to_ship),
                $all_done ? ' — all parts despatched.' : ''
            ));

            // The shipment rows and parts_done above are a record of what the warehouse
            // despatched, and stay. Changing the ORDER STATUS is a separate decision: it is
            // made only for an order still in flight, read here, inside the lock.
            $current_status = (string) $order->get_status();
            $status_eligible = oti_ps_status_eligible($current_status);

            if (!$status_eligible) {
                $order->add_order_note(sprintf(
                    'WMS: Part %d/%d despatched, but the order is "%s" so its status was left unchanged.',
                    $part, $total, $current_status
                ));
                $order->save();
                error_log(sprintf(
                    '[OTI] partial-shipment Part %d/%d recorded for WC %d; status "%s" is not eligible, status left unchanged.',
                    $part, $total, $order_id, $current_status
                ));
            } elseif ($all_done) {
                // Skip the partial-shipped intermediate when this part closes the order.
                $order->update_status('completed', sprintf('WMS: all %d split parts despatched.', $total));
            } elseif (has_action('wphub_partial_shipment_status')) {
                // Persist metas, then let wphub-partial-shipment do its own transition
                // (equivalent to clicking "Add Shipment" in its UI) + customer email.
                $order->save();
                do_action('wphub_partial_shipment_status', $order_id);
                if (has_action('wphub_partial_shipment_new_email')) {
                    do_action('wphub_partial_shipment_new_email', $order_id, $shipment_pk);
                }
            } else {
                // wphub absent — fall back to wc-partial-shipped if registered, else
                // leave status untouched and log so an operator notices.
                $statuses = function_exists('wc_get_order_statuses') ? wc_get_order_statuses() : [];
                if (isset($statuses['wc-partial-shipped'])) {
                    $order->update_status('partial-shipped', sprintf(
                        'WMS: Part %d/%d despatched (wphub-partial-shipment unavailable — direct transition).',
                        $part, $total
                    ));
                } else {
                    $order->save();
                    error_log(sprintf(
                        '[OTI] partial-shipment recorded for WC %d Part %d/%d but no wphub plugin / wc-partial-shipped status to transition to.',
                        $order_id, $part, $total
                    ));
                }
            }

            return new WP_REST_Response([
                'ok'          => true,
                'part'        => $part,
                'all_done'    => $all_done,
                'shipment_id' => $next_shipment_id,
                'status_changed' => $status_eligible,
            ], 200);
        } finally {
            $wpdb->query($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock_name));
        }
    }
}

/* ============================================================
 * Module 4 — TrackShip Re-fire
 * ============================================================ */

// How long a `pending_trackship` row counts as proof of a shipment: TrackShip inserts it at once and finishes from a background job, so a row
// that stays pending past this is taken to have lost that job and the parcel is treated as missing again.
const OTI_TS_PENDING_GRACE = 3600;
// A tracking number despatched longer ago than this is never re-registered: the parcel has arrived, and TrackShip would e-mail the customer about it.
const OTI_TS_WINDOW = 604800;
// How far the signed timestamp may be from this server's clock, in seconds. A signed request is also single-use inside that window (the nonce).
const OTI_TS_REPLAY_WINDOW = 300;

if (!function_exists('oti_verify_trackship_refire_signature')) {
    /**
     * Signature of the TrackShip re-fire route: HMAC-SHA256, hex, of "timestamp \n METHOD \n path \n raw body" with the shared secret, header
     * X-OTI-Signature, timestamp in X-OTI-Timestamp. The body is JSON {order_id, ts, nonce}: the order id must equal the one in the URL, ts must equal
     * the header, and a nonce is accepted once (a transient kept for twice the window). A captured request cannot be pointed at another order, nor
     * re-sent. (The older signed routes sign the body only; that is a separate matter and is not changed here.)
     */
    function oti_verify_trackship_refire_signature(WP_REST_Request $request)
    {
        $secret = get_option(OTI_FX_SECRET_OPT, '');
        if (!is_string($secret) || $secret === '') {
            return new WP_Error('oti_fx_no_secret', 'onetwoInventory shared secret not configured', ['status' => 401]);
        }
        $signature = $request->get_header('x-oti-signature');
        $ts_header = $request->get_header('x-oti-timestamp');
        if (!$signature || !$ts_header || !ctype_digit((string) $ts_header)) {
            return new WP_Error('oti_ts_missing_sig', 'Missing signature or timestamp', ['status' => 401]);
        }
        $timestamp = (int) $ts_header;
        if (abs(time() - $timestamp) > OTI_TS_REPLAY_WINDOW) {
            return new WP_Error('oti_ts_stale', 'Timestamp outside the replay window', ['status' => 401]);
        }
        $order_id = absint($request['order_id']);
        $body = (string) $request->get_body();
        $path = '/wp-json/oti/v1/order/' . $order_id . '/trackship-refire';
        $expected = hash_hmac('sha256', $timestamp . "\n" . strtoupper($request->get_method()) . "\n" . $path . "\n" . $body, $secret);
        if (!hash_equals($expected, (string) $signature)) {
            return new WP_Error('oti_ts_bad_sig', 'Invalid signature', ['status' => 401]);
        }
        $payload = json_decode($body, true);
        if (!is_array($payload) || (int) ($payload['order_id'] ?? 0) !== $order_id || (int) ($payload['ts'] ?? 0) !== $timestamp) {
            return new WP_Error('oti_ts_bad_body', 'Body does not match the signed request', ['status' => 401]);
        }
        $nonce = isset($payload['nonce']) ? (string) $payload['nonce'] : '';
        if (!preg_match('/^[0-9a-f]{16,64}$/', $nonce)) {
            return new WP_Error('oti_ts_no_nonce', 'Missing nonce', ['status' => 401]);
        }
        $key = 'oti_tsn_' . md5($nonce);
        if (get_transient($key) !== false) {
            return new WP_Error('oti_ts_replayed', 'Request already used', ['status' => 401]);
        }
        set_transient($key, 1, 2 * OTI_TS_REPLAY_WINDOW);
        return true;
    }
}

if (!function_exists('oti_verify_partial_shipment_signature')) {
    /**
     * Signature of the partial-shipment route (1.5.3): HMAC-SHA256, hex, of "timestamp \n METHOD \n path \n nonce \n raw body" with the shared secret,
     * in the header X-OTI-Signature-V2; timestamp in X-OTI-Timestamp, nonce (16 to 64 hex characters) in X-OTI-Nonce. The path carries the order id, so a
     * captured request cannot be pointed at another order. It is refused outside a 300 second window and a nonce is accepted once (claimed atomically,
     * after the signature has passed so an unsigned caller cannot fill the table). The body-only X-OTI-Signature header is deliberately ignored.
     */
    function oti_verify_partial_shipment_signature(WP_REST_Request $request)
    {
        $secret = get_option(OTI_FX_SECRET_OPT, '');
        if (!is_string($secret) || $secret === '') {
            return new WP_Error('oti_fx_no_secret', 'onetwoInventory shared secret not configured', ['status' => 401]);
        }
        $signature = $request->get_header('x-oti-signature-v2');
        $ts_header = $request->get_header('x-oti-timestamp');
        $nonce     = $request->get_header('x-oti-nonce');
        if (!is_string($signature) || $signature === '' || !$ts_header || !ctype_digit((string) $ts_header) || !is_string($nonce) || !preg_match('/^[0-9a-f]{16,64}$/', $nonce)) {
            return new WP_Error('oti_ps_missing_sig', 'Missing signature, timestamp or nonce', ['status' => 401]);
        }
        $timestamp = (int) $ts_header;
        if (abs(time() - $timestamp) > OTI_TS_REPLAY_WINDOW) {
            return new WP_Error('oti_ps_stale', 'Timestamp outside the replay window', ['status' => 401]);
        }
        $order_id = absint($request['order_id']);
        $path = '/wp-json/oti/v1/order/' . $order_id . '/partial-shipment';
        $expected = hash_hmac('sha256', $timestamp . "\n" . strtoupper($request->get_method()) . "\n" . $path . "\n" . $nonce . "\n" . (string) $request->get_body(), $secret);
        if (!hash_equals($expected, $signature)) {
            return new WP_Error('oti_ps_bad_sig', 'Invalid signature', ['status' => 401]);
        }
        if (!oti_claim_nonce('ps', $nonce, OTI_TS_REPLAY_WINDOW)) {
            return new WP_Error('oti_ps_replayed', 'Request already used', ['status' => 401]);
        }
        return true;
    }
}

if (!function_exists('oti_handle_trackship_refire')) {
    /**
     * POST /wp-json/oti/v1/order/{id}/trackship-refire   (signed: see oti_verify_trackship_refire_signature)
     *
     * Answers one of, always HTTP 200 unless the request itself is wrong:
     *   result 'covered'         TrackShip holds a shipment for every tracking number on the order; nothing was fired.
     *   result 'fired'           at least one tracking number had no shipment (or a pending one past the grace window), the order was
     *                            eligible, and TrackShip's `send_order_to_trackship` action was fired once for the order.
     *   result 'not_eligible'    something was missing but TrackShip's own gate (`is_order_shipped`) refused the order right now
     *                            (not in a trigger status, or no tracking visible); nothing was fired.
     *   result 'no_tracking'     the order carries no tracking number; nothing to register.
     *   result 'outside_window'  every tracking number TrackShip lacks was despatched more than 7 days ago, or has no usable despatch date; nothing fired.
     *                            When a RECENT number is missing too the route fires (order-wide: an old missing number is re-registered with it).
     *   result 'trackship_inactive'  TrackShip is not installed or not ready (HTTP 503); nothing was fired.
     *   404 oti_ts_not_found     no such order.
     *
     * `missing` is the number of tracking numbers that had no shipment. Idempotent: TrackShip upserts on (order, tracking number), so a
     * repeat call cannot create a duplicate row. Serialised per order under a named lock so two overlapping calls fire once.
     */
    function oti_handle_trackship_refire(WP_REST_Request $request)
    {
        global $wpdb;
        if (!function_exists('wc_get_order')) {
            return new WP_Error('oti_ts_no_wc', 'WooCommerce not active', ['status' => 500]);
        }
        $order_id = absint($request['order_id']);
        $order = wc_get_order($order_id);
        if (!$order) {
            return new WP_Error('oti_ts_not_found', 'Order not found', ['status' => 404]);
        }
        if (!function_exists('trackship_for_woocommerce')) {
            return new WP_REST_Response(['ok' => false, 'result' => 'trackship_inactive', 'missing' => 0], 503);
        }
        $ts = trackship_for_woocommerce();
        if (!is_object($ts) || !method_exists($ts, 'get_tracking_items')) {
            return new WP_REST_Response(['ok' => false, 'result' => 'trackship_inactive', 'missing' => 0], 503);
        }

        $lock_name = 'oti_ts_refire_' . $order_id;
        if ((int) $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, %d)', $lock_name, 0)) !== 1) {
            return new WP_Error('oti_ts_lock', 'Another re-fire for this order is running', ['status' => 409]);
        }
        try {
            // Read through TrackShip itself, bypassing the object cache whose stale answer is what dropped the shipment in the first place.
            try {
                $items = $ts->get_tracking_items($order_id, false);
            } catch (\Throwable $e) {
                return new WP_REST_Response(['ok' => false, 'result' => 'trackship_inactive', 'missing' => 0], 503);
            }
            if (!is_array($items)) {
                return new WP_REST_Response(['ok' => false, 'result' => 'trackship_inactive', 'missing' => 0], 503);
            }
            $numbers = [];
            foreach ($items as $item) {
                $num = isset($item['tracking_number']) ? trim((string) $item['tracking_number']) : '';
                if ($num !== '') {
                    $numbers[$num] = true;
                }
            }
            if (empty($numbers)) {
                return new WP_REST_Response(['ok' => true, 'result' => 'no_tracking', 'missing' => 0], 200);
            }

            $table = $wpdb->prefix . 'trackship_shipment';
            $wpdb->last_error = '';
            // phpcs:ignore WordPress.DB.PreparedSQL -- table name is internal.
            $rows = $wpdb->get_results($wpdb->prepare("SELECT tracking_number, shipment_status FROM {$table} WHERE order_id = %d", $order_id));
            if ($wpdb->last_error || !is_array($rows)) {
                // A failed read must never be taken for "no shipments": firing on it would resubmit parcels that are already tracked.
                return new WP_REST_Response(['ok' => false, 'result' => 'trackship_inactive', 'missing' => 0], 503);
            }
            $status_by_number = [];
            foreach ($rows as $row) {
                $status_by_number[(string) $row->tracking_number] = (string) $row->shipment_status;
            }

            // A pending row is proof only inside the grace window, measured from when the tracking was shipped (the item's own date, which
            // nothing else touches), not from the order's modified time, which any unrelated save bumps.
            $now = time();
            $missing = 0;   // missing, despatched inside the window: a repair is wanted
            $outside = 0;   // missing, but despatched before the window OR with no usable date (fail closed): never a reason to fire
            foreach ($items as $item) {
                $num = isset($item['tracking_number']) ? trim((string) $item['tracking_number']) : '';
                if ($num === '') {
                    continue;
                }
                $raw_date = $item['date_shipped'] ?? 0;
                $shipped_at = (is_int($raw_date) || (is_string($raw_date) && ctype_digit($raw_date))) ? (int) $raw_date : 0;
                if (!isset($status_by_number[$num])) {
                    $is_missing = true;
                } elseif ($status_by_number[$num] === 'pending_trackship') {
                    // Pending proves a shipment only inside the grace; with no usable date the age cannot be judged, and it is left as covered.
                    $is_missing = $shipped_at > 0 && ($now - $shipped_at) > OTI_TS_PENDING_GRACE;
                } else {
                    $is_missing = false;
                }
                if (!$is_missing) {
                    continue;
                }
                // Each missing number is judged on its own. A missing date is NOT "recent": it counts as outside the window.
                if ($shipped_at <= 0 || ($now - $shipped_at) > OTI_TS_WINDOW) {
                    $outside++;
                } else {
                    $missing++;
                }
            }
            // Only when EVERY missing number is outside the window is the order refused. Firing is order-wide (TrackShip walks every tracking item), so
            // when a recent number is missing too, the action also re-registers the old one: accepted, because that parcel never reached TrackShip
            // either, and the alternative is leaving the recent parcel untracked for good. The answer says how many were outside.
            if ($missing === 0 && $outside > 0) {
                return new WP_REST_Response(['ok' => true, 'result' => 'outside_window', 'missing' => $outside], 200);
            }
            if ($missing === 0) {
                return new WP_REST_Response(['ok' => true, 'result' => 'covered', 'missing' => 0], 200);
            }

            // TrackShip's own gate: a trigger status AND tracking visible. When it says no, firing would do nothing.
            $eligible = false;
            try {
                $eligible = (bool) apply_filters('is_order_shipped', false, $order);
            } catch (\Throwable $e) {
                return new WP_REST_Response(['ok' => false, 'result' => 'trackship_inactive', 'missing' => $missing], 503);
            }
            if (!$eligible) {
                return new WP_REST_Response(['ok' => true, 'result' => 'not_eligible', 'missing' => $missing], 200);
            }
            try {
                do_action('send_order_to_trackship', $order_id);
            } catch (\Throwable $e) {
                return new WP_REST_Response(['ok' => false, 'result' => 'trackship_inactive', 'missing' => $missing], 503);
            }
            return new WP_REST_Response(['ok' => true, 'result' => 'fired', 'missing' => $missing, 'outside_window' => $outside], 200);
        } finally {
            $wpdb->query($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock_name));
        }
    }
}

/* ============================================================
 * Module 5 — Incumbents probe (READ ONLY)
 * ============================================================ */

// How far the signed timestamp of the probe may be from this server's clock, in seconds (short: the probe is a read that IMS repeats).
const OTI_INCUMBENTS_WINDOW = 60;
// The legacy bridge plugin: its exact slug, REST namespace, settings option and the WooCommerce webhook it relies on.
const OTI_BRIDGE_PLUGIN_SLUG      = 'wc-mintsoft-sync';
const OTI_BRIDGE_REST_NAMESPACE   = '/wc-mintsoft/v1';
const OTI_BRIDGE_SETTINGS_OPT     = 'wc_mintsoft_settings';
const OTI_BRIDGE_PRODUCT_SYNC_HOOK = 'wc_mintsoft_run_product_sync';
const OTI_BRIDGE_WEBHOOK_URL_PART = '/webhook/woocommerce/product-update';
// Xeroom's order-note switch: the option read by the o3d mu-plugin that suppresses only Xeroom's WooCommerce order note.
const OTI_XEROOM_NOTE_OFF_OPT     = 'o3d_xeroom_order_note_off';
// Withdrawal-request capture (1.5.0, per-order options 1.5.1). Neither option kind is order meta, so neither is ever an order save or an order.updated webhook.
// OTI_WDRAW_OUTCOME_ON_OPT is switched on by IMS itself, the first time it posts a withdrawal outcome (only when it is live); until then the capture hook is inert.
// KNOWN LIMIT: a request filed before that first post (or between activation and it) is never captured, so IMS's rejection of it ends as a `no_request`
// operator task (a person rejects it by hand), not a loss. Later requests are captured.
const OTI_WDRAW_OUTCOME_ON_OPT    = 'oti_withdrawal_outcome_enabled';
// ONE option per order (`oti_wdraw_req_<order id>` => request id), autoload off, deleted with the order. Not one shared map: a read-modify-write of a
// shared map loses an entry when two submissions land together (update_option has no compare-and-set); a per-order key has no shared state to lose.
const OTI_WDRAW_REQUEST_ID_OPT_PREFIX = 'oti_wdraw_req_';
// The order statuses (without the `wc-` prefix) that can carry a withdrawal request: WebToffee's defaults, filterable (`oti_wdraw_statuses`) for a store that renamed them.
// An order response looks the request id up ONLY for these (or for an order IMS already wrote an outcome marker on), so a normal order costs no query.
const OTI_WDRAW_STATUSES = ['pending-wdraw', 'withdrawn'];

if (!function_exists('oti_verify_incumbents_signature')) {
    /**
     * Signature of the probe: HMAC-SHA256, hex, of "timestamp \n METHOD \n path \n nonce" with the shared secret, header X-OTI-Signature, timestamp in
     * X-OTI-Timestamp, nonce (16 to 64 hex characters) in X-OTI-Nonce. The window is 60 seconds and a nonce is accepted once.
     */
    function oti_verify_incumbents_signature(WP_REST_Request $request)
    {
        $secret = get_option(OTI_FX_SECRET_OPT, '');
        if (!is_string($secret) || $secret === '') {
            return new WP_Error('oti_inc_no_secret', 'onetwoInventory shared secret not configured', ['status' => 401]);
        }
        $signature = $request->get_header('x-oti-signature');
        $ts_header = $request->get_header('x-oti-timestamp');
        $nonce     = $request->get_header('x-oti-nonce');
        if (!$signature || !$ts_header || !ctype_digit((string) $ts_header) || !is_string($nonce) || !preg_match('/^[0-9a-f]{16,64}$/', $nonce)) {
            return new WP_Error('oti_inc_missing_sig', 'Missing signature, timestamp or nonce', ['status' => 401]);
        }
        $timestamp = (int) $ts_header;
        if (abs(time() - $timestamp) > OTI_INCUMBENTS_WINDOW) {
            return new WP_Error('oti_inc_stale', 'Timestamp outside the window', ['status' => 401]);
        }
        $path = '/wp-json/oti/v1/incumbents';
        $expected = hash_hmac('sha256', $timestamp . "\n" . strtoupper($request->get_method()) . "\n" . $path . "\n" . $nonce, $secret);
        if (!hash_equals($expected, (string) $signature)) {
            return new WP_Error('oti_inc_bad_sig', 'Invalid signature', ['status' => 401]);
        }
        if (!oti_claim_nonce('inc', $nonce, OTI_INCUMBENTS_WINDOW)) {
            return new WP_Error('oti_inc_replayed', 'Request already used', ['status' => 401]);
        }
        return true;
    }
}

if (!function_exists('oti_claim_nonce')) {
    /**
     * Claim a single-use nonce ATOMICALLY: one INSERT IGNORE on the options table's unique option_name, so two parallel replays cannot both pass (a
     * transient get-then-set can, and without a persistent object cache is not shared at all). True = this call claimed it; false = already used, or the
     * claim could not be made (fail closed). Claims older than twice the window are deleted on the way.
     */
    function oti_claim_nonce($scope, $nonce, $window)
    {
        global $wpdb;
        if (!isset($wpdb) || !is_object($wpdb)) {
            return false;
        }
        $prefix = 'oti_nonce_' . $scope . '_';
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery -- an atomic claim has no API equivalent.
        $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name LIKE %s AND CAST(option_value AS UNSIGNED) < %d", $wpdb->esc_like($prefix) . '%', time() - (2 * (int) $window)));
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery
        $claimed = $wpdb->query($wpdb->prepare("INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')", $prefix . md5((string) $nonce), (string) time()));
        return $claimed === 1;
    }
}

if (!function_exists('oti_incumbents_bridge_routes_registered')) {
    /** Is any REST route of the bridge plugin registered right now? Read from the server's own route table, so it holds however the plugin is loaded. */
    function oti_incumbents_bridge_routes_registered()
    {
        if (!function_exists('rest_get_server')) {
            return null;
        }
        $server = rest_get_server();
        if (!is_object($server) || !method_exists($server, 'get_routes')) {
            return null;
        }
        $routes = $server->get_routes();
        if (!is_array($routes)) {
            return null;
        }
        foreach (array_keys($routes) as $route) {
            if (strpos((string) $route, OTI_BRIDGE_REST_NAMESPACE) === 0) {
                return true;
            }
        }
        return false;
    }
}

if (!function_exists('oti_incumbents_bridge_webhooks')) {
    /** The WooCommerce webhooks that deliver to the bridge's product endpoint: how many exist and how many are active. Null when they cannot be read. */
    function oti_incumbents_bridge_webhooks()
    {
        if (!class_exists('WC_Data_Store') || !class_exists('WC_Webhook')) {
            return null;
        }
        try {
            $store = WC_Data_Store::load('webhook');
            $ids = $store->search_webhooks(['limit' => 500]);
            if (!is_array($ids)) {
                return null;
            }
            $total = 0;
            $active = 0;
            foreach ($ids as $id) {
                $hook = new WC_Webhook($id);
                if (strpos((string) $hook->get_delivery_url(), OTI_BRIDGE_WEBHOOK_URL_PART) === false) {
                    continue;
                }
                $total++;
                if ($hook->get_status() === 'active') {
                    $active++;
                }
            }
            return ['total' => $total, 'active' => $active];
        } catch (\Throwable $e) {
            return null;
        }
    }
}

if (!function_exists('oti_incumbents_pending_product_sync_jobs')) {
    /** Pending Action Scheduler jobs of the bridge's product sync hook. Null when Action Scheduler cannot be read. */
    function oti_incumbents_pending_product_sync_jobs()
    {
        if (!function_exists('as_get_scheduled_actions')) {
            return null;
        }
        try {
            $ids = as_get_scheduled_actions([
                'hook'     => OTI_BRIDGE_PRODUCT_SYNC_HOOK,
                'status'   => 'pending',
                'per_page' => 1000,
            ], 'ids');
            return is_array($ids) ? count($ids) : null;
        } catch (\Throwable $e) {
            return null;
        }
    }
}

if (!function_exists('oti_incumbents_latest_mintsoft_write')) {
    /**
     * The latest time (unix seconds) the bridge stamped on any order. WooCommerce meta rows carry no write time, so this covers exactly the `_mintsoft_*` keys
     * whose VALUE is a time: `_mintsoft_status_updated_at`, `_mintsoft_sync_queued_at` (the bridge deletes it on success), `_mintsoft_wdraw_queued_at` and
     * `_mintsoft_wdraw_escalated`. A bridge write that leaves no time (tracking, order id and number links, outcome flags) is NOT visible to it: the probe is one
     * signal beside the settings and route checks, not proof the bridge is silent. 0 when it never has; null when unreadable.
     */
    function oti_incumbents_latest_mintsoft_write()
    {
        global $wpdb;
        if (!isset($wpdb) || !is_object($wpdb)) {
            return null;
        }
        $keys = ['_mintsoft_status_updated_at', '_mintsoft_sync_queued_at', '_mintsoft_wdraw_queued_at', '_mintsoft_wdraw_escalated'];
        $tables = [];
        $hpos = $wpdb->prefix . 'wc_orders_meta';
        // phpcs:ignore WordPress.DB.PreparedSQL -- table names are internal.
        if ((string) $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $hpos)) === $hpos) {
            $tables[] = $hpos;
        }
        $tables[] = $wpdb->postmeta;
        $latest = 0;
        foreach ($tables as $table) {
            $wpdb->last_error = '';
            $placeholders = implode(',', array_fill(0, count($keys), '%s'));
            // phpcs:ignore WordPress.DB.PreparedSQL -- table name is internal; the keys are bound.
            $value = $wpdb->get_var($wpdb->prepare("SELECT MAX(CAST(meta_value AS UNSIGNED)) FROM {$table} WHERE meta_key IN ({$placeholders})", $keys));
            if ($wpdb->last_error) {
                return null;
            }
            $latest = max($latest, (int) $value);
        }
        return $latest;
    }
}

if (!function_exists('oti_handle_incumbents')) {
    /**
     * GET /wp-json/oti/v1/incumbents   (signed: see oti_verify_incumbents_signature). READ ONLY: writes nothing, anywhere.
     *
     * Every field is a plain value; a field that could not be read is null (IMS reads null as "not probed", never as "fine").
     */
    function oti_handle_incumbents(WP_REST_Request $request)
    {
        $settings = get_option(OTI_BRIDGE_SETTINGS_OPT, null);
        $order_sync = null;
        if (is_array($settings)) {
            $order_sync = !empty($settings['order_sync_enabled']);
        } elseif ($settings === null || $settings === false || $settings === '') {
            // No settings option at all: the bridge was never configured here, so its order sync is not on.
            $order_sync = false;
        }
        $xeroom_off = get_option(OTI_XEROOM_NOTE_OFF_OPT, null);
        $plugin_active = null;
        if (function_exists('is_plugin_active')) {
            $plugin_active = is_plugin_active(OTI_BRIDGE_PLUGIN_SLUG . '/' . OTI_BRIDGE_PLUGIN_SLUG . '.php');
        }
        return new WP_REST_Response([
            'ok'            => true,
            'plugin_version' => '1.5.3',
            'generated_at'  => time(),
            'bridge'        => [
                'slug'                   => OTI_BRIDGE_PLUGIN_SLUG,
                // Informational only: whether the plugin is active is NOT the signal. The routes, the switch, the webhook, the jobs and the writes are.
                'plugin_active'          => $plugin_active,
                'routes_registered'      => oti_incumbents_bridge_routes_registered(),
                'order_sync_enabled'     => $order_sync,
                'product_webhook'        => oti_incumbents_bridge_webhooks(),
                'pending_product_jobs'   => oti_incumbents_pending_product_sync_jobs(),
                'latest_mintsoft_write'  => oti_incumbents_latest_mintsoft_write(),
            ],
            'xeroom'        => [
                // Absent means the default (false): Xeroom still writes its note.
                'order_note_off'         => $xeroom_off === null || $xeroom_off === false ? false : in_array((string) $xeroom_off, ['1', 'yes', 'true', 'on'], true),
                'order_note_off_present' => $xeroom_off !== null && $xeroom_off !== false,
            ],
        ], 200);
    }
}

/* ============================================================
 * Module 6 — Withdrawal outcome
 * ============================================================ */

if (!function_exists('oti_verify_withdrawal_outcome_signature')) {
    /**
     * Same scheme as the TrackShip re-fire route (HMAC of "timestamp \n METHOD \n path \n raw body", body {order_id, ts, nonce, ...}, single-use
     * nonce, 5 minute window), over this route's own path so a captured re-fire request cannot be replayed here.
     */
    function oti_verify_withdrawal_outcome_signature(WP_REST_Request $request)
    {
        $secret = get_option(OTI_FX_SECRET_OPT, '');
        if (!is_string($secret) || $secret === '') {
            return new WP_Error('oti_wo_no_secret', 'onetwoInventory shared secret not configured', ['status' => 401]);
        }
        $signature = $request->get_header('x-oti-signature');
        $ts_header = $request->get_header('x-oti-timestamp');
        if (!$signature || !$ts_header || !ctype_digit((string) $ts_header)) {
            return new WP_Error('oti_wo_missing_sig', 'Missing signature or timestamp', ['status' => 401]);
        }
        $timestamp = (int) $ts_header;
        if (abs(time() - $timestamp) > OTI_TS_REPLAY_WINDOW) {
            return new WP_Error('oti_wo_stale', 'Timestamp outside the replay window', ['status' => 401]);
        }
        $order_id = absint($request['order_id']);
        $body = (string) $request->get_body();
        $path = '/wp-json/oti/v1/order/' . $order_id . '/withdrawal-outcome';
        $expected = hash_hmac('sha256', $timestamp . "\n" . strtoupper($request->get_method()) . "\n" . $path . "\n" . $body, $secret);
        if (!hash_equals($expected, (string) $signature)) {
            return new WP_Error('oti_wo_bad_sig', 'Invalid signature', ['status' => 401]);
        }
        $payload = json_decode($body, true);
        if (!is_array($payload) || (int) ($payload['order_id'] ?? 0) !== $order_id || (int) ($payload['ts'] ?? 0) !== $timestamp) {
            return new WP_Error('oti_wo_bad_body', 'Body does not match the signed request', ['status' => 401]);
        }
        $nonce = isset($payload['nonce']) ? (string) $payload['nonce'] : '';
        if (!preg_match('/^[0-9a-f]{16,64}$/', $nonce)) {
            return new WP_Error('oti_wo_no_nonce', 'Missing nonce', ['status' => 401]);
        }
        if (!oti_claim_nonce('wo', $nonce, OTI_TS_REPLAY_WINDOW)) {
            return new WP_Error('oti_wo_replayed', 'Request already used', ['status' => 401]);
        }
        return true;
    }
}

if (!function_exists('oti_capture_wdraw_request')) {
    /**
     * Remember the withdrawal plugin's request id for an order, in a per-order wp_option (`oti_wdraw_req_<order id>`), NEVER in order meta. On the HPOS store
     * save_meta_data() saves the order itself (a new modified time, woocommerce_update_order, an order.updated webhook), so any order-meta write is a live
     * order write; an option write is not. The id reaches IMS through oti_expose_wdraw_request_id (the order's REST and webhook payload), and the
     * withdrawal-outcome route reads it back at call time. Hooked to the withdrawal plugin's own events; the arguments are ($request, $order).
     *
     * INERT until IMS switches the withdrawal outcome on (option `oti_withdrawal_outcome_enabled`, set by the outcome route): in P1 the plugin writes nothing.
     */
    function oti_capture_wdraw_request($request = null, $order = null)
    {
        if (get_option(OTI_WDRAW_OUTCOME_ON_OPT, '') !== 'yes') {
            return;
        }
        if (!is_object($request) || !isset($request->id) || !is_object($order) || !method_exists($order, 'get_id')) {
            return;
        }
        $id = absint($request->id);
        $order_id = absint($order->get_id());
        if (!$id || !$order_id) {
            return;
        }
        $option = OTI_WDRAW_REQUEST_ID_OPT_PREFIX . $order_id;
        if (absint(get_option($option, 0)) === $id) {
            return;
        }
        update_option($option, $id, false);
    }
    add_action('wbte_ewb_request_submitted', 'oti_capture_wdraw_request', 5, 2);
    add_action('wbte_ewb_request_approved', 'oti_capture_wdraw_request', 5, 2);
    add_action('wbte_ewb_request_rejected', 'oti_capture_wdraw_request', 5, 2);
}

if (!function_exists('oti_wdraw_request_id_for_order')) {
    /**
     * The captured withdrawal request id of an order (0 when none). A read; never writes. It is a single-row SELECT on the options table, NOT get_option():
     * get_option() records every MISS in the one shared `notoptions` cache array, which would grow by an entry per order read through REST.
     */
    function oti_wdraw_request_id_for_order($order_id)
    {
        global $wpdb;
        $name = OTI_WDRAW_REQUEST_ID_OPT_PREFIX . absint($order_id);
        $value = $wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s LIMIT 1", $name));
        return absint($value);
    }
}

if (!function_exists('oti_expose_wdraw_request_id')) {
    /**
     * Put the captured request id into the order's REST response (and so its webhook payload) as a TOP-LEVEL field `_oti_wdraw_request_id`, which is where IMS
     * reads it. NOT a meta_data entry: a client that round-trips meta_data in a PUT would persist a meta entry as real order meta, and a stale id could stick.
     * A response filter: nothing is stored on the order.
     *
     * NO LOOKUP unless the capture switch is on AND the order is in a withdrawal status (or already carries IMS's outcome markers, which is how a request IMS
     * has rejected, and which has left the withdrawal status, stays visible): every other order response costs nothing.
     */
    function oti_expose_wdraw_request_id($response, $order = null)
    {
        if (!is_object($response) || !isset($response->data) || !is_array($response->data) || !is_object($order) || !method_exists($order, 'get_id')) {
            return $response;
        }
        if (get_option(OTI_WDRAW_OUTCOME_ON_OPT, '') !== 'yes') {
            return $response;
        }
        $statuses = apply_filters('oti_wdraw_statuses', OTI_WDRAW_STATUSES);
        $status = method_exists($order, 'get_status') ? (string) $order->get_status() : '';
        $has_marker = method_exists($order, 'get_meta') && is_array($order->get_meta('_oti_wdraw_outcome_keys')) && count($order->get_meta('_oti_wdraw_outcome_keys')) > 0;
        if (!$has_marker && !(is_array($statuses) && in_array($status, $statuses, true))) {
            return $response;
        }
        $request_id = oti_wdraw_request_id_for_order($order->get_id());
        if (!$request_id) {
            return $response;
        }
        $response->data['_oti_wdraw_request_id'] = (int) $request_id;
        return $response;
    }
    add_filter('woocommerce_rest_prepare_shop_order_object', 'oti_expose_wdraw_request_id', 20, 2);
}

if (!function_exists('oti_forget_wdraw_request')) {
    /** Cleanup: an order that is deleted leaves the map. delete_option on an absent option is one SELECT and records nothing in `notoptions`. */
    function oti_forget_wdraw_request($order_id)
    {
        delete_option(OTI_WDRAW_REQUEST_ID_OPT_PREFIX . absint($order_id));
    }
    /** The same, for a legacy (post-backed) order: delete_post fires for EVERY post type, so only an order type is looked at. */
    function oti_forget_wdraw_request_for_post($post_id)
    {
        $type = get_post_type($post_id);
        if ($type === 'shop_order' || $type === 'shop_order_placehold') {
            oti_forget_wdraw_request($post_id);
        }
    }
    add_action('woocommerce_delete_order', 'oti_forget_wdraw_request', 10, 1);
    add_action('delete_post', 'oti_forget_wdraw_request_for_post', 10, 1);
}

if (!function_exists('oti_handle_withdrawal_outcome')) {
    /**
     * POST /wp-json/oti/v1/order/{id}/withdrawal-outcome   (signed: see oti_verify_withdrawal_outcome_signature)
     *
     * Body: {order_id, ts, nonce, outcome: 'noted'|'rejected', note?: string, reject_reason?: string, request_id?: int, outcome_key: string}
     *
     *   'noted'     add the (admin-only) order note. Nothing else.
     *   'rejected'  the goods have already gone: reject the customer's withdrawal request through the withdrawal plugin's own service (so its e-mails and
     *               log run), then add the note. The request id is the one in the body, else the one captured for the order, else the bridge's `_mintsoft_wdraw_request_id`. It must belong to this order, or nothing is rejected ('no_request').
     *
     * Idempotent per outcome_key: a note is added once per key (kept in an order meta), so a retry after a lost answer adds nothing. Answers:
     *   result 'noted' | 'rejected' | 'already_done'; 'no_request' (rejection asked, no request id known: the note was still added);
     *   'no_withdrawal_plugin' (rejection asked, the withdrawal plugin is not active: nothing rejected, note added); 'not_rejected' (the request was not pending and is not rejected, e.g. approved meanwhile: no note); 404 oti_wo_not_found.
     */
    function oti_handle_withdrawal_outcome(WP_REST_Request $request)
    {
        global $wpdb;
        if (!function_exists('wc_get_order')) {
            return new WP_Error('oti_wo_no_wc', 'WooCommerce not active', ['status' => 500]);
        }
        $order_id = absint($request['order_id']);
        $data = json_decode((string) $request->get_body(), true);
        $data = is_array($data) ? $data : [];
        $outcome = isset($data['outcome']) ? (string) $data['outcome'] : '';
        if (!in_array($outcome, ['noted', 'rejected'], true)) {
            return new WP_Error('oti_wo_bad_outcome', 'Unknown outcome', ['status' => 400]);
        }
        $key = isset($data['outcome_key']) ? (string) $data['outcome_key'] : '';
        if (!preg_match('/^[A-Za-z0-9:_-]{8,96}$/', $key)) {
            return new WP_Error('oti_wo_bad_key', 'Missing outcome key', ['status' => 400]);
        }
        $note = isset($data['note']) ? sanitize_textarea_field((string) $data['note']) : '';

        $lock_name = 'oti_wo_' . $order_id;
        if ((int) $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, %d)', $lock_name, 0)) !== 1) {
            return new WP_Error('oti_wo_lock', 'Another outcome for this order is running', ['status' => 409]);
        }
        try {
            // The order and its done-markers are read only AFTER the lock is held: a parallel call that has just released it has written its markers.
            $order = wc_get_order($order_id);
            if (!$order) {
                return new WP_Error('oti_wo_not_found', 'Order not found', ['status' => 404]);
            }
            // IMS posting an outcome means the outcome writer is live: switch the capture hook on (an option, not order meta).
            if (get_option(OTI_WDRAW_OUTCOME_ON_OPT, '') !== 'yes') {
                update_option(OTI_WDRAW_OUTCOME_ON_OPT, 'yes', false);
            }
            // Two done-markers per key, so a retry resumes exactly where the last attempt stopped: `n:` the note is written, `r:` the rejection is carried out.
            $done = $order->get_meta('_oti_wdraw_outcome_keys');
            $done = is_array($done) ? $done : [];
            $note_done = in_array('n:' . $key, $done, true) || in_array($key, $done, true);
            $reject_done = $outcome !== 'rejected' || in_array('r:' . $key, $done, true) || in_array($key, $done, true);
            if ($note_done && $reject_done) {
                return new WP_REST_Response(['ok' => true, 'result' => 'already_done'], 200);
            }
            $result = 'noted';
            $fresh = [];
            if ($outcome === 'rejected' && !$reject_done) {
                $reason = isset($data['reject_reason']) && $data['reject_reason'] !== '' ? sanitize_textarea_field((string) $data['reject_reason']) : 'order already dispatched';
                if (!class_exists('Wbte_Ewb_Request_Service') || !class_exists('Wbte_Ewb_Request_Repository')) {
                    $result = 'no_withdrawal_plugin';
                } else {
                    $request_id = isset($data['request_id']) ? absint($data['request_id']) : 0;
                    if (!$request_id) {
                        $request_id = oti_wdraw_request_id_for_order($order_id);
                    }
                    if (!$request_id) {
                        $request_id = absint($order->get_meta('_mintsoft_wdraw_request_id'));
                    }
                    if (!$request_id) {
                        $result = 'no_request';
                    } else {
                        try {
                            $repo = new Wbte_Ewb_Request_Repository();
                            // The request must be THIS order's: the id in the body is never trusted on its own. Unknown ownership fails closed.
                            $found = method_exists($repo, 'find') ? $repo->find($request_id) : null;
                            $owner = is_object($found) ? (isset($found->order_id) ? absint($found->order_id) : (method_exists($found, 'get_order_id') ? absint($found->get_order_id()) : 0)) : 0;
                            if ($owner !== $order_id) {
                                $result = 'no_request';
                            } else {
                                $service = new Wbte_Ewb_Request_Service($repo);
                                $rejected = $service->reject($request_id, 0, $reason);
                                if (is_wp_error($rejected) && $rejected->get_error_code() !== 'wbte_ewb_not_pending') {
                                    return new WP_REST_Response(['ok' => false, 'result' => 'reject_failed'], 502);
                                }
                                if (is_wp_error($rejected)) {
                                    // Not pending: only a request that is REJECTED counts as done. One approved meanwhile is not (the bridge checks is_rejected() too).
                                    $now = method_exists($repo, 'find') ? $repo->find($request_id) : null;
                                    if (!is_object($now) || !method_exists($now, 'is_rejected') || !$now->is_rejected()) {
                                        return new WP_REST_Response(['ok' => true, 'result' => 'not_rejected'], 200);
                                    }
                                }
                                $result = 'rejected';
                                $fresh[] = 'r:' . $key;
                            }
                        } catch (\Throwable $e) {
                            return new WP_REST_Response(['ok' => false, 'result' => 'reject_failed'], 502);
                        }
                    }
                }
            }
            if (!$note_done) {
                if ($note !== '' && !$order->add_order_note($note)) {
                    return new WP_REST_Response(['ok' => false, 'result' => 'note_failed'], 502);
                }
                $fresh[] = 'n:' . $key;
            }
            if ($fresh) {
                // The done-markers are order meta. On the HPOS store save_meta_data() saves the order, so this DOES raise one order.updated webhook; IMS's own
                // ledger (a fixed key per order and request) is what makes that harmless, not the absence of a save.
                $order->update_meta_data('_oti_wdraw_outcome_keys', array_slice(array_merge($done, $fresh), -40));
                $order->save_meta_data();
            }
            return new WP_REST_Response(['ok' => true, 'result' => $result], 200);
        } finally {
            $wpdb->query($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock_name));
        }
    }
}

if (!function_exists('oti_can_download_invoice_pdf')) {
    function oti_can_download_invoice_pdf(WP_REST_Request $request)
    {
        $order_id = absint($request['order_id']);
        if ($order_id <= 0 || !function_exists('wc_get_order')) {
            return new WP_Error('oti_invoice_not_found', 'Invoice not found', ['status' => 404]);
        }

        $nonce = $request->get_param('_wpnonce');
        if (!is_string($nonce) || !wp_verify_nonce($nonce, 'oti_invoice_pdf_' . $order_id)) {
            return new WP_Error('oti_invoice_bad_nonce', 'Invalid invoice download request', ['status' => 403]);
        }

        $order = wc_get_order($order_id);
        if (!$order || !oti_order_has_invoice_pdf($order_id)) {
            return new WP_Error('oti_invoice_not_found', 'Invoice not found', ['status' => 404]);
        }

        if (current_user_can('manage_woocommerce')) return true;
        $user_id = get_current_user_id();
        if ($user_id > 0 && (int) $order->get_customer_id() === $user_id) return true;

        return new WP_Error('oti_invoice_forbidden', 'Invoice not found', ['status' => 404]);
    }
}

if (!function_exists('oti_normalized_ims_base_url')) {
    function oti_normalized_ims_base_url(): string
    {
        $raw = trim((string) get_option(OTI_IMS_INVOICE_PDF_BASE_URL_OPT, ''));
        if ($raw === '') return '';
        $url = untrailingslashit(esc_url_raw($raw));
        $parts = wp_parse_url($url);
        if (!is_array($parts)) return '';
        $scheme = isset($parts['scheme']) ? strtolower((string) $parts['scheme']) : '';
        $host = isset($parts['host']) ? (string) $parts['host'] : '';
        if ($scheme !== 'https' || $host === '') return '';
        return $url;
    }
}

if (!function_exists('oti_invoice_pdf_endpoint')) {
    function oti_invoice_pdf_endpoint(): string
    {
        $base = oti_normalized_ims_base_url();
        if ($base === '') return '';
        return $base . '/api/shopping/woocommerce/invoice-pdf';
    }
}

if (!function_exists('oti_proxy_invoice_pdf')) {
    function oti_proxy_invoice_pdf(WP_REST_Request $request)
    {
        $order_id = absint($request['order_id']);
        $order = function_exists('wc_get_order') ? wc_get_order($order_id) : null;
        if (!$order) {
            return new WP_Error('oti_invoice_not_found', 'Invoice not found', ['status' => 404]);
        }

        $endpoint = oti_invoice_pdf_endpoint();
        $secret = (string) get_option(OTI_INVOICE_PDF_SECRET_OPT, '');
        if ($endpoint === '' || $secret === '') {
            return new WP_Error('oti_invoice_not_configured', 'Invoice download is not configured', ['status' => 503]);
        }

        $now = time();
        $payload = [
            'connector'          => 'woocommerce',
            'externalOrderId'    => (string) $order_id,
            'externalCustomerId' => (string) $order->get_customer_id(),
            'externalOrderKey'   => (string) $order->get_order_key(),
            'issuedAt'           => $now,
            'expiresAt'          => $now + 300,
            'nonce'              => wp_generate_uuid4(),
        ];
        $body = wp_json_encode($payload);
        if (!is_string($body)) {
            return new WP_Error('oti_invoice_payload_failed', 'Invoice download failed', ['status' => 500]);
        }

        $response = wp_remote_post($endpoint, [
            'timeout' => 30,
            'headers' => [
                'Content-Type'    => 'application/json',
                'X-OTI-Signature' => hash_hmac('sha256', $body, $secret),
            ],
            'body' => $body,
        ]);
        if (is_wp_error($response)) {
            return new WP_Error('oti_invoice_upstream_failed', 'Invoice download failed', ['status' => 502]);
        }

        $code = (int) wp_remote_retrieve_response_code($response);
        $pdf = wp_remote_retrieve_body($response);
        if ($code !== 200 || $pdf === '') {
            return new WP_Error('oti_invoice_unavailable', 'Invoice not found', ['status' => $code >= 400 ? $code : 502]);
        }

        nocache_headers();
        header('Content-Type: application/pdf');
        header('Content-Disposition: inline; filename="invoice-' . $order_id . '.pdf"');
        echo $pdf;
        exit;
    }
}

/* ------------------------------------------------------------
 * Aelia Currency Switcher integration: RETIRED in 1.3.0
 *
 * Earlier versions hooked `wc_aelia_currencyswitcher_exchange_rate` and served the rates IMS had pushed (option `oti_fx_rates`)
 * in place of Aelia's own. Aelia is the exchange-rate master, so this plugin NO LONGER hooks that filter (nor flushes Aelia's
 * caches): nothing here overrides, converts or caches an Aelia rate, stale or not. The options `oti_fx_rates`,
 * `oti_fx_base_currency` and `oti_fx_last_push` left by earlier versions are left as they are (nothing writes them any more and
 * nothing reads them except the read-only table on the settings page). A site admin may delete those three options at will.
 * ------------------------------------------------------------ */

/* ------------------------------------------------------------
 * Settings page: paste the shared secret + view current state
 * ------------------------------------------------------------ */

add_action('admin_menu', function () {
    add_options_page(
        'onetwoInventory Helper',
        'onetwoInventory',
        'manage_options',
        'oti-helper',
        'oti_render_settings_page'
    );
});

add_action('admin_init', function () {
    register_setting('oti_helper', OTI_FX_SECRET_OPT, [
        'type'              => 'string',
        'sanitize_callback' => 'sanitize_text_field',
        'show_in_rest'      => false,
    ]);
    register_setting('oti_helper', OTI_INVOICE_PDF_SECRET_OPT, [
        'type'              => 'string',
        'sanitize_callback' => 'sanitize_text_field',
        'show_in_rest'      => false,
    ]);
    register_setting('oti_helper', OTI_IMS_INVOICE_PDF_BASE_URL_OPT, [
        'type'              => 'string',
        'sanitize_callback' => 'esc_url_raw',
        'show_in_rest'      => false,
    ]);
});

if (!function_exists('oti_render_settings_page')) {
    function oti_render_settings_page(): void
    {
        if (!current_user_can('manage_options')) return;

        $secret    = (string) get_option(OTI_FX_SECRET_OPT, '');
        $invoice_secret = (string) get_option(OTI_INVOICE_PDF_SECRET_OPT, '');
        $ims_base_url = (string) get_option(OTI_IMS_INVOICE_PDF_BASE_URL_OPT, '');
        $rates     = get_option(OTI_FX_OPTION, []);
        $base      = (string) get_option(OTI_FX_BASE_OPT, '');
        $last_push = (string) get_option(OTI_FX_LASTPUSH_OPT, '');
        $endpoint  = esc_url_raw(rest_url(OTI_FX_NAMESPACE . '/fx-rates'));

        echo '<div class="wrap">';
        echo '<h1>onetwoInventory Helper</h1>';
        echo '<p>Companion plugin for One Two Inventory. Receives FX rates from IMS and proxies customer invoice PDF downloads after WooCommerce account ownership checks.</p>';

        echo '<form method="post" action="options.php">';
        settings_fields('oti_helper');
        echo '<table class="form-table" role="presentation">';
        echo '<tr><th scope="row"><label for="oti-secret">Shared secret</label></th>';
        echo '<td><input type="password" id="oti-secret" name="' . esc_attr(OTI_FX_SECRET_OPT) . '" value="' . esc_attr($secret) . '" class="regular-text" autocomplete="off">';
        echo '<p class="description">Paste the same value you set as <code>WC_WEBHOOK_SECRET</code> in One Two Inventory. Used only to verify FX rate pushes from IMS.</p></td></tr>';
        echo '<tr><th scope="row"><label for="oti-invoice-secret">Invoice PDF secret</label></th>';
        echo '<td><input type="password" id="oti-invoice-secret" name="' . esc_attr(OTI_INVOICE_PDF_SECRET_OPT) . '" value="' . esc_attr($invoice_secret) . '" class="regular-text" autocomplete="off">';
        echo '<p class="description">Paste the same value you set as <code>WC_INVOICE_PDF_SECRET</code> in One Two Inventory. This is separate from the WooCommerce webhook / FX secret.</p></td></tr>';
        echo '<tr><th scope="row"><label for="oti-ims-base-url">IMS base URL</label></th>';
        echo '<td><input type="url" id="oti-ims-base-url" name="' . esc_attr(OTI_IMS_INVOICE_PDF_BASE_URL_OPT) . '" value="' . esc_attr($ims_base_url) . '" class="regular-text" placeholder="https://ims.example.com">';
        echo '<p class="description">HTTPS base URL for One Two Inventory. The helper constructs the fixed invoice endpoint from this site option and never follows per-order meta URLs.</p></td></tr>';
        echo '</table>';
        submit_button();
        echo '</form>';

        echo '<h2>FX rate endpoint</h2>';
        echo '<p><code>' . esc_html($endpoint) . '</code></p>';

        echo '<h2>Current rates</h2>';
        if (!is_array($rates) || empty($rates)) {
            echo '<p><em>No rates received yet. Once IMS pushes its first set, they will appear here.</em></p>';
        } else {
            echo '<p><strong>Base:</strong> ' . esc_html($base) . ' &nbsp; <strong>Last push:</strong> ' . esc_html($last_push) . '</p>';
            echo '<table class="widefat striped" style="max-width:480px"><thead><tr><th>Currency</th><th>Rate (1 ' . esc_html($base) . ' = X)</th><th>Fetched at</th></tr></thead><tbody>';
            foreach ($rates as $code => $row) {
                if (!is_array($row)) continue;
                echo '<tr><td>' . esc_html((string) $code) . '</td><td>' . esc_html((string) ($row['rate'] ?? '')) . '</td><td>' . esc_html((string) ($row['fetchedAt'] ?? '')) . '</td></tr>';
            }
            echo '</tbody></table>';
        }
        echo '</div>';
    }
}
