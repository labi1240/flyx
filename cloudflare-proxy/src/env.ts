/**
 * Environment bindings for the CF Worker
 */

export interface Env {
  API_KEY?: string;
  LOG_LEVEL?: string;
  TMDB_API_KEY?: string;
  HETZNER_PROXY_URL?: string;
  HETZNER_PROXY_KEY?: string;
  TURNSTILE_SOLVER_URL?: string;
  TURNSTILE_SOLVER_TOKEN?: string;
  ALLOWED_ORIGINS?: string;
  SIGNING_SECRET?: string;
  NONCE_KV?: KVNamespace;
  SESSION_KV?: KVNamespace;
  BLACKLIST_KV?: KVNamespace;
  WATERMARK_SECRET?: string;
  PROTECTION_MODE?: string;
  ENABLE_ANTI_LEECH?: string;
  OXYLABS_USERNAME?: string;
  OXYLABS_PASSWORD?: string;
  OXYLABS_ENDPOINT?: string;
  OXYLABS_COUNTRY?: string;
  OXYLABS_CITY?: string;
  HEXA_CONFIG?: KVNamespace;
  HEXA_ALERT_WEBHOOK_URL?: string;
  AUTO_DEPLOY_WASM?: string;
}
