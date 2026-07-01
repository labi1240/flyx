import { Provider, ProviderConfig, ExtractionRequest, ExtractionResult, StreamSource, MediaType } from '../types';

export class PloyanProvider implements Provider {
  readonly name = 'ployan';
  readonly priority = 25; // Good priority since it's reliable but slightly slower due to Puppeteer
  readonly enabled = true;

  getConfig(): ProviderConfig {
    return {
      name: this.name,
      priority: this.priority,
      enabled: this.enabled,
      supportedContent: ['movie', 'tv'],
    };
  }

  supportsContent(mediaType: MediaType, metadata?: { isAnime?: boolean; isLive?: boolean }): boolean {
    if (metadata?.isLive || metadata?.isAnime) return false;
    return mediaType === 'movie' || mediaType === 'tv';
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const startTime = Date.now();
    try {
      // The VPS microservice URL. You should configure this in your .env file
      // e.g. PLOYAN_EXTRACTOR_URL=https://my-ployan-service.onrender.com
      const serviceUrl = process.env.PLOYAN_EXTRACTOR_URL || process.env.NEXT_PUBLIC_PLOYAN_EXTRACTOR_URL || 'http://localhost:3005';
      
      const params = new URLSearchParams({
        tmdbId: request.tmdbId,
        type: request.mediaType,
        title: request.title || ''
      });

      if (request.mediaType === 'tv') {
        params.append('season', request.season?.toString() || '1');
        params.append('episode', request.episode?.toString() || '1');
      }

      console.log(`[PloyanProvider] Requesting extraction from microservice: ${serviceUrl}/extract?${params.toString()}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 35000); // 35s timeout since Puppeteer is slow

      const response = await fetch(`${serviceUrl}/extract?${params.toString()}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Microservice returned status ${response.status}`);
      }

      const data = await response.json();

      if (!data.success || !data.sources || data.sources.length === 0) {
        throw new Error(data.error || 'Failed to extract sources from microservice');
      }

      const sources: StreamSource[] = data.sources.map((s: any) => {
        let finalUrl = s.url;
        // Sometimes Puppeteer intercepts the JWPlayer ping.gif which contains the m3u8 in the 'mu' query param
        if (finalUrl.includes('ping.gif') && finalUrl.includes('mu=')) {
            try {
                const urlParams = new URLSearchParams(finalUrl.split('?')[1]);
                const mu = urlParams.get('mu');
                if (mu) finalUrl = decodeURIComponent(mu);
            } catch (e) {}
        }
        
        return {
          url: finalUrl,
          quality: s.quality || 'auto',
          type: s.type || 'hls',
          requiresSegmentProxy: true, // Required because ployan does not have CORS headers
          status: 'working'
        };
      });

      return {
        success: true,
        sources: sources,
        subtitles: data.subtitles || [],
        provider: this.name,
        timing: Date.now() - startTime
      };

    } catch (error: any) {
      console.error(`[PloyanProvider] Extraction error:`, error.message);
      return {
        success: false,
        sources: [],
        subtitles: [],
        provider: this.name,
        error: error.message,
        timing: Date.now() - startTime
      };
    }
  }

  async fetchSourceByName(_sourceName: string, request: ExtractionRequest): Promise<StreamSource | null> {
    const result = await this.extract(request);
    if (!result.success || result.sources.length === 0) return null;
    
    // We only have one "auto" source from ployan typically
    return result.sources[0];
  }
}
