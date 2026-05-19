/**
 * MAL-Based Anime Stream API
 * GET /api/anime/stream?malId=57658&episode=1&provider=hianime
 * GET /api/anime/stream?malId=4107 (for movies, no episode needed)
 * 
 * Supports providers: hianime, animekai
 * Each request returns ONLY sources from the requested provider.
 * The VideoPlayer fires both providers in parallel and uses the first to succeed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { extractAnimeKaiStreams } from '@/app/lib/services/animekai-extractor';
import { extractHiAnimeStreams } from '@/app/lib/services/hianime-extractor';
import { extractMiruroStreams } from '@/app/lib/services/miruro-extractor';
import { malService } from '@/lib/services/mal';
import { getAnimeKaiProxyUrl } from '@/app/lib/proxy-config';

type Provider = 'hianime' | 'animekai' | 'miruro';

export async function GET(request: NextRequest) {
  const startTime = Date.now();

  try {
    const searchParams = request.nextUrl.searchParams;

    const malId = searchParams.get('malId') ? parseInt(searchParams.get('malId')!) : undefined;
    const episode = searchParams.get('episode') ? parseInt(searchParams.get('episode')!) : undefined;
    const requestedProvider = (searchParams.get('provider') as Provider) || 'hianime';

    if (!malId) {
      return NextResponse.json(
        { error: 'MAL ID is required' },
        { status: 400 }
      );
    }

    console.log(`[ANIME-STREAM] Request: MAL ID ${malId}, Episode ${episode || 'N/A (movie)'}, Provider ${requestedProvider}`);

    // Get MAL anime info
    const anime = await malService.getById(malId);
    if (!anime) {
      return NextResponse.json(
        { error: 'Anime not found on MAL' },
        { status: 404 }
      );
    }

    const isMovie = anime.type === 'Movie';
    const title = anime.title_english || anime.title;
    console.log(`[ANIME-STREAM] Found anime: ${title} (type: ${anime.type}, episodes: ${anime.episodes})`);

    // Extract from the REQUESTED provider ONLY — no fallback.
    // The VideoPlayer fires both providers in parallel via Promise.any,
    // so cross-provider fallback here would cause duplicate/misattributed sources.
    console.log(`[ANIME-STREAM] Extracting from ${requestedProvider} (no fallback)...`);
    
    const result = await extractFromProvider(requestedProvider, malId, title, anime, isMovie, episode)
      .catch((err) => {
        console.log(`[ANIME-STREAM] ❌ ${requestedProvider} threw:`, err?.message);
        return null;
      });

    const providerLabel = requestedProvider === 'hianime' ? 'HiAnime' : 'AnimeKai';

    if (result?.success && result.sources.length > 0) {
      console.log(`[ANIME-STREAM] ✅ ${providerLabel}: ${result.sources.length} sources`);
      
      const sources = result.sources.map(source => {
        if (requestedProvider === 'animekai') {
          return { ...source, url: getAnimeKaiProxyUrl(source.url), title: `${source.title || 'AnimeKai'} [AnimeKai]` };
        }
        if (requestedProvider === 'miruro') {
          return { ...source, title: `${source.title || 'Miruro'} [Miruro]` };
        }
        return { ...source, title: `${source.title || 'HiAnime'} [HiAnime]` };
      });

      const executionTime = Date.now() - startTime;
      console.log(`[ANIME-STREAM] ✅ SUCCESS: ${sources.length} sources from ${requestedProvider} in ${executionTime}ms`);
      
      return NextResponse.json({
        success: true,
        sources,
        subtitles: result.subtitles || [],
        provider: requestedProvider,
        providers: [requestedProvider],
        anime: {
          malId: anime.mal_id,
          title: anime.title,
          titleEnglish: anime.title_english,
          episodes: anime.episodes,
          type: anime.type,
        },
        executionTime,
      });
    }

    const error = result?.error || 'No sources';
    console.log(`[ANIME-STREAM] ❌ ${providerLabel} failed: ${error}`);

    return NextResponse.json(
      { error: `No streams found from ${providerLabel}`, provider: requestedProvider, success: false },
      { status: 404 }
    );
  } catch (error) {
    console.error('[ANIME-STREAM] Error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch anime stream', success: false },
      { status: 500 }
    );
  }
}

interface ExtractResult {
  success: boolean;
  sources: Array<{
    quality: string;
    title?: string;
    url: string;
    type: string;
    referer?: string;
    requiresSegmentProxy: boolean;
    skipOrigin?: boolean;
    language?: string;
    skipIntro?: [number, number];
    skipOutro?: [number, number];
  }>;
  subtitles?: Array<{ label: string; url: string; language: string }>;
  error?: string;
}

async function extractFromProvider(
  provider: Provider,
  malId: number,
  title: string,
  _anime: { type: string },
  isMovie: boolean,
  episode?: number,
): Promise<ExtractResult | null> {
  if (provider === 'hianime') {
    const result = await extractHiAnimeStreams(
      malId,
      title,
      isMovie ? undefined : (episode || 1),
    );
    return {
      ...result,
      sources: result.sources.map(s => ({ ...s, title: s.title ?? '' })),
    };
  }

  if (provider === 'animekai') {
    const result = await extractAnimeKaiStreams(
      '0',
      isMovie ? 'movie' : 'tv',
      isMovie ? undefined : 1,
      isMovie ? undefined : (episode || 1),
      malId,
      title,
    );
    return {
      ...result,
      sources: result.sources.map(s => ({ ...s, title: s.title ?? '' })),
    };
  }

  if (provider === 'miruro') {
    // Miruro uses AniList IDs — try to use malId directly (MAL→AniList mapping)
    const result = await extractMiruroStreams(
      malId,
      title,
      isMovie ? undefined : (episode || 1),
      'sub',
    );
    return {
      success: result.success,
      sources: result.sources.map(s => ({ ...s, title: s.title ?? '' })),
      subtitles: result.subtitles,
      error: result.error,
    };
  }

  return null;
}
