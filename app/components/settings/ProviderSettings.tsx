'use client';

import { useState, useCallback } from 'react';
import { getProviderSettings, saveProviderSettings, setProviderOrder, toggleProvider } from '@/lib/sync';
import type { ProviderSettings as ProviderSettingsType } from '@/lib/sync';
import styles from './ProviderSettings.module.css';

interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  isAnimeOnly?: boolean;
  isLiveTvOnly?: boolean;
}

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'videasy',
    name: 'Videasy',
    description: 'Primary — browser-direct via CF Worker, zero-auth HLS, 4K',
    icon: '🎯',
  },
  {
    id: 'flixer',
    name: 'Flixer',
    description: 'Browser-direct via CF Worker — WASM-based, 12 NATO servers',
    icon: '📺',
  },
  {
    id: 'bingebox',
    name: 'BingeBox',
    description: 'Browser-direct via CF Worker — 15 direct HLS sources',
    icon: '📦',
  },
  {
    id: 'hianime',
    name: 'HiAnime',
    description: 'Browser-direct via CF Worker — search→match→MegaCloud decrypt, sub+dub',
    icon: '🌸',
    isAnimeOnly: true,
  },
  {
    id: 'miruro',
    name: 'Miruro',
    description: 'Browser-direct via CF Worker — pipe-encrypted API, 6 providers, sub+dub',
    icon: '🎌',
    isAnimeOnly: true,
  },
  {
    id: 'primesrc',
    name: 'PrimeSrc',
    description: 'CF Worker proxy — xprime.su (needs Turnstile token)',
    icon: '⚡',
  },
  {
    id: 'vidsrc',
    name: 'VidSrc',
    description: 'RPI-dependent — currently unavailable',
    icon: '🎬',
  },
  {
    id: 'moviebox',
    name: 'MovieBox',
    description: 'Movies/TV/Anime — currently unavailable',
    icon: '🎞️',
  },
  {
    id: 'ntv',
    name: 'NTV',
    description: 'Live TV — 2052 channels, 7 match servers',
    icon: '📡',
    isLiveTvOnly: true,
  },
  {
    id: 'globetv',
    name: 'GlobeTV',
    description: 'Live TV — globetv.app',
    icon: '🌍',
    isLiveTvOnly: true,
  },
  {
    id: 'ufreetv',
    name: 'uFreeTV',
    description: 'Live TV — ufreetv.com',
    icon: '📺',
    isLiveTvOnly: true,
  },
  {
    id: 'dlhd',
    name: 'DLHD',
    description: 'Live TV — DLHD/DaddyLive',
    icon: '🏟️',
    isLiveTvOnly: true,
  },
  {
    id: 'viprow',
    name: 'VIPRow',
    description: 'Live TV — VIPRow sports streams',
    icon: '⚽',
    isLiveTvOnly: true,
  },
  {
    id: 'ppv',
    name: 'PPV',
    description: 'Live TV — PPV events',
    icon: '🥊',
    isLiveTvOnly: true,
  },
  {
    id: 'cdn-live',
    name: 'CDN Live',
    description: 'Live TV — cdn-live-tv.ru segments',
    icon: '🔄',
    isLiveTvOnly: true,
  },
  {
    id: 'iptv',
    name: 'IPTV',
    description: 'Live TV — IPTV m3u playlists',
    icon: '📋',
    isLiveTvOnly: true,
  },
];

export default function ProviderSettings() {
  const [settings, setSettings] = useState<ProviderSettingsType>(() => getProviderSettings());
  const [draggedProvider, setDraggedProvider] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Get ordered providers list
  const orderedProviders = [...settings.providerOrder].map(id => 
    PROVIDERS.find(p => p.id === id)
  ).filter(Boolean) as ProviderInfo[];

  // Add any providers not in the order list
  const missingProviders = PROVIDERS.filter(p => !settings.providerOrder.includes(p.id));
  const allProviders = [...orderedProviders, ...missingProviders];

  const handleToggleProvider = useCallback((providerId: string) => {
    const isCurrentlyDisabled = settings.disabledProviders.includes(providerId);
    toggleProvider(providerId, isCurrentlyDisabled);
    
    setSettings(prev => ({
      ...prev,
      disabledProviders: isCurrentlyDisabled
        ? prev.disabledProviders.filter(id => id !== providerId)
        : [...prev.disabledProviders, providerId],
    }));
  }, [settings.disabledProviders]);

  const handleDragStart = useCallback((e: React.DragEvent, providerId: string) => {
    setDraggedProvider(providerId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', providerId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedProvider(null);
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain');
    
    if (!draggedId) return;

    const currentOrder = [...settings.providerOrder];
    const draggedIndex = currentOrder.indexOf(draggedId);
    
    if (draggedIndex === -1) {
      // Provider wasn't in order list, add it
      currentOrder.splice(dropIndex, 0, draggedId);
    } else {
      // Reorder
      currentOrder.splice(draggedIndex, 1);
      currentOrder.splice(dropIndex, 0, draggedId);
    }

    setProviderOrder(currentOrder);
    setSettings(prev => ({ ...prev, providerOrder: currentOrder }));
    setDraggedProvider(null);
    setDragOverIndex(null);
  }, [settings.providerOrder]);

  const moveProvider = useCallback((providerId: string, direction: 'up' | 'down') => {
    const currentOrder = [...settings.providerOrder];
    const index = currentOrder.indexOf(providerId);
    
    if (index === -1) return;
    
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= currentOrder.length) return;

    currentOrder.splice(index, 1);
    currentOrder.splice(newIndex, 0, providerId);

    setProviderOrder(currentOrder);
    setSettings(prev => ({ ...prev, providerOrder: currentOrder }));
  }, [settings.providerOrder]);

  const handleAnimeAudioChange = useCallback((pref: 'sub' | 'dub') => {
    saveProviderSettings({ animeAudioPreference: pref });
    setSettings(prev => ({ ...prev, animeAudioPreference: pref }));
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.iconWrapper}>
          <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </div>
        <div>
          <h2 className={styles.title}>Provider Settings</h2>
          <p className={styles.subtitle}>
            Customize which streaming providers to use and their priority order
          </p>
        </div>
      </div>

      {/* Provider order section */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Provider Priority</h3>
        <p className={styles.sectionDesc}>
          Drag to reorder. Higher providers are tried first.
        </p>

        <div className={styles.providerList}>
          {allProviders.map((provider, index) => {
            const isDisabled = settings.disabledProviders.includes(provider.id);
            const isDragging = draggedProvider === provider.id;
            const isDragOver = dragOverIndex === index;

            return (
              <div
                key={provider.id}
                className={`${styles.providerItem} ${isDisabled ? styles.disabled : ''} ${isDragging ? styles.dragging : ''} ${isDragOver ? styles.dragOver : ''}`}
                draggable
                onDragStart={(e) => handleDragStart(e, provider.id)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragEnd={handleDragEnd}
                onDrop={(e) => handleDrop(e, index)}
              >
                <div className={styles.dragHandle}>
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="6" r="1.5" />
                    <circle cx="15" cy="6" r="1.5" />
                    <circle cx="9" cy="12" r="1.5" />
                    <circle cx="15" cy="12" r="1.5" />
                    <circle cx="9" cy="18" r="1.5" />
                    <circle cx="15" cy="18" r="1.5" />
                  </svg>
                </div>

                <span className={styles.providerIcon}>{provider.icon}</span>

                <div className={styles.providerInfo}>
                  <span className={styles.providerName}>
                    {provider.name}
                    {provider.isAnimeOnly && (
                      <span className={styles.badge}>Anime</span>
                    )}
                    {provider.isLiveTvOnly && (
                      <span className={`${styles.badge} ${styles.liveTvBadge}`}>Live TV</span>
                    )}
                  </span>
                  <span className={styles.providerDesc}>{provider.description}</span>
                </div>

                <div className={styles.providerActions}>
                  <button
                    className={styles.moveButton}
                    onClick={() => moveProvider(provider.id, 'up')}
                    disabled={index === 0}
                    title="Move up"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                  <button
                    className={styles.moveButton}
                    onClick={() => moveProvider(provider.id, 'down')}
                    disabled={index === allProviders.length - 1}
                    title="Move down"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <button
                    className={`${styles.toggleButton} ${!isDisabled ? styles.enabled : ''}`}
                    onClick={() => handleToggleProvider(provider.id)}
                    title={isDisabled ? 'Enable provider' : 'Disable provider'}
                  >
                    {isDisabled ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="1" y="5" width="22" height="14" rx="7" ry="7" />
                        <circle cx="8" cy="12" r="3" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="1" y="5" width="22" height="14" rx="7" ry="7" />
                        <circle cx="16" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Anime preferences */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Anime Preferences</h3>
        <p className={styles.sectionDesc}>
          Default audio preference for anime content
        </p>

        <div className={styles.audioToggle}>
          <button
            className={`${styles.audioOption} ${settings.animeAudioPreference === 'sub' ? styles.active : ''}`}
            onClick={() => handleAnimeAudioChange('sub')}
          >
            <span className={styles.audioIcon}>🇯🇵</span>
            <span className={styles.audioLabel}>Subbed</span>
            <span className={styles.audioDesc}>Japanese audio with subtitles</span>
          </button>
          <button
            className={`${styles.audioOption} ${settings.animeAudioPreference === 'dub' ? styles.active : ''}`}
            onClick={() => handleAnimeAudioChange('dub')}
          >
            <span className={styles.audioIcon}>🇺🇸</span>
            <span className={styles.audioLabel}>Dubbed</span>
            <span className={styles.audioDesc}>English audio</span>
          </button>
        </div>
      </div>

      {/* Info */}
      <div className={styles.infoBox}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <p>
          When a provider fails, the next enabled provider in the list will be tried automatically.
          Disabled providers are skipped entirely.
        </p>
      </div>
    </div>
  );
}
