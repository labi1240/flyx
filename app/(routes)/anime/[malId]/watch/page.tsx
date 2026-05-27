import { Suspense } from 'react';
import { Metadata } from 'next';
import { malService } from '@/lib/services/mal';
import AnimeWatchClient from './AnimeWatchClient';

interface Props {
  params: Promise<{ malId: string }>;
  searchParams: Promise<{ episode?: string }>;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { malId: malIdStr } = await params;
  const { episode } = await searchParams;
  const malId = parseInt(malIdStr);

  if (isNaN(malId)) return { title: 'Watch | Flyx' };

  try {
    const anime = await malService.getById(malId);
    if (anime) {
      const title = anime.title_english || anime.title;
      const epLabel = episode ? `E${episode} - ` : '';
      return {
        title: `${epLabel}${title} | Flyx`,
        description: anime.synopsis || `Watch ${title} on Flyx`,
        openGraph: {
          title: `${epLabel}${title}`,
          description: anime.synopsis || undefined,
          images: anime.images?.jpg?.large_image_url ? [anime.images.jpg.large_image_url] : undefined,
          type: 'video.episode',
          siteName: 'Flyx',
        },
        twitter: {
          card: 'summary_large_image',
          title: `${epLabel}${title}`,
          description: anime.synopsis || undefined,
          images: anime.images?.jpg?.large_image_url ? [anime.images.jpg.large_image_url] : undefined,
        },
      };
    }
  } catch {}

  return { title: `Anime Watch | Flyx` };
}

export default function AnimeWatchPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><p className="text-white">Loading...</p></div>}>
      <AnimeWatchClient />
    </Suspense>
  );
}
