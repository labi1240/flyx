/**
 * Fetch-based HLS.js loader — replaces the default XMLHttpRequest loader
 * so the Service Worker can intercept CDN requests and inject the headers
 * (Referer/Origin) that CDNs require. XHR bypasses the SW entirely.
 *
 * Implements the hls.js Loader interface for both playlist and fragment loads.
 */

import type { Loader, LoaderContext, LoaderConfiguration, LoaderCallbacks, LoaderStats } from 'hls.js';

const DEFAULT_RETRY = 3;
const DEFAULT_TIMEOUT = 20000;

class FetchLoader implements Loader<LoaderContext> {
  private controller: AbortController | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  stats!: LoaderStats;
  context!: LoaderContext;

  destroy(): void {
    this.abort();
  }

  abort(): void {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ): void {
    this.context = context;
    this.stats = { aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0, loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } } as LoaderStats;

    const maxRetry = config.maxRetry ?? DEFAULT_RETRY;
    const timeout = config.timeout ?? DEFAULT_TIMEOUT;

    const doFetch = (retryCount: number) => {
      this.controller = new AbortController();
      const signal = this.controller.signal;

      this.timeoutId = setTimeout(() => {
        this.controller?.abort();
      }, timeout);

      fetch(context.url, {
        method: 'GET',
        headers: context.headers as Record<string, string> | undefined,
        signal,
        credentials: 'same-origin',
      })
        .then(async (res) => {
          if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = null; }
          this.stats.loading.end = performance.now();

          if (!res.ok && res.status >= 400) {
            throw { code: res.status, text: res.statusText };
          }

          const data = await res.arrayBuffer();
          this.stats.loaded = data.byteLength;
          this.stats.total = data.byteLength;

          callbacks.onSuccess(
            { url: res.url, data: new Uint8Array(data) },
            this.stats,
            context,
            null as any,
          );
        })
        .catch((err: any) => {
          if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = null; }
          const isAborted = err?.name === 'AbortError' || signal.aborted;
          if (isAborted) {
            if (retryCount < maxRetry) {
              this.stats.retry = retryCount + 1;
              setTimeout(() => doFetch(retryCount + 1), Math.min(1000 * (retryCount + 1), 4000));
            } else {
              callbacks.onError({ code: 0, text: 'Fetch aborted after retries' }, context, null as any, this.stats);
            }
            return;
          }
          if (retryCount < maxRetry) {
            this.stats.retry = retryCount + 1;
            setTimeout(() => doFetch(retryCount + 1), Math.min(1000 * (retryCount + 1), 4000));
          } else {
            callbacks.onError(
              { code: err?.code ?? 0, text: err?.text ?? err?.message ?? 'Fetch failed' },
              context,
              null as any,
              this.stats,
            );
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
