import { Metadata } from 'next';
import AnimePageClient from './AnimePageClient';
import { malListingsService, MAL_GENRES, type MALAnimeListItem } from '@/lib/services/mal-listings';

export const metadata: Metadata = {
  title: 'Anime | FlyX',
  description: 'Browse and stream the best anime on FlyX - powered by MyAnimeList',
};

// Revalidate every hour
export const revalidate = 3600;

interface AnimeData {
  airing: { items: MALAnimeListItem[]; total: number };
  popular: { items: MALAnimeListItem[]; total: number };
  topRated: { items: MALAnimeListItem[]; total: number };
  action: { items: MALAnimeListItem[]; total: number };
  fantasy: { items: MALAnimeListItem[]; total: number };
  romance: { items: MALAnimeListItem[]; total: number };
  movies: { items: MALAnimeListItem[]; total: number };
}

async function getAnimeData(): Promise<AnimeData | null> {
  try {
    // Fetch all anime data from AniList in parallel for faster loading.
    // AniList allows 90 req/min — 7 parallel calls is well within limits.
    // Individual failures return empty results instead of crashing the whole page.
    const [airing, popular, topRated, action, fantasy, romance, movies] = await Promise.all([
      malListingsService.getAiringAnime(1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
      malListingsService.getPopularAnime(1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
      malListingsService.getTopRatedAnime(1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
      malListingsService.getAnimeByGenre(MAL_GENRES.ACTION, 1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
      malListingsService.getAnimeByGenre(MAL_GENRES.FANTASY, 1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
      malListingsService.getAnimeByGenre(MAL_GENRES.ROMANCE, 1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
      malListingsService.getAnimeMovies(1, 25).catch(() => ({ items: [], pagination: { items: { total: 0 } } })),
    ]);

    // Check if we got at least some data — don't fail the whole page if a few categories are empty
    const hasAnyData = airing.items.length > 0 || popular.items.length > 0 || 
                       topRated.items.length > 0 || movies.items.length > 0;
    
    if (!hasAnyData) {
      console.error('[AnimePage] All anime data fetches returned empty results');
      return null;
    }

    return {
      airing: { items: airing.items, total: airing.pagination.items.total },
      popular: { items: popular.items, total: popular.pagination.items.total },
      topRated: { items: topRated.items, total: topRated.pagination.items.total },
      action: { items: action.items, total: action.pagination.items.total },
      fantasy: { items: fantasy.items, total: fantasy.pagination.items.total },
      romance: { items: romance.items, total: romance.pagination.items.total },
      movies: { items: movies.items, total: movies.pagination.items.total },
    };
  } catch (error) {
    console.error('[AnimePage] Error fetching anime data:', error);
    return null;
  }
}

export default async function AnimePage() {
  const data = await getAnimeData();

  if (!data) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <p className="text-white">Failed to load anime. Please try again later.</p>
      </div>
    );
  }

  return <AnimePageClient {...data} />;
}
