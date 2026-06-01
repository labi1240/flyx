# Flyx Bypass v3.1.0 — "The Delisting Special"

> *"You can't block us without blocking your own users. You played yourselves."*

---

## What's New

### 🧩 AllAnime Provider (H.264 primary, large catalog)
AllAnime joins the roster as our new primary H.264 anime source. Bypasses Cloudflare bot management by injecting full Sec-Fetch and client-hint headers at the network layer — the SW relay now presents as a real Chrome browser, matching what the AllAnime SPA sends. No more Cloudflare challenges killing background fetches.

### 🔐 AnimeKai/MegaUp CORS Relay
AnimeKai and MegaUp CDN fetches now route through the extension service worker to bypass CORS restrictions. SW injects permissive CORS response headers on the fly — no more blocked cross-origin segment requests.

### 🎯 Miruro CDN Referer Fix
Miruro's CDN (kwik.cx) now gets the correct Referer header injected via DNR rules. Fixes a regression where segments were 403-ing due to a stale miruro.to referer.

### 📊 Improved Provider Stats & Activity Log
Stats persistence across sessions. Activity log ring buffer (last 100 events). Real-time provider toggle state reflected in the popup immediately.

---

## Architecture

```
inject.js (MAIN world, document_start)
    ↕  window.postMessage
bridge.js (ISOLATED world, document_start)
    ↕  chrome.runtime.sendMessage
service-worker.js (background, module)
    ↕  declarativeNetRequest
Network Layer (header injection before request leaves browser)
```

Three isolation layers. The site page, the extension bridge, and the SW all run in separate contexts — the page can't inspect or interfere with header rewriting, and the SW can inject headers the page never sees.

---

## Providers Covered

| Cat     | Provider    | Status |
|---------|-------------|--------|
| Live TV | DLHD        | ✅ Active (client-side token mint, reCAPTCHA auto-solve) |
| Movies  | Flixer/Hexa | ✅ Active (Origin + Referer injection) |
| Movies  | Videasy     | ✅ Active (Referer injection) |
| Movies  | BingeBox    | ✅ Active |
| Movies  | MovieBox    | ✅ Active |
| Anime   | AllAnime    | ✅ Active (H.264, CF bot bypass via Sec-Fetch headers) |
| Anime   | Miruro      | ✅ Active (kwik.cx CDN Referer) |
| Anime   | AnimeKai    | ✅ Active (MegaUp CORS relay) |
| Live TV | NTV         | ✅ Active |
| Live TV | GlobeTV     | ✅ Active |

---

## Why This Version Is Near-Bulletproof

DLHD's final move was IP-bound media tokens — server-side proxies can't mint them because the CDN checks the origin IP. Our extension mints tokens *in the user's browser on their residential IP.* The CDN sees a real viewer. There is no datacenter to block.

Every other provider's protection (Origin checks, Referer gates, CORS, Cloudflare bot management) is handled at the DNR layer — headers are rewritten before the request ever leaves the browser. The remote server literally never sees the real request.

**We don't have a single IP you can ban. We don't have a single server you can block. We are every user.**

---

## Install

1. Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → select this folder
2. Or wait for Chrome Web Store listing (pending review)

---

*Flyx don't fold. We just ship.* 🦅
