/**
 * Provider Availability API
 * Returns which stream providers are enabled/available
 *
 * Provider Priority:
 * - Flixer: ONLY provider for movies/TV (WASM-based extraction)
 * - HiAnime: Primary anime provider (MegaCloud extraction via CF Worker)
 * - AnimeKai: Secondary anime provider (native crypto extraction)
 *
 * All other movie/TV providers are disabled until new sources are added.
 */

import { NextResponse } from 'next/server';
import { ANIMEKAI_ENABLED } from '@/app/lib/services/animekai-extractor';
import { FLIXER_ENABLED } from '@/app/lib/services/flixer-extractor';

export async function GET() {
  return NextResponse.json({
    providers: {
      primesrc: {
        enabled: false,
        name: 'PrimeSrc',
        primary: false,
        description: 'Disabled — pending new sources',
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
        description: 'Disabled — pending new sources',
      },
      vidsrc: {
        enabled: false,
        name: 'VidSrc',
        primary: false,
        description: 'Disabled — pending new sources',
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
      hianime: {
        enabled: true,
        name: 'HiAnime',
        primary: false,
        animeOnly: true,
        description: 'Primary anime provider (MegaCloud extraction)',
      },
    },
  });
}
