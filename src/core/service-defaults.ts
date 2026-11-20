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
 * `docs/relay.md` and the Android `MainActivity.DEFAULT_SERVER` in sync
 * when the tunnels are recreated.
 */
export const DEFAULT_RELAY_URL = "https://thickness-oxygen-life-resistant.trycloudflare.com";

/** 443 belongs to the relay's own TLS listener, so stats keeps its separate port. */
export const DEFAULT_USAGE_STATS_URL = "https://submitting-reseller-trustee-fairy.trycloudflare.com/api/report";

/**
 * `luban update` asks the same host that already holds the usage numbers: one
 * server, two endpoints (`/api/report`, `/api/update`). Deriving it from the
 * stats address keeps a tunnel rotation to a single edit.
 */
export const DEFAULT_UPDATE_URL = DEFAULT_USAGE_STATS_URL.replace(/\/api\/report$/u, "");
