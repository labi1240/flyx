/**
 * Smoke test for FetchLoader: verifies it honors context.responseType.
 *
 * Regression guard for the bug where the custom loader always returned
 * ArrayBuffer to hls.js playlist parsers (which call `response.data as string`),
 * silently killing manifest parsing for flixer/videasy/bingebox.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import FetchLoader from './hls-fetch-loader';

const M3U8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
index.m3u8
`;

const FRAGMENT_BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer;

let originalFetch: typeof fetch;

function mockFetch(body: string | ArrayBuffer, contentType = 'application/vnd.apple.mpegurl') {
  // @ts-ignore — testing with a partial fetch mock
  globalThis.fetch = async (_url: any, _init: any) => {
    const isString = typeof body === 'string';
    return new Response(body as any, {
      status: 200,
      headers: { 'Content-Type': isString ? contentType : 'video/mp2t' },
    });
  };
}

function loadOnce(loader: any, context: any): Promise<{ type: 'success' | 'error'; data?: any; err?: any }> {
  return new Promise((resolve) => {
    loader.load(context, { timeout: 5000, maxRetry: 0 }, {
      onSuccess: (response: any) => resolve({ type: 'success', data: response.data }),
      onError: (err: any) => resolve({ type: 'error', err }),
      onProgress: () => {},
      onAbort: () => {},
      onTimeout: () => {},
    });
  });
}

describe('FetchLoader', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns a string when responseType is "text" (playlist load)', async () => {
    mockFetch(M3U8);
    const loader = new FetchLoader();
    const result = await loadOnce(loader, {
      url: 'https://example.com/master.m3u8',
      responseType: 'text',
    });

    expect(result.type).toBe('success');
    expect(typeof result.data).toBe('string');
    expect(result.data).toContain('#EXTM3U');
  });

  it('returns a string when responseType is undefined (default)', async () => {
    mockFetch(M3U8);
    const loader = new FetchLoader();
    const result = await loadOnce(loader, {
      url: 'https://example.com/master.m3u8',
    });

    expect(result.type).toBe('success');
    expect(typeof result.data).toBe('string');
  });

  it('returns an ArrayBuffer when responseType is "arraybuffer" (fragment load)', async () => {
    mockFetch(FRAGMENT_BYTES);
    const loader = new FetchLoader();
    const result = await loadOnce(loader, {
      url: 'https://example.com/segment0.ts',
      responseType: 'arraybuffer',
    });

    expect(result.type).toBe('success');
    expect(result.data instanceof ArrayBuffer).toBe(true);
    expect((result.data as ArrayBuffer).byteLength).toBe(10);
  });

  it('forwards rangeStart/rangeEnd as a Range header', async () => {
    let capturedHeaders: Headers | null = null;
    // @ts-ignore
    globalThis.fetch = async (_url: any, init: any) => {
      capturedHeaders = init.headers as Headers;
      return new Response(FRAGMENT_BYTES, { status: 200 });
    };

    const loader = new FetchLoader();
    await loadOnce(loader, {
      url: 'https://example.com/init.mp4',
      responseType: 'arraybuffer',
      rangeStart: 0,
      rangeEnd: 1024,
    });

    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!.get('Range')).toBe('bytes=0-1023');
  });

  it('reports error on HTTP 4xx without retry when maxRetry=0', async () => {
    // @ts-ignore
    globalThis.fetch = async () => new Response('not found', { status: 404, statusText: 'Not Found' });

    const loader = new FetchLoader();
    const result = await loadOnce(loader, {
      url: 'https://example.com/missing.m3u8',
      responseType: 'text',
    });

    expect(result.type).toBe('error');
    expect(result.err.code).toBe(404);
  });
});
