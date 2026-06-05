/**
 * StreamNinja Proxy — Browser-Side Extraction
 *
 * The user's browser runs j() from BHMWs0S_.js and calls the
 * StreamNinja API directly. The browser has the correct TLS
 * fingerprint and full JS runtime to execute the VM bytecode.
 *
 * This Worker is a lightweight relay:
 *   - Serves the provider list
 *   - Caches and serves the BHMWs0S_.js bundle (so the browser
 *     doesn't hit streamninja.xyz on every page load)
 *   - Provides a health check
 *
 * No Browser Rendering, no eval(), no heavy lifting.
 */

import type { Env } from "./env";

// Cache the bundle in memory (it's static, changes infrequently)
let cachedBundle: string | null = null;
let bundleFetchPromise: Promise<string> | null = null;

async function getBundle(): Promise<string> {
  if (cachedBundle) return cachedBundle;
  if (bundleFetchPromise) return bundleFetchPromise;

  bundleFetchPromise = (async () => {
    const resp = await fetch("https://streamninja.xyz/assets/BHMWs0S_.js");
    cachedBundle = await resp.text();
    console.log("[streamninja] Bundle cached: " + cachedBundle.length + " bytes");
    return cachedBundle;
  })();

  return bundleFetchPromise;
}

const PROVIDERS = [
  { id: "nba", name: "NBA" },
  { id: "ufc", name: "UFC" },
  { id: "fifa", name: "FIFA World Cup" },
  { id: "skygo", name: "SKY GO" },
  { id: "smx", name: "SuperMotocross" },
  { id: "beinsports", name: "beIN Sports" },
  { id: "tntsports", name: "TNT Sports" },
  { id: "nbcsports", name: "NBC Sports" },
  { id: "tsnsports", name: "TSN Sports" },
  { id: "admin", name: "Admin" },
];

export async function handleStreamNinjaRequest(request: Request, _env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace("/streamninja", "").replace(/^\/+/, "");

  // /streamninja/bundle — serve the cached decrypt bundle
  if (path === "bundle") {
    try {
      const bundle = await getBundle();
      return new Response(bundle, {
        status: 200,
        headers: {
          "Content-Type": "application/javascript",
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502, headers: { "Content-Type": "application/json" },
      });
    }
  }

  // /streamninja/providers or /streamninja
  if (path === "providers" || path === "") {
    return new Response(JSON.stringify({ providers: PROVIDERS }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // /streamninja/health
  if (path === "health") {
    return new Response(JSON.stringify({ status: "ok", bundleCached: !!cachedBundle }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({
    error: "StreamNinja extraction runs browser-side",
    usage: {
      bundle: "GET /streamninja/bundle — cached BHMWs0S_.js",
      providers: "GET /streamninja/providers — available providers",
      health: "GET /streamninja/health — status check",
    },
    browserUsage: `
// In your browser extension or Next.js app:
const resp = await fetch("https://media-proxy.vynx-3b3.workers.dev/streamninja/bundle");
const source = await resp.text();
eval(source.replace(/export\\{hQ0VQk as j,jJfxvqG as m\\};/, "window.__j=hQ0VQk;window.__m=jJfxvqG;"));
const data = await window.__j("https://ninja-data.getsugatensho.workers.dev/admin", "admin", "ADMIN");
console.log(data); // decrypted JSON with stream_urls
    `.trim(),
  }), {
    status: 400,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
