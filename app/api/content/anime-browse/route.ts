/**
 * Anime Browse API — client-side fallback for /anime page
 *
 * Fetches all 7 anime categories from AniList and returns them as JSON.
 * When CF edge IPs get blocked by AniList, the AnimePageClient falls back
 * to calling AniList directly from the user's browser.
 */

import { NextRequest, NextResponse } from 'next/server';
import { malListingsService, MAL_GENRES } from '@/lib/services/mal-listings';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest) {
  try {
    const [airing, popular, topRated, action, fantasy, romance, movies] = await Promise.all([
      malListingsService.getAiringAnime(1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
      malListingsService.getPopularAnime(1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
      malListingsService.getTopRatedAnime(1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
      malListingsService.getAnimeByGenre(MAL_GENRES.ACTION, 1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
      malListingsService.getAnimeByGenre(MAL_GENRES.FANTASY, 1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
      malListingsService.getAnimeByGenre(MAL_GENRES.ROMANCE, 1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
      malListingsService.getAnimeMovies(1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
    ]);

    const hasAnyData = airing.items.length > 0 || popular.items.length > 0 ||
                       topRated.items.length > 0 || movies.items.length > 0;

    if (!hasAnyData) {
      return NextResponse.json({ success: false, error: 'AniList unreachable from edge' });
    }

    return NextResponse.json({
      success: true,
      data: {
        airing: { items: airing.items, total: airing.pagination.items.total },
        popular: { items: popular.items, total: popular.pagination.items.total },
        topRated: { items: topRated.items, total: topRated.pagination.items.total },
        action: { items: action.items, total: action.pagination.items.total },
        fantasy: { items: fantasy.items, total: fantasy.pagination.items.total },
        romance: { items: romance.items, total: romance.pagination.items.total },
        movies: { items: movies.items, total: movies.pagination.items.total },
      },
    });
  } catch (error) {
    console.error('[anime-browse] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch anime data' }, { status: 500 });
  }
}
