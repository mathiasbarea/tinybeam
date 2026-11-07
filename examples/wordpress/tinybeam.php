<?php
/*
 * Plugin Name: Tinybeam
 * Description: Lightweight first-party analytics. Adds the Tinybeam script to every page and keeps the visitor's ID in cookies set by this site, so returning visitors are recognized for 13 months in every browser.
 * Version: 0.0.0
 * Requires PHP: 7.3
 * License: MIT
 */

// Settings > Tinybeam: the site ID and the collector's address from the Tinybeam portal, and whether the
// site uses Tinybeam's consent banner. The plugin then:
// - prints the script tag (tinybeam-ids.js with data-id="endpoint") and the noscript pixel in <head>,
// - answers /tb/id itself: the ID endpoint (docs/spec.md, section 5), examples/endpoint/id.php.
// To install, put this file and examples/endpoint/id.php in a `tinybeam` folder under wp-content/plugins
// (or zip that folder and upload it in Plugins > Add New).

if (!defined('ABSPATH')) exit;

function tinybeam_options() {
    return wp_parse_args(get_option('tinybeam', []), ['site' => '', 'collector' => '', 'banner' => '']);
}

add_action('wp_head', function () {
    $o = tinybeam_options();
    if (!$o['site'] || !$o['collector']) return;
    $collector = untrailingslashit($o['collector']);
    printf(
        '<script src="%1$s/tb/tinybeam-ids.js" data-site="%2$s" data-endpoint="%1$s/tb/e" data-id="endpoint"%3$s defer></script>' .
        '<noscript><img src="%1$s/tb/n?s=%2$s" alt="" width="1" height="1"></noscript>' . "\n",
        esc_url($collector),
        esc_attr($o['site']),
        $o['banner'] ? ' data-consent="auto"' : ''
    );
}, 1);

// The ID endpoint, before WordPress routes the request.
add_action('init', function () {
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
    if ($path !== '/tb/id') return;
    require __DIR__ . '/id.php';
    exit;
}, 0);

add_action('admin_menu', function () {
    add_options_page('Tinybeam', 'Tinybeam', 'manage_options', 'tinybeam', function () {
        $o = tinybeam_options(); ?>
        <div class="wrap"><h1>Tinybeam</h1>
        <form method="post" action="options.php"><?php settings_fields('tinybeam'); ?>
        <table class="form-table">
        <tr><th><label for="tb-site">Site ID</label></th><td><input id="tb-site" name="tinybeam[site]" value="<?php echo esc_attr($o['site']); ?>" class="regular-text"></td></tr>
        <tr><th><label for="tb-collector">Collector address</label></th><td><input id="tb-collector" name="tinybeam[collector]" type="url" placeholder="https://analytics.example.com" value="<?php echo esc_attr($o['collector']); ?>" class="regular-text"></td></tr>
        <tr><th>Consent banner</th><td><label><input type="checkbox" name="tinybeam[banner]" value="1" <?php checked($o['banner'], '1'); ?>> Use Tinybeam's banner (configured in the Tinybeam portal)</label></td></tr>
        </table><?php submit_button(); ?></form></div>
    <?php });
});

add_action('admin_init', function () {
    register_setting('tinybeam', 'tinybeam', ['sanitize_callback' => function ($input) {
        return [
            'site' => preg_replace('/[^a-z0-9]/', '', strtolower($input['site'] ?? '')),
            'collector' => esc_url_raw($input['collector'] ?? ''),
            'banner' => empty($input['banner']) ? '' : '1',
        ];
    }]);
});
