/**
 * Subtitles API - Fetches subtitles from OpenSubtitles
 * Returns best subtitle per language
 */

import { NextResponse } from 'next/server';

const languageMap = {
  'eng': { name: 'English', iso639: 'en' },
  'spa': { name: 'Spanish', iso639: 'es' },
  'fre': { name: 'French', iso639: 'fr' },
  'ger': { name: 'German', iso639: 'de' },
  'ita': { name: 'Italian', iso639: 'it' },
  'por': { name: 'Portuguese', iso639: 'pt' },
  'pob': { name: 'Portuguese (BR)', iso639: 'pt-BR' },
  'rus': { name: 'Russian', iso639: 'ru' },
  'ara': { name: 'Arabic', iso639: 'ar' },
  'chi': { name: 'Chinese', iso639: 'zh' },
  'jpn': { name: 'Japanese', iso639: 'ja' },
  'kor': { name: 'Korean', iso639: 'ko' },
  'dan': { name: 'Danish', iso639: 'da' },
  'dut': { name: 'Dutch', iso639: 'nl' },
  'fin': { name: 'Finnish', iso639: 'fi' },
  'nor': { name: 'Norwegian', iso639: 'no' },
  'swe': { name: 'Swedish', iso639: 'sv' },
  'pol': { name: 'Polish', iso639: 'pl' },
  'tur': { name: 'Turkish', iso639: 'tr' },
  'gre': { name: 'Greek', iso639: 'el' },
  'heb': { name: 'Hebrew', iso639: 'he' },
  'hin': { name: 'Hindi', iso639: 'hi' },
  'tha': { name: 'Thai', iso639: 'th' },
  'vie': { name: 'Vietnamese', iso639: 'vi' },
  'ind': { name: 'Indonesian', iso639: 'id' },
  'cze': { name: 'Czech', iso639: 'cs' },
  'hun': { name: 'Hungarian', iso639: 'hu' },
  'rum': { name: 'Romanian', iso639: 'ro' },
  'ukr': { name: 'Ukrainian', iso639: 'uk' },
};

async function fetchSubtitlesForLanguage(imdbId, languageId, season, episode, query) {
  try {
    // Build URL with parameters in alphabetical order
    const params = [];

    if (imdbId) {
      const numericImdbId = imdbId.replace(/^tt/, '');
      if (season && episode) {
        params.push(`episode-${episode}`);
        params.push(`imdbid-${numericImdbId}`);
        params.push(`season-${season}`);
        params.push(`sublanguageid-${languageId}`);
      } else {
        params.push(`imdbid-${numericImdbId}`);
        params.push(`sublanguageid-${languageId}`);
      }
    } else if (query) {
      params.push(`query-${encodeURIComponent(query)}`);
      if (season && episode) {
        params.push(`episode-${episode}`);
        params.push(`season-${season}`);
      }
      params.push(`sublanguageid-${languageId}`);
    } else {
      return [];
    }
    
    params.sort();
    const apiUrl = `https://rest.opensubtitles.org/search/${params.join('/')}`.toLowerCase();
    
    console.log(`[SUBTITLES] Fetching ${languageId}:`, apiUrl);
    
    // OpenSubtitles' legacy REST endpoint resets/throttles bursts of concurrent
    // connections from one IP. A single failed request shouldn't drop the whole
    // language — retry once after a short backoff before giving up.
    let response = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'TemporaryUserAgent',
            'X-User-Agent': 'TemporaryUserAgent',
            'Accept': 'application/json',
          },
          redirect: 'follow',
        });
        if (response.ok) break;
        console.log(`[SUBTITLES] ${languageId} HTTP ${response.status} (attempt ${attempt + 1})`);
      } catch (e) {
        console.log(`[SUBTITLES] ${languageId} fetch failed (attempt ${attempt + 1}): ${e.message}`);
        response = null;
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, 400));
    }

    if (!response || !response.ok) {
      console.log(`[SUBTITLES] No results for ${languageId}`);
      return [];
    }
    
    const data = await response.json();
    
    if (!Array.isArray(data)) {
      console.log(`[SUBTITLES] Invalid response for ${languageId}`);
      return [];
    }
    
    // Filter for valid formats
    const validSubtitles = data.filter(sub => 
      sub.SubFormat === 'srt' || sub.SubFormat === 'vtt'
    );
    
    const languageInfo = languageMap[languageId] || { name: 'Unknown', iso639: 'en' };
    
    // Calculate quality score
    const calculateQualityScore = (subtitle) => {
      let score = 50;
      const downloads = parseInt(subtitle.SubDownloadsCnt) || 0;
      if (downloads > 1000) score += 20;
      else if (downloads > 100) score += 10;
      else if (downloads > 10) score += 5;
      const rating = parseFloat(subtitle.SubRating) || 0;
      score += Math.round(rating * 5);
      if (subtitle.SubFormat === 'vtt') score += 15;
      return Math.min(100, Math.max(0, score));
    };
    
    const formatted = validSubtitles.map(sub => ({
      id: sub.IDSubtitleFile,
      url: sub.SubDownloadLink,
      language: languageInfo.name,
      iso639: languageInfo.iso639,
      langCode: languageId,
      format: sub.SubFormat,
      fileName: sub.SubFileName,
      qualityScore: calculateQualityScore(sub),
      downloads: sub.SubDownloadsCnt || 0,
      rating: sub.SubRating || 0,
    }));
    
    console.log(`[SUBTITLES] Found ${formatted.length} subtitles for ${languageId}`);
    return formatted;
    
  } catch (error) {
    console.error(`[SUBTITLES] Error fetching ${languageId}:`, error.message);
    return [];
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const imdbId = searchParams.get('imdbId');
  const query = searchParams.get('query');
  const season = searchParams.get('season');
  const episode = searchParams.get('episode');

  if (!imdbId && !query) {
    return NextResponse.json(
      { success: false, error: 'IMDB ID or query is required' },
      { status: 400 }
    );
  }

  try {
    console.log('[SUBTITLES] Request:', { imdbId, query, season, episode });

    // Fetch subtitles with LIMITED concurrency. OpenSubtitles' legacy endpoint
    // resets the connection when too many requests arrive from one IP at once
    // (firing all ~30 languages in parallel returns empty for nearly all of
    // them). A small worker pool keeps us under that limit while staying well
    // within the function time budget (~30 langs / 4 workers x ~0.8s ≈ 6s).
    const languageIds = Object.keys(languageMap);
    const CONCURRENCY = 4;
    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < languageIds.length) {
        const langId = languageIds[cursor++];
        results.push(await fetchSubtitlesForLanguage(imdbId, langId, season, episode, query));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // Flatten all subtitles
    const allSubtitles = results.flat();

    // Deduplicate by language - keep only the best rated subtitle per language
    const bestByLanguage = {};
    for (const subtitle of allSubtitles) {
      const langCode = subtitle.langCode;
      if (!bestByLanguage[langCode] || subtitle.qualityScore > bestByLanguage[langCode].qualityScore) {
        bestByLanguage[langCode] = subtitle;
      }
    }

    const deduplicatedSubtitles = Object.values(bestByLanguage).sort((a, b) => b.qualityScore - a.qualityScore);

    console.log(`[SUBTITLES] Total found: ${allSubtitles.length}, deduplicated: ${deduplicatedSubtitles.length}`);

    return NextResponse.json({
      success: true,
      subtitles: deduplicatedSubtitles,
      totalCount: deduplicatedSubtitles.length,
      source: 'opensubtitles-proxy'
    });

  } catch (error) {
    console.error('[SUBTITLES] Error:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to fetch subtitles',
        details: error.message
      },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  return NextResponse.json(
    { error: 'Method not allowed' },
    { status: 405 }
  );
}
