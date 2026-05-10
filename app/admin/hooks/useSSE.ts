'use client';

/**
 * useSSE - Server-Sent Events hook for real-time admin data push
 *
 * Manages SSE connection lifecycle with:
 * - JWT-authenticated connection to /admin/sse
 * - Exponential backoff reconnection: min(2^attempt * 1000, 30000)ms
 * - Fallback polling to /admin/stats every 60s when SSE unavailable
 * - Last-Event-ID tracking for reconnection
 * - Sequence gap detection triggering full resync
 *
 * Requirements: 1.4, 1.5, 7.3, 10.1
 */

import { useEffect, useRef, useCallback, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeltaUpdate {
  channel: string;
  sequence: number;
  timestamp: number;
  changes: Record<string, unknown>;
}

export interface UseSSEOptions {
  channels: string[];
  onSnapshot: (channel: string, data: Record<string, unknown>) => void;
  onDelta: (delta: DeltaUpdate) => void;
  onError?: (error: Error) => void;
  fallbackPollInterval?: number; // ms, default 60000
  enabled?: boolean;
}

export interface UseSSEReturn {
  connected: boolean;
  reconnecting: boolean;
  lastEventId: string | null;
  usingFallback: boolean;
}

// ---------------------------------------------------------------------------
// Pure utility functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Compute exponential backoff delay for a given attempt number.
 * Formula: min(2^attempt * 1000, 30000)ms
 * Requirement 1.4
 */
export function computeBackoffDelay(attempt: number): number {
  return Math.min(Math.pow(2, attempt) * 1000, 30000);
}

/**
 * Detect whether a sequence gap exists.
 * Returns true if newSequence !== lastSequence + 1 (gap detected, resync needed).
 * Returns false if newSequence === lastSequence + 1 (sequential, no resync).
 * Requirement 7.3
 */
export function hasSequenceGap(lastSequence: number, newSequence: number): boolean {
  return newSequence !== lastSequence + 1;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const CF_WORKER_URL = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_CF_SYNC_URL || 'https://flyx-sync.vynx-3b3.workers.dev')
  : '';


export function useSSE(options: UseSSEOptions): UseSSEReturn {
  const {
    channels,
    onSnapshot,
    onDelta,
    onError,
    fallbackPollInterval = 60000,
    enabled = true,
  } = options;

  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [usingFallback, setUsingFallback] = useState(false);

  // Refs for mutable state that shouldn't trigger re-renders
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const lastSequenceRef = useRef<Map<string, number>>(new Map());
  const mountedRef = useRef(true);

  // Stable callback refs
  const onSnapshotRef = useRef(onSnapshot);
  const onDeltaRef = useRef(onDelta);
  const onErrorRef = useRef(onError);
  onSnapshotRef.current = onSnapshot;
  onDeltaRef.current = onDelta;
  onErrorRef.current = onError;

  const channelsKey = channels.sort().join(',');

  // -----------------------------------------------------------------------
  // Fallback polling
  // -----------------------------------------------------------------------

  const startFallbackPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    setUsingFallback(true);

    const poll = async () => {
      try {
        const url = `${CF_WORKER_URL}/admin/stats?slices=${channelsKey}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
        const data = await res.json();
        if (data.success && data.slices && mountedRef.current) {
          for (const [channel, sliceData] of Object.entries(data.slices)) {
            onSnapshotRef.current(channel, sliceData as Record<string, unknown>);
          }
        }
      } catch (err) {
        onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    // Poll immediately, then on interval
    poll();
    pollTimerRef.current = setInterval(poll, fallbackPollInterval);
  }, [channelsKey, fallbackPollInterval]);

  const stopFallbackPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setUsingFallback(false);
  }, []);

  // -----------------------------------------------------------------------
  // SSE connection
  // -----------------------------------------------------------------------

  const getToken = useCallback((): string | null => {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.match(/admin_token=([^;]+)/);
    return match ? match[1] : null;
  }, []);

  const connectSSE = useCallback(() => {
    if (!mountedRef.current || !enabled) return;

    const token = getToken();
    if (!token) {
      // No token — fall back to polling
      startFallbackPolling();
      return;
    }

    // Build SSE URL
    const params = new URLSearchParams({
      token,
      channels: channelsKey,
    });
    const sseUrl = `${CF_WORKER_URL}/admin/sse?${params.toString()}`;

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const es = new EventSource(sseUrl);
    eventSourceRef.current = es;

    es.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      setReconnecting(false);
      reconnectAttemptRef.current = 0;
      stopFallbackPolling();
    };

    // Handle snapshot events
    es.addEventListener('snapshot', (event: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const data = JSON.parse(event.data);
        if (data.channel && data.state) {
          onSnapshotRef.current(data.channel, data.state);
          if (typeof data.sequence === 'number') {
            lastSequenceRef.current.set(data.channel, data.sequence);
          }
        }
        if (event.lastEventId) {
          lastEventIdRef.current = event.lastEventId;
        }
      } catch (err) {
        onErrorRef.current?.(new Error('Failed to parse snapshot'));
      }
    });

    // Handle delta events
    es.addEventListener('delta', (event: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const delta: DeltaUpdate = JSON.parse(event.data);

        // Sequence gap detection (Requirement 7.3)
        const lastSeq = lastSequenceRef.current.get(delta.channel) ?? 0;
        if (hasSequenceGap(lastSeq, delta.sequence)) {
          // Gap detected — request full resync by reconnecting
          es.close();
          lastSequenceRef.current.clear();
          lastEventIdRef.current = null;
          connectSSE();
          return;
        }

        lastSequenceRef.current.set(delta.channel, delta.sequence);
        onDeltaRef.current(delta);

        if (event.lastEventId) {
          lastEventIdRef.current = event.lastEventId;
        }
      } catch (err) {
        onErrorRef.current?.(new Error('Failed to parse delta'));
      }
    });

    // Handle auth_expired events
    es.addEventListener('auth_expired', () => {
      if (!mountedRef.current) return;
      es.close();
      setConnected(false);
      startFallbackPolling();
    });

    es.onerror = () => {
      if (!mountedRef.current) return;
      es.close();
      eventSourceRef.current = null;
      setConnected(false);
      setReconnecting(true);

      // Exponential backoff reconnection (Requirement 1.4)
      const delay = computeBackoffDelay(reconnectAttemptRef.current);
      reconnectAttemptRef.current++;

      // Start fallback polling while reconnecting (Requirement 10.1)
      startFallbackPolling();

      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          connectSSE();
        }
      }, delay);
    };
  }, [enabled, channelsKey, getToken, startFallbackPolling, stopFallbackPolling]);

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  useEffect(() => {
    mountedRef.current = true;

    if (enabled) {
      connectSSE();
    }

    return () => {
      mountedRef.current = false;

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [enabled, connectSSE]);

  return {
    connected,
    reconnecting,
    lastEventId: lastEventIdRef.current,
    usingFallback,
  };
}
