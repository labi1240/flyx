/**
 * Provider Availability API
 * Returns which stream providers are enabled/available
 *
 * Provider Priority:
 * - Flixer: ONLY provider for movies/TV (WASM-based extraction)
 * - AnimeKai/HiAnime: Anime-only providers (auto-detected via MAL ID)
 *
 * All other movie/TV providers are disabled until new sources are added.
 */

import { NextResponse } from 'next/server';
import { ANIMEKAI_ENABLED } from '@/app/lib/services/animekai-extractor';
import { FLIXER_ENABLED } from '@/app/lib/services/flixer-extractor';
import { VIDSRC_ENABLED } from '@/app/lib/services/vidsrc-extractor';
import { PRIMESRC_ENABLED } from '@/app/lib/services/primesrc-extractor';
import { MULTI_EMBED_ENABLED } from '@/app/lib/services/multi-embed-extractor';

export async function GET() {
  return NextResponse.json({
    providers: {
      primesrc: {
        enabled: PRIMESRC_ENABLED,
        name: 'PrimeSrc',
        primary: false,
        description: 'Multi-server streaming via CF Worker (Turnstile-gated)',
      },
      flixer: {
        enabled: FLIXER_ENABLED,
        name: 'Flixer',
        primary: true,
        description: 'Primary streaming source (WASM-based extraction)',
      },
      uflix: {
        enabled: false,
        name: 'Uflix',
        primary: false,
        description: 'Disabled — pending new sources',
      },
      hexa: {
        enabled: false,
        name: 'Hexa',
        primary: false,
        description: 'Alias for Flixer — use Flixer instead',
      },
      vidsrc: {
        enabled: VIDSRC_ENABLED,
        name: 'VidSrc',
        primary: false,
        description: '2embed.stream API — direct m3u8 extraction',
      },
      'multi-embed': {
        enabled: MULTI_EMBED_ENABLED,
        name: 'MultiEmbed',
        primary: false,
        description: 'Hexawatch aggregator — multiple embed providers',
      },
      '1movies': {
        enabled: false,
        name: '1movies',
        primary: false,
        description: 'Disabled — pending new sources',
      },
      animekai: {
        enabled: ANIMEKAI_ENABLED,
        name: 'AnimeKai',
        primary: false,
        animeOnly: true,
        description: 'Specialized anime streaming with Japanese audio',
      },
    },
  });
}
