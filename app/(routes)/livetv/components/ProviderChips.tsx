/**
 * Provider Chips — Horizontal scrollable provider filter pills
 */

import { memo } from 'react';
import { ProviderFilter, ProviderStats } from '../hooks/useLiveTVData';
import styles from '../LiveTV.module.css';

interface ProviderInfo {
  id: ProviderFilter;
  label: string;
  icon: string;
  colorClass: string;
}

const PROVIDERS: ProviderInfo[] = [
  { id: 'all', label: 'All', icon: '🌐', colorClass: 'chipAll' },
  { id: 'dlhd', label: 'DLHD', icon: '📡', colorClass: 'chipBlue' },
  { id: 'ntv', label: 'NTV', icon: '🛰️', colorClass: 'chipOrange' },
  { id: 'ppv', label: 'PPV.to', icon: '🏟️', colorClass: 'chipPurple' },
  { id: 'cdnlive', label: 'CDN Live', icon: '📡', colorClass: 'chipGreen' },
  { id: 'ufreetv', label: 'uFreeTV', icon: '📺', colorClass: 'chipPink' },
  { id: 'globetv', label: 'GlobeTV', icon: '🌍', colorClass: 'chipTeal' },
];

interface ProviderChipsProps {
  selectedProvider: ProviderFilter;
  onProviderChange: (provider: ProviderFilter) => void;
  stats: ProviderStats;
  loading?: boolean;
}

export const ProviderChips = memo(function ProviderChips({
  selectedProvider,
  onProviderChange,
  stats,
  loading,
}: ProviderChipsProps) {
  const getCount = (id: ProviderFilter): number => {
    if (id === 'all') {
      return (stats.dlhd?.events||0) + (stats.dlhd?.channels||0) +
        (stats.cdnlive?.events||0) + (stats.cdnlive?.channels||0) +
        (stats.ppv?.events||0) +
        (stats.ntv?.events||0) + (stats.ntv?.channels||0) +
        (stats.ufreetv?.channels||0) + (stats.globetv?.channels||0);
    }
    const s = stats[id];
    if (!s) return 0;
    return ('events' in s ? s.events : 0) + ('channels' in s ? s.channels : 0);
  };

  const getLiveCount = (id: ProviderFilter): number => {
    if (id === 'all') {
      return (stats.dlhd?.live||0) + (stats.cdnlive?.live||0) + (stats.ppv?.live||0) + (stats.ntv?.live||0);
    }
    const s = stats[id];
    if (!s || !('live' in s)) return 0;
    return s.live;
  };

  return (
    <div className={styles.providerChips}>
      {PROVIDERS.map(({ id, label, icon, colorClass }) => {
        const count = getCount(id);
        const liveCount = getLiveCount(id);
        const isActive = selectedProvider === id;

        return (
          <button
            key={id}
            onClick={() => onProviderChange(id)}
            className={`${styles.providerChip} ${isActive ? styles.active : ''} ${styles[colorClass]}`}
            disabled={loading}
            data-tv-focusable="true"
          >
            <span className={styles.providerChipIcon}>{icon}</span>
            <span className={styles.providerChipLabel}>{label}</span>
            <span className={styles.providerChipCount}>
              {loading ? '...' : count}
            </span>
            {liveCount > 0 && (
              <span className={styles.providerChipLive}>
                <span className={styles.liveDotMini} />
                {liveCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
});
