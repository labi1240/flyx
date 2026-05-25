/**
 * Live TV Channel Router
 * 
 * Properly routes channels to the correct provider based on:
 * - Channel availability per provider
 * - Provider capabilities and specializations
 * - Fallback priority order
 * 
 * PROVIDER SPECIALIZATIONS:
 * - DLHD: General live TV channels (850+ channels)
 * - CDN-Live.tv: Live sports events and premium channels
 */

import channelMappings from '@/app/data/channel-mappings.json';
import { LiveTVSourceType, ChannelMapping } from './source-providers';

export interface ChannelInfo {
  id: string;
  name: string;
  category: string;
  country: string;
  providers: {
    dlhd?: string | null;
    cdnlive?: string | null;
    ppv?: string | null;
  };
  priority: LiveTVSourceType[];
  description?: string;
}

export interface ProviderInfo {
  name: string;
  description: string;
  baseUrl: string;
  totalChannels: number;
  categories: string[];
  countries: string[];
  channelIdFormat: string;
  examples: string[];
}

export class ChannelRouter {
  private mappings = channelMappings;

  /**
   * Get provider information
   */
  getProviderInfo(provider: LiveTVSourceType): ProviderInfo | null {
    const info = this.mappings.providers[provider as keyof typeof this.mappings.providers];
    return info || null;
  }

  /**
   * Get all available providers
   */
  getAvailableProviders(): ProviderInfo[] {
    return Object.entries(this.mappings.providers).map(([key, info]) => ({
      ...info,
      type: key as LiveTVSourceType,
    }));
  }

  /**
   * Find channel by ID across all providers
   */
  findChannelById(channelId: string): ChannelInfo | null {
    // First check direct channel mappings
    const channel = Object.entries(this.mappings.channels).find(([_, info]) => 
      info.providers.dlhd === channelId ||
      info.providers.cdnlive === channelId
    );

    if (channel) {
      const [id, info] = channel;
      return {
        id,
        ...info,
        providers: { ...info.providers, ppv: null },
        priority: info.priority as LiveTVSourceType[],
      };
    }

    // Check if it's a DLHD numeric channel
    if (/^\d+$/.test(channelId)) {
      return this.createDLHDChannelInfo(channelId);
    }

    return null;
  }

  /**
   * Find channels by name (fuzzy search)
   */
  findChannelsByName(name: string): ChannelInfo[] {
    const searchTerm = name.toLowerCase();
    return Object.entries(this.mappings.channels)
      .filter(([_, info]) => info.name.toLowerCase().includes(searchTerm))
      .map(([id, info]) => ({ 
        id, 
        ...info, 
        providers: { ...info.providers, ppv: null },
        priority: info.priority as LiveTVSourceType[] 
      }));
  }

  /**
   * Get channels by category
   */
  getChannelsByCategory(category: string): ChannelInfo[] {
    return Object.entries(this.mappings.channels)
      .filter(([_, info]) => info.category === category)
      .map(([id, info]) => ({ 
        id, 
        ...info, 
        providers: { ...info.providers, ppv: null },
        priority: info.priority as LiveTVSourceType[] 
      }));
  }

  /**
   * Get channels by country
   */
  getChannelsByCountry(country: string): ChannelInfo[] {
    return Object.entries(this.mappings.channels)
      .filter(([_, info]) => info.country === country)
      .map(([id, info]) => ({ 
        id, 
        ...info, 
        providers: { ...info.providers, ppv: null },
        priority: info.priority as LiveTVSourceType[] 
      }));
  }

  /**
   * Get channels available on specific provider
   */
  getChannelsByProvider(provider: LiveTVSourceType): ChannelInfo[] {
    // VIPRow doesn't use channel mappings - it uses event URLs directly
    if (provider === 'ppv') return [];
    
    return Object.entries(this.mappings.channels)
      .filter(([_, info]) => info.providers[provider as 'dlhd' | 'cdnlive'])
      .map(([id, info]) => ({ 
        id, 
        ...info, 
        providers: { ...info.providers, ppv: null },
        priority: info.priority as LiveTVSourceType[] 
      }));
  }

  /**
   * Get optimal provider for a channel
   */
  getOptimalProvider(channelId: string): {
    provider: LiveTVSourceType;
    providerId: string;
    priority: number;
  } | null {
    const channel = this.findChannelById(channelId);
    if (!channel) return null;

    // Use the first available provider from priority list
    for (let i = 0; i < channel.priority.length; i++) {
      const provider = channel.priority[i];
      // VIPRow doesn't use channel mappings
      if (provider === 'ppv') continue;
      const providerId = channel.providers[provider as 'dlhd' | 'cdnlive'];
      
      if (providerId) {
        return {
          provider,
          providerId,
          priority: i + 1,
        };
      }
    }

    return null;
  }

  /**
   * Get all available providers for a channel with fallback order
   */
  getChannelProviders(channelId: string): Array<{
    provider: LiveTVSourceType;
    providerId: string;
    priority: number;
  }> {
    const channel = this.findChannelById(channelId);
    if (!channel) return [];

    const providers: Array<{
      provider: LiveTVSourceType;
      providerId: string;
      priority: number;
    }> = [];

    channel.priority.forEach((provider, index) => {
      // VIPRow doesn't use channel mappings
      if (provider === 'ppv') return;
      const providerId = channel.providers[provider as 'dlhd' | 'cdnlive'];
      if (providerId) {
        providers.push({
          provider,
          providerId,
          priority: index + 1,
        });
      }
    });

    return providers;
  }

  /**
   * Create channel mapping for provider routing
   */
  createChannelMapping(channelId: string): ChannelMapping {
    const channel = this.findChannelById(channelId);
    if (!channel) {
      // Fallback for unknown channels - assume DLHD if numeric
      if (/^\d+$/.test(channelId)) {
        return { dlhdId: channelId };
      }
      return {};
    }

    return {
      dlhdId: channel.providers.dlhd || undefined,
      cdnliveId: channel.providers.cdnlive || undefined,
    };
  }

  /**
   * Get provider-specific URL for a channel
   */
  getProviderUrl(channelId: string, provider: LiveTVSourceType): string | null {
    // VIPRow doesn't use channel mappings - it uses event URLs directly
    if (provider === 'ppv') return null;
    
    const channel = this.findChannelById(channelId);
    if (!channel) return null;

    const providerId = channel.providers[provider as 'dlhd' | 'cdnlive'];
    if (!providerId) return null;

    const providerInfo = this.getProviderInfo(provider);
    if (!providerInfo) return null;

    switch (provider) {
      case 'dlhd':
        return `${providerInfo.baseUrl}/?channel=${providerId}`;
      case 'cdnlive':
        return `${providerInfo.baseUrl}/stream?eventId=${encodeURIComponent(providerId)}`;
      default:
        return null;
    }
  }

  /**
   * Get statistics about channel distribution
   */
  getChannelStats(): {
    totalChannels: number;
    byProvider: Record<LiveTVSourceType, number>;
    byCategory: Record<string, number>;
    byCountry: Record<string, number>;
  } {
    const channels = Object.values(this.mappings.channels);
    
    const byProvider: Record<LiveTVSourceType, number> = {
      dlhd: 0,
      ntv: 0,
      cdnlive: 0,
      ppv: 0,
      ufreetv: 0,
      globetv: 0,
    };

    const byCategory: Record<string, number> = {};
    const byCountry: Record<string, number> = {};

    channels.forEach(channel => {
      // Count by provider
      if (channel.providers.dlhd) byProvider.dlhd++;
      if (channel.providers.cdnlive) byProvider.cdnlive++;
      // VIPRow doesn't use channel mappings - it uses event URLs directly

      // Count by category
      byCategory[channel.category] = (byCategory[channel.category] || 0) + 1;

      // Count by country
      byCountry[channel.country] = (byCountry[channel.country] || 0) + 1;
    });

    return {
      totalChannels: channels.length,
      byProvider,
      byCategory,
      byCountry,
    };
  }

  /**
   * Create DLHD channel info for numeric IDs
   */
  private createDLHDChannelInfo(channelId: string): ChannelInfo {
    return {
      id: channelId,
      name: `DLHD Channel ${channelId}`,
      category: 'entertainment',
      country: 'usa',
      providers: {
        dlhd: channelId,
        cdnlive: null,
        ppv: null,
      },
      priority: ['dlhd'],
      description: 'DLHD live TV channel',
    };
  }
}

// Export singleton instance
export const channelRouter = new ChannelRouter();

// Export helper functions
export function getChannelInfo(channelId: string): ChannelInfo | null {
  return channelRouter.findChannelById(channelId);
}

export function getOptimalProvider(channelId: string) {
  return channelRouter.getOptimalProvider(channelId);
}

export function createChannelMapping(channelId: string): ChannelMapping {
  return channelRouter.createChannelMapping(channelId);
}

export function getProviderUrl(channelId: string, provider: LiveTVSourceType): string | null {
  return channelRouter.getProviderUrl(channelId, provider);
}