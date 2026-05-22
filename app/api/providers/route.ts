/**
 * Provider Availability API
 * Returns which stream providers are enabled/available
 */

import { NextResponse } from 'next/server';
import { FLIXER_ENABLED } from '@/app/lib/services/flixer-extractor';

export async function GET() {
  return NextResponse.json({
    providers: {
      videasy: {
        enabled: true,
        name: 'Videasy',
        primary: true,
        description: 'Primary — browser-direct via CF Worker, zero-auth, direct HLS, 4K',
      },
      flixer: {
        enabled: FLIXER_ENABLED,
        name: 'Flixer',
        primary: false,
        description: 'Browser-direct via CF Worker — WASM-based, 12 NATO servers',
      },
      bingebox: {
        enabled: true,
        name: 'BingeBox',
        primary: false,
        description: 'Browser-direct via CF Worker — 15 direct HLS sources (api.dlproxy.com)',
      },
      primesrc: {
        enabled: false,
        name: 'PrimeSrc',
        primary: false,
        description: 'Needs Turnstile token + embed CDNs block CF IPs',
      },
      uflix: {
        enabled: true,
        name: 'Uflix',
        primary: false,
        description: '5 embed servers — direct fetch (unverified from CF IPs)',
      },
      hexa: {
        enabled: true,
        name: 'Hexa',
        primary: false,
        description: 'Multi-embed aggregator — direct fetch (unverified from CF IPs)',
      },
      vidsrc: {
        enabled: false,
        name: 'VidSrc',
        primary: false,
        description: 'RPI-dependent — dead without RPI',
      },
      'multi-embed': {
        enabled: true,
        name: 'MultiEmbed',
        primary: false,
        description: 'Multi-source embed aggregator — direct fetch (unverified)',
      },
      hianime: {
        enabled: true,
        name: 'HiAnime',
        primary: false,
        animeOnly: true,
        description: 'Browser-direct via CF Worker — search→match→extract→MegaCloud decrypt',
      },
      miruro: {
        enabled: true,
        name: 'Miruro',
        primary: false,
        animeOnly: true,
        description: 'Browser-direct via CF Worker — pipe-encrypted API, 6 providers, sub+dub',
      },
      moviebox: {
        enabled: false,
        name: 'MovieBox',
        primary: false,
        description: 'Empty streams from h5-api.aoneroom.com — dead',
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
        description: 'Live TV — DLHD/DaddyLive',
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
