/**
 * Built-in addresses for the two hosted services luban talks to.
 *
 * Cloudflare quick tunnels hand out a new hostname every time they restart, so
 * the values live in exactly one place and every consumer imports them from
 * here instead of repeating the literal. They are only fallbacks: a user
 * overrides either one in `~/.luban/config.json` (`remote.relay_url`,
 * `usage_stats.url`) or with `LUBAN_RELAY_PUBLIC_URL` /
 * `LUBAN_USAGE_STATS_URL`.
 *
 * Keep `scripts/setup-relay-tunnel.sh`, `docs/reference.md`,
 * `docs/relay-domain.md` and the Android `MainActivity.DEFAULT_SERVER` in sync
 * when the tunnels are recreated.
 */
export const DEFAULT_RELAY_URL = "https://thickness-oxygen-life-resistant.trycloudflare.com";

/** 443 belongs to the relay's own TLS listener, so stats keeps its separate port. */
export const DEFAULT_USAGE_STATS_URL = "https://submitting-reseller-trustee-fairy.trycloudflare.com/api/report";
