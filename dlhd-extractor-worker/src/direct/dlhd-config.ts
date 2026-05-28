/**
 * DLHD Central Configuration — May 2026
 *
 * Single source of truth for all DLHD domains, servers, and endpoints.
 * Update this file when DLHD rotates infrastructure.
 *
 * ACCESS PATHS (tried in order):
 *   1. Direct origin IP (213.21.239.30, HTTP) — bypasses Cloudflare WAF entirely
 *   2. Cloudflare-fronted domains (HTTPS) — may be WAF-blocked from CF edge
 *   3. Residential proxy fallback (RPI/SOCKS5) — for when both above fail
 *
 * Infrastructure layout:
 *   Player page:  www.{playerDomain}/premiumtv/daddyhd.php?id={ch}
 *   Server lookup: {host}/server_lookup?channel_id=premium{ch}
 *   M3U8 proxy:    {host}/proxy/{server}/premium{ch}/mono.css
 *   Key server:    {host}/key/{resource}/{keyNumber}
 *   Verify:        {host}/verify
 */

/** Origin server IP (dlhd.pk resolves here — NOT behind Cloudflare, HTTP only) */
export const ORIGIN_IP = '213.21.239.30';

/** Current player domain (serves the daddyhd.php auth page) */
export const PLAYER_DOMAIN = 'www.newkso.ru';

/** Current primary backend domain */
export const PRIMARY_DOMAIN = 'newkso.ru';

/** All backend domains to try for M3U8, keys, and server_lookup */
export const BACKEND_DOMAINS = [
  'newkso.ru',
  'enviromentalanimal.horse',
  'soyspace.cyou',
] as const;

/** Origin IP access hosts — Host headers to try when accessing via origin IP */
export const ORIGIN_HOSTS = [
  'chevy.newkso.ru',
  'chevy.enviromentalanimal.horse',
  'chevy.soyspace.cyou',
  'dlhd.pk',
  'www.newkso.ru',
];

/** All known DLHD streaming servers */
export const ALL_SERVERS = [
  'ddy6', 'zeko', 'wind', 'dokko1', 'nfs', 'wiki', 'x4',
] as const;

/** reCAPTCHA v3 site key (for IP whitelisting — reportedly disabled as of Apr 2026) */
export const RECAPTCHA_SITE_KEY = '6LfJv4AsAAAAALTLEHKaQ7LN_VYfFqhLPrB2Tvgj';

/** Fake/poison keys returned to non-whitelisted IPs */
export const FAKE_KEYS = new Set([
  '45db13cfa0ed393fdb7da4dfe9b5ac81',
  '455806f8bc592fdacb6ed5e071a517b1',
  '4542956ed8680eaccb615f7faad4da8f',
  '45a542173e0b81d2a9c13cbc2bdcfd8c',
]);

/** Player page URL template */
export function playerPageUrl(channel: string): string {
  return `https://${PLAYER_DOMAIN}/premiumtv/daddyhd.php?id=${channel}`;
}

/** Server lookup URL for a domain */
export function serverLookupUrl(domain: string, channelKey: string): string {
  return `https://chevy.${domain}/server_lookup?channel_id=${encodeURIComponent(channelKey)}`;
}

/** M3U8 URL for a server+domain+channel */
export function m3u8Url(server: string, domain: string, channelId: string): string {
  return `https://chevy.${domain}/proxy/${server}/premium${channelId}/mono.css`;
}

/** Key URL for a domain+resource+keyNumber */
export function keyUrl(domain: string, resource: string, keyNumber: string): string {
  return `https://chevy.${domain}/key/${resource}/${keyNumber}`;
}

/** Verify URL (reCAPTCHA IP whitelist) */
export function verifyUrl(domain: string): string {
  return `https://chevy.${domain}/verify`;
}

/**
 * Build M3U8 URL targeting the origin IP directly (HTTP, bypasses Cloudflare WAF).
 * Uses a specific Host header to route to the correct virtual host.
 */
export function originM3U8Url(server: string, channelId: string): string {
  return `http://${ORIGIN_IP}/proxy/${server}/premium${channelId}/mono.css`;
}

/** Build server_lookup URL targeting the origin IP directly */
export function originServerLookupUrl(channelKey: string): string {
  return `http://${ORIGIN_IP}/server_lookup?channel_id=${encodeURIComponent(channelKey)}`;
}

/** Build player page URL targeting the origin IP directly */
export function originPlayerPageUrl(channel: string): string {
  return `http://${ORIGIN_IP}/premiumtv/daddyhd.php?id=${channel}`;
}

/** Default request headers for DLHD upstream requests */
export function upstreamHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Referer': `https://${PLAYER_DOMAIN}/`,
    'Origin': `https://${PLAYER_DOMAIN}`,
    ...extra,
  };
}

/** Headers for origin IP requests (Host header required for nginx virtual host routing) */
export function originHeaders(vhost: string, extra?: Record<string, string>): Record<string, string> {
  return {
    ...upstreamHeaders(extra),
    'Host': vhost,
  };
}

/** Check if a 16-byte hex key is a known fake */
export function isFakeKey(hex: string): boolean {
  if (FAKE_KEYS.has(hex)) return true;
  if (hex.startsWith('00000000') || hex.startsWith('ffffffff')) return true;
  if (hex.startsWith('6572726f72')) return true; // "error" in ASCII
  return false;
}

/** Convert Uint8Array to hex string */
export function toHex(data: Uint8Array): string {
  return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Parse a key URL into {resource, keyNumber} */
export function parseKeyUrl(url: string): { resource: string; keyNumber: string } | null {
  const m = url.match(/\/key\/([^/]+)\/(\d+)/);
  return m ? { resource: m[1], keyNumber: m[2] } : null;
}
