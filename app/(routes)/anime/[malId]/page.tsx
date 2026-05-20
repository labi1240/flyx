import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { malService } from '@/lib/services/mal';
import AnimeDetailsClient from './AnimeDetailsClient';

// Must be dynamic — Cloudflare Pages doesn't support ISR.
// Pre-rendering at build time caches failures permanently.
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ malId: string }>; // Next.js 13+ async params
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { malId: malIdStr } = await params;
  const malId = parseInt(malIdStr);
  
  if (isNaN(malId) || malId <= 0) {
    return {
      title: 'Invalid Anime | Flyx',
      description: 'The requested anime ID is invalid.',
    };
  }
  
  const anime = await malService.getById(malId);
  
  if (!anime) {
    return {
      title: 'Anime Not Found | Flyx',
      description: 'The requested anime could not be found.',
    };
  }

  return {
    title: `${anime.title} | Flyx Anime`,
    description: anime.synopsis || `Watch ${anime.title} on Flyx`,
    openGraph: {
      title: anime.title,
      description: anime.synopsis || undefined,
      images: anime.images?.jpg?.large_image_url ? [anime.images.jpg.large_image_url] : undefined,
      type: 'video.tv_show',
      siteName: 'Flyx',
    },
    twitter: {
      card: 'summary_large_image',
      title: anime.title,
      description: anime.synopsis || undefined,
      images: anime.images?.jpg?.large_image_url ? [anime.images.jpg.large_image_url] : undefined,
    },
  };
}

export default async function AnimeDetailsPage({ params }: Props) {
  const { malId: malIdStr } = await params;
  const malId = parseInt(malIdStr);

  if (isNaN(malId) || malId <= 0) {
    console.warn(`[AnimeDetailsPage] Invalid MAL ID: ${malIdStr}`);
    notFound();
  }

  try {
    const seriesData = await malService.getSeriesSeasons(malId);

    if (seriesData) {
      return (
        <AnimeDetailsClient
          anime={seriesData.mainEntry}
          allSeasons={seriesData.allSeasons}
          totalEpisodes={seriesData.totalEpisodes}
        />
      );
    }

    console.warn(`[AnimeDetailsPage] No data from edge for MAL ID: ${malId}, falling back to client`);
  } catch (error) {
    console.error(`[AnimeDetailsPage] Error fetching MAL data for ${malId}:`, error);
  }

  // Server fetch failed — pass the malId to the client so it can fetch
  // from the browser (bypasses CF edge IP blocks)
  return <AnimeDetailsClient malId={malId} />;
}
