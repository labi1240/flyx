/**
 * Fetch-based HLS.js loader — replaces the default XMLHttpRequest loader
 * so the Service Worker can intercept CDN requests and inject the headers
 * (Referer/Origin) that CDNs require. XHR bypasses the SW entirely.
 *
 * Implements the hls.js Loader interface for both playlist and fragment loads.
 *
 * Must respect context.responseType:
 *   'text'        → playlist parsers call `response.data as string`
 *   'arraybuffer' → fragment loader treats data as binary
 *   'json'        → JSON responses
 * Returning the wrong type breaks manifest parsing → no levels → no playback.
 */

import type { Loader, LoaderContext, LoaderConfiguration, LoaderCallbacks, LoaderStats } from 'hls.js';

const DEFAULT_RETRY = 3;
const DEFAULT_TIMEOUT = 20000;

class FetchLoader implements Loader<LoaderContext> {
  private controller: AbortController | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private retryId: ReturnType<typeof setTimeout> | null = null;
  private aborted = false;
  // Initialize at construction — hls.js's ABR/destroy paths read
  // `loader.stats.loading` OUTSIDE the load() cycle, so `stats` must exist
  // before load() is ever called (default XHR loader inits it in its ctor).
  // load() resets these values per request; this just guarantees the shape.
  stats: LoaderStats = {
    aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  } as LoaderStats;
  context!: LoaderContext;

  destroy(): void {
    this.abort();
  }

  abort(): void {
    this.aborted = true;
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.retryId) {
      clearTimeout(this.retryId);
      this.retryId = null;
    }
  }

  load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ): void {
    this.context = context;
    this.aborted = false;
    this.stats = {
      aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
      loading: { start: performance.now(), first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 },
    } as LoaderStats;

    const maxRetry = config.maxRetry ?? DEFAULT_RETRY;
    const timeout = config.timeout ?? DEFAULT_TIMEOUT;

    const isArrayBuffer = context.responseType === 'arraybuffer';
    const isJson = context.responseType === 'json';

    const doFetch = (retryCount: number) => {
      if (this.aborted) return;

      this.controller = new AbortController();
      const signal = this.controller.signal;

      this.timeoutId = setTimeout(() => {
        this.controller?.abort();
      }, timeout);

      // Merge byte-range header for fragments that use it
      const headers = new Headers((context.headers as Record<string, string> | undefined) || {});
      if (context.rangeEnd) {
        headers.set('Range', 'bytes=' + (context.rangeStart || 0) + '-' + String(context.rangeEnd - 1));
      }

      fetch(context.url, {
        method: 'GET',
        headers,
        signal,
        credentials: 'same-origin',
      })
        .then(async (res) => {
          if (this.aborted) return;
          if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = null; }
          this.stats.loading.first = performance.now();

          if (!res.ok && res.status >= 400) {
            throw { code: res.status, text: res.statusText };
          }

          // Decode body according to context.responseType — hls.js's playlist
          // parsers do `response.data as string`, fragment loader treats data
          // as ArrayBuffer. Mismatched types break manifest parsing silently.
          const data: string | ArrayBuffer | any = isArrayBuffer
            ? await res.arrayBuffer()
            : isJson
              ? await res.json()
              : await res.text();

          if (this.aborted) return;
          this.stats.loading.end = performance.now();

          const len = typeof data === 'string'
            ? data.length
            : (data instanceof ArrayBuffer ? data.byteLength : 0);
          this.stats.loaded = len;
          this.stats.total = len;

          if (callbacks.onProgress) {
            callbacks.onProgress(this.stats, context, data, null as any);
          }

          callbacks.onSuccess(
            { url: res.url, data },
            this.stats,
            context,
            null as any,
          );
        })
        .catch((err: any) => {
          if (this.aborted) return;
          if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = null; }

          const isTimeout = err?.name === 'AbortError' || signal.aborted;
          const code = err?.code ?? 0;
          const text = err?.text ?? err?.message ?? (isTimeout ? 'Request timed out' : 'Fetch failed');

          if (retryCount < maxRetry) {
            this.stats.retry = retryCount + 1;
            this.retryId = setTimeout(() => {
              this.retryId = null;
              if (!this.aborted) doFetch(retryCount + 1);
            }, Math.min(1000 * (retryCount + 1), 4000));
          } else {
            callbacks.onError({ code, text }, context, null as any, this.stats);
          }
        });
    };

    doFetch(0);
  }

  getCacheAge(): number | null {
    return null;
  }
}

export default FetchLoader;
