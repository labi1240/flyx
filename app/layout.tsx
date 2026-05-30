import './globals.css'
import { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import AnalyticsProvider from './components/analytics/AnalyticsProvider'
import PresenceProvider from './components/analytics/PresenceProvider'
import { RegionProvider } from './lib/context/RegionContext'
import { TVNavigationProvider } from './components/tv/TVNavigationProvider'
import { TVNavigationHint } from './components/tv/TVNavigationHint'
import AdminBanner from './components/ui/AdminBanner'
import { WatchlistProvider } from './hooks/useWatchlist'
import SyncProvider from './components/providers/SyncProvider'
import { NavigationOverlay } from './components/navigation/NavigationOverlay'

// Optimized font loading with next/font (eliminates render-blocking CSS)
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
  preload: true,
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
  preload: true,
})

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
  themeColor: '#6366f1',
  colorScheme: 'dark light',
}

export const metadata: Metadata = {
  title: 'Flyx 2.0 - Stream Beyond',
  description: 'Discover and stream your favorite movies and TV shows with Flyx 2.0. Your ultimate entertainment destination.',
  metadataBase: new URL('https://tv.vynx.cc'),
  keywords: ['movies', 'tv shows', 'streaming', 'entertainment', 'flyx'],
  authors: [{ name: 'Flyx Team' }],
  creator: 'Flyx Team',
  publisher: 'Flyx',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  // Open Graph tags
  openGraph: {
    title: 'Flyx 2.0 - Stream Beyond',
    description: 'Discover and stream your favorite movies and TV shows with Flyx 2.0. Your ultimate entertainment destination.',
    url: 'https://tv.vynx.cc',
    siteName: 'Flyx 2.0',
    images: [
      {
        url: 'https://tv.vynx.cc/opengraph-image',
        width: 1200,
        height: 630,
        alt: 'Flyx 2.0 - Stream Beyond',
        type: 'image/png',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  // Twitter Card tags
  twitter: {
    card: 'summary_large_image',
    title: 'Flyx 2.0 - Stream Beyond',
    description: 'Discover and stream your favorite movies and TV shows with Flyx 2.0. Your ultimate entertainment destination.',
    images: ['https://tv.vynx.cc/twitter-image'],
    creator: '@flyx', // Update with your actual Twitter handle if you have one
  },
  // Apple Touch Icon
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
  // Manifest
  manifest: '/manifest.json',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://image.tmdb.org" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://image.tmdb.org" />
        <link rel="preconnect" href="https://api.themoviedb.org" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://api.themoviedb.org" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
	if ('serviceWorker' in navigator) {
	  navigator.serviceWorker.getRegistrations().then(function(regs) {
	    regs.forEach(function(reg) { reg.unregister(); });
	    console.log('[Flyx] All service workers unregistered');
	  }).catch(function(err) {
	    console.warn('[Flyx] SW cleanup error:', err);
	  });
	}`,
          }}
        />
      </head>
      <body className={inter.className} suppressHydrationWarning>
        {/* Screen reader announcements */}
        <div id="sr-announcements" role="status" aria-live="polite" aria-atomic="true" className="sr-only"></div>

        <RegionProvider>
          <AnalyticsProvider>
            <PresenceProvider>
              <SyncProvider>
                <WatchlistProvider>
                  <TVNavigationProvider>
                    <AdminBanner />
                    <NavigationOverlay />
                    {children}
                    <TVNavigationHint />
                  </TVNavigationProvider>
                </WatchlistProvider>
              </SyncProvider>
            </PresenceProvider>
          </AnalyticsProvider>
        </RegionProvider>
      </body>
    </html>
  )
}
