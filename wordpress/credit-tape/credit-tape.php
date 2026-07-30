<?php
/**
 * Plugin Name:  Credit Tape
 * Description:  Renders end-of-day credit spreads from a Credit Tape JSON feed. Syncs once daily, caches server-side, no CORS.
 * Version:      1.1.0
 * Requires PHP: 7.4
 * Author:       Stepan
 * License:      MIT
 */

defined( 'ABSPATH' ) || exit;

define( 'CREDIT_TAPE_VERSION', '1.1.0' );
define( 'CREDIT_TAPE_CACHE_KEY', 'credit_tape_data_v1' );
define( 'CREDIT_TAPE_FALLBACK_KEY', 'credit_tape_last_good_v1' );
define( 'CREDIT_TAPE_CRON_HOOK', 'credit_tape_refresh' );

/**
 * Trailing-slash base URL of the published feed, e.g.
 * https://raw.githubusercontent.com/<user>/credit-tape/main/public/
 */
function credit_tape_base_url() {
	$url = defined( 'CREDIT_TAPE_BASE_URL' )
		? CREDIT_TAPE_BASE_URL
		: get_option( 'credit_tape_base_url', '' );

	return apply_filters( 'credit_tape_base_url', trailingslashit( trim( (string) $url ) ) );
}

/** Longest history retained server-side. Shortcode windows slice out of this. */
function credit_tape_max_days() {
	// 40 years. The ICE series are capped at 3 by the publisher anyway; this
	// only matters for BAA10Y (1986→) and T10Y2Y.
	return (int) apply_filters( 'credit_tape_max_days', 365 * 40 );
}

/** Window key → days of history. null means everything available. */
function credit_tape_window_days( $key ) {
	$map = array(
		'1M'  => 30,
		'3M'  => 91,
		'6M'  => 182,
		'1Y'  => 365,
		'3Y'  => 1095,
		'5Y'  => 1825,
		'10Y' => 3650,
		'MAX' => null,
	);
	$key = strtoupper( trim( (string) $key ) );
	return array_key_exists( $key, $map ) ? $map[ $key ] : 365;
}

/* -------------------------------------------------------------------------
 * Sync
 * ---------------------------------------------------------------------- */

function credit_tape_fetch_json( $url ) {
	$res = wp_remote_get(
		$url,
		array(
			'timeout'    => 20,
			'user-agent' => 'CreditTape/' . CREDIT_TAPE_VERSION . '; ' . home_url(),
			'headers'    => array( 'Accept' => 'application/json' ),
		)
	);

	if ( is_wp_error( $res ) ) {
		return $res;
	}

	$code = wp_remote_retrieve_response_code( $res );
	if ( 200 !== $code ) {
		return new WP_Error( 'credit_tape_http', sprintf( 'HTTP %d from %s', $code, $url ) );
	}

	$data = json_decode( wp_remote_retrieve_body( $res ), true );
	if ( ! is_array( $data ) ) {
		return new WP_Error( 'credit_tape_json', 'Response was not valid JSON: ' . $url );
	}

	return $data;
}

/**
 * Pulls the manifest plus every series, trimmed to the retention window.
 * Returns the payload the shortcode renders from, or WP_Error.
 */
function credit_tape_sync() {
	$base = credit_tape_base_url();
	if ( '' === $base ) {
		return new WP_Error( 'credit_tape_unconfigured', 'No feed URL set. Settings → Credit Tape.' );
	}

	$manifest = credit_tape_fetch_json( $base . 'data/manifest.json' );
	if ( is_wp_error( $manifest ) ) {
		return $manifest;
	}
	if ( empty( $manifest['series'] ) || ! is_array( $manifest['series'] ) ) {
		return new WP_Error( 'credit_tape_empty', 'Manifest contained no series.' );
	}

	$cutoff_ms = ( time() - credit_tape_max_days() * DAY_IN_SECONDS ) * 1000;
	$payload   = array(
		'generatedAt' => isset( $manifest['generatedAt'] ) ? $manifest['generatedAt'] : gmdate( 'c' ),
		'syncedAt'    => gmdate( 'c' ),
		'series'      => array(),
	);

	foreach ( $manifest['series'] as $meta ) {
		if ( empty( $meta['id'] ) ) {
			continue;
		}

		$series = credit_tape_fetch_json( $base . 'data/' . rawurlencode( $meta['id'] ) . '.json' );
		if ( is_wp_error( $series ) || empty( $series['observations'] ) ) {
			continue; // One bad series shouldn't sink the whole sync.
		}

		$trimmed = array();
		foreach ( $series['observations'] as $row ) {
			if ( isset( $row[0], $row[1] ) && $row[0] >= $cutoff_ms ) {
				$trimmed[] = array( (int) $row[0], (float) $row[1] );
			}
		}

		$meta['observations'] = $trimmed;
		$payload['series'][]  = $meta;
	}

	if ( empty( $payload['series'] ) ) {
		return new WP_Error( 'credit_tape_empty', 'Every series failed to load.' );
	}

	set_transient( CREDIT_TAPE_CACHE_KEY, $payload, DAY_IN_SECONDS );
	update_option( CREDIT_TAPE_FALLBACK_KEY, $payload, false ); // survives cache flush / GitHub outage
	delete_option( 'credit_tape_last_error' );

	return $payload;
}

/**
 * Cached read. Falls back to the last good sync rather than rendering nothing
 * if GitHub is unreachable — a day-old spread beats an empty box.
 */
function credit_tape_get_data() {
	$cached = get_transient( CREDIT_TAPE_CACHE_KEY );
	if ( is_array( $cached ) ) {
		return $cached;
	}

	$fresh = credit_tape_sync();
	if ( ! is_wp_error( $fresh ) ) {
		return $fresh;
	}

	update_option( 'credit_tape_last_error', $fresh->get_error_message(), false );

	$fallback = get_option( CREDIT_TAPE_FALLBACK_KEY );
	return is_array( $fallback ) ? $fallback : null;
}

add_action( CREDIT_TAPE_CRON_HOOK, 'credit_tape_sync' );

register_activation_hook( __FILE__, function () {
	if ( ! wp_next_scheduled( CREDIT_TAPE_CRON_HOOK ) ) {
		// 00:30 UTC — comfortably after the 23:10 UTC GitHub Actions deploy.
		wp_schedule_event( strtotime( 'tomorrow 00:30 UTC' ), 'daily', CREDIT_TAPE_CRON_HOOK );
	}
} );

register_deactivation_hook( __FILE__, function () {
	wp_clear_scheduled_hook( CREDIT_TAPE_CRON_HOOK );
	delete_transient( CREDIT_TAPE_CACHE_KEY );
} );

/* -------------------------------------------------------------------------
 * Shortcode
 * ---------------------------------------------------------------------- */

function credit_tape_shortcode( $atts ) {
	$a = shortcode_atts(
		array(
			'series' => 'US HY,US IG', // short names or FRED IDs, comma separated
			'window' => '1Y',          // 1M 3M 6M 1Y 3Y 5Y 10Y MAX
			'show'   => 'both',        // both | cards | chart
			'height' => '380',
			'theme'  => 'light',       // light | dark
			'accent' => '',            // overrides every series line colour
			'up'     => '#c51e3a',     // widening
			'down'   => '#2f9e8f',     // tightening
			'colors' => '',            // per-series overrides, comma separated
		),
		$atts,
		'credit_tape'
	);

	$data = credit_tape_get_data();
	if ( ! $data ) {
		if ( current_user_can( 'manage_options' ) ) {
			$err = get_option( 'credit_tape_last_error', 'No feed URL set.' );
			return '<p class="credit-tape-notice">Credit Tape has no data: ' . esc_html( $err )
				. ' <a href="' . esc_url( admin_url( 'options-general.php?page=credit-tape' ) ) . '">Check settings</a>.</p>';
		}
		return '';
	}

	// Resolve the requested series against the feed, preserving the caller's order.
	$wanted   = array_filter( array_map( 'trim', explode( ',', $a['series'] ) ) );
	$overrides = array_filter( array_map( 'trim', explode( ',', $a['colors'] ) ) );
	$selected = array();

	foreach ( $wanted as $i => $want ) {
		foreach ( $data['series'] as $s ) {
			$matches = 0 === strcasecmp( $want, $s['id'] ) || 0 === strcasecmp( $want, $s['short'] );
			if ( ! $matches ) {
				continue;
			}
			if ( '' !== $a['accent'] ) {
				$s['color'] = $a['accent'];
			} elseif ( isset( $overrides[ $i ] ) ) {
				$s['color'] = $overrides[ $i ];
			}
			$selected[] = $s;
			break;
		}
	}

	if ( empty( $selected ) ) {
		return current_user_can( 'manage_options' )
			? '<p class="credit-tape-notice">Credit Tape: no series matched "' . esc_html( $a['series'] ) . '".</p>'
			: '';
	}

	credit_tape_enqueue();

	// Trim each series to the requested window before inlining. Without this a
	// MAX-window BAA10Y chart would push ~200KB of JSON into the page source.
	$window     = strtoupper( $a['window'] );
	$window_days = credit_tape_window_days( $window );

	if ( null !== $window_days ) {
		$cutoff_ms = ( time() - $window_days * DAY_IN_SECONDS ) * 1000;
		foreach ( $selected as $i => $s ) {
			if ( empty( $s['observations'] ) ) {
				continue;
			}
			$selected[ $i ]['observations'] = array_values(
				array_filter(
					$s['observations'],
					static function ( $row ) use ( $cutoff_ms ) {
						return isset( $row[0] ) && $row[0] >= $cutoff_ms;
					}
				)
			);
		}
	}

	// Cards need no series history at all — drop it entirely.
	if ( 'cards' === $a['show'] ) {
		foreach ( $selected as $i => $s ) {
			$selected[ $i ]['observations'] = array();
		}
	}

	$id      = 'credit-tape-' . wp_unique_id();
	$payload = array(
		'series'   => $selected,
		'window'   => $window,
		'show'     => $a['show'],
		'theme'    => $a['theme'],
		'up'       => $a['up'],
		'down'     => $a['down'],
		'syncedAt' => $data['syncedAt'],
	);

	ob_start();
	?>
	<div class="credit-tape credit-tape--<?php echo esc_attr( $a['theme'] ); ?>"
		id="<?php echo esc_attr( $id ); ?>"
		style="--ct-up:<?php echo esc_attr( $a['up'] ); ?>;--ct-down:<?php echo esc_attr( $a['down'] ); ?>;">
		<script type="application/json" class="credit-tape-data"><?php
			echo wp_json_encode( $payload );
		?></script>
		<div class="credit-tape-cards"></div>
		<div class="credit-tape-chart" style="height:<?php echo (int) $a['height']; ?>px">
			<canvas></canvas>
		</div>
		<p class="credit-tape-stamp"></p>
	</div>
	<?php
	return ob_get_clean();
}
add_shortcode( 'credit_tape', 'credit_tape_shortcode' );

function credit_tape_enqueue() {
	if ( wp_script_is( 'credit-tape', 'enqueued' ) ) {
		return;
	}

	$dir = plugin_dir_url( __FILE__ );

	wp_enqueue_style( 'credit-tape', $dir . 'assets/credit-tape.css', array(), CREDIT_TAPE_VERSION );

	// Swap for a locally hosted copy with:
	// add_filter( 'credit_tape_chartjs_url', fn() => get_stylesheet_directory_uri() . '/js/chart.umd.min.js' );
	$chartjs = apply_filters(
		'credit_tape_chartjs_url',
		'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
	);

	wp_enqueue_script( 'chartjs', $chartjs, array(), '4.4.1', true );
	wp_enqueue_script( 'credit-tape', $dir . 'assets/credit-tape.js', array( 'chartjs' ), CREDIT_TAPE_VERSION, true );
}

/* -------------------------------------------------------------------------
 * Settings
 * ---------------------------------------------------------------------- */

add_action( 'admin_menu', function () {
	add_options_page( 'Credit Tape', 'Credit Tape', 'manage_options', 'credit-tape', 'credit_tape_settings_page' );
} );

add_action( 'admin_init', function () {
	register_setting( 'credit_tape', 'credit_tape_base_url', array( 'sanitize_callback' => 'esc_url_raw' ) );
} );

function credit_tape_settings_page() {
	if ( isset( $_POST['credit_tape_sync_now'] ) && check_admin_referer( 'credit_tape_sync' ) ) {
		delete_transient( CREDIT_TAPE_CACHE_KEY );
		$result = credit_tape_sync();
		echo is_wp_error( $result )
			? '<div class="notice notice-error"><p>' . esc_html( $result->get_error_message() ) . '</p></div>'
			: '<div class="notice notice-success"><p>Synced ' . count( $result['series'] ) . ' series.</p></div>';
	}

	$data = get_option( CREDIT_TAPE_FALLBACK_KEY );
	?>
	<div class="wrap">
		<h1>Credit Tape</h1>

		<form method="post" action="options.php">
			<?php settings_fields( 'credit_tape' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="credit_tape_base_url">Feed URL</label></th>
					<td>
						<input type="url" class="regular-text" id="credit_tape_base_url"
							name="credit_tape_base_url"
							value="<?php echo esc_attr( get_option( 'credit_tape_base_url', '' ) ); ?>"
							placeholder="https://raw.githubusercontent.com/user/credit-tape/main/public/">
						<p class="description">Root of the published feed. The plugin reads <code>data/manifest.json</code> beneath it.</p>
					</td>
				</tr>
			</table>
			<?php submit_button( 'Save feed URL' ); ?>
		</form>

		<hr>
		<h2>Sync</h2>
		<p>
			Runs daily at 00:30 UTC.
			<?php if ( is_array( $data ) ) : ?>
				Last successful sync: <strong><?php echo esc_html( $data['syncedAt'] ); ?></strong>
				(<?php echo count( $data['series'] ); ?> series).
			<?php else : ?>
				No successful sync yet.
			<?php endif; ?>
		</p>
		<form method="post">
			<?php wp_nonce_field( 'credit_tape_sync' ); ?>
			<?php submit_button( 'Sync now', 'secondary', 'credit_tape_sync_now', false ); ?>
		</form>

		<hr>
		<h2>Shortcode</h2>
		<p><code>[credit_tape series="US HY,US IG" window="1Y" theme="light" height="380"]</code></p>
		<p>
			<strong>series</strong> — any of:
			<?php
			echo is_array( $data )
				? esc_html( implode( ', ', wp_list_pluck( $data['series'], 'short' ) ) )
				: 'sync first to list available series';
			?><br>
			<strong>window</strong> — 1M, 3M, 6M, 1Y, 3Y, 5Y, 10Y, MAX &nbsp;·&nbsp;
			<strong>show</strong> — both, cards, chart &nbsp;·&nbsp;
			<strong>theme</strong> — light, dark<br>
			<strong>accent</strong> — one hex for all lines &nbsp;·&nbsp;
			<strong>colors</strong> — per-series hex list &nbsp;·&nbsp;
			<strong>up</strong> / <strong>down</strong> — widening / tightening colours
		</p>
	</div>
	<?php
}
