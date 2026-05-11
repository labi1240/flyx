/**
 * Sync Client - Handles client-side sync operations
 * Collects local data and syncs with server
 */

import type { 
  SyncData, 
  SyncCode, 
  SyncStatus, 
  ProviderSettings, 
  AccountProfile,
  AccountIcon,
  AccountColor,
  Passphrase 
} from './types';
import { DEFAULT_PROFILE, SYNC_SCHEMA_VERSION } from './types';
import { 
  generateSyncCode, 
  generatePassphrase,
  isValidSyncCode, 
  isValidPassphrase,
  parseSyncCodeInput,
  parsePassphraseInput 
} from './sync-code';

const SYNC_CODE_STORAGE_KEY = 'flyx_sync_code';
const PASSPHRASE_STORAGE_KEY = 'flyx_sync_passphrase';
const PROFILE_STORAGE_KEY = 'flyx_account_profile';
const LAST_SYNC_STORAGE_KEY = 'flyx_last_sync';
const SYNC_ENABLED_KEY = 'flyx_sync_enabled';

// Default provider settings
const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  providerOrder: ['videasy', 'primesrc', 'flixer', 'uflix', 'hexa', 'vidsrc', '1movies', 'animekai'],
  disabledProviders: [],
  lastSuccessfulProviders: {},
  animeAudioPreference: 'sub',
  preferredAnimeKaiServer: null,
};

/**
 * Get current sync status
 */
export function getSyncStatus(): SyncStatus {
  if (typeof window === 'undefined') {
    return { 
      isLinked: false, 
      syncCode: null, 
      passphrase: null,
      profile: null,
      lastSyncedAt: null, 
      isSyncing: false, 
      error: null 
    };
  }
  
  const syncCode = localStorage.getItem(SYNC_CODE_STORAGE_KEY);
  const passphrase = localStorage.getItem(PASSPHRASE_STORAGE_KEY);
  const profileRaw = localStorage.getItem(PROFILE_STORAGE_KEY);
  const lastSyncedAt = localStorage.getItem(LAST_SYNC_STORAGE_KEY);
  const isEnabled = localStorage.getItem(SYNC_ENABLED_KEY) === 'true';
  
  let profile: AccountProfile | null = null;
  if (profileRaw) {
    try {
      profile = JSON.parse(profileRaw);
    } catch {
      profile = null;
    }
  }
  
  const isValidCode = syncCode && isValidSyncCode(syncCode);
  const isValidPass = passphrase && isValidPassphrase(passphrase);
  
  return {
    isLinked: isEnabled && !!isValidCode && !!isValidPass,
    syncCode: isValidCode ? syncCode : null,
    passphrase: isValidPass ? passphrase : null,
    profile,
    lastSyncedAt: lastSyncedAt ? parseInt(lastSyncedAt, 10) : null,
    isSyncing: false,
    error: null,
  };
}

/**
 * Get account profile
 */
export function getAccountProfile(): AccountProfile {
  if (typeof window === 'undefined') return DEFAULT_PROFILE;
  
  const profileRaw = localStorage.getItem(PROFILE_STORAGE_KEY);
  if (profileRaw) {
    try {
      return { ...DEFAULT_PROFILE, ...JSON.parse(profileRaw) };
    } catch {
      return DEFAULT_PROFILE;
    }
  }
  return DEFAULT_PROFILE;
}

/**
 * Save account profile
 */
export function saveAccountProfile(profile: Partial<AccountProfile>): AccountProfile {
  if (typeof window === 'undefined') return DEFAULT_PROFILE;
  
  const current = getAccountProfile();
  const updated = { ...current, ...profile };
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(updated));
  return updated;
}

/**
 * Update profile name
 */
export function setProfileName(name: string): void {
  saveAccountProfile({ name: name.trim() || 'My Account' });
}

/**
 * Update profile icon
 */
export function setProfileIcon(icon: AccountIcon): void {
  saveAccountProfile({ icon });
}

/**
 * Update profile color
 */
export function setProfileColor(color: AccountColor): void {
  saveAccountProfile({ color });
}

/**
 * Generate a new sync code and passphrase, save locally
 */
export function createNewSyncAccount(profile?: Partial<AccountProfile>): { 
  code: SyncCode; 
  passphrase: Passphrase;
  profile: AccountProfile;
} {
  const code = generateSyncCode();
  const passphrase = generatePassphrase();
  const accountProfile: AccountProfile = {
    ...DEFAULT_PROFILE,
    ...profile,
    createdAt: Date.now(),
  };
  
  if (typeof window !== 'undefined') {
    localStorage.setItem(SYNC_CODE_STORAGE_KEY, code);
    localStorage.setItem(PASSPHRASE_STORAGE_KEY, passphrase);
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(accountProfile));
    localStorage.setItem(SYNC_ENABLED_KEY, 'true');
  }
  
  return { code, passphrase, profile: accountProfile };
}

/**
 * Legacy: Generate just a sync code (for backward compatibility)
 */
export function createNewSyncCode(): SyncCode {
  const { code } = createNewSyncAccount();
  return code;
}

/**
 * Import an existing sync code with passphrase
 */
export function importSyncAccount(
  codeInput: string, 
  passphraseInput: string
): { success: boolean; code?: SyncCode; passphrase?: Passphrase; error?: string } {
  const parsedCode = parseSyncCodeInput(codeInput);
  const parsedPassphrase = parsePassphraseInput(passphraseInput);
  
  if (!parsedCode) {
    return { success: false, error: 'Invalid sync code format' };
  }
  
  if (!parsedPassphrase) {
    return { success: false, error: 'Invalid passphrase format' };
  }
  
  if (typeof window !== 'undefined') {
    localStorage.setItem(SYNC_CODE_STORAGE_KEY, parsedCode);
    localStorage.setItem(PASSPHRASE_STORAGE_KEY, parsedPassphrase);
    localStorage.setItem(SYNC_ENABLED_KEY, 'true');
  }
  
  return { success: true, code: parsedCode, passphrase: parsedPassphrase };
}

/**
 * Legacy: Import just a sync code (for backward compatibility)
 */
export function importSyncCode(input: string): { success: boolean; code?: SyncCode; error?: string } {
  const parsed = parseSyncCodeInput(input);
  
  if (!parsed) {
    return { success: false, error: 'Invalid sync code format' };
  }
  
  if (typeof window !== 'undefined') {
    localStorage.setItem(SYNC_CODE_STORAGE_KEY, parsed);
    localStorage.setItem(SYNC_ENABLED_KEY, 'true');
  }
  
  return { success: true, code: parsed };
}

/**
 * Disconnect sync (removes local sync code but keeps data)
 */
export function disconnectSync(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(SYNC_CODE_STORAGE_KEY);
    localStorage.removeItem(PASSPHRASE_STORAGE_KEY);
    localStorage.removeItem(LAST_SYNC_STORAGE_KEY);
    localStorage.setItem(SYNC_ENABLED_KEY, 'false');
    // Keep profile for if they reconnect
  }
}

/**
 * Collect all local data for syncing
 */
export function collectLocalSyncData(): SyncData {
  if (typeof window === 'undefined') {
    return getEmptySyncData();
  }
  
  // Collect profile
  const profile = getAccountProfile();
  
  // Collect watch progress - transform to sync format
  const watchProgressRaw = localStorage.getItem('flyx_watch_progress');
  let watchProgress: Record<string, any> = {};
  
  if (watchProgressRaw) {
    const rawProgress = JSON.parse(watchProgressRaw);
    // Transform each item to ensure it has the required sync fields
    for (const [key, item] of Object.entries(rawProgress)) {
      const progressItem = item as any;
      watchProgress[key] = {
        contentId: progressItem.contentId || key,
        contentType: progressItem.contentType || 'movie',
        title: progressItem.title,
        poster: progressItem.poster,
        progress: progressItem.completionPercentage || progressItem.progress || 0,
        currentTime: progressItem.currentTime || 0,
        duration: progressItem.duration || 0,
        seasonNumber: progressItem.seasonNumber,
        episodeNumber: progressItem.episodeNumber,
        lastWatched: progressItem.lastWatched || Date.now(),
      };
    }
  }
  
  // Collect watchlist
  const watchlistRaw = localStorage.getItem('flyx_watchlist');
  const watchlist = watchlistRaw ? JSON.parse(watchlistRaw) : [];
  
  // Collect subtitle preferences
  const subtitleRaw = localStorage.getItem('vynx_subtitle_preferences');
  const subtitleSettings = subtitleRaw ? JSON.parse(subtitleRaw) : {
    enabled: true,
    languageCode: 'eng',
    languageName: 'English',
    fontSize: 100,
    textColor: '#ffffff',
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    backgroundOpacity: 80,
    verticalPosition: 90,
  };
  
  // Collect player preferences
  const playerRaw = localStorage.getItem('flyx_player_preferences');
  const playerPrefs = playerRaw ? JSON.parse(playerRaw) : {};
  const playerSettings = {
    autoPlayNextEpisode: playerPrefs.autoPlayNextEpisode ?? true,
    autoPlayCountdown: playerPrefs.autoPlayCountdown ?? 10,
    showNextEpisodeBeforeEnd: playerPrefs.showNextEpisodeBeforeEnd ?? 90,
    volume: playerPrefs.volume ?? 1,
    isMuted: playerPrefs.isMuted ?? false,
  };
  
  // Collect provider settings
  const providerRaw = localStorage.getItem('flyx_provider_settings');
  const providerSettings: ProviderSettings = providerRaw 
    ? { ...DEFAULT_PROVIDER_SETTINGS, ...JSON.parse(providerRaw) }
    : {
        ...DEFAULT_PROVIDER_SETTINGS,
        animeAudioPreference: playerPrefs.animeAudioPreference ?? 'sub',
        preferredAnimeKaiServer: playerPrefs.preferredAnimeKaiServer ?? null,
      };
  
  return {
    profile,
    watchProgress,
    watchlist,
    providerSettings,
    subtitleSettings,
    playerSettings,
    lastSyncedAt: Date.now(),
    schemaVersion: SYNC_SCHEMA_VERSION,
  };
}

// Custom event name for sync data changes
export const SYNC_DATA_CHANGED_EVENT = 'flyx_sync_data_changed';

/**
 * Dispatch event to notify components that sync data has changed
 */
function dispatchSyncDataChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SYNC_DATA_CHANGED_EVENT));
    console.log('[Sync] Dispatched sync data changed event');
  }
}

/**
 * Apply synced data to local storage
 */
export function applyRemoteSyncData(data: SyncData): void {
  if (typeof window === 'undefined') return;
  
  // Apply profile (merge with local, prefer remote name/icon/color if set)
  if (data.profile) {
    const localProfile = getAccountProfile();
    const mergedProfile = {
      ...localProfile,
      name: data.profile.name || localProfile.name,
      icon: data.profile.icon || localProfile.icon,
      color: data.profile.color || localProfile.color,
    };
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(mergedProfile));
  }
  
  // Apply watch progress
  if (data.watchProgress) {
    localStorage.setItem('flyx_watch_progress', JSON.stringify(data.watchProgress));
  }
  
  // Apply watchlist
  if (data.watchlist) {
    localStorage.setItem('flyx_watchlist', JSON.stringify(data.watchlist));
  }
  
  // Apply subtitle settings
  if (data.subtitleSettings) {
    localStorage.setItem('vynx_subtitle_preferences', JSON.stringify({
      enabled: data.subtitleSettings.enabled,
      languageCode: data.subtitleSettings.languageCode,
      languageName: data.subtitleSettings.languageName,
      style: {
        fontSize: data.subtitleSettings.fontSize,
        textColor: data.subtitleSettings.textColor,
        backgroundColor: data.subtitleSettings.backgroundColor,
        backgroundOpacity: data.subtitleSettings.backgroundOpacity,
        verticalPosition: data.subtitleSettings.verticalPosition,
      },
    }));
  }
  
  // Apply player settings
  if (data.playerSettings) {
    const existingPlayer = localStorage.getItem('flyx_player_preferences');
    const existing = existingPlayer ? JSON.parse(existingPlayer) : {};
    localStorage.setItem('flyx_player_preferences', JSON.stringify({
      ...existing,
      ...data.playerSettings,
    }));
  }
  
  // Apply provider settings
  if (data.providerSettings) {
    localStorage.setItem('flyx_provider_settings', JSON.stringify(data.providerSettings));
    
    // Also update anime preferences in player settings for backward compatibility
    const playerRaw = localStorage.getItem('flyx_player_preferences');
    const playerPrefs = playerRaw ? JSON.parse(playerRaw) : {};
    playerPrefs.animeAudioPreference = data.providerSettings.animeAudioPreference;
    playerPrefs.preferredAnimeKaiServer = data.providerSettings.preferredAnimeKaiServer;
    localStorage.setItem('flyx_player_preferences', JSON.stringify(playerPrefs));
  }
  
  // Update last sync timestamp
  localStorage.setItem(LAST_SYNC_STORAGE_KEY, data.lastSyncedAt.toString());
  
  // Notify all components that sync data has changed
  dispatchSyncDataChanged();
}

/**
 * Merge local and remote data
 * For both watchlist AND watch progress: remote wins for deletions
 * Server is the source of truth - if something is deleted on one device, it stays deleted
 */
export function mergeSyncData(local: SyncData, remote: SyncData, strategy: 'local' | 'remote' | 'newest' = 'newest'): SyncData {
  const merged: SyncData = {
    profile: local.profile || remote.profile,
    watchProgress: {},
    watchlist: [],
    providerSettings: { ...DEFAULT_PROVIDER_SETTINGS },
    subtitleSettings: local.subtitleSettings,
    playerSettings: local.playerSettings,
    lastSyncedAt: Date.now(),
    schemaVersion: SYNC_SCHEMA_VERSION,
  };
  
  const remoteLastSync = remote.lastSyncedAt || 0;
  const localLastSync = local.lastSyncedAt || 0;
  
  // Merge watch progress - REMOTE WINS for deletions (same as watchlist)
  // If an item exists locally but not remotely, it was deleted on another device
  // Only keep local-only items if they were modified AFTER the remote sync timestamp
  if (strategy === 'remote' || remoteLastSync > localLastSync) {
    // Remote is newer - start with remote watch progress
    // Only add local items that were updated AFTER the remote sync
    const remoteKeys = new Set(Object.keys(remote.watchProgress || {}));
    
    // Start with remote watch progress
    for (const [key, item] of Object.entries(remote.watchProgress || {})) {
      merged.watchProgress[key] = item;
    }
    
    // Add local items that are NEW or UPDATED after remote sync
    for (const [key, item] of Object.entries(local.watchProgress || {})) {
      if (!remoteKeys.has(key)) {
        // Item exists locally but not remotely
        // Only keep if it was watched AFTER the remote sync (new local watch)
        if (item.lastWatched > remoteLastSync) {
          console.log(`[Sync] Keeping new local watch progress: ${key} (watched at ${item.lastWatched}, remote sync at ${remoteLastSync})`);
          merged.watchProgress[key] = item;
        } else {
          console.log(`[Sync] Removing deleted watch progress: ${key} (was deleted on another device)`);
        }
      } else {
        // Item exists in both - keep the one with newer lastWatched
        const remoteItem = remote.watchProgress![key];
        if (item.lastWatched > remoteItem.lastWatched) {
          merged.watchProgress[key] = item;
        }
      }
    }
  } else {
    // Local is newer - start with local watch progress
    const localKeys = new Set(Object.keys(local.watchProgress || {}));
    
    // Start with local watch progress
    for (const [key, item] of Object.entries(local.watchProgress || {})) {
      merged.watchProgress[key] = item;
    }
    
    // Add remote items that are NEW or UPDATED after local sync
    for (const [key, item] of Object.entries(remote.watchProgress || {})) {
      if (!localKeys.has(key)) {
        if (item.lastWatched > localLastSync) {
          merged.watchProgress[key] = item;
        }
      } else {
        // Item exists in both - keep the one with newer lastWatched
        const localItem = local.watchProgress![key];
        if (item.lastWatched > localItem.lastWatched) {
          merged.watchProgress[key] = item;
        }
      }
    }
  }
  
  // Merge watchlist - REMOTE WINS for deletions
  if (strategy === 'remote' || remoteLastSync > localLastSync) {
    // Remote is newer - use remote watchlist as base
    // Only add local items that were added AFTER the remote sync
    const remoteIds = new Set((remote.watchlist || []).map(item => item.id));
    const watchlistMap = new Map<string | number, typeof merged.watchlist[0]>();
    
    // Start with remote watchlist
    for (const item of remote.watchlist || []) {
      watchlistMap.set(item.id, item);
    }
    
    // Add local items that are NEW (added after last sync)
    for (const item of local.watchlist || []) {
      if (!remoteIds.has(item.id) && item.addedAt > remoteLastSync) {
        // This is a new local addition, keep it
        watchlistMap.set(item.id, item);
      }
    }
    
    merged.watchlist = Array.from(watchlistMap.values())
      .sort((a, b) => b.addedAt - a.addedAt);
  } else {
    // Local is newer or same - use local watchlist as base
    const localIds = new Set((local.watchlist || []).map(item => item.id));
    const watchlistMap = new Map<string | number, typeof merged.watchlist[0]>();
    
    // Start with local watchlist
    for (const item of local.watchlist || []) {
      watchlistMap.set(item.id, item);
    }
    
    // Add remote items that are NEW (added after last local sync)
    for (const item of remote.watchlist || []) {
      if (!localIds.has(item.id) && item.addedAt > localLastSync) {
        watchlistMap.set(item.id, item);
      }
    }
    
    merged.watchlist = Array.from(watchlistMap.values())
      .sort((a, b) => b.addedAt - a.addedAt);
  }
  
  // Provider settings - use local (user's current device preference)
  merged.providerSettings = local.providerSettings || remote.providerSettings || DEFAULT_PROVIDER_SETTINGS;
  
  // Subtitle/player settings - use local
  merged.subtitleSettings = local.subtitleSettings || remote.subtitleSettings;
  merged.playerSettings = local.playerSettings || remote.playerSettings;
  
  return merged;
}

/**
 * Get empty sync data structure
 */
function getEmptySyncData(): SyncData {
  return {
    profile: DEFAULT_PROFILE,
    watchProgress: {},
    watchlist: [],
    providerSettings: DEFAULT_PROVIDER_SETTINGS,
    subtitleSettings: {
      enabled: true,
      languageCode: 'eng',
      languageName: 'English',
      fontSize: 100,
      textColor: '#ffffff',
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      backgroundOpacity: 80,
      verticalPosition: 90,
    },
    playerSettings: {
      autoPlayNextEpisode: true,
      autoPlayCountdown: 10,
      showNextEpisodeBeforeEnd: 90,
      volume: 1,
      isMuted: false,
    },
    lastSyncedAt: 0,
    schemaVersion: SYNC_SCHEMA_VERSION,
  };
}

// ============================================================================
// Provider Settings Management
// ============================================================================

const PROVIDER_SETTINGS_KEY = 'flyx_provider_settings';

export function getProviderSettings(): ProviderSettings {
  if (typeof window === 'undefined') return DEFAULT_PROVIDER_SETTINGS;
  
  try {
    const stored = localStorage.getItem(PROVIDER_SETTINGS_KEY);
    if (stored) {
      return { ...DEFAULT_PROVIDER_SETTINGS, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.error('[ProviderSettings] Error reading:', e);
  }
  
  return DEFAULT_PROVIDER_SETTINGS;
}

export function saveProviderSettings(settings: Partial<ProviderSettings>): void {
  if (typeof window === 'undefined') return;
  
  const current = getProviderSettings();
  const updated = { ...current, ...settings };
  
  try {
    localStorage.setItem(PROVIDER_SETTINGS_KEY, JSON.stringify(updated));
  } catch (e) {
    console.error('[ProviderSettings] Error saving:', e);
  }
}

export function setProviderOrder(order: string[]): void {
  saveProviderSettings({ providerOrder: order });
}

export function toggleProvider(provider: string, enabled: boolean): void {
  const settings = getProviderSettings();
  const disabled = new Set(settings.disabledProviders);
  
  if (enabled) {
    disabled.delete(provider);
  } else {
    disabled.add(provider);
  }
  
  saveProviderSettings({ disabledProviders: Array.from(disabled) });
}

export function recordSuccessfulProvider(contentId: string, provider: string): void {
  const settings = getProviderSettings();
  saveProviderSettings({
    lastSuccessfulProviders: {
      ...settings.lastSuccessfulProviders,
      [contentId]: provider,
    },
  });
}

export function getLastSuccessfulProvider(contentId: string): string | null {
  const settings = getProviderSettings();
  return settings.lastSuccessfulProviders[contentId] || null;
}
