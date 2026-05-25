import { NextRequest, NextResponse } from 'next/server';
import { getMALAnimeEpisodes } from '@/lib/services/mal';

/**
 * GET /api/content/mal-episodes?malId=X&page=Y
 *
 * Returns a paginated episode list for an anime. Previously hit Jikan
 * directly; now uses the AniList-backed malService which synthesises
 * episode stubs from the anime's total episode count (AniList doesn't
 * expose per-episode titles/filler flags).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const malId = searchParams.get('malId');
  const page = searchParams.get('page') || '1';

  if (!malId) {
    return NextResponse.json({ success: false, error: 'Missing malId parameter' }, { status: 400 });
  }

  const malIdNum = parseInt(malId);
  const pageNum = parseInt(page);

  if (isNaN(malIdNum)) {
    return NextResponse.json({ success: false, error: 'Invalid malId parameter' }, { status: 400 });
  }

  if (isNaN(pageNum) || pageNum < 1) {
    return NextResponse.json({ success: false, error: 'Invalid page parameter' }, { status: 400 });
  }

  const result = await getMALAnimeEpisodes(malIdNum, pageNum);

  if (!result.episodes.length && !result.hasNextPage && result.lastPage <= 1) {
    // No episodes found — anime doesn't exist or has zero episode count
    return new NextResponse(
      JSON.stringify({ success: false, error: 'No episodes found' }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      }
    );
  }

  return new NextResponse(
    JSON.stringify({
      success: true,
      data: {
        malId: malIdNum,
        page: pageNum,
        totalPages: result.lastPage,
        hasNextPage: result.hasNextPage,
        episodes: result.episodes.map(ep => ({
          number: ep.mal_id,
          title: ep.title,
          titleJapanese: ep.title_japanese,
          aired: ep.aired,
          score: ep.score,
          filler: ep.filler,
          recap: ep.recap,
        })),
      },
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
      },
    }
  );
}
