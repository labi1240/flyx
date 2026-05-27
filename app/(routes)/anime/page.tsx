import { Metadata } from 'next';
import AnimePageClient from './AnimePageClient';

export const metadata: Metadata = {
  title: 'Anime | Flyx',
  description: 'Stream anime on Flyx',
};

export const dynamic = 'force-dynamic';

export default function AnimePage() {
  return <AnimePageClient />;
}
