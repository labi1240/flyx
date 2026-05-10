/**
 * Debug endpoint to test if CF Pages can reach the CF Worker
 * DELETE THIS AFTER DEBUGGING
 */
import { NextResponse } from 'next/server';

export async function GET() {
  const results: Record<string, any> = {};
  
  // Test 1: Check env vars
  results.env = {
    NEXT_PUBLIC_CF_STREAM_PROXY_URL: process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 'NOT SET',
    CF_STREAM_PROXY_URL: process.env.CF_STREAM_PROXY_URL || 'NOT SET',
    RPI_PROXY_URL: process.env.RPI_PROXY_URL ? 'SET' : 'NOT SET',
    RPI_PROXY_KEY: process.env.RPI_PROXY_KEY ? 'SET' : 'NOT SET',
    NEXT_PUBLIC_RPI_PROXY_URL: process.env.NEXT_PUBLIC_RPI_PROXY_URL ? 'SET' : 'NOT SET',
    NODE_ENV: process.env.NODE_ENV || 'NOT SET',
  };

  // Test 2: Try to reach CF Worker health endpoint
  try {
    const healthUrl = 'https://media-proxy.vynx-3b3.workers.dev/health';
    const start = Date.now();
    const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    const body = await resp.text();
    results.cfWorkerHealth = {
      status: resp.status,
      body: body.substring(0, 200),
      timeMs: Date.now() - start,
    };
  } catch (e: any) {
    results.cfWorkerHealth = { error: e.message };
  }

  // Test 3: Try to reach CF Worker flixer health
  try {
    const url = 'https://media-proxy.vynx-3b3.workers.dev/flixer/health';
    const start = Date.now();
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await resp.text();
    results.flixerHealth = {
      status: resp.status,
      body: body.substring(0, 200),
      timeMs: Date.now() - start,
    };
  } catch (e: any) {
    results.flixerHealth = { error: e.message };
  }

  // Test 4: Try to reach CF Worker flixer extract (single server)
  try {
    const url = 'https://media-proxy.vynx-3b3.workers.dev/flixer/extract?tmdbId=550&type=movie&server=bravo';
    const start = Date.now();
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = await resp.text();
    results.flixerExtract = {
      status: resp.status,
      body: body.substring(0, 300),
      timeMs: Date.now() - start,
    };
  } catch (e: any) {
    results.flixerExtract = { error: e.message };
  }

  // Test 5: Try cfFetch detection
  try {
    const { cfFetch, isRpiProxyConfigured, needsProxying } = await import('@/app/lib/utils/cf-fetch');
    results.cfFetchConfig = {
      isRpiConfigured: isRpiProxyConfigured(),
      needsProxying: needsProxying(),
      nodeEnv: process.env.NODE_ENV || 'NOT SET',
    };
    // Test cfFetch to CF Worker (should route through RPI in production)
    const start = Date.now();
    const resp = await cfFetch('https://media-proxy.vynx-3b3.workers.dev/health', {
      signal: AbortSignal.timeout(10000),
    });
    const body = await resp.text();
    results.cfFetchToWorker = {
      status: resp.status,
      body: body.substring(0, 200),
      timeMs: Date.now() - start,
    };
  } catch (e: any) {
    results.cfFetchConfig = { error: e.message };
  }

  // Test 6: Try getCloudflareContext
  try {
    const { getCloudflareContext } = require('@opennextjs/cloudflare');
    const ctx = getCloudflareContext({ async: false });
    results.cfContext = {
      hasEnv: !!ctx?.env,
      envKeys: ctx?.env ? Object.keys(ctx.env).filter((k: string) => !k.startsWith('__')).slice(0, 20) : [],
      hasRpiUrl: !!ctx?.env?.RPI_PROXY_URL,
      hasRpiKey: !!ctx?.env?.RPI_PROXY_KEY,
    };
  } catch (e: any) {
    results.cfContext = { error: e.message };
  }

  return NextResponse.json(results, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
