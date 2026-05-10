/**
 * Cloudflare Sync Client
 * 
 * Provides sync functions that communicate with the Cloudflare Sync Worker.
 * Implements graceful degradation with localStorage fallback when the worker is unavailable.
 * 
 * Features:
 * - Watch progress sync
 * - Watchlist sync
 * - Settings sync (provider, subtitle, player)
 * - localStorage fallback
 * - Retry logic with exponential backoff
 * 
 * Requirements: 9.1, 9.2, 9.4
 */

import type { SyncData, WatchProgressItem, WatchlistSyncItem, ProviderSettings, SubtitleSettings, PlayerSettings } from './types';
import { SYNC_SCHEMA_VERSION, DEFAULT_PROFILE } from './types';

// Configuration
const CF_SYNC_WORKER_URL = process.env.NEXT_PUBLIC_CF_SYNC_URL || 'https://flyx-sync.vynx-3b3.workers.dev';
const REQUEST_TIMEOUT = 5000; // 5 seconds
const MAX_RETRIES = 2;
const RETRY_DELAY_BASE = 1000; // 1 second base delay

// Local storage keys for fallback
const LOCAL_SYNC_DATA_KEY = 'flyx_local_sync_data';
const LOCAL_WATCH_PROGRESS_KEY = 'flyx_watch_progress';
const LOCAL_WATCHLIST_KEY = 'flyx_watchlist';
const LOCAL_PROVIDER_SETTINGS_KEY = 'flyx_provider_settings';
const LOCAL_SUBTITLE_SETTINGS_KEY = 'vynx_subtitle_preferences';
const LOCAL_PLAYER_SETTINGS_KEY = 'flyx_player_preferences';
const LOCAL_PROFILE_KEY = 'flyx_account_profile';

// Types
export interface SyncResponse {
  success: boolean;
  data?: SyncData | null;
  message?: string;
  lastSyncedAt?: number;
  isNew?: boolean;
  error?: string;
  source?: 'worker' | 'local' | 'none';
}

// Track worker availability for graceful degradation
let workerAvailable = true;
let lastFailureTime = 0;
const FAILURE_COOLDOWN = 30000; // 30 seconds before retrying after failure

/**
 * Check if the sync worker is currently available
 */
export function isSyncWorkerAvailable(): boolean {
  if (!workerAvailable) {
    // Check if cooldown period has passed
    if (Date.now() - lastFailureTime > FAILURE_COOLDOWN) {
      workerAvailable = true;
    }
  }
  return workerAvailable;
}

/**
 * Mark the worker as unavailable (for graceful degradation)
 */
function markWorkerUnavailable(): void {
  workerAvailable = false;
  lastFailureTime = Date.now();
  console.warn('[CloudflareSync] Worker marked as unavailable, will retry after cooldown');
}

/**
 * Reset worker availability (for testing or manual recovery)
 */
export function resetWorkerAvailability(): void {
  workerAvailable = true;
  lastFailureTime = 0;
}

/**
 * Make a request to the sync worker with timeout and retry logic
 */
async function makeRequest(
  method: 'GET' | 'POST' | 'DELETE',
  syncCode: string,
  data?: unknown,
  options: { retries?: number } = {}
): Promise<SyncResponse> {
  const { retries = MAX_RETRIES } = options;
  
  // Check if worker is available (graceful degradation)
  if (!isSyncWorkerAvailable()) {
    return { success: false, error: 'Worker temporarily unavailable', source: 'none' };
  }
  
  const url = `${CF_SYNC_WORKER_URL}/sync`;
  
  // Standard fetch with timeout and retry
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      
      const requestOptions: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Sync-Code': syncCode,
        },
        signal: controller.signal,
      };
      
      if (data && method === 'POST') {
        requestOptions.body = JSON.stringify(data);
      }
      
      const response = await fetch(url, requestOptions);
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const result = await response.json();
      return { ...result, source: 'worker' } as SyncResponse;
      
    } catch (error) {
      const isLastAttempt = attempt === retries;
      
      if (isLastAttempt) {
        // Mark worker as unavailable after all retries fail
        markWorkerUnavailable();
        console.error('[CloudflareSync] Request failed after retries:', error);
        return { success: false, error: String(error), source: 'none' };
      }
      
      // Exponential backoff before retry
      const delay = RETRY_DELAY_BASE * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return { success: false, error: 'Unknown error', source: 'none' };
}

/**
 * Get local sync data from localStorage (fallback)
 */
function getLocalSyncData(): SyncData {
  if (typeof window === 'undefined') {
    return getEmptySyncData();
  }
  
  try {
    // Try to get cached sync data first
    const cachedData = localStorage.getItem(LOCAL_SYNC_DATA_KEY);
    if (cachedData) {
      return JSON.parse(cachedData);
    }
    
    // Otherwise, collect from individual storage keys
    const watchProgressRaw = localStorage.getItem(LOCAL_WATCH_PROGRESS_KEY);
    const watchlistRaw = localStorage.getItem(LOCAL_WATCHLIST_KEY);
    const providerSettingsRaw = localStorage.getItem(LOCAL_PROVIDER_SETTINGS_KEY);
    const subtitleSettingsRaw = localStorage.getItem(LOCAL_SUBTITLE_SETTINGS_KEY);
    const playerSettingsRaw = localStorage.getItem(LOCAL_PLAYER_SETTINGS_KEY);
    const profileRaw = localStorage.getItem(LOCAL_PROFILE_KEY);
    
    return {
      profile: profileRaw ? JSON.parse(profileRaw) : DEFAULT_PROFILE,
      watchProgress: watchProgressRaw ? JSON.parse(watchProgressRaw) : {},
      watchlist: watchlistRaw ? JSON.parse(watchlistRaw) : [],
      providerSettings: providerSettingsRaw ? JSON.parse(providerSettingsRaw) : getDefaultProviderSettings(),
      subtitleSettings: subtitleSettingsRaw ? JSON.parse(subtitleSettingsRaw) : getDefaultSubtitleSettings(),
      playerSettings: playerSettingsRaw ? JSON.parse(playerSettingsRaw) : getDefaultPlayerSettings(),
      lastSyncedAt: 0,
      schemaVersion: SYNC_SCHEMA_VERSION,
    };
  } catch (error) {
    console.error('[CloudflareSync] Error reading local data:', error);
    return getEmptySyncData();
  }
}

/**
 * Save sync data to localStorage (fallback)
 */
function saveLocalSyncData(data: SyncData): void {
  if (typeof window === 'undefined') return;
  
  try {
    // Save to individual keys for component access
    if (data.watchProgress) {
      localStorage.setItem(LOCAL_WATCH_PROGRESS_KEY, JSON.stringify(data.watchProgress));
    }
    if (data.watchlist) {
      localStorage.setItem(LOCAL_WATCHLIST_KEY, JSON.stringify(data.watchlist));
    }
    if (data.providerSettings) {
      localStorage.setItem(LOCAL_PROVIDER_SETTINGS_KEY, JSON.stringify(data.providerSettings));
    }
    if (data.subtitleSettings) {
      localStorage.setItem(LOCAL_SUBTITLE_SETTINGS_KEY, JSON.stringify(data.subtitleSettings));
    }
    if (data.playerSettings) {
      localStorage.setItem(LOCAL_PLAYER_SETTINGS_KEY, JSON.stringify(data.playerSettings));
    }
    if (data.profile) {
      localStorage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(data.profile));
    }
    
    // Also cache the full sync data
    localStorage.setItem(LOCAL_SYNC_DATA_KEY, JSON.stringify(data));
  } catch (error) {
    console.error('[CloudflareSync] Error saving local data:', error);
  }
}

/**
 * Sync watch progress to the Cloudflare Sync Worker
 * Falls back to localStorage if worker is unavailable
 * 
 * @param syncCode - The user's sync code
 * @param progress - Watch progress data to sync
 * @returns Promise resolving to sync response
 * 
 * Requirements: 9.1
 */
export async function syncWatchProgress(
  syncCode: string,
  progress: WatchProgressItem
): Promise<SyncResponse> {
  if (!syncCode) {
    // No sync code - save locally only
    saveWatchProgressLocally(progress);
    return { success: true, source: 'local', message: 'Saved locally (no sync code)' };
  }
  
  // First, get current sync data
  const currentData = await loadSyncData(syncCode);
  
  // Update watch progress
  const key = progress.contentType === 'tv' 
    ? `${progress.contentId}_s${progress.seasonNumber || 1}_e${progress.episodeNumber || 1}`
    : progress.contentId;
  
  const updatedData: SyncData = {
    ...(currentData.data || getEmptySyncData()),
    watchProgress: {
      ...(currentData.data?.watchProgress || {}),
      [key]: progress,
    },
    lastSyncedAt: Date.now(),
  };
  
  // Try to sync to worker
  const result = await makeRequest('POST', syncCode, updatedData);
  
  if (!result.success || result.source === 'none') {
    // Worker unavailable - save locally
    saveLocalSyncData(updatedData);
    return { success: true, source: 'local', message: 'Saved locally (worker unavailable)' };
  }
  
  // Also update local cache
  saveLocalSyncData(updatedData);
  
  return result;
}

/**
 * Save watch progress to localStorage only
 */
function saveWatchProgressLocally(progress: WatchProgressItem): void {
  if (typeof window === 'undefined') return;
  
  try {
    const key = progress.contentType === 'tv' 
      ? `${progress.contentId}_s${progress.seasonNumber || 1}_e${progress.episodeNumber || 1}`
      : progress.contentId;
    
    const existingRaw = localStorage.getItem(LOCAL_WATCH_PROGRESS_KEY);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    
    existing[key] = progress;
    localStorage.setItem(LOCAL_WATCH_PROGRESS_KEY, JSON.stringify(existing));
  } catch (error) {
    console.error('[CloudflareSync] Error saving watch progress locally:', error);
  }
}

/**
 * Load sync data from the Cloudflare Sync Worker
 * Falls back to localStorage if worker is unavailable
 * 
 * @param syncCode - The user's sync code
 * @returns Promise resolving to sync data
 * 
 * Requirements: 9.2
 */
export async function loadSyncData(
  syncCode: string
): Promise<{ success: boolean; data?: SyncData; source: 'worker' | 'local' | 'none' }> {
  if (!syncCode) {
    // No sync code - return local data
    const localData = getLocalSyncData();
    return { success: true, data: localData, source: 'local' };
  }
  
  // Try to load from worker
  const result = await makeRequest('GET', syncCode);
  
  if (result.success && result.data) {
    // Update local cache with remote data
    saveLocalSyncData(result.data);
    return { success: true, data: result.data, source: 'worker' };
  }
  
  if (result.success && result.isNew) {
    // New sync code - no data yet
    return { success: true, data: undefined, source: 'worker' };
  }
  
  // Worker unavailable or error - fall back to local
  if (!result.success || result.source === 'none') {
    const localData = getLocalSyncData();
    if (localData.lastSyncedAt > 0 || Object.keys(localData.watchProgress).length > 0) {
      return { success: true, data: localData, source: 'local' };
    }
    return { success: false, source: 'none' };
  }
  
  return { success: false, source: 'none' };
}

/**
 * Push full sync data to the Cloudflare Sync Worker
 * 
 * @param syncCode - The user's sync code
 * @param data - Full sync data to push
 * @returns Promise resolving to sync response
 * 
 * Requirements: 9.1, 9.2
 */
export async function pushSyncData(
  syncCode: string,
  data: SyncData
): Promise<SyncResponse> {
  if (!syncCode) {
    // No sync code - save locally only
    saveLocalSyncData(data);
    return { success: true, source: 'local', message: 'Saved locally (no sync code)' };
  }
  
  const result = await makeRequest('POST', syncCode, {
    ...data,
    lastSyncedAt: Date.now(),
    schemaVersion: SYNC_SCHEMA_VERSION,
  });
  
  if (!result.success || result.source === 'none') {
    // Worker unavailable - save locally
    saveLocalSyncData(data);
    return { success: true, source: 'local', message: 'Saved locally (worker unavailable)' };
  }
  
  // Also update local cache
  saveLocalSyncData(data);
  
  return result;
}

/**
 * Delete sync account from the Cloudflare Sync Worker
 * 
 * @param syncCode - The user's sync code
 * @returns Promise resolving to sync response
 */
export async function deleteSyncAccount(syncCode: string): Promise<SyncResponse> {
  if (!syncCode) {
    return { success: false, error: 'No sync code provided', source: 'none' };
  }
  
  return makeRequest('DELETE', syncCode);
}

/**
 * Sync watchlist to the Cloudflare Sync Worker
 * 
 * @param syncCode - The user's sync code
 * @param watchlist - Watchlist items to sync
 * @returns Promise resolving to sync response
 * 
 * Requirements: 9.3
 */
export async function syncWatchlist(
  syncCode: string,
  watchlist: WatchlistSyncItem[]
): Promise<SyncResponse> {
  if (!syncCode) {
    // No sync code - save locally only
    if (typeof window !== 'undefined') {
      localStorage.setItem(LOCAL_WATCHLIST_KEY, JSON.stringify(watchlist));
    }
    return { success: true, source: 'local', message: 'Saved locally (no sync code)' };
  }
  
  // Get current sync data and update watchlist
  const currentData = await loadSyncData(syncCode);
  
  const updatedData: SyncData = {
    ...(currentData.data || getEmptySyncData()),
    watchlist,
    lastSyncedAt: Date.now(),
  };
  
  return pushSyncData(syncCode, updatedData);
}

/**
 * Health check for the sync worker
 * 
 * @returns Promise resolving to health status
 */
export async function checkSyncHealth(): Promise<{
  healthy: boolean;
  latency?: number;
  error?: string;
}> {
  const startTime = Date.now();
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    
    const response = await fetch(`${CF_SYNC_WORKER_URL}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    const latency = Date.now() - startTime;
    
    if (!response.ok) {
      return { healthy: false, latency, error: `HTTP ${response.status}` };
    }
    
    // Reset availability on successful health check
    resetWorkerAvailability();
    
    return { healthy: true, latency };
  } catch (error) {
    return { healthy: false, error: String(error) };
  }
}

// Helper functions for default values
function getEmptySyncData(): SyncData {
  return {
    profile: DEFAULT_PROFILE,
    watchProgress: {},
    watchlist: [],
    providerSettings: getDefaultProviderSettings(),
    subtitleSettings: getDefaultSubtitleSettings(),
    playerSettings: getDefaultPlayerSettings(),
    lastSyncedAt: 0,
    schemaVersion: SYNC_SCHEMA_VERSION,
  };
}

function getDefaultProviderSettings(): ProviderSettings {
  return {
    providerOrder: ['flixer', 'uflix', 'vidsrc', '1movies', 'animekai'],
    disabledProviders: [],
    lastSuccessfulProviders: {},
    animeAudioPreference: 'sub',
    preferredAnimeKaiServer: null,
  };
}

function getDefaultSubtitleSettings(): SubtitleSettings {
  return {
    enabled: true,
    languageCode: 'eng',
    languageName: 'English',
    fontSize: 100,
    textColor: '#ffffff',
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    backgroundOpacity: 80,
    verticalPosition: 90,
  };
}

function getDefaultPlayerSettings(): PlayerSettings {
  return {
    autoPlayNextEpisode: true,
    autoPlayCountdown: 10,
    showNextEpisodeBeforeEnd: 90,
    volume: 1,
    isMuted: false,
  };
}

// Export for testing
export { getLocalSyncData, saveLocalSyncData, getEmptySyncData };
