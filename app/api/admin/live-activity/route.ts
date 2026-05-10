/**
 * Live Activity API - Real-time monitoring of user activity
 * GET /api/admin/live-activity - Get live activity data (requires auth)
 * POST /api/admin/live-activity - Record new activity (public endpoint for tracking)
 * 
 * MIGRATED: Queries Analytics Worker for live activity data
 * Falls back to D1 database if worker is unavailable
 * 
 * Requirements: 13.6
 */

import { NextRequest } from 'next/server';
import { verifyAdminAuth } from '@/lib/utils/admin-auth';
import { getAdapter } from '@/lib/db/adapter';
import {
  successResponse,
  unauthorizedResponse,
  internalErrorResponse,
} from '@/app/lib/utils/api-response';

export const dynamic = 'force-dynamic';

// Sync Worker URL (admin analytics endpoints)
const CF_ANALYTICS_WORKER_URL = process.env.NEXT_PUBLIC_CF_SYNC_URL || 'https://flyx-sync.vynx-3b3.workers.dev';
const REQUEST_TIMEOUT = 5000;

interface LiveActivity {
  id: string;
  userId: string;
  contentId: string;
  contentTitle: string;
  contentType: 'movie' | 'tv';
  season?: number;
  episode?: number;
  action: 'started' | 'watching' | 'paused' | 'completed';
  progress: number;
  location: { country?: string; city?: string; ip: string };
  device: { userAgent: string; platform?: string; browser?: string };
  timestamp: string;
  duration: number;
}

// In-memory store for recent activities (last 24 hours)
const recentActivities: LiveActivity[] = [];
const MAX_ACTIVITIES = 1000;


function getLocationInfo(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const cfConnectingIp = request.headers.get('cf-connecting-ip');
  const country = request.headers.get('cf-ipcountry') || 'Unknown';
  const city = request.headers.get('cf-ipcity') || 'Unknown';
  const ip = cfConnectingIp || realIp || (forwarded ? forwarded.split(',')[0].trim() : 'unknown');
  
  return {
    country: country !== 'XX' ? country : 'Unknown',
    city: city !== 'Unknown' ? decodeURIComponent(city) : 'Unknown',
    ip: ip.substring(0, 8) + '***'
  };
}

function parseUserAgent(userAgent: string) {
  const ua = userAgent.toLowerCase();
  let browser = 'Unknown', platform = 'Unknown';
  
  if (ua.includes('chrome')) browser = 'Chrome';
  else if (ua.includes('firefox')) browser = 'Firefox';
  else if (ua.includes('safari')) browser = 'Safari';
  else if (ua.includes('edge')) browser = 'Edge';
  else if (ua.includes('opera')) browser = 'Opera';
  
  if (ua.includes('windows')) platform = 'Windows';
  else if (ua.includes('mac')) platform = 'macOS';
  else if (ua.includes('linux')) platform = 'Linux';
  else if (ua.includes('android')) platform = 'Android';
  else if (ua.includes('iphone') || ua.includes('ipad')) platform = 'iOS';
  
  return { browser, platform };
}

/**
 * Query the Analytics Worker for live activity data
 */
async function queryAnalyticsWorker(limit: number): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    
    const response = await fetch(`${CF_ANALYTICS_WORKER_URL}/live-activity?limit=${limit}`, {
      method: 'GET',
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.warn('[Live Activity] Analytics Worker unavailable:', error);
    return { success: false, error: String(error) };
  }
}


export async function GET(request: NextRequest) {
  try {
    const authResult = await verifyAdminAuth(request);
    if (!authResult.success) {
      return unauthorizedResponse(authResult.error || 'Authentication required');
    }

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');
    const type = searchParams.get('type') || 'all';
    
    let activities: LiveActivity[] = [];
    let workerData: any = null;
    
    // First, try to get data from Analytics Worker (primary source)
    const workerResult = await queryAnalyticsWorker(limit);
    
    if (workerResult.success && workerResult.data) {
      workerData = workerResult.data;
      // Transform worker data to LiveActivity format if needed
      if (workerData.users && Array.isArray(workerData.users)) {
        activities = workerData.users.map((user: any) => ({
          id: user.id || `activity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          userId: user.userId || user.user_id,
          contentId: user.contentId || user.content_id || 'unknown',
          contentTitle: user.contentTitle || user.content_title || 'Unknown Title',
          contentType: user.contentType || user.content_type || 'movie',
          season: user.seasonNumber || user.season_number,
          episode: user.episodeNumber || user.episode_number,
          action: user.activityType === 'watching' ? 'watching' : 
                  user.activityType === 'livetv' ? 'watching' : 'browsing' as any,
          progress: user.progress || 0,
          location: { country: user.country || 'Unknown', city: user.city || 'Unknown', ip: 'hidden' },
          device: { userAgent: user.userAgent || 'Unknown', platform: user.platform, browser: user.browser },
          timestamp: user.lastHeartbeat ? new Date(user.lastHeartbeat).toISOString() : new Date().toISOString(),
          duration: user.duration || 0
        }));
      }
    }
    
    // Fallback to D1 database if worker data is not available
    if (activities.length === 0) {
      try {
        const adapter = getAdapter();
        const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
        
        const result = await adapter.query<any>(
          `SELECT id, session_id, timestamp, event_type, metadata
           FROM analytics_events 
           WHERE timestamp >= ? 
             AND (event_type = 'watch_start' OR event_type = 'watch_progress' OR event_type = 'watch_complete')
           ORDER BY timestamp DESC 
           LIMIT ?`,
          [twentyFourHoursAgo, limit]
        );
        
        activities = (result.data || []).map((row: any) => {
          const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
          const device = parseUserAgent(metadata.userAgent || '');
          
          let action: 'started' | 'watching' | 'paused' | 'completed' = 'watching';
          if (row.event_type === 'watch_start') action = 'started';
          else if (row.event_type === 'watch_complete') action = 'completed';
          else if (metadata.progress && metadata.progress < 5) action = 'started';
          else if (Date.now() - row.timestamp > 5 * 60 * 1000) action = 'paused';
          
          return {
            id: row.id,
            userId: row.session_id,
            contentId: metadata.contentId || 'unknown',
            contentTitle: metadata.title || metadata.contentTitle || 'Unknown Title',
            contentType: metadata.mediaType || metadata.contentType || 'movie',
            season: metadata.season,
            episode: metadata.episode,
            action,
            progress: Math.round(metadata.progress || 0),
            location: { country: metadata.country || 'Unknown', city: metadata.city || 'Unknown', ip: metadata.ip || 'unknown' },
            device: { userAgent: metadata.userAgent || 'Unknown', platform: device.platform, browser: device.browser },
            timestamp: new Date(row.timestamp).toISOString(),
            duration: metadata.duration || 0
          };
        });
      } catch (dbError) {
        console.warn('Database not available for live activity, using in-memory data:', dbError);
        activities = recentActivities.slice(0, limit);
      }
    }
    
    // Filter by type if specified
    let filteredActivities = activities;
    if (type === 'active') {
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      filteredActivities = activities.filter(activity => 
        new Date(activity.timestamp).getTime() > tenMinutesAgo && activity.action === 'watching'
      );
    } else if (type === 'recent') {
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      filteredActivities = activities.filter(activity => 
        new Date(activity.timestamp).getTime() > oneHourAgo
      );
    }
    
    // Build stats from worker data or activities
    const stats = workerData ? {
      totalActivities: workerData.total || activities.length,
      activeNow: workerData.total || activities.filter(a => {
        const timeDiff = Date.now() - new Date(a.timestamp).getTime();
        return timeDiff < 10 * 60 * 1000 && a.action === 'watching';
      }).length,
      watching: workerData.watching || 0,
      browsing: workerData.browsing || 0,
      livetv: workerData.livetv || 0,
      uniqueUsers: workerData.total || new Set(activities.map(a => a.userId)).size,
      topContent: activities.reduce((acc: Record<string, number>, activity) => {
        const key = activity.contentTitle;
        if (key) acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      topCountries: activities.reduce((acc: Record<string, number>, activity) => {
        const country = activity.location.country;
        if (country && country !== 'Unknown') acc[country] = (acc[country] || 0) + 1;
        return acc;
      }, {}),
      deviceBreakdown: activities.reduce((acc: Record<string, number>, activity) => {
        const platform = activity.device.platform;
        if (platform && platform !== 'Unknown') acc[platform] = (acc[platform] || 0) + 1;
        return acc;
      }, {})
    } : {
      totalActivities: activities.length,
      activeNow: activities.filter(a => {
        const timeDiff = Date.now() - new Date(a.timestamp).getTime();
        return timeDiff < 10 * 60 * 1000 && a.action === 'watching';
      }).length,
      uniqueUsers: new Set(activities.map(a => a.userId)).size,
      topContent: activities.reduce((acc: Record<string, number>, activity) => {
        const key = activity.contentTitle;
        if (key) acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      topCountries: activities.reduce((acc: Record<string, number>, activity) => {
        const country = activity.location.country;
        if (country && country !== 'Unknown') acc[country] = (acc[country] || 0) + 1;
        return acc;
      }, {}),
      deviceBreakdown: activities.reduce((acc: Record<string, number>, activity) => {
        const platform = activity.device.platform;
        if (platform && platform !== 'Unknown') acc[platform] = (acc[platform] || 0) + 1;
        return acc;
      }, {})
    };
    
    return successResponse({
      activities: filteredActivities,
      stats,
      totalCount: filteredActivities.length,
      source: workerResult.success ? 'analytics-worker' : 'd1'
    });
    
  } catch (error) {
    console.error('Live activity API error:', error);
    return internalErrorResponse('Failed to fetch live activity data', error instanceof Error ? error : undefined);
  }
}


export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, contentId, contentTitle, contentType, season, episode, action, progress, duration } = body;
    
    const activity: LiveActivity = {
      id: `activity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId: userId || `anon_${Date.now()}`,
      contentId,
      contentTitle,
      contentType,
      season,
      episode,
      action,
      progress: progress || 0,
      location: getLocationInfo(request),
      device: {
        userAgent: request.headers.get('user-agent') || 'Unknown',
        ...parseUserAgent(request.headers.get('user-agent') || '')
      },
      timestamp: new Date().toISOString(),
      duration: duration || 0
    };
    
    recentActivities.unshift(activity);
    if (recentActivities.length > MAX_ACTIVITIES) {
      recentActivities.splice(MAX_ACTIVITIES);
    }
    
    return successResponse({ activityId: activity.id }, { message: 'Activity recorded' });
    
  } catch (error) {
    console.error('Live activity POST error:', error);
    return internalErrorResponse('Failed to record activity', error instanceof Error ? error : undefined);
  }
}
