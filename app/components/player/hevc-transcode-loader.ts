/**
 * HEVC Transcode Loader — hls.js custom fragment loader.
 *
 * When the HLS manifest contains HEVC/H.265 levels (common for Miruro/uwucdn),
 * hls.js creates fragment loaders via the `fLoader` config option. This loader
 * wraps the built-in FetchLoader: for HEVC levels it fetches the segment,
 * pipes it through the FFmpeg.wasm transcoder (HEVC → H.264), and hands the
 * transcoded data to hls.js as if it were a native H.264 segment.
 *
 * Non-HEVC fragments (AnimeKai/MegaUp, AllAnime) pass through unchanged.
 *
 * Architecture:
 *   hls.js → fLoader.load()
 *     ├─ HEVC level → fetch segment → FFmpeg.wasm transcode → onSuccess(H.264)
 *     └─ other      → FetchLoader.load() (unchanged)
 */

import { FetchLoader } from 'hls.js';
import type {
  Loader,
  LoaderContext,
  LoaderConfiguration,
  LoaderCallbacks,
  LoaderStats,
  HlsConfig,
} from 'hls.js';

/** Runtime shape hls.js passes for fragment loads (FragmentLoaderContext). */
interface FragmentContext extends LoaderContext {
  frag?: {
    level?: number;
    sn?: number;
    type?: string;
  };
}

// ── HEVC level tracking ──────────────────────────────────────────────────

/**
 * Set of hls.js quality-level indices that contain HEVC video.
 * Populated by AnimeVideoPlayer after MANIFEST_PARSED.
 * Shared across all HevcTranscodeLoader instances for this stream.
 */
const hevcLevels = new Set<number>();

/** Mark quality-level indices as HEVC. Call after MANIFEST_PARSED. */
export function markHevcLevels(indices: Set<number>): void {
  hevcLevels.clear();
  for (const i of indices) hevcLevels.add(i);
}

/** Clear HEVC markings. Call on player destroy. */
export function clearHevcLevels(): void {
  hevcLevels.clear();
}

// ── Loader ───────────────────────────────────────────────────────────────

export class HevcTranscodeLoader implements Loader<LoaderContext> {
  private inner: FetchLoader;
  private abortController: AbortController | null = null;
  private destroyed = false;
  /** Only forward abort/destroy to inner if we delegated a load to it. */
  private innerLoadDelegated = false;

  constructor(config: HlsConfig) {
    this.inner = new FetchLoader(config);
  }

  // --- Passthrough properties ---

  get stats(): LoaderStats {
    return this.inner.stats;
  }

  set stats(s: LoaderStats) {
    this.inner.stats = s;
  }

  get context(): LoaderContext {
    return this.inner.context as LoaderContext;
  }

  // --- Lifecycle ---

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // Only forward to inner if we delegated a load — inner.destroy() fires
    // callbacks that can cause hls.js to re-enter our destroy() in a loop.
    if (this.innerLoadDelegated) {
      this.inner.destroy();
    }
  }

  abort(): void {
    if (this.destroyed) return;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.innerLoadDelegated) {
      this.inner.abort();
    }
  }

  getCacheAge(): number | null {
    return this.inner.getCacheAge();
  }

  // --- Load (the core) ---

  load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ): void {
    // Only transcode fragment loads (responseType 'arraybuffer') from HEVC levels.
    // Playlist loads ('text') and other loads pass through to FetchLoader.
    const isFragment = context.responseType === 'arraybuffer';
    const fragLevel = (context as FragmentContext).frag?.level;
    const shouldTranscode =
      isFragment &&
      typeof fragLevel === 'number' &&
      hevcLevels.has(fragLevel);

    if (!shouldTranscode) {
      this.innerLoadDelegated = true;
      this.inner.load(context, config, callbacks);
      return;
    }

    // HEVC fragment load with transcode
    this.loadWithTranscode(context, config, callbacks);
  }

  // ── HEVC fetch + transcode ──────────────────────────────────────────

  private async loadWithTranscode(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ): Promise<void> {
    const maxRetry = config.maxRetry ?? 3;
    const timeout = config.timeout ?? 20000;
    // stats needs to persist across the async boundary so hls.js can read it
    // in onSuccess / onError callbacks.
    const stats: LoaderStats = (this.inner.stats = {
      aborted: false,
      loaded: 0,
      total: 0,
      retry: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: { start: performance.now(), first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 },
    } as LoaderStats);

    let attempt = 0;

    const tryLoad = async (): Promise<void> => {
      if (stats.aborted) return;

      this.abortController = new AbortController();
      const signal = this.abortController.signal;

      const timeoutId = setTimeout(() => {
        this.abortController?.abort();
      }, timeout);

      try {
        // Build headers
        const headers = new Headers(
          (context.headers as Record<string, string> | undefined) ?? {},
        );
        if (context.rangeEnd) {
          headers.set(
            'Range',
            `bytes=${context.rangeStart ?? 0}-${context.rangeEnd - 1}`,
          );
        }

        // Fetch the HEVC segment
        const res = await fetch(context.url, {
          method: 'GET',
          headers,
          signal,
          credentials: 'same-origin',
        });

        clearTimeout(timeoutId);

        if (!res.ok && res.status >= 400) {
          throw { code: res.status, text: res.statusText };
        }

        stats.loading.first = performance.now();

        const rawData = await res.arrayBuffer();

        stats.loading.end = performance.now();
        stats.loaded = rawData.byteLength;
        stats.total = rawData.byteLength;

        // ── Transcode HEVC → H.264 ──────────────────────────────
        stats.parsing.start = performance.now();

        const { transcodeHevcToH264 } = await import(
          '@/lib/wasm/hevc-transcoder'
        );
        const h264Data = await transcodeHevcToH264(
          new Uint8Array(rawData),
          (context as FragmentContext).frag?.sn,
        );

        stats.parsing.end = performance.now();

        // Return H.264 data to hls.js as if it were the original segment
        callbacks.onSuccess(
          { url: res.url, data: h264Data.buffer as ArrayBuffer },
          stats,
          context,
          null,
        );
      } catch (err: any) {
        clearTimeout(timeoutId);

        if (stats.aborted) return;

        // Distinguish abort/timeout from real errors
        const isAbort = err?.name === 'AbortError' || signal.aborted;
        const code = err?.code ?? 0;
        const text = isAbort
          ? 'Transcode request aborted'
          : err?.text ?? err?.message ?? 'HEVC transcode failed';

        if (attempt < maxRetry && !isAbort) {
          attempt++;
          stats.retry = attempt;
          const backoff = Math.min(1000 * attempt, 4000);
          setTimeout(() => {
            if (!stats.aborted) tryLoad();
          }, backoff);
        } else {
          // Exhausted retries or aborted — signal error to hls.js
          callbacks.onError({ code, text }, context, null, stats);
        }
      }
    };

    tryLoad();
  }
}
