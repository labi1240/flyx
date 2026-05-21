/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disable React Strict Mode in dev to prevent double-mounting effects
  // which causes duplicate extraction requests and race conditions
  reactStrictMode: false,

  // Fix workspace root detection (C:\Users\Nicks\bun.lockb confuses Next.js)
  turbopack: {
    root: __dirname,
  },

  // Enable standalone output for Docker/Cloudflare deployments
  ...(process.env.FLYX_SELF_HOSTED === 'true' || process.env.DOCKER_BUILD === 'true'
    ? { output: 'standalone', outputFileTracingRoot: __dirname }
    : {}),

  // Image optimization
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'image.tmdb.org',
        port: '',
        pathname: '/t/p/**',
      },
    ],
    // Use modern formats
    formats: ['image/avif', 'image/webp'],
    // Optimize image sizes - reduced for faster loading
    deviceSizes: [640, 750, 1080, 1920],
    imageSizes: [16, 32, 64, 128, 256],
    // Minimize layout shift
    minimumCacheTTL: 60 * 60 * 24 * 30, // 30 days
    // Unoptimized for external images (TMDB handles optimization)
    unoptimized: false,
  },

  // Enable compression
  compress: true,

  // Optimize production builds
  productionBrowserSourceMaps: false,

  // Reduce bundle size
  // swcMinify is deprecated in Next.js 13+ (SWC is enabled by default)

  // Experimental optimizations
  experimental: {
    // Optimize package imports (tree-shaking)
    optimizePackageImports: [
      'lucide-react',
      'framer-motion',
      'recharts',
      '@babel/parser',
      '@babel/traverse',
      '@babel/generator',
      'date-fns',
    ],
  },

  // Keep these packages external (not bundled) — they use dynamic require or native modules
  serverExternalPackages: ['libsodium-wrappers', 'libsodium'],

  // Compiler optimizations
  compiler: {
    // Remove console.log in production
    removeConsole: process.env.NODE_ENV === 'production' ? {
      exclude: ['error', 'warn'],
    } : false,
  },

  // Headers for caching and security
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
        ],
      },
      {
        // Cache static assets aggressively (images, fonts, wasm)
        source: '/(.*)\\.(ico|png|jpg|jpeg|gif|webp|avif|svg|woff|woff2|wasm)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        // Cache manifest.json with moderate TTL (may change occasionally)
        source: '/manifest.json',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=86400, stale-while-revalidate=604800',
          },
        ],
      },
      {
        // Cache JS/CSS chunks
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        // Cache API responses briefly
        source: '/api/content/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, s-maxage=60, stale-while-revalidate=300',
          },
        ],
      },
      {
        // Cache TMDB proxy responses
        source: '/api/tmdb/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, s-maxage=300, stale-while-revalidate=600',
          },
        ],
      },
    ];
  },

  // Rewrites for external resources
  async rewrites() {
    return [];
  },
};

module.exports = async () => {
  if (process.env.NODE_ENV === 'development' && process.env.USE_CLOUDFLARE_BACKEND === 'true') {
    const { initOpenNextCloudflareForDev } = await import("@opennextjs/cloudflare");
    initOpenNextCloudflareForDev();
  }
  return nextConfig;
};
