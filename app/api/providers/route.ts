/**
 * Provider Availability API
 * Returns which stream providers are enabled/available
 */

import { NextResponse } from 'next/server';
import { ANIMEKAI_ENABLED } from '@/app/lib/services/animekai-extractor';
import { FLIXER_ENABLED } from '@/app/lib/services/flixer-extractor';

export async function GET() {
  return NextResponse.json({
    providers: {
      videasy: {
        enabled: true,
        name: 'Videasy',
        primary: true,
        description: 'Primary streaming source (player.videasy.net)',
      },
      flixer: {
        enabled: FLIXER_ENABLED,
        name: 'Flixer',
        primary: false,
        description: 'WASM-based extraction — multi-server (12 NATO servers)',
      },
      primesrc: {
        enabled: true,
        name: 'PrimeSrc',
        primary: false,
        description: 'CF Worker proxy — xprime.su backend',
      },
      uflix: {
        enabled: true,
        name: 'Uflix',
        primary: false,
        description: '5 embed servers — cloudnestra extraction',
      },
      hexa: {
        enabled: true,
        name: 'Hexa',
        primary: false,
        description: 'Multi-embed aggregator — 8 servers (hexa.su)',
      },
      vidsrc: {
        enabled: true,
        name: 'VidSrc',
        primary: false,
        description: '2embed API + cloudnestra extraction',
      },
      'multi-embed': {
        enabled: true,
        name: 'MultiEmbed',
        primary: false,
        description: 'Multi-source embed aggregator',
      },
      '1movies': {
        enabled: true,
        name: '1movies',
        primary: false,
        description: 'Alternative provider (111movies.com)',
      },
      animekai: {
        enabled: ANIMEKAI_ENABLED,
        name: 'AnimeKai',
        primary: false,
        animeOnly: true,
        description: 'Anime — native crypto, MegaUp CDN (sub)',
      },
      hianime: {
        enabled: true,
        name: 'HiAnime',
        primary: false,
        animeOnly: true,
        description: 'Anime sub+dub — MegaCloud extraction via CF Worker',
      },
      miruro: {
        enabled: true,
        name: 'Miruro',
        primary: false,
        animeOnly: true,
        description: 'Anime sub+dub — 6 providers, uwucdn.top CDN',
      },
      moviebox: {
        enabled: true,
        name: 'MovieBox',
        primary: false,
        description: 'Movies/TV/anime — h5-api.aoneroom.com',
      },
      bingebox: {
        enabled: true,
        name: 'BingeBox',
        primary: false,
        description: 'Movies/TV/anime — 15 direct HLS sources (bingebox.to)',
      },
      ntv: {
        enabled: true,
        name: 'NTV',
        primary: false,
        liveTvOnly: true,
        description: 'Live TV — 2052 channels, 7 match servers',
      },
      globetv: {
        enabled: true,
        name: 'GlobeTV',
        primary: false,
        liveTvOnly: true,
        description: 'Live TV — globetv.app',
      },
      ufreetv: {
        enabled: true,
        name: 'uFreeTV',
        primary: false,
        liveTvOnly: true,
        description: 'Live TV — ufreetv.com',
      },
      dlhd: {
        enabled: true,
        name: 'DLHD',
        primary: false,
        liveTvOnly: true,
        description: 'Live TV — DLHD/DaddyLive (831 channels)',
      },
      viprow: {
        enabled: true,
        name: 'VIPRow',
        primary: false,
        liveTvOnly: true,
        description: 'Live TV — VIPRow sports streams',
      },
      ppv: {
        enabled: true,
        name: 'PPV',
        primary: false,
        liveTvOnly: true,
        description: 'Live TV — PPV events',
      },
      'cdn-live': {
        enabled: true,
        name: 'CDN Live',
        primary: false,
        liveTvOnly: true,
        description: 'Live TV — cdn-live-tv.ru segments',
      },
      iptv: {
        enabled: true,
        name: 'IPTV',
        primary: false,
        liveTvOnly: true,
        description: 'Live TV — IPTV m3u playlists',
      },
    },
  });
}
