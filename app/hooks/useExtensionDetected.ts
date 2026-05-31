/**
 * Extension Detection Hook
 *
 * Detects whether the Flyx Bypass browser extension is installed.
 * Uses two detection methods:
 *   1. window.__FLYX_EXTENSION__ flag (set by inject.js in MAIN world — fast path)
 *   2. postMessage ping/pong (bridge.js in ISOLATED world — fallback)
 *
 * The extension is REQUIRED for Live TV because DLHD media tokens are
 * IP-bound to the browser's residential IP. Without the extension
 * minting the signed stream in-browser, the CF Worker datacenter IP
 * gets 403'd on every media playlist fetch.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';

const PING_TIMEOUT_MS = 1500;  // How long to wait for bridge pong response
const FLAG_POLL_INTERVAL_MS = 200; // Poll window flag if not immediately available
const FLAG_POLL_MAX_MS = 2000; // Max time to poll for the window flag

interface ExtensionInfo {
  detected: boolean;
  version: string | null;
  checking: boolean;
}

/**
 * Check for the window flag set by inject.js (MAIN world, document_start).
 * Returns the flag value if present, null otherwise.
 */
function checkWindowFlag(): { version: string } | null {
  try {
    const flag = (window as any).__FLYX_EXTENSION__;
    if (flag && flag.installed) {
      return { version: flag.version || 'unknown' };
    }
  } catch {
    // window access blocked (unlikely)
  }
  return null;
}

/**
 * Send a ping via postMessage and wait for pong from bridge.js.
 * Bridge runs in ISOLATED world and has chrome.runtime access.
 */
function pingBridge(timeoutMs: number): Promise<{ version: string } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMsg);
      resolve(null);
    }, timeoutMs);

    function onMsg(e: MessageEvent) {
      if (e.source !== window || !e.data || e.data.__flyx !== 'pong') return;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      resolve({ version: e.data.version || 'unknown' });
    }

    window.addEventListener('message', onMsg);
    window.postMessage({ __flyx: 'ping' }, '*');
  });
}

export function useExtensionDetected(): ExtensionInfo & { recheck: () => void } {
  const [detected, setDetected] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const detect = useCallback(async () => {
    setChecking(true);

    // Fast path: check window flag (inject.js sets this synchronously at document_start)
    const flag = checkWindowFlag();
    if (flag) {
      setDetected(true);
      setVersion(flag.version);
      setChecking(false);
      return;
    }

    // Flag not set yet — inject.js might still be loading.
    // Poll for it briefly.
    const flagResult = await new Promise<{ version: string } | null>((resolve) => {
      const start = Date.now();
      const poll = () => {
        const f = checkWindowFlag();
        if (f) { resolve(f); return; }
        if (Date.now() - start >= FLAG_POLL_MAX_MS) { resolve(null); return; }
        setTimeout(poll, FLAG_POLL_INTERVAL_MS);
      };
      poll();
    });

    if (flagResult) {
      setDetected(true);
      setVersion(flagResult.version);
      setChecking(false);
      return;
    }

    // Fallback: ping the bridge.js via postMessage (ISOLATED world)
    const pong = await pingBridge(PING_TIMEOUT_MS);
    if (pong) {
      setDetected(true);
      setVersion(pong.version);
    } else {
      setDetected(false);
      setVersion(null);
    }

    setChecking(false);
  }, []);

  useEffect(() => {
    detect();
  }, [detect]);

  return { detected, version, checking, recheck: detect };
}
