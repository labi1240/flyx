/**
 * Live TV Schedule API
 * 
 * Fetches and returns sports events schedule from DLHD.
 * Uses regex-based parsing (no external dependencies).
 * 
 * UPDATED May 31, 2026:
 * - Primary domain: dlhd.pk (dlhd.link died ~March 2026)
 * - Removed Node.js https module / SNI workaround — standard fetch works now
 * - Fallback: RPI proxy (dead — dlhd.pk is direct nginx, no Cloudflare)
 */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SportEvent {
  id: string;
  time: string;
  isoTime: string; // ISO timestamp for client-side timezone conversion
  dataTime: string;
  title: string;
  sport?: string;
  league?: string;
  teams?: { home: string; away: string };
  isLive: boolean;
  channels: { name: string; channelId: string; href: string }[];
}

interface ScheduleCategory {
  name: string;
  icon: string;
  events: SportEvent[];
}

const SPORT_ICONS: Record<string, string> = {
  'soccer': '⚽', 'football': '⚽', 'basketball': '🏀', 'tennis': '🎾',
  'cricket': '🏏', 'hockey': '🏒', 'baseball': '⚾', 'golf': '⛳',
  'rugby': '🏉', 'motorsport': '🏎️', 'f1': '🏎️', 'boxing': '🥊',
  'mma': '🥊', 'ufc': '🥊', 'wwe': '🤼', 'volleyball': '🏐',
  'am. football': '🏈', 'nfl': '🏈', 'tv shows': '📺',
};

function getIcon(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(SPORT_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return '📺';
}

/**
 * Convert UK GMT time (HH:MM) to ISO timestamp for today
 * This allows the client to convert to local timezone
 */
function toISOTimestamp(time24: string): string {
  if (!time24) return '';
  
  const match = time24.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '';
  
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  
  // Create a date for today with the given time in UTC (UK GMT = UTC)
  const now = new Date();
  const eventDate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hours,
    minutes,
    0,
    0
  ));
  
  return eventDate.toISOString();
}

/**
 * Check if an event is currently live based on its start time.
 * Events are considered live if they started within the last hour
 * (for "Live Now Only" filter to show currently airing events)
 */
function isEventLive(dataTime: string, time24: string, htmlIndicatesLive: boolean): boolean {
  // If HTML already says it's live, trust that
  if (htmlIndicatesLive) return true;
  
  // Try to parse the time and check if it's within the last hour
  try {
    const now = new Date();
    let eventTime: Date | null = null;
    
    // First try dataTime if it looks like a full date/timestamp
    if (dataTime && /^\d+$/.test(dataTime)) {
      // Unix timestamp (seconds)
      eventTime = new Date(parseInt(dataTime) * 1000);
    } else if (dataTime && dataTime.includes('-')) {
      // Full date string like "2025-12-14 13:00"
      eventTime = new Date(dataTime + ' GMT');
    } else if (time24) {
      // Just time like "13:00" - assume today in UK timezone
      const match = time24.match(/^(\d{1,2}):(\d{2})$/);
      if (match) {
        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        
        // Create a date for today with the given time (UK timezone = GMT)
        eventTime = new Date();
        // Adjust for UK timezone (GMT/UTC)
        const ukOffset = 0; // GMT is UTC+0
        eventTime.setUTCHours(hours - ukOffset, minutes, 0, 0);
      }
    }
    
    if (!eventTime) return false;
    
    const diffMs = now.getTime() - eventTime.getTime();
    const diffMinutes = diffMs / (1000 * 60);
    
    // Event is live if it started between 0 and 60 minutes ago (1 hour)
    return diffMinutes >= 0 && diffMinutes <= 60;
  } catch {
    return false;
  }
}

function parseEvents(html: string): SportEvent[] {
  const events: SportEvent[] = [];
  
  // Match schedule__event blocks - each event contains eventHeader and channels
  // The structure is: <div class="schedule__event">...<div class="schedule__channels">...</div></div>
  const eventRegex = /<div[^>]*class="[^"]*schedule__event(?:\s[^"]*)?[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*schedule__event(?:\s|")[^"]*"|<\/div>\s*<\/div>\s*<div[^>]*class="[^"]*schedule__category|$)/gi;
  let match;
  let index = 0;

  while ((match = eventRegex.exec(html)) !== null) {
    const eventHtml = match[0];
    
    // Extract time - format: <span class="schedule__time" data-time="13:00">13:00</span>
    let time = '';
    let dataTime = '';
    
    // Try data-time attribute first
    const dataTimeMatch = eventHtml.match(/data-time="([^"]*)"/i);
    if (dataTimeMatch) {
      dataTime = dataTimeMatch[1];
    }
    
    // Get display time from schedule__time span
    const timeMatch = eventHtml.match(/class="[^"]*schedule__time[^"]*"[^>]*>([^<]*)</i);
    if (timeMatch) {
      time = timeMatch[1].trim();
    }
    
    // Extract title from schedule__eventTitle span
    const titleMatch = eventHtml.match(/class="[^"]*schedule__eventTitle[^"]*"[^>]*>([^<]*)</i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    
    // Check if live from HTML - look for is-live class or LIVE text
    const htmlIndicatesLive = /is-live|class="[^"]*live[^"]*"|>LIVE</i.test(eventHtml);
    
    // Determine if event is live based on time or HTML indicator
    const isLive = isEventLive(dataTime, time, htmlIndicatesLive);
    
    // Get ISO timestamp for client-side timezone conversion
    const isoTime = toISOTimestamp(time);
    
    // Extract channels from schedule__channels section
    const channels: { name: string; channelId: string; href: string }[] = [];
    const channelsSection = eventHtml.match(/class="[^"]*schedule__channels[^"]*"[^>]*>([\s\S]*?)(?:<\/div>|$)/i);
    if (channelsSection) {
      const channelRegex = /<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
      let chMatch;
      while ((chMatch = channelRegex.exec(channelsSection[1])) !== null) {
        const href = chMatch[1];
        const name = chMatch[2].trim();
        // Extract channel ID from href like "/watch.php?id=313"
        const idMatch = href.match(/id=(\d+)/);
        if (name && name.length > 0) {
          channels.push({ 
            name, 
            channelId: idMatch ? idMatch[1] : '', 
            href 
          });
        }
      }
    }
    
    // Parse teams from title (e.g., "Team A vs Team B - League Name")
    let teams: { home: string; away: string } | undefined;
    let league: string | undefined;
    const vsMatch = title.match(/(.+?)\s+vs\.?\s+(.+?)(?:\s*[-–]\s*(.+))?$/i);
    if (vsMatch) {
      teams = { home: vsMatch[1].trim(), away: vsMatch[2].trim() };
      if (vsMatch[3]) league = vsMatch[3].trim();
    }
    
    // Only add if we have meaningful content
    if (title && title.length > 0) {
      // Create a unique ID based on content hash to avoid duplicates
      const contentHash = `${time}-${title}-${channels.map(c => c.channelId).join(',')}`;
      const hashCode = contentHash.split('').reduce((a, b) => {
        a = ((a << 5) - a) + b.charCodeAt(0);
        return a & a;
      }, 0);
      
      events.push({
        id: `event-${Math.abs(hashCode)}-${index++}`,
        time: time, // Keep original 24h UK time
        isoTime, // ISO timestamp for client-side conversion
        dataTime, 
        title, 
        isLive, 
        channels, 
        teams, 
        league
      });
    }
  }
  
  return events;
}


function parseCategories(html: string): ScheduleCategory[] {
  // Find all category names and their positions using card__meta divs
  const categoryPositions: { name: string; index: number }[] = [];
  const cardMetaRegex = /<div[^>]*class="card__meta"[^>]*>([^<]+)<\/div>/gi;
  let cardMetaMatch;
  
  while ((cardMetaMatch = cardMetaRegex.exec(html)) !== null) {
    const name = cardMetaMatch[1].trim();
    if (name) {
      categoryPositions.push({
        name,
        index: cardMetaMatch.index
      });
    }
  }
  
  if (categoryPositions.length === 0) {
    return [];
  }
  
  // Parse events for each category section (from one card__meta to the next)
  const categoryMap = new Map<string, SportEvent[]>();
  let globalEventIndex = 0; // Global counter to ensure unique IDs across all categories
  
  for (let i = 0; i < categoryPositions.length; i++) {
    const start = categoryPositions[i].index;
    const end = i < categoryPositions.length - 1 ? categoryPositions[i + 1].index : html.length;
    const catHtml = html.substring(start, end);
    const catName = categoryPositions[i].name;
    
    const events = parseEvents(catHtml);
    // Assign globally unique IDs and set sport name
    events.forEach(e => { 
      e.sport = catName;
      // Override the ID with a globally unique one
      e.id = `evt-${i}-${globalEventIndex++}`;
    });
    
    if (events.length > 0) {
      // Merge with existing category if name already exists
      const existing = categoryMap.get(catName);
      if (existing) {
        existing.push(...events);
      } else {
        categoryMap.set(catName, events);
      }
    }
  }
  
  // Convert map to array
  const categories: ScheduleCategory[] = [];
  for (const [name, events] of categoryMap) {
    categories.push({ name, icon: getIcon(name), events });
  }
  
  // Sort by event count (most events first)
  categories.sort((a, b) => b.events.length - a.events.length);
  
  return categories;
}

const SCHEDULE_DOMAIN = 'dlhd.pk';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch schedule HTML from DLHD.
 * 
 * Strategy:
 *   1. Direct fetch to dlhd.link (primary, no TLS hacks needed)
 *   2. Fallback: RPI proxy fetch (residential IP)
 */
async function fetchScheduleHTML(source?: string): Promise<string> {
  // Method 1: Direct fetch to dlhd.link
  try {
    const url = source
      ? `https://${SCHEDULE_DOMAIN}/schedule-api.php?source=${encodeURIComponent(source)}`
      : `https://${SCHEDULE_DOMAIN}/`;
    console.log('[Schedule] Fetching from', SCHEDULE_DOMAIN);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const text = await res.text();
      
      if (source) {
        try {
          const json = JSON.parse(text);
          if (json.success && json.html) {
            console.log('[Schedule] Got schedule HTML from API:', json.html.length, 'chars');
            return json.html;
          }
        } catch {
          // Not JSON, might be raw HTML
        }
      }
      
      if (text.length > 1000) {
        console.log('[Schedule] Got schedule HTML:', text.length, 'chars');
        return text;
      }
    }
    console.warn('[Schedule] Direct fetch returned empty/short response, status:', res.status);
  } catch (err) {
    console.error('[Schedule] Direct fetch error:', err);
  }
  
  // Method 2: Via RPI proxy (residential IP)
  const rpiUrl = process.env.RPI_PROXY_URL;
  const rpiKey = process.env.RPI_PROXY_KEY;
  if (rpiUrl && rpiKey) {
    try {
      const targetUrl = source
        ? `https://${SCHEDULE_DOMAIN}/schedule-api.php?source=${encodeURIComponent(source)}`
        : `https://${SCHEDULE_DOMAIN}/`;
      const proxyUrl = `${rpiUrl}/dlhd/stream?url=${encodeURIComponent(targetUrl)}&key=${rpiKey}`;
      console.log('[Schedule] Trying RPI proxy fallback...');
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const text = await res.text();
        if (source) {
          try {
            const json = JSON.parse(text);
            if (json.success && json.html) return json.html;
          } catch {}
        }
        if (text.length > 1000) {
          console.log('[Schedule] Got schedule via RPI:', text.length, 'chars');
          return text;
        }
      }
    } catch (err) {
      console.error('[Schedule] RPI proxy error:', err);
    }
  }
  
  console.error('[Schedule] All fetch methods failed');
  return '';
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const source = searchParams.get('source');
    const sport = searchParams.get('sport');
    const search = searchParams.get('search');
    const liveOnly = searchParams.get('live') === 'true';
    
    let html = '';
    try {
      html = await fetchScheduleHTML(source || undefined);
    } catch (fetchErr) {
      console.error('[Schedule API] Fetch error:', fetchErr);
    }
    
    if (!html) {
      // Return empty but valid response instead of 500
      return NextResponse.json({
        success: true,
        schedule: { date: new Date().toISOString().split('T')[0], timezone: 'UK GMT', categories: [] },
        stats: { totalCategories: 0, totalEvents: 0, liveEvents: 0 },
        filters: { sports: [] },
        warning: 'Schedule temporarily unavailable',
      }, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      });
    }
    
    let categories = parseCategories(html);
    
    // Fallback: parse events directly if no categories found
    if (categories.length === 0) {
      const events = parseEvents(html);
      if (events.length > 0) {
        categories = [{ name: 'All Events', icon: '📺', events }];
      }
    }
    
    // Apply filters
    if (sport && sport !== 'all') {
      categories = categories.filter(cat => cat.name.toLowerCase().includes(sport.toLowerCase()));
    }
    
    if (search) {
      const s = search.toLowerCase();
      categories = categories.map(cat => ({
        ...cat,
        events: cat.events.filter(e => 
          e.title.toLowerCase().includes(s) || 
          e.channels.some(ch => ch.name.toLowerCase().includes(s))
        )
      })).filter(cat => cat.events.length > 0);
    }
    
    if (liveOnly) {
      categories = categories.map(cat => ({
        ...cat,
        events: cat.events.filter(e => e.isLive)
      })).filter(cat => cat.events.length > 0);
    }
    
    const totalEvents = categories.reduce((sum, cat) => sum + cat.events.length, 0);
    const liveEvents = categories.reduce((sum, cat) => sum + cat.events.filter(e => e.isLive).length, 0);
    
    return NextResponse.json({
      success: true,
      schedule: { 
        date: new Date().toISOString().split('T')[0], 
        timezone: 'UK GMT', 
        categories 
      },
      stats: { totalCategories: categories.length, totalEvents, liveEvents },
      filters: { 
        sports: categories.map(cat => ({ name: cat.name, icon: cat.icon, count: cat.events.length })) 
      }
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
    
  } catch (error) {
    console.error('[Schedule API] Error:', error);
    // Return empty but valid response instead of 500 so frontend doesn't break
    return NextResponse.json({
      success: true,
      schedule: { date: new Date().toISOString().split('T')[0], timezone: 'UK GMT', categories: [] },
      stats: { totalCategories: 0, totalEvents: 0, liveEvents: 0 },
      filters: { sports: [] },
      warning: error instanceof Error ? error.message : 'Schedule error',
    });
  }
}
