/**
 * VIPRow Schedule API
 * 
 * GET /api/livetv/viprow-schedule
 * 
 * Fetches and parses the VIPRow schedule from their big-games page.
 * Events are extracted from the server-rendered HTML.
 */

import { NextResponse } from 'next/server';

const VIPROW_BASE = 'https://www.viprow.nu';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface ViprowEvent {
  id: string;
  title: string;
  sport: string;
  time: string;
  isoTime: string;
  url: string;
  isLive: boolean;
  startsIn?: string; // Human-readable time until start (for upcoming events)
}

export async function GET() {
  try {
    // Fetch the big-games schedule page
    const response = await fetch(`${VIPROW_BASE}/sports-big-games`, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return NextResponse.json({
        success: false,
        error: `Failed to fetch schedule: ${response.status}`,
      }, { status: response.status });
    }

    const html = await response.text();
    
    // Parse events from HTML
    // Actual structure:
    // <a href="/nba/houston-rockets-vs-phoenix-suns-online-stream" role="button" title="Houston Rockets v Phoenix Suns">
    //   <span class="align-bottom me-2 vipbox nba"></span>
    //   <span content="2026-01-06T01:00" class="b9o4y6s8z6 me-2">01:00</span>
    //   Houston Rockets v Phoenix Suns
    // </a>
    
    const events: ViprowEvent[] = [];
    
    // Match each event link - use simpler pattern that works with the actual HTML
    // Pattern: href="URL" ... title="TITLE" ... vipbox SPORT ... content="ISO_TIME" ... >TIME</span>
    const linkPattern = /<a[^>]*href="([^"]*online-stream)"[^>]*title="([^"]+)"[^>]*>/g;
    let linkMatch;
    
    while ((linkMatch = linkPattern.exec(html)) !== null) {
      const [, url, title] = linkMatch;
      const startIdx = linkMatch.index;
      
      // Find the closing </a> tag
      const endIdx = html.indexOf('</a>', startIdx);
      if (endIdx === -1) continue;
      
      const linkContent = html.substring(startIdx, endIdx + 4);
      
      // Extract sport from vipbox class
      const sportMatch = linkContent.match(/vipbox\s+([a-z0-9-]+)/i);
      const sport = sportMatch ? sportMatch[1] : 'other';
      
      // Extract time from content attribute
      const timeMatch = linkContent.match(/content="([^"]+)"[^>]*>(\d{2}:\d{2})</);
      if (!timeMatch) continue;
      
      const [, isoTime, time] = timeMatch;
      
      // Parse the event time - VIPRow times appear to be in UTC
      // Format: "2026-01-06T01:00" (no timezone = assume UTC)
      let eventTime: Date;
      if (isoTime.includes('T') && !isoTime.includes('Z') && !isoTime.includes('+')) {
        // No timezone specified, treat as UTC
        eventTime = new Date(isoTime + 'Z');
      } else {
        eventTime = new Date(isoTime);
      }
      
      const now = new Date();
      
      // Event is live if:
      // 1. It has already started (eventTime <= now)
      // 2. It started within the last 4 hours (typical sports event duration)
      const timeSinceStart = now.getTime() - eventTime.getTime();
      const isLive = timeSinceStart >= 0 && timeSinceStart < 4 * 60 * 60 * 1000;
      
      // Calculate time until start for upcoming events
      let startsIn: string | undefined;
      if (timeSinceStart < 0) {
        const minutesUntil = Math.abs(timeSinceStart) / (60 * 1000);
        if (minutesUntil < 60) {
          startsIn = `${Math.round(minutesUntil)}m`;
        } else {
          const hoursUntil = minutesUntil / 60;
          startsIn = `${Math.round(hoursUntil)}h`;
        }
      }
      
      events.push({
        id: `viprow-${url.replace(/[^a-z0-9]/gi, '-')}`,
        title: title.trim(),
        sport: sport.trim(),
        time,
        isoTime,
        url,
        isLive,
        startsIn,
      });
    }

    // Group events by sport
    const bySport: Record<string, ViprowEvent[]> = {};
    for (const event of events) {
      if (!bySport[event.sport]) {
        bySport[event.sport] = [];
      }
      bySport[event.sport].push(event);
    }

    return NextResponse.json({
      success: true,
      count: events.length,
      events,
      bySport,
      fetchedAt: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    });

  } catch (error: unknown) {
    console.error('[VIPRow Schedule] Error:', error);
    // Return empty results instead of 500 so the frontend still works
    return NextResponse.json({
      success: true,
      count: 0,
      events: [],
      bySport: {},
      fetchedAt: new Date().toISOString(),
      warning: error instanceof Error ? error.message : 'VIPRow unavailable',
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      },
    });
  }
}
