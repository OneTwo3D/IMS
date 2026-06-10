<?php
/**
 * Plugin Name: onetwoInventory Helper
 * Plugin URI:  https://github.com/OneTwo3D/IMS
 * Description: Companion plugin for One Two Inventory. Adds invoice download
 *              buttons to WooCommerce, and accepts FX rate pushes from IMS so
 *              the storefront's multi-currency display matches the rates used
 *              in IMS and Xero.
 * Version:     1.0.0
 * Author:      One Two Enterprises Ltd
 * Requires PHP: 7.4
 * Requires at least: 6.0
 *
 * Modules included:
 *   1. Invoice Buttons — adds invoice PDF / accounting links to My Account
 *      orders and the wp-admin order screen, reading order meta written by
 *      One Two Inventory.
 *   2. FX Rate Receiver — exposes a signed REST endpoint POST /wp-json/oti/v1/fx-rates
 *      that One Two Inventory pushes daily ECB rates to. Stored rates are
 *      surfaced to the Aelia Currency Switcher (and other plugins via filter)
 *      so the storefront converts at the same rate as IMS and Xero.
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

add_action('rest_api_init', function () {
    register_rest_route(OTI_FX_NAMESPACE, '/fx-rates', [
        'methods'             => 'POST',
        'permission_callback' => 'oti_verify_fx_signature',
        'callback'            => 'oti_handle_fx_push',
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
    function oti_handle_fx_push(WP_REST_Request $request): WP_REST_Response
    {
        $params = $request->get_json_params();
        $rates  = isset($params['rates']) && is_array($params['rates']) ? $params['rates'] : [];

        $clean   = [];
        $base    = '';
        $skipped = 0;

        foreach ($rates as $row) {
            $from = isset($row['fromCurrency']) ? strtoupper((string) $row['fromCurrency']) : '';
            $to   = isset($row['toCurrency'])   ? strtoupper((string) $row['toCurrency'])   : '';
            $rate = isset($row['rate']) ? (float) $row['rate'] : 0.0;
            if ($from === '' || $to === '' || !is_finite($rate) || $rate <= 0) {
                $skipped++;
                continue;
            }
            // Last write wins per `to` currency.
            $clean[$to] = [
                'from'      => $from,
                'rate'      => $rate,
                'fetchedAt' => isset($row['fetchedAt']) ? (string) $row['fetchedAt'] : gmdate('c'),
            ];
            if ($base === '') $base = $from;
        }

        update_option(OTI_FX_OPTION, $clean, /* autoload */ false);
        if ($base !== '') update_option(OTI_FX_BASE_OPT, $base, false);
        update_option(OTI_FX_LASTPUSH_OPT, gmdate('c'), false);

        // Best-effort cache invalidation for Aelia Currency Switcher.
        oti_invalidate_aelia_cache();

        return new WP_REST_Response([
            'ok'      => true,
            'pushed'  => count($clean),
            'skipped' => $skipped,
        ]);
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

if (!function_exists('oti_invalidate_aelia_cache')) {
    function oti_invalidate_aelia_cache(): void
    {
        // Aelia stores rates inside its own settings option and may cache them
        // in transients. Delete any transient keys that look like Aelia rate
        // caches so the next storefront request picks up the new values.
        global $wpdb;
        if (!isset($wpdb) || !is_object($wpdb)) return;
        $like = $wpdb->esc_like('_transient_aelia_cs_exchange_rates') . '%';
        $wpdb->query(
            $wpdb->prepare(
                "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
                $like,
                '_transient_timeout_aelia_cs_exchange_rates%'
            )
        );

        // Newer Aelia versions expose a public reset method. If present, call it.
        if (class_exists('\Aelia\WC\CurrencySwitcher\WC_Aelia_CurrencySwitcher')) {
            $obj = \Aelia\WC\CurrencySwitcher\WC_Aelia_CurrencySwitcher::instance();
            if (is_object($obj) && method_exists($obj, 'reset_settings_cache')) {
                $obj->reset_settings_cache();
            }
        }
    }
}

/* ------------------------------------------------------------
 * Aelia Currency Switcher integration
 *
 * We hook the per-pair exchange rate filter rather than
 * registering a full provider class. This is forward-compatible
 * across Aelia versions and avoids depending on Aelia's internal
 * class hierarchy.
 *
 * Direction handling: IMS sends rates as "1 base = X to-currency".
 * Aelia asks for the rate to convert "from" → "to". We resolve any
 * conversion that touches the IMS base currency:
 *   - base → X       : direct lookup, return stored rate
 *   - X    → base    : inverted lookup (1 / rate)
 *   - X    → Y       : cross-rate via base (Y_rate / X_rate)
 * ------------------------------------------------------------ */

add_filter('wc_aelia_currencyswitcher_exchange_rate', function ($default, $from_currency, $to_currency) {
    $rates = get_option(OTI_FX_OPTION, []);
    $base  = (string) get_option(OTI_FX_BASE_OPT, '');
    if (!is_array($rates) || empty($rates) || $base === '') {
        return $default;
    }

    $from = strtoupper((string) $from_currency);
    $to   = strtoupper((string) $to_currency);
    if ($from === $to) return 1.0;

    $resolved = oti_resolve_rate($from, $to, $base, $rates);
    return $resolved !== null ? $resolved : $default;
}, 10, 3);

if (!function_exists('oti_resolve_rate')) {
    /**
     * @param array<string,array{from:string,rate:float,fetchedAt:string}> $rates
     */
    function oti_resolve_rate(string $from, string $to, string $base, array $rates): ?float
    {
        if ($from === $base) {
            return isset($rates[$to]) ? (float) $rates[$to]['rate'] : null;
        }
        if ($to === $base) {
            if (!isset($rates[$from])) return null;
            $r = (float) $rates[$from]['rate'];
            return $r > 0 ? 1 / $r : null;
        }
        // Cross rate via base.
        if (!isset($rates[$from]) || !isset($rates[$to])) return null;
        $rFrom = (float) $rates[$from]['rate'];
        $rTo   = (float) $rates[$to]['rate'];
        return $rFrom > 0 ? $rTo / $rFrom : null;
    }
}

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
