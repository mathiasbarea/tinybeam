<?php
// Tinybeam ID endpoint for PHP 7.3+ (docs/spec.md, section 5, `id_store: endpoint`). It keeps the stable
// ID and the consent decision in cookies set by the site's own server, so Safari doesn't cap them at 7
// days, while events go straight to a Tinybeam collector anywhere.
//
// Install: save it so that /tb/id on your site runs it, for example as tb/id/index.php in the web root.
// The page loads tinybeam-ids.js with data-id="endpoint".
//
// The same logic as createIdEndpoint() in collector/endpoint.js. It needs no configuration: it never knows
// the visitor's region, which the collector decides.

$secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
$set = function ($name, $value, $maxAge) use ($secure) {
    setcookie($name, $value, [
        'expires' => $maxAge > 0 ? time() + $maxAge : time() - 3600,
        'path' => '/',
        'secure' => $secure,
        'httponly' => false, // the script reads them
        'samesite' => 'Lax',
    ]);
};

// Only the site's own pages may call it.
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && $origin !== ($secure ? 'https://' : 'http://') . $_SERVER['HTTP_HOST']) {
    http_response_code(403);
    exit;
}

$id = preg_match('/^[a-z0-9]{16,40}$/', $_COOKIE['tb_id'] ?? '') ? $_COOKIE['tb_id'] : null;
$decision = preg_match('/^[01]{2}$/', $_COOKIE['tb_c'] ?? '') ? $_COOKIE['tb_c'] : null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = json_decode(file_get_contents('php://input') ?: '{}', true);
    if (!is_array($body)) $body = [];
    if (isset($body['analytics']) && is_bool($body['analytics'])) {
        // A decision: remember it, and keep or delete the ID with it.
        $decision = ($body['analytics'] ? '1' : '0') . (($body['ads'] ?? false) === true ? '1' : '0');
        $set('tb_c', $decision, 182 * 86400);
        $id = $body['analytics'] ? ($id ?: bin2hex(random_bytes(16))) : null;
    } else {
        // No decision: a region where consent isn't required.
        $id = $id ?: bin2hex(random_bytes(16));
    }
} elseif ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    header('Allow: GET, POST');
    exit;
}

if ($id) {
    $set('tb_id', $id, 395 * 86400); // 13 months, renewed
    $set('tb_r', '1', 86400);        // renewed today: the script won't call again until tomorrow
} elseif (isset($_COOKIE['tb_id'])) {
    $set('tb_id', '', 0);
    $set('tb_r', '', 0);
}

header('Content-Type: application/json');
header('Cache-Control: no-store');
echo json_encode(['i' => $id, 'c' => $decision]);
