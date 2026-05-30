'use client';

/**
 * PrimeSrc Turnstile Solver
 *
 * Renders an invisible Cloudflare Turnstile widget that solves the challenge
 * in the browser. The token is then passed to the CF Worker to call /api/v1/l.
 *
 * Sitekey: 0x4AAAAAACox-LngVREu55Y4 (from primesrc.me)
 * Appearance: interaction-only (invisible until user interaction needed)
 */

import { useEffect, useRef, useCallback, useState } from 'react';

const TURNSTILE_SITEKEY = '0x4AAAAAACox-LngVREu55Y4';
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

interface PrimeSrcTurnstileProps {
  onToken: (token: string) => void;
  onError?: (error: string) => void;
  /** Auto-solve on mount (default: true) */
  autoSolve?: boolean;
}

// Global script loading state
let scriptLoaded = false;
let scriptLoading = false;
const scriptCallbacks: (() => void)[] = [];

function loadTurnstileScript(): Promise<void> {
  if (scriptLoaded) return Promise.resolve();
  return new Promise((resolve) => {
    if (scriptLoading) {
      scriptCallbacks.push(resolve);
      return;
    }
    scriptLoading = true;
    const script = document.createElement('script');
    script.src = `${TURNSTILE_SCRIPT_URL}?render=explicit`;
    script.async = true;
    script.onload = () => {
      scriptLoaded = true;
      scriptLoading = false;
      resolve();
      scriptCallbacks.forEach(cb => cb());
      scriptCallbacks.length = 0;
    };
    script.onerror = () => {
      scriptLoading = false;
      resolve(); // Resolve anyway, render will handle missing window.turnstile
    };
    document.head.appendChild(script);
  });
}

export default function PrimeSrcTurnstile({ onToken, onError, autoSolve = true }: PrimeSrcTurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  // Track mount state to prevent callbacks from operating on removed widgets.
  // Turnstile error 110200 = "Invalid widget ID" — caused by reset() or remove()
  // racing on a widget that was already destroyed.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const renderWidget = useCallback(() => {
    if (!mountedRef.current || !containerRef.current) return;
    if (widgetIdRef.current !== null) return; // Already rendered

    const turnstile = (window as any).turnstile;
    if (!turnstile) {
      onError?.('Turnstile script not loaded');
      return;
    }

    try {
      const id = turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITEKEY,
        appearance: 'interaction-only',
        callback: (token: string) => {
          if (!mountedRef.current) return;
          console.log('[PrimeSrc Turnstile] Token obtained:', token.substring(0, 20) + '...');
          onToken(token);
        },
        'error-callback': (err: any) => {
          if (!mountedRef.current || widgetIdRef.current === null) return;
          // 110200 = domain not authorized for this sitekey (expected — tv.vynx.cc
          // isn't in primesrc.me's Turnstile allowlist). Suppress to avoid noise.
          const code = err?.toString?.() || '';
          if (code.includes('110200')) {
            console.warn('[PrimeSrc Turnstile] Domain not authorized for sitekey (expected)');
            return;
          }
          console.error('[PrimeSrc Turnstile] Error:', err);
          onError?.(typeof err === 'string' ? err : 'Turnstile challenge failed');
        },
        'expired-callback': () => {
          if (!mountedRef.current || widgetIdRef.current === null) return;
          console.log('[PrimeSrc Turnstile] Token expired, re-solving...');
          try { turnstile.reset(widgetIdRef.current); } catch {}
        },
        retry: 'auto',
        'retry-interval': 2000,
      });
      widgetIdRef.current = id;
      console.log('[PrimeSrc Turnstile] Widget rendered, id:', id);
    } catch (e) {
      console.error('[PrimeSrc Turnstile] Render error:', e);
      onError?.(e instanceof Error ? e.message : 'Failed to render Turnstile');
    }
  }, [onToken, onError]);

  useEffect(() => {
    if (!autoSolve) return;

    let cancelled = false;
    loadTurnstileScript().then(() => {
      if (cancelled) return;
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        if (!cancelled) renderWidget();
      }, 100);
    });

    return () => {
      cancelled = true;
      mountedRef.current = false;
      // Clear widgetId BEFORE calling remove to prevent expired-callback
      // from calling reset() on a widget about to be destroyed.
      const wid = widgetIdRef.current;
      widgetIdRef.current = null;
      if (wid !== null) {
        try {
          const turnstile = (window as any).turnstile;
          if (turnstile) turnstile.remove(wid);
        } catch {}
      }
    };
  }, [autoSolve, renderWidget]);

  // The container is invisible — Turnstile only shows UI if interaction is needed
  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        bottom: 0,
        right: 0,
        zIndex: 9999,
        // Turnstile with interaction-only is invisible unless it needs user input
      }}
      aria-hidden="true"
    />
  );
}

/**
 * Hook to get a Turnstile token for PrimeSrc.
 * Returns { token, loading, error, refresh }.
 */
export function usePrimeSrcTurnstile() {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const handleToken = useCallback((t: string) => {
    setToken(t);
    setLoading(false);
    setError(null);
  }, []);

  const handleError = useCallback((e: string) => {
    setError(e);
    setLoading(false);
  }, []);

  const refresh = useCallback(() => {
    setToken(null);
    setLoading(true);
    setError(null);
    // The component will re-render and re-solve
  }, []);

  return { token, loading, error, refresh, handleToken, handleError };
}
