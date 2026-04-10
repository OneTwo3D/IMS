<?php
/**
 * Plugin Name: One Two Inventory — Invoice Buttons
 * Description: Adds invoice PDF download buttons to WooCommerce My Account orders
 *              and the wp-admin order page. Reads _invoice_pdf_url and
 *              _accounting_invoice_url order meta set by One Two Inventory.
 * Version: 1.0.0
 * Requires PHP: 7.4
 *
 * Drop this file into wp-content/mu-plugins/
 */

defined('ABSPATH') || exit;

/* ──────────────────────────────────────────────
 * Helper: read meta from order (HPOS-compatible)
 * ────────────────────────────────────────────── */

function oti_get_order_meta(int $order_id, string $key): string {
    if (function_exists('wc_get_order')) {
        $order = wc_get_order($order_id);
        if ($order) {
            return (string) $order->get_meta($key);
        }
    }
    return (string) get_post_meta($order_id, $key, true);
}

/* ──────────────────────────────────────────────
 * Customer: "Invoice" button on My Account orders list
 * ────────────────────────────────────────────── */

add_filter('woocommerce_my_account_my_orders_actions', function (array $actions, $order) {
    $pdf_url = oti_get_order_meta($order->get_id(), '_invoice_pdf_url');
    if ($pdf_url) {
        $actions['invoice_pdf'] = [
            'url'  => esc_url($pdf_url),
            'name' => __('Invoice', 'woocommerce'),
        ];
    }
    return $actions;
}, 10, 2);

/* ──────────────────────────────────────────────
 * Customer: "Download Invoice" button on order detail page
 * ────────────────────────────────────────────── */

add_action('woocommerce_order_details_after_order_table', function ($order) {
    $pdf_url = oti_get_order_meta($order->get_id(), '_invoice_pdf_url');
    if (!$pdf_url) return;

    printf(
        '<p class="oti-invoice-download"><a href="%s" class="button" target="_blank" rel="noopener noreferrer">%s</a></p>',
        esc_url($pdf_url),
        esc_html__('Download Invoice PDF', 'woocommerce')
    );
});

/* ──────────────────────────────────────────────
 * Admin: Invoice meta box on order edit screen
 * ────────────────────────────────────────────── */

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

function oti_render_invoice_meta_box($post_or_order): void {
    $order_id = $post_or_order instanceof WP_Post ? $post_or_order->ID : $post_or_order->get_id();

    $pdf_url        = oti_get_order_meta($order_id, '_invoice_pdf_url');
    $accounting_url = oti_get_order_meta($order_id, '_accounting_invoice_url');

    if (!$pdf_url && !$accounting_url) {
        echo '<p>' . esc_html__('No invoice available yet.', 'woocommerce') . '</p>';
        return;
    }

    if ($pdf_url) {
        printf(
            '<p><a href="%s" class="button" target="_blank" rel="noopener noreferrer">%s</a></p>',
            esc_url($pdf_url),
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
