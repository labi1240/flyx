/**
 * HEVC → H.264 WASM Transcoder
 *
 * Uses FFmpeg.wasm (@ffmpeg/ffmpeg v0.12.x) compiled to WebAssembly to
 * transcode HEVC/H.265 video segments into H.264 on-the-fly in the browser.
 *
 * The FFmpeg.wasm core (~31MB) is lazy-loaded from CDN on first use.
 * Each segment transcode writes input → exec ffmpeg → reads output via
 * the FFmpeg virtual filesystem. A serial queue prevents concurrent
 * operations from overwhelming the single-threaded WASM instance.
 *
 * Architecture:
 *   HEVC fMP4/TS segment (ArrayBuffer)
 *     → write to FFmpeg virtual FS (/input/seg_N.mp4)
 *     → ffmpeg: -c:v libx264 -preset ultrafast -crf 28 -tune zerolatency
 *     → read /output/seg_N_h264.mp4 → ArrayBuffer
 *     → returned as Uint8Array for hls.js fragment loader
 *
 * Only runs in the browser. SSR-safe (dynamic import via 'use client').
 */

'use client';

declare global {
  interface Window {
    __HEVC_TRANSCODER__?: { loaded: boolean };
  }
}

// ── Types ────────────────────────────────────────────────────────────────

export type TranscodeProgressCallback = (progress: number, time: number) => void;

// ── CDN config ───────────────────────────────────────────────────────────

const CORE_VERSION = '0.12.6';
const CORE_CDN = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

// ── FFmpeg transcode args (fastest possible HEVC→H.264 in software) ──────

const TRANSCODE_ARGS = (input: string, output: string): string[] => [
  '-nostdin',
  '-y',
  '-i', input,
  '-c:v', 'libx264',
  '-preset', 'ultrafast',
  '-crf', '30',
  '-tune', 'zerolatency',
  '-c:a', 'copy',
  '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
  '-f', 'mp4',
  output,
];

// ── State ────────────────────────────────────────────────────────────────

let FFmpeg: any = null; // import constructor, cached after first dyn import
let ffmpeg: any = null; // singleton instance
let ffmpegLoadPromise: Promise<any> | null = null;
let loaded = false;
let transcodeQueue: Promise<any> = Promise.resolve();
let loadError: Error | null = null;

// ── Dynamic import ───────────────────────────────────────────────────────

async function importFFmpeg(): Promise<any> {
  if (FFmpeg) return FFmpeg;
  const mod = await import('@ffmpeg/ffmpeg');
  FFmpeg = mod.FFmpeg;
  return FFmpeg;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Lazy-load the FFmpeg.wasm singleton. Safe to call multiple times —
 * subsequent calls return the cached instance.
 */
export async function getFFmpeg(): Promise<any> {
  if (ffmpeg && loaded) return ffmpeg;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpegLoadPromise = (async () => {
    console.log('[HEVC] Loading FFmpeg.wasm core...');
    const t0 = performance.now();

    try {
      const FFmpegClass = await importFFmpeg();
      ffmpeg = new FFmpegClass();

      await ffmpeg.load({
        coreURL: `${CORE_CDN}/ffmpeg-core.js`,
        wasmURL: `${CORE_CDN}/ffmpeg-core.wasm`,
        // Single-threaded — no workerURL needed
      });

      loaded = true;
      console.log(
        `[HEVC] FFmpeg.wasm core ready (${((performance.now() - t0) / 1000).toFixed(1)}s)`,
      );
      return ffmpeg;
    } catch (err) {
      console.error('[HEVC] FFmpeg.wasm failed to load:', err);
      loadError = err instanceof Error ? err : new Error(String(err));
      ffmpegLoadPromise = null;
      throw err;
    }
  })();

  return ffmpegLoadPromise;
}

/**
 * Transcode an HEVC-encoded segment to H.264.
 *
 * Operations are serialized — concurrent calls are queued internally so
 * the single-threaded WASM instance never runs two ffmpeg processes at once.
 *
 * @param input  Raw segment bytes (fMP4 container with HEVC video)
 * @param segmentId  Optional segment number for debug logging
 * @param onProgress  Optional progress callback
 * @returns  H.264-encoded fMP4 segment as Uint8Array
 */
export async function transcodeHevcToH264(
  input: Uint8Array,
  segmentId?: number,
  onProgress?: TranscodeProgressCallback,
): Promise<Uint8Array> {
  if (loadError) throw loadError;

  return new Promise<Uint8Array>((resolve, reject) => {
    transcodeQueue = transcodeQueue.then(async () => {
      const fm = await getFFmpeg();
      const id = segmentId ?? 0;
      const segLabel = segmentId !== undefined ? `#${segmentId}` : '';
      const t0 = performance.now();

      const inputFile = `/input/seg_${id}.mp4`;
      const outputFile = `/output/seg_${id}_h264.mp4`;

      try {
        // Ensure directories exist
        await fm.createDir('/input');
        await fm.createDir('/output');

        // Write input segment to virtual FS
        await fm.writeFile(inputFile, input);

        // Attach progress listener if requested
        const onLog = onProgress
          ? ({ type, message }: { type: string; message: string }) => {
              if (type === 'stderr' && message.includes('frame=')) {
                const progressMatch = message.match(/time=(\d+:\d+:\d+\.\d+)/);
                if (progressMatch) {
                  const parts = progressMatch[1].split(':').map(Number);
                  const seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
                  onProgress(seconds, seconds);
                }
              }
            }
          : undefined;

        if (onLog) fm.on('log', onLog);

        // Run: ffmpeg -i /input/seg_N.mp4 -c:v libx264 ... /output/seg_N_h264.mp4
        const exitCode = await fm.exec(TRANSCODE_ARGS(inputFile, outputFile), 18000);

        if (onLog) fm.off('log', onLog);

        if (exitCode !== 0) {
          throw new Error(`FFmpeg exited with code ${exitCode}`);
        }

        // Read output
        const output = await fm.readFile(outputFile);

        // readFile can return Uint8Array | string depending on how FFmpeg stored it
        let result: Uint8Array;
        if (output instanceof Uint8Array) {
          result = output;
        } else if (typeof output === 'string') {
          // Binary data returned as string — decode back to bytes
          const buf = new Uint8Array(output.length);
          for (let i = 0; i < output.length; i++) buf[i] = output.charCodeAt(i) & 0xff;
          result = buf;
        } else if (Array.isArray(output)) {
          result = new Uint8Array(output as number[]);
        } else {
          result = new Uint8Array(0);
        }

        const elapsed = (performance.now() - t0).toFixed(0);
        const inKB = (input.byteLength / 1024).toFixed(0);
        const outKB = (result.byteLength / 1024).toFixed(0);
        const ratio =
          input.byteLength > 0
            ? ((result.byteLength / input.byteLength) * 100).toFixed(0)
            : '?';
        console.log(
          `[HEVC] seg${segLabel}: ${inKB}KB → ${outKB}KB (${ratio}%) ${elapsed}ms`,
        );

        // Cleanup virtual FS
        fm.deleteFile(inputFile).catch(() => {});
        fm.deleteFile(outputFile).catch(() => {});

        resolve(result);
      } catch (err) {
        console.error(`[HEVC] Transcode seg${segLabel} failed:`, err);
        // Cleanup on error too
        fm.deleteFile(inputFile).catch(() => {});
        fm.deleteFile(outputFile).catch(() => {});
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * Returns true if the FFmpeg.wasm core has been loaded and is ready.
 */
export function isTranscoderReady(): boolean {
  return loaded;
}

/**
 * Returns the load error if FFmpeg.wasm failed to initialize, null otherwise.
 */
export function getTranscoderError(): Error | null {
  return loadError;
}

/**
 * Preload the FFmpeg.wasm core in the background. Call this early so the
 * core is ready by the time the first HEVC segment needs transcoding.
 */
export function preloadTranscoder(): void {
  if (loaded || ffmpegLoadPromise) return;
  getFFmpeg().catch((_err) => {
    console.warn('[HEVC] Preload failed — will retry on first transcode');
    ffmpegLoadPromise = null;
    loadError = null;
  });
}

/**
 * Terminate the FFmpeg.wasm worker and reset all state. Useful when
 * navigating away from a player page.
 */
export function terminateTranscoder(): void {
  if (ffmpeg) {
    try {
      ffmpeg.terminate();
    } catch {
      // Worker may already be dead
    }
    ffmpeg = null;
    ffmpegLoadPromise = null;
    loaded = false;
    loadError = null;
    transcodeQueue = Promise.resolve();
  }
}
