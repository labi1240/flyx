/**
 * Analytics Endpoints Configuration — Local-first
 *
 * The dedicated analytics worker has been removed. Admin analytics
 * endpoints are now served by the Sync_Worker.
 *
 * Usage:
 *   import { getAnalyticsEndpoint } from '@/lib/utils/analytics-endpoints';
 *   const url = getAnalyticsEndpoint('live-activity');
 */

const CF_SYNC_WORKER_FALLBACK = 'https://flyx-sync.vynx-3b3.workers.dev';

function getSyncWorkerUrl(): string {
  return process.env.NEXT_PUBLIC_CF_SYNC_URL || CF_SYNC_WORKER_FALLBACK;
}

/**
 * Get the appropriate analytics endpoint URL.
 * All admin analytics endpoints are now served by the Sync_Worker.
 */
export function getAnalyticsEndpoint(
  endpoint:
    | 'presence'
    | 'pageview'
    | 'page-view'
    | 'event'
    | 'watch-session'
    | 'live-activity'
    | 'livetv-session'
    | 'stats'
    | 'traffic-sources'
    | 'presence-stats'
    | 'users'
    | 'user-engagement'
    | 'unified-stats'
    | 'admin-analytics'
    | 'activity-history'
    | 'system-health',
): string {
  const base = getSyncWorkerUrl();

  const routes: Record<string, string> = {
    'live-activity': '/admin/live',
    'stats': '/admin/stats',
    'unified-stats': '/admin/stats',
    'admin-analytics': '/admin/stats',
    'heartbeat': '/heartbeat',
  };

  return `${base}${routes[endpoint] || `/${endpoint}`}`;
}

/**
 * Check if analytics is routed through Cloudflare
 */
export function isUsingCloudflareAnalytics(): boolean {
  return !!getSyncWorkerUrl();
}

/**
 * Get analytics configuration info (for debugging)
 */
export function getAnalyticsConfig(): {
  provider: 'sync-worker' | 'local';
  baseUrl: string | null;
} {
  const url = getSyncWorkerUrl();
  return {
    provider: url ? 'sync-worker' : 'local',
    baseUrl: url || null,
  };
}
