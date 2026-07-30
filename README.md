# Credit Tape

End-of-day credit spread monitor. Node fetch script + static frontend, hosted free on GitHub Pages, refreshed nightly by GitHub Actions.

Data comes from FRED's ICE BofA option-adjusted spread series — the standard free stand-in for CDX/iTraxx index levels.

## Why it's built this way

`fredgraph.csv` doesn't send `Access-Control-Allow-Origin`, so a browser can't call FRED directly. Rather than run a proxy server, the data is fetched at build time and committed to the deployed artifact as static JSON. The site is then pure static files: no runtime, no server bill, no API key. A daily cron re-runs the fetch, which matches the once-a-day cadence of the underlying data anyway.

## Layout

```
scripts/fetch-fred.mjs        pulls FRED CSV → public/data/*.json + manifest.json
scripts/fetch-fred.test.mjs   parser tests (node --test, no deps)
server.mjs                    local static server for preview
public/                       everything that gets deployed
.github/workflows/deploy.yml  nightly fetch + Pages deploy
```

Zero runtime dependencies. Chart.js loads from a CDN in the browser.

## Local run

```bash
npm run fetch    # pull today's marks into public/data/
npm run dev      # http://localhost:4173
npm test         # parser tests
```

`public/data/*.json` is gitignored — it's regenerated on every deploy, so there's no reason to version it.

## Deploy to GitHub Pages

```bash
cd eod-credit-dashboard
git init -b main
git add .
git commit -m "Credit spread EOD dashboard"
gh repo create credit-tape --public --source=. --push
```

Then, once:

1. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. Repo → **Actions** → *Refresh data and deploy* → **Run workflow**

Live at `https://<user>.github.io/credit-tape/`. After that it redeploys on every push and on the 23:10 UTC weekday cron.

Without `gh`, create the repo in the web UI and:

```bash
git remote add origin https://github.com/<user>/credit-tape.git
git push -u origin main
```

## WordPress

`wordpress/credit-tape/` is a self-contained plugin. Zip that folder, upload it under Plugins → Add New → Upload, activate, then set the feed URL under **Settings → Credit Tape** and hit **Sync now**.

```
[credit_tape series="US HY,US IG" window="1Y" theme="light" height="380"]
```

Drop that into an Elementor **Shortcode** widget, or a Text/HTML widget, or the block editor.

| Attribute | Default | Notes |
|---|---|---|
| `series` | `US HY,US IG` | Short names or FRED IDs, comma separated. Order is preserved. |
| `window` | `1Y` | `1M` `3M` `6M` `1Y` `3Y` |
| `show` | `both` | `both` `cards` `chart` |
| `height` | `380` | Chart height in px |
| `theme` | `light` | `light` `dark` |
| `accent` | — | One hex applied to every line |
| `colors` | — | Per-series hex list, matched positionally to `series` |
| `up` / `down` | `#c51e3a` / `#2f9e8f` | Widening / tightening |

Steady Trader: `[credit_tape colors="#c51e3a,#62BEB1" up="#c51e3a" down="#62BEB1"]`
CompassFX dark section: `[credit_tape theme="dark" accent="#FF7A00"]`

### How the sync works

WordPress calls the GitHub Pages JSON **server-side** via `wp_remote_get`, so CORS never enters the picture and visitors make zero external requests. The response is trimmed to 3 years, cached in a transient for 24h, and mirrored into an option as a fallback — if GitHub is unreachable the widget renders yesterday's marks instead of an empty box.

A daily WP-Cron event at 00:30 UTC refreshes it, half an hour after the Actions deploy. WP-Cron only fires on page traffic, but that doesn't matter here: the transient read triggers a sync on expiry anyway, so a quiet site self-heals on its next visitor.

Chart.js loads from jsDelivr. To self-host it instead:

```php
add_filter( 'credit_tape_chartjs_url', function () {
    return get_stylesheet_directory_uri() . '/js/chart.umd.min.js';
} );
```

You can also pin the feed URL in `wp-config.php` rather than the database:

```php
define( 'CREDIT_TAPE_BASE_URL', 'https://yourname.github.io/credit-tape/' );
```

### Why not an iframe

It works, but you inherit a fixed height that fights Elementor breakpoints, a colour scheme you can't reach, no ability to slice series per page, and no content for search engines. The shortcode is roughly the same setup effort and gives you all four.

## Series tracked

| FRED ID | Shown as | What it is |
|---|---|---|
| `BAMLH0A0HYM2` | US HY | ICE BofA US High Yield OAS — CDX.NA.HY proxy |
| `BAMLC0A0CM` | US IG | ICE BofA US Corporate OAS — CDX.NA.IG proxy |
| `BAMLC0A4CBBB` | BBB | BBB Corporate OAS |
| `BAMLH0A3CCC` | CCC | CCC & Lower High Yield OAS |
| `BAMLEMCBPIOAS` | EM Corp | EM Corporate Plus OAS |
| `BAMLH0A0HYM2EY` | HY Yield | HY effective yield (level, not a spread) |

Add or remove series by editing the `SERIES` array in `scripts/fetch-fred.mjs` — the frontend builds itself from the manifest, so nothing else needs touching.

### Two corrections from the source notes

- `BAMLEMHBHYCRPIUSHPTRIV` is a **total-return index level**, not a spread. Plotting it on a bps axis next to OAS series produces a meaningless chart. Replaced with `BAMLEMCBPIOAS`.
- FRED publishes these in percentage points, so the ×100 conversion to bps is correct — but it's only correct for OAS series. Any series added in bps or index points needs `unit` set accordingly in the series config, or it'll be off by 100×.

## Limits worth knowing

These are cash-bond option-adjusted spreads, not CDS. They track CDX for direction and regime, but the cash/CDS basis moves independently and can stay dislocated for weeks. For actual CDX/iTraxx EOD marks you need an S&P Global (Markit) feed.

Single-name CDS (e.g. Apple 5Y) has no free source at all. DTCC's Trade Information Warehouse publishes weekly aggregate open interest, which is useful for positioning but is not pricing.

ICE BofA index data is redistributed by FRED under ICE Data Indices, LLC terms — worth reading before putting this behind a paywall or in a commercial product.

## License

MIT.
