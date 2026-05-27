import { Metadata } from 'next';
import { malService } from '@/lib/services/mal';
import AnimeDetailsClient from './AnimeDetailsClient';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ malId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { malId: malIdStr } = await params;
  const malId = parseInt(malIdStr);
  if (isNaN(malId)) return { title: 'Anime | Flyx' };

  try {
    const anime = await malService.getById(malId);
    if (anime) {
      const title = anime.title_english || anime.title;
      return {
        title: `${title} | Flyx`,
        description: anime.synopsis || `Watch ${title} on Flyx`,
        openGraph: {
          title,
          description: anime.synopsis || undefined,
          images: anime.images?.jpg?.large_image_url ? [anime.images.jpg.large_image_url] : undefined,
        },
      };
    }
  } catch {}

  return { title: `Anime | Flyx` };
}

export default async function AnimeDetailsPage({ params }: Props) {
  const { malId: malIdStr } = await params;
  const malId = parseInt(malIdStr);
  if (isNaN(malId)) return <AnimeDetailsClient malId={0} />;

  try {
    const series = await malService.getSeriesSeasons(malId);
    if (series) {
      return <AnimeDetailsClient anime={series.mainEntry} allSeasons={series.allSeasons} />;
    }
    const anime = await malService.getById(malId);
    if (anime) {
      return <AnimeDetailsClient anime={anime} allSeasons={[]} />;
    }
  } catch {}

  return <AnimeDetailsClient malId={malId} />;
}
