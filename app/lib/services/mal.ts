/**
 * MyAnimeList (MAL) API Service
 *
 * Previously backed by Jikan (api.jikan.moe), but Jikan's MongoDB backend
 * is chronically unstable (~87% 500 error rate under load as of Apr 2026),
 * so this module now uses AniList GraphQL with Jikan-shaped adapters.
 *
 * AniList exposes `idMal` on every anime, so MAL IDs keep working as the
 * canonical key that downstream consumers (hianime extractor, URL routes,
 * absolute-episode mapping tables) already depend on.
 */

import {
  getAnimeByMalId as anilistGetAnime,
  searchAnime as anilistSearch,
  anilistMediaToMALAnime,
  anilistMediaToMALSearchResult,
  syntheticEpisodesForAnime,
} from './anilist';
import { scrapeMALEpisodePage, scrapeMALEpisodes } from './mal-scrape';

export interface MALAnime {
  mal_id: number;
  title: string;
  title_english: string | null;
  title_japanese: string | null;
  type: string; // TV, Movie, OVA, etc.
  episodes: number | null;
  status: string;
  score: number | null;
  scored_by: number | null;
  rank: number | null;
  popularity: number | null;
  members: number | null;
  synopsis: string | null;
  season: string | null;
  year: number | null;
  images: {
    jpg: { image_url: string; large_image_url: string };
    webp: { image_url: string; large_image_url: string };
  };
  aired: {
    from: string | null;
    to: string | null;
    string: string;
  };
  genres: Array<{ mal_id: number; name: string }>;
  studios: Array<{ mal_id: number; name: string }>;
}

export interface MALRelation {
  relation: string;
  entry: Array<{
    mal_id: number;
    type: string;
    name: string;
    url: string;
  }>;
}

export interface MALSearchResult {
  mal_id: number;
  title: string;
  title_english: string | null;
  type: string;
  episodes: number | null;
  score: number | null;
  images: {
    jpg: { image_url: string; large_image_url: string };
  };
}

export interface MALSeason {
  malId: number;
  title: string;
  titleEnglish: string | null;
  episodes: number | null;
  score: number | null;
  members: number | null;
  type: string;
  status: string;
  aired: string;
  synopsis: string | null;
  imageUrl: string;
  seasonOrder: number; // Order in the series (1, 2, 3...)
  year?: number; // Release year for sorting
}

export interface MALAnimeDetails {
  mainEntry: MALAnime;
  allSeasons: MALSeason[];
  totalEpisodes: number;
}

/**
 * Search for anime on MAL by title
 */
export async function searchMALAnime(query: string, limit: number = 10): Promise<MALSearchResult[]> {
  const results = await anilistSearch(query, limit);
  return results
    .map(anilistMediaToMALSearchResult)
    .filter((r): r is MALSearchResult => r !== null);
}

/**
 * Get anime details by MAL ID
 */
export async function getMALAnimeById(malId: number): Promise<MALAnime | null> {
  const media = await anilistGetAnime(malId);
  if (!media) return null;
  return anilistMediaToMALAnime(media);
}

/**
 * AniList relation type → Jikan relation name
 * Jikan uses: Sequel, Prequel, Side story, Summary, Parent story, Alternative version,
 * Spin-off, Character, Other, Adaptation, Alternative setting, Full story
 */
const RELATION_MAP: Record<string, string> = {
  SEQUEL: 'Sequel',
  PREQUEL: 'Prequel',
  SIDE_STORY: 'Side story',
  SUMMARY: 'Summary',
  PARENT: 'Parent story',
  ALTERNATIVE: 'Alternative version',
  SPIN_OFF: 'Spin-off',
  CHARACTER: 'Character',
  OTHER: 'Other',
  ADAPTATION: 'Adaptation',
  SOURCE: 'Adaptation',
  COMPILATION: 'Summary',
  CONTAINS: 'Side story',
};

/**
 * Get anime relations (sequels, prequels, etc.)
 *
 * Data sourced from AniList's relations.edges and remapped to the Jikan shape
 * used by collectSequelChain. Only ANIME entries with a MAL ID are included
 * (manga adaptations and AniList-only entries are filtered out).
 */
export async function getMALAnimeRelations(malId: number): Promise<MALRelation[]> {
  const media = await anilistGetAnime(malId);
  if (!media?.relations?.edges) return [];

  // Group edges by relation type (Jikan returns one entry per relation type)
  const groups = new Map<string, MALRelation['entry']>();
  for (const edge of media.relations.edges) {
    if (edge.node.type !== 'ANIME' || !edge.node.idMal) continue;
    const relationName = RELATION_MAP[edge.relationType] ?? 'Other';
    const existing = groups.get(relationName) ?? [];
    existing.push({
      mal_id: edge.node.idMal,
      type: 'anime',
      name: edge.node.title.romaji || edge.node.title.english || 'Unknown',
      url: `https://myanimelist.net/anime/${edge.node.idMal}`,
    });
    groups.set(relationName, existing);
  }

  return Array.from(groups.entries()).map(([relation, entry]) => ({ relation, entry }));
}

// Known title mappings from TMDB to MAL search terms
const TITLE_MAPPINGS: Record<string, string> = {
  'thousand-year blood war': 'Sennen Kessen',
  'attack on titan': 'Shingeki no Kyojin',
  'demon slayer': 'Kimetsu no Yaiba',
  'my hero academia': 'Boku no Hero Academia',
  'jujutsu kaisen': 'Jujutsu Kaisen',
  'spy x family': 'Spy x Family',
  'chainsaw man': 'Chainsaw Man',
  'one punch man': 'One Punch Man',
};

// TMDB Season to MAL Entry mapping
// Key: TMDB ID, Value: { tmdbSeason: { malId, episodes, title } }
// This maps each TMDB season to its corresponding MAL entry
// 
// WHY THIS EXISTS:
// TMDB and MAL have different season structures. TMDB groups content by "seasons"
// while MAL treats each season as a separate anime entry with its own ID.
// For example, JJK Season 2 on TMDB is a completely different MAL entry (51009)
// than JJK Season 1 (40748). Without this mapping, searching for "Jujutsu Kaisen"
// episode 24 would return S1E24, not S2E1.
//
// SPECIAL CASE: Some anime on TMDB use ABSOLUTE episode numbering (single season)
// e.g., JJK on TMDB is Season 1 with 59 episodes, not 3 seasons
// For these, we use tmdbSeason=1 and calculate the MAL entry based on episode number
const TMDB_TO_MAL_SEASON_MAPPING: Record<number, Record<number, { malId: number; episodes: number; title: string }>> = {
  // Jujutsu Kaisen (TMDB ID: 95479)
  // TMDB has this as SINGLE SEASON with 71 episodes (absolute numbering)
  // MAL has: S1=40748 (24 eps), S2=51009 (23 eps), S3=57658 (12 eps for Part 1, more coming)
  // We map TMDB season 1 to the first MAL entry, but the extractor will
  // calculate the correct MAL entry based on absolute episode number
  95479: {
    1: { malId: 40748, episodes: 24, title: 'Jujutsu Kaisen' },
    2: { malId: 51009, episodes: 23, title: 'Jujutsu Kaisen 2nd Season' },
    3: { malId: 57658, episodes: 12, title: 'Jujutsu Kaisen: The Culling Game - Part 1' },
  },
  // Solo Leveling (TMDB ID: 203624)
  // TMDB S1 = MAL 52299 (12 eps), S2 = MAL 58567 (13 eps)
  203624: {
    1: { malId: 52299, episodes: 12, title: 'Solo Leveling' },
    2: { malId: 58567, episodes: 13, title: 'Solo Leveling Season 2: Arise from the Shadow' },
  },
  // Demon Slayer (TMDB ID: 85937)
  85937: {
    1: { malId: 38000, episodes: 26, title: 'Kimetsu no Yaiba' },
    2: { malId: 47778, episodes: 18, title: 'Kimetsu no Yaiba: Yuukaku-hen' },
    3: { malId: 51019, episodes: 11, title: 'Kimetsu no Yaiba: Katanakaji no Sato-hen' },
    4: { malId: 55701, episodes: 11, title: 'Kimetsu no Yaiba: Hashira Geiko-hen' },
  },
  // My Hero Academia (TMDB ID: 65930)
  65930: {
    1: { malId: 31964, episodes: 13, title: 'Boku no Hero Academia' },
    2: { malId: 33486, episodes: 25, title: 'Boku no Hero Academia 2nd Season' },
    3: { malId: 36456, episodes: 25, title: 'Boku no Hero Academia 3rd Season' },
    4: { malId: 38408, episodes: 25, title: 'Boku no Hero Academia 4th Season' },
    5: { malId: 41587, episodes: 25, title: 'Boku no Hero Academia 5th Season' },
    6: { malId: 49918, episodes: 25, title: 'Boku no Hero Academia 6th Season' },
    7: { malId: 54789, episodes: 21, title: 'Boku no Hero Academia 7th Season' },
  },
  // Attack on Titan (TMDB ID: 1429)
  1429: {
    1: { malId: 16498, episodes: 25, title: 'Shingeki no Kyojin' },
    2: { malId: 25777, episodes: 12, title: 'Shingeki no Kyojin Season 2' },
    3: { malId: 35760, episodes: 22, title: 'Shingeki no Kyojin Season 3' },
    4: { malId: 40028, episodes: 28, title: 'Shingeki no Kyojin: The Final Season' },
  },
  // Spy x Family (TMDB ID: 135157)
  135157: {
    1: { malId: 50265, episodes: 25, title: 'Spy x Family' },
    2: { malId: 53887, episodes: 12, title: 'Spy x Family Season 2' },
  },
};

// Anime that use ABSOLUTE episode numbering on TMDB (single season with all episodes)
// For these, we need to calculate which MAL entry an episode belongs to
const TMDB_ABSOLUTE_EPISODE_ANIME: Record<number, Array<{ malId: number; episodes: number; title: string }>> = {
  // JJK: TMDB shows as 1 season with 71 episodes (as of Jan 2026)
  // Episodes 1-24 = MAL 40748, 25-47 = MAL 51009, 48-59 = MAL 57658 (Part 1 - 12 eps)
  // Note: Season 3 Part 2 will add more episodes later
  95479: [
    { malId: 40748, episodes: 24, title: 'Jujutsu Kaisen' },
    { malId: 51009, episodes: 23, title: 'Jujutsu Kaisen 2nd Season' },
    { malId: 57658, episodes: 12, title: 'Jujutsu Kaisen: The Culling Game - Part 1' },
  ],
};

// Special cases where TMDB ID maps to multiple MAL entries (all seasons)
// Key: TMDB ID, Value: Array of all MAL entries for this anime
// This is used for displaying total episode count across all seasons
const TMDB_TO_MAL_ALL_SEASONS: Record<number, Array<{ malId: number; episodes: number; title: string }>> = {
  95479: [ // Jujutsu Kaisen
    { malId: 40748, episodes: 24, title: 'Jujutsu Kaisen' },
    { malId: 51009, episodes: 23, title: 'Jujutsu Kaisen 2nd Season' },
    { malId: 57658, episodes: 12, title: 'Jujutsu Kaisen: The Culling Game - Part 1' },
  ],
  203624: [ // Solo Leveling
    { malId: 52299, episodes: 12, title: 'Solo Leveling' },
    { malId: 58567, episodes: 13, title: 'Solo Leveling Season 2: Arise from the Shadow' },
  ],
  85937: [ // Demon Slayer
    { malId: 38000, episodes: 26, title: 'Kimetsu no Yaiba' },
    { malId: 47778, episodes: 18, title: 'Kimetsu no Yaiba: Yuukaku-hen' },
    { malId: 51019, episodes: 11, title: 'Kimetsu no Yaiba: Katanakaji no Sato-hen' },
    { malId: 55701, episodes: 11, title: 'Kimetsu no Yaiba: Hashira Geiko-hen' },
  ],
  65930: [ // My Hero Academia
    { malId: 31964, episodes: 13, title: 'Boku no Hero Academia' },
    { malId: 33486, episodes: 25, title: 'Boku no Hero Academia 2nd Season' },
    { malId: 36456, episodes: 25, title: 'Boku no Hero Academia 3rd Season' },
    { malId: 38408, episodes: 25, title: 'Boku no Hero Academia 4th Season' },
    { malId: 41587, episodes: 25, title: 'Boku no Hero Academia 5th Season' },
    { malId: 49918, episodes: 25, title: 'Boku no Hero Academia 6th Season' },
    { malId: 54789, episodes: 21, title: 'Boku no Hero Academia 7th Season' },
  ],
  1429: [ // Attack on Titan
    { malId: 16498, episodes: 25, title: 'Shingeki no Kyojin' },
    { malId: 25777, episodes: 12, title: 'Shingeki no Kyojin Season 2' },
    { malId: 35760, episodes: 22, title: 'Shingeki no Kyojin Season 3' },
    { malId: 40028, episodes: 28, title: 'Shingeki no Kyojin: The Final Season' },
  ],
  135157: [ // Spy x Family
    { malId: 50265, episodes: 25, title: 'Spy x Family' },
    { malId: 53887, episodes: 12, title: 'Spy x Family Season 2' },
  ],
};

/**
 * Get all MAL seasons for a TMDB anime
 * Returns all MAL entries that correspond to this anime series
 */
export async function getAllMALSeasonsForTMDB(
  tmdbId: number,
  tmdbTitle: string
): Promise<MALAnimeDetails | null> {
  // Check if this TMDB ID has a complete season mapping
  const allSeasons = TMDB_TO_MAL_ALL_SEASONS[tmdbId];
  
  if (allSeasons && allSeasons.length > 0) {
    console.log(`[MAL] Using complete season mapping for TMDB ID ${tmdbId}: ${allSeasons.length} MAL entries`);
    
    try {
      // Fetch details for all MAL entries
      const fetchedSeasons: MALSeason[] = [];
      
      for (let i = 0; i < allSeasons.length; i++) {
        const entry = allSeasons[i];
        const anime = await getMALAnimeById(entry.malId);
        
        if (anime) {
          fetchedSeasons.push({
            malId: anime.mal_id,
            title: anime.title,
            titleEnglish: anime.title_english,
            episodes: anime.episodes || entry.episodes,
            score: anime.score,
            members: anime.members,
            type: anime.type,
            status: anime.status,
            aired: anime.aired.string,
            synopsis: anime.synopsis,
            imageUrl: anime.images.jpg.large_image_url || anime.images.jpg.image_url,
            seasonOrder: i + 1,
          });
          console.log(`[MAL] Fetched: ${anime.title} (${anime.episodes || entry.episodes} eps)`);
        }
      }
      
      if (fetchedSeasons.length === 0) {
        return null;
      }
      
      const totalEpisodes = fetchedSeasons.reduce((sum, s) => sum + (s.episodes || 0), 0);
      
      return {
        mainEntry: await getMALAnimeById(allSeasons[0].malId) as MALAnime,
        allSeasons: fetchedSeasons,
        totalEpisodes,
      };
    } catch (error) {
      console.error('[MAL] Error fetching all seasons:', error);
    }
  }
  
  // Fall back to normal MAL search
  return getMALDataForTMDBAnime(tmdbTitle);
}

/**
 * Find the best MAL match for a TMDB anime
 */
export async function findMALMatch(
  tmdbTitle: string,
  _tmdbYear?: number, // Reserved for future year-based filtering
  tmdbType?: 'movie' | 'tv'
): Promise<MALAnime | null> {
  console.log(`[MAL] Finding match for: "${tmdbTitle}"`);
  
  // Clean up title for search - but keep important keywords like "Thousand-Year Blood War"
  let cleanTitle = tmdbTitle
    .replace(/\s*\(.*?\)\s*/g, '') // Remove parenthetical info
    .replace(/\s*-\s*Season\s*\d+/gi, '') // Remove "- Season X"
    .replace(/\s*Season\s*\d+/gi, '') // Remove "Season X"
    .trim();
  
  // Check for known title mappings
  const titleLower = cleanTitle.toLowerCase();
  for (const [englishTerm, japaneseTerm] of Object.entries(TITLE_MAPPINGS)) {
    if (titleLower.includes(englishTerm)) {
      // Replace the English term with Japanese term for better MAL search
      const baseName = cleanTitle.split(':')[0].trim(); // Get "Bleach" from "Bleach: Thousand-Year Blood War"
      cleanTitle = `${baseName} ${japaneseTerm}`;
      console.log(`[MAL] Applied title mapping: "${englishTerm}" -> "${japaneseTerm}"`);
      break;
    }
  }
  
  console.log(`[MAL] Search query: "${cleanTitle}"`);
  
  const results = await searchMALAnime(cleanTitle, 25);
  console.log(`[MAL] Search returned ${results.length} results`);
  
  if (results.length === 0) {
    // Try with original title
    const originalResults = await searchMALAnime(tmdbTitle, 10);
    if (originalResults.length === 0) return null;
    
    // Return best match by members
    const anime = await getMALAnimeById(originalResults[0].mal_id);
    return anime;
  }
  
  // Score each result
  const scoredResults = results.map(result => {
    let score = 0;
    
    // Title match
    const titleLower = cleanTitle.toLowerCase();
    const resultTitleLower = result.title.toLowerCase();
    const resultEnglishLower = result.title_english?.toLowerCase() || '';
    
    // Exact match
    if (resultTitleLower === titleLower || resultEnglishLower === titleLower) {
      score += 100;
    } 
    // Check if search title contains result title or vice versa
    else if (resultTitleLower.includes(titleLower) || resultEnglishLower.includes(titleLower)) {
      score += 50;
    } else if (titleLower.includes(resultTitleLower) || (resultEnglishLower && titleLower.includes(resultEnglishLower))) {
      score += 30;
    }
    
    // Special handling for specific keywords that should match
    // e.g., "Thousand-Year Blood War" should strongly prefer entries with that phrase
    const keywords = ['thousand-year', 'blood war', 'sennen kessen', 'tybw'];
    for (const keyword of keywords) {
      if (titleLower.includes(keyword)) {
        if (resultTitleLower.includes(keyword) || resultEnglishLower.includes(keyword)) {
          score += 50; // Strong bonus for matching important keywords
        } else {
          score -= 30; // Penalty for NOT having the keyword when we're searching for it
        }
      }
    }
    
    // Type match
    if (tmdbType === 'movie' && result.type === 'Movie') {
      score += 20;
    } else if (tmdbType === 'tv' && result.type === 'TV') {
      score += 20;
    }
    
    // Popularity bonus (more members = more likely correct)
    score += Math.min(result.score || 0, 10);
    
    return { result, score };
  });
  
  // Sort by score and get best match
  scoredResults.sort((a, b) => b.score - a.score);
  
  // Log top 5 results for debugging
  console.log('[MAL] Top 5 scored results:', scoredResults.slice(0, 5).map(r => ({
    title: r.result.title,
    english: r.result.title_english,
    score: r.score,
    malId: r.result.mal_id
  })));
  
  if (scoredResults.length > 0 && scoredResults[0].score > 20) {
    const anime = await getMALAnimeById(scoredResults[0].result.mal_id);
    console.log(`[MAL] Best match: ${anime?.title} (${anime?.mal_id})`);
    return anime;
  }
  
  return null;
}

/**
 * Recursively collect all related anime IDs following sequel/prequel chains
 * e.g., Part 1 ↔ Part 2 ↔ Part 3
 * 
 * Follows BOTH Sequel AND Prequel relations to ensure complete series discovery
 * regardless of which entry point is used (start, middle, or end of series).
 * 
 * Note: This may collect unwanted entries (e.g., original Bleach when searching TYBW).
 * Filtering is applied in getMALSeriesSeasons() based on title keywords.
 * 
 * @param startId - MAL ID to start the chain from
 * @param collected - Set to track already collected IDs (prevents infinite loops)
 * @param maxDepth - Maximum recursion depth to prevent runaway queries
 */
async function collectSequelChain(
  startId: number,
  collected: Set<number>,
  maxDepth: number = 10
): Promise<void> {
  if (maxDepth <= 0 || collected.has(startId)) return;
  
  collected.add(startId);
  
  try {
    const relations = await getMALAnimeRelations(startId);
    
    for (const relation of relations) {
      // Follow BOTH Sequel AND Prequel to ensure complete series discovery
      // regardless of which entry point is used (start, middle, or end of series).
      // Title-keyword filtering in getMALSeriesSeasons() prevents unrelated entries.
      if (relation.relation === 'Sequel' || relation.relation === 'Prequel') {
        for (const entry of relation.entry) {
          if (entry.type === 'anime' && !collected.has(entry.mal_id)) {
            console.log(`[MAL] Following ${relation.relation}: ${entry.name} (${entry.mal_id})`);
            await collectSequelChain(entry.mal_id, collected, maxDepth - 1);
          }
        }
      }
    }
  } catch (error) {
    console.error(`[MAL] Error collecting sequel chain for ${startId}:`, error);
  }
}

/**
 * Get all seasons/entries for an anime series
 * This handles cases like Bleach TYBW where MAL has multiple entries
 * Recursively follows sequel/prequel chains to find all parts
 */
export async function getMALSeriesSeasons(malId: number): Promise<MALAnimeDetails | null> {
  try {
    // Get the main anime entry
    const mainAnime = await getMALAnimeById(malId);
    if (!mainAnime) return null;
    
    console.log(`[MAL] Getting series seasons for: ${mainAnime.title} (${malId})`);
    
    // Check if this is a specific arc/season that should be isolated (e.g., TYBW)
    const mainTitleLower = mainAnime.title.toLowerCase();
    const isTYBW = mainTitleLower.includes('sennen kessen') || mainTitleLower.includes('thousand-year');
    const titleKeywords = isTYBW ? ['sennen kessen', 'thousand-year'] : null;
    
    // Recursively collect all related anime IDs following sequel/prequel chains
    const relatedIds = new Set<number>();
    await collectSequelChain(malId, relatedIds);
    
    console.log(`[MAL] Found ${relatedIds.size} related entries:`, Array.from(relatedIds));
    
    // Fetch details for all related anime SEQUENTIALLY to respect rate limits
    // Using Promise.all would bypass rate limiting and cause requests to fail
    const allAnime: MALAnime[] = [];
    for (const id of relatedIds) {
      const anime = await getMALAnimeById(id);
      if (anime) {
        // Early filtering: Skip entries that don't match title keywords (if specified)
        if (titleKeywords) {
          const animeTitleLower = anime.title.toLowerCase();
          const matchesKeywords = titleKeywords.some(keyword => animeTitleLower.includes(keyword));
          if (!matchesKeywords) {
            console.log(`[MAL] Skipping non-matching entry: ${anime.title} (${anime.mal_id})`);
            continue;
          }
        }
        
        allAnime.push(anime);
        console.log(`[MAL] Fetched: ${anime.title} (${anime.episodes} eps)`);
      } else {
        console.log(`[MAL] Failed to fetch MAL ID: ${id}`);
      }
    }
    
    console.log(`[MAL] Fetched ${allAnime.length} anime details out of ${relatedIds.size}`);
    
    // Filter to only TV series and ONA, sort by air date
    const tvSeries = allAnime
      .filter(a => a.type === 'TV' || a.type === 'ONA')
      .sort((a, b) => {
        const dateA = a.aired.from ? new Date(a.aired.from).getTime() : 0;
        const dateB = b.aired.from ? new Date(b.aired.from).getTime() : 0;
        return dateA - dateB;
      });
    
    console.log(`[MAL] Filtered to ${tvSeries.length} TV/ONA series:`, tvSeries.map(a => ({
      title: a.title,
      episodes: a.episodes,
      aired: a.aired.from
    })));
    
    // For ongoing anime (episodes === null), we still want to show them
    // Only filter out entries that are truly empty (0 episodes and not airing)
    const filteredSeries = tvSeries.filter(a => {
      // Keep entries with episodes defined
      if (a.episodes !== null && a.episodes > 0) return true;
      // Keep ongoing/airing anime even if episodes is null
      if (a.status === 'Currently Airing' || a.status === 'Not yet aired') return true;
      // Filter out completed anime with no episodes (likely bad data)
      return false;
    });
    
    if (isTYBW && filteredSeries.length !== tvSeries.length) {
      console.log(`[MAL] Filtered to TYBW entries only: ${filteredSeries.length}`);
    }
    
    console.log(`[MAL] After filtering: ${filteredSeries.length} entries (kept ongoing anime with null episodes)`);
    
    // Convert to MALSeason format
    const seasons: MALSeason[] = filteredSeries.map((anime, index) => ({
      malId: anime.mal_id,
      title: anime.title,
      titleEnglish: anime.title_english,
      episodes: anime.episodes,
      score: anime.score,
      members: anime.members,
      type: anime.type,
      status: anime.status,
      aired: anime.aired.string,
      synopsis: anime.synopsis,
      imageUrl: anime.images.jpg.large_image_url || anime.images.jpg.image_url,
      seasonOrder: index + 1,
    }));
    
    // Calculate total episodes
    const totalEpisodes = seasons.reduce((sum, s) => sum + (s.episodes || 0), 0);
    
    console.log(`[MAL] Final result: ${seasons.length} seasons, ${totalEpisodes} total episodes`);
    
    return {
      mainEntry: mainAnime,
      allSeasons: seasons,
      totalEpisodes,
    };
  } catch (error) {
    console.error('[MAL] Get series seasons error:', error);
    return null;
  }
}

/**
 * Get MAL data for TMDB anime with special season mapping
 * Handles cases like Jujutsu Kaisen where each TMDB season maps to a specific MAL entry
 * 
 * @param tmdbId - TMDB ID of the anime
 * @param tmdbTitle - Title for fallback search
 * @param tmdbSeason - TMDB season number (optional, defaults to 1)
 */
export async function getMALDataForTMDBAnimeWithSeasonMapping(
  tmdbId: number,
  tmdbTitle: string,
  tmdbSeason: number = 1
): Promise<MALAnimeDetails | null> {
  // Check if this TMDB ID has special season mapping
  const seasonMapping = TMDB_TO_MAL_SEASON_MAPPING[tmdbId];
  if (!seasonMapping) {
    // Fall back to normal MAL search
    return getMALDataForTMDBAnime(tmdbTitle);
  }

  // Get the MAL entry for this specific TMDB season
  const malEntry = seasonMapping[tmdbSeason];
  if (!malEntry) {
    console.log(`[MAL] No mapping for TMDB ID ${tmdbId} season ${tmdbSeason}, falling back to search`);
    return getMALDataForTMDBAnime(tmdbTitle);
  }

  console.log(`[MAL] Using season mapping for TMDB ID ${tmdbId} S${tmdbSeason}: MAL ID ${malEntry.malId} (${malEntry.title})`);

  try {
    const anime = await getMALAnimeById(malEntry.malId);
    if (!anime) {
      console.log(`[MAL] Failed to fetch MAL ID: ${malEntry.malId}`);
      return null;
    }

    console.log(`[MAL] Fetched: ${anime.title} (${anime.episodes} eps, MAL ID: ${anime.mal_id})`);

    // Use episode count from our mapping if MAL returns null (for ongoing series)
    const episodeCount = anime.episodes || malEntry.episodes;

    // Return as a single-season result (no splitting needed)
    const season: MALSeason = {
      malId: anime.mal_id,
      title: anime.title,
      titleEnglish: anime.title_english,
      episodes: episodeCount,
      score: anime.score,
      members: anime.members,
      type: anime.type,
      status: anime.status,
      aired: anime.aired.string,
      synopsis: anime.synopsis,
      imageUrl: anime.images.jpg.large_image_url || anime.images.jpg.image_url,
      seasonOrder: 1,
    };

    console.log(`[MAL] Season mapping result: 1 season, ${episodeCount} episodes`);

    return {
      mainEntry: anime,
      allSeasons: [season], // Single season - no splitting needed
      totalEpisodes: episodeCount,
    };
  } catch (error) {
    console.error('[MAL] Error in season mapping:', error);
    return null;
  }
}

/**
 * Search and get full series info for a TMDB anime
 */
export async function getMALDataForTMDBAnime(
  tmdbTitle: string,
  tmdbYear?: number,
  tmdbType?: 'movie' | 'tv'
): Promise<MALAnimeDetails | null> {
  // Find the MAL match
  const match = await findMALMatch(tmdbTitle, tmdbYear, tmdbType);
  if (!match) return null;
  
  // Get all seasons for the series
  return getMALSeriesSeasons(match.mal_id);
}

/**
 * For anime with absolute episode numbering on TMDB, calculate which MAL entry
 * an episode belongs to and return the relative episode number within that entry.
 * 
 * Example: JJK episode 48 on TMDB → MAL entry 57658 (3rd Season), episode 1
 * 
 * @param tmdbId - TMDB ID of the anime
 * @param absoluteEpisode - Absolute episode number from TMDB
 * @returns { malId, malTitle, relativeEpisode } or null if not a special case
 */
export function getMALEntryForAbsoluteEpisode(
  tmdbId: number,
  absoluteEpisode: number
): { malId: number; malTitle: string; relativeEpisode: number } | null {
  const entries = TMDB_ABSOLUTE_EPISODE_ANIME[tmdbId];
  if (!entries || entries.length === 0) {
    return null;
  }
  
  let episodeOffset = 0;
  for (const entry of entries) {
    if (absoluteEpisode <= episodeOffset + entry.episodes) {
      const relativeEpisode = absoluteEpisode - episodeOffset;
      console.log(`[MAL] Absolute episode ${absoluteEpisode} → ${entry.title} episode ${relativeEpisode}`);
      return {
        malId: entry.malId,
        malTitle: entry.title,
        relativeEpisode,
      };
    }
    episodeOffset += entry.episodes;
  }
  
  // Episode is beyond known entries - use the last entry
  const lastEntry = entries[entries.length - 1];
  const relativeEpisode = absoluteEpisode - episodeOffset + lastEntry.episodes;
  console.log(`[MAL] Absolute episode ${absoluteEpisode} beyond known entries, using ${lastEntry.title} episode ${relativeEpisode}`);
  return {
    malId: lastEntry.malId,
    malTitle: lastEntry.title,
    relativeEpisode,
  };
}

/**
 * Check if a TMDB anime uses absolute episode numbering
 */
export function usesAbsoluteEpisodeNumbering(tmdbId: number): boolean {
  return tmdbId in TMDB_ABSOLUTE_EPISODE_ANIME;
}

/**
 * Get all MAL entries for an anime that uses absolute episode numbering
 */
export function getAbsoluteEpisodeEntries(tmdbId: number): Array<{ malId: number; episodes: number; title: string }> | null {
  return TMDB_ABSOLUTE_EPISODE_ANIME[tmdbId] || null;
}

/**
 * Episode data from Jikan API
 */
export interface MALEpisode {
  mal_id: number;
  title: string;
  title_japanese: string | null;
  title_romanji: string | null;
  aired: string | null;
  score: number | null;
  filler: boolean;
  recap: boolean;
}

/**
 * Get episodes for an anime.
 *
 * Primary source is MAL's public episode page (scraped), which gives us real
 * titles, air dates, filler/recap flags, and episode scores — everything
 * Jikan used to provide. If the scrape fails (network issue, rate limit,
 * MAL down), we fall back to synthetic "Episode N" stubs generated from
 * the AniList episode count so the UI still renders.
 *
 * Paginated 100 per page to match the old Jikan contract.
 */
export async function getMALAnimeEpisodes(malId: number, page: number = 1): Promise<{ episodes: MALEpisode[]; hasNextPage: boolean; lastPage: number }> {
  const anime = await getMALAnimeById(malId);
  const total = anime?.episodes ?? undefined;

  const scraped = await scrapeMALEpisodePage(malId, page, total);
  if (scraped && scraped.episodes.length > 0) {
    return scraped;
  }

  // Fallback: synthetic stubs from AniList episode count
  if (!anime) return { episodes: [], hasNextPage: false, lastPage: 1 };
  const totalEps = anime.episodes ?? 0;
  const perPage = 100;
  const lastPage = Math.max(1, Math.ceil(totalEps / perPage));
  const pageEpisodes = syntheticEpisodesForAnime(totalEps).slice((page - 1) * perPage, page * perPage);
  return {
    episodes: pageEpisodes,
    hasNextPage: page < lastPage,
    lastPage,
  };
}

/**
 * Get all episodes for an anime. Tries MAL scrape first, falls back to
 * synthetic stubs.
 */
export async function getAllMALAnimeEpisodes(malId: number): Promise<MALEpisode[]> {
  const anime = await getMALAnimeById(malId);
  const total = anime?.episodes ?? undefined;

  const scraped = await scrapeMALEpisodes(malId, total);
  if (scraped && scraped.length > 0) return scraped;

  return syntheticEpisodesForAnime(anime?.episodes ?? 0);
}

export const malService = {
  search: searchMALAnime,
  getById: getMALAnimeById,
  getRelations: getMALAnimeRelations,
  findMatch: findMALMatch,
  getSeriesSeasons: getMALSeriesSeasons,
  getDataForTMDB: getMALDataForTMDBAnime,
  getDataForTMDBWithSeasonMapping: getMALDataForTMDBAnimeWithSeasonMapping,
  getAllMALSeasonsForTMDB,
  getMALEntryForAbsoluteEpisode,
  usesAbsoluteEpisodeNumbering,
  getAbsoluteEpisodeEntries,
  getEpisodes: getMALAnimeEpisodes,
  getAllEpisodes: getAllMALAnimeEpisodes,
};
