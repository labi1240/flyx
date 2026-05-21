/**
 * In-memory metrics tracking for the CF Worker
 * Resets on worker restart (Cloudflare Workers are ephemeral)
 */

export interface WorkerMetrics {
  requests: number;
  errors: number;
  streamRequests: number;
  tvRequests: number;
  dlhdRequests: number;
  decodeRequests: number;
  animekaiRequests: number;
  flixerRequests: number;
  analyticsRequests: number;
  tmdbRequests: number;
  viprowRequests: number;
  vidsrcRequests: number;
  hianimeRequests: number;
  miruroRequests: number;
  movieboxRequests: number;
  ntvRequests: number;
  primesrcRequests: number;
  bingeboxRequests: number;
  ufreetvRequests: number;
  globetvRequests: number;
  startTime: number;
}

export const metrics: WorkerMetrics = {
  requests: 0,
  errors: 0,
  streamRequests: 0,
  tvRequests: 0,
  dlhdRequests: 0,
  decodeRequests: 0,
  animekaiRequests: 0,
  flixerRequests: 0,
  analyticsRequests: 0,
  tmdbRequests: 0,
  viprowRequests: 0,
  vidsrcRequests: 0,
  hianimeRequests: 0,
  miruroRequests: 0,
  movieboxRequests: 0,
  ntvRequests: 0,
  primesrcRequests: 0,
  bingeboxRequests: 0,
  ufreetvRequests: 0,
  globetvRequests: 0,
  startTime: Date.now(),
};

/** Metric keys that can be incremented */
export type IncrementableMetric = keyof Omit<WorkerMetrics, 'startTime'>;

/** Increment a specific metric counter */
export function incrementMetric(key: IncrementableMetric): void {
  metrics[key]++;
}

/** Get uptime in seconds */
export function getUptimeSeconds(): number {
  return Math.floor((Date.now() - metrics.startTime) / 1000);
}
