import { Metadata } from 'next';
import { malService } from '@/lib/services/mal';
import AnimeWatchClient from './AnimeWatchClient';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ malId: string }>;
  searchParams: Promise<{ episode?: string; autoplay?: string }>;
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
      return { title: `${epLabel}${title} | Flyx` };
    }
  } catch {}

  return { title: 'Watch | Flyx' };
}

export default async function WatchPage({ params, searchParams }: Props) {
  const { malId: malIdStr } = await params;
  const { episode: epStr } = await searchParams;
  const malId = parseInt(malIdStr);
  const episode = parseInt(epStr || '1');

  return <AnimeWatchClient malId={isNaN(malId) ? 0 : malId} episode={isNaN(episode) ? 1 : episode} />;
}
