/**
 * Media Types - Content models for movies and TV shows
 */

export interface Genre {
  id: number;
  name: string;
}

export interface MediaItem {
  id: number | string;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  mediaType?: 'movie' | 'tv' | 'person';
  media_type?: 'movie' | 'tv' | 'person';
  genres?: Genre[];
  genre_ids?: number[];
  runtime?: number;
  seasons?: Season[];
  // Person specific
  profile_path?: string;
  known_for?: MediaItem[];
  // Legacy support for backward compatibility
  posterPath?: string;
  backdropPath?: string;
  releaseDate?: string;
  rating?: number;
  voteCount?: number;
  // AniList/MAL support
  imageUrl?: string;
  year?: number;
  episodes?: number;
  format?: string;
}

export interface Season {
  seasonNumber: number;
  episodeCount: number;
  episodes: Episode[];
}

export interface Episode {
  id: string;
  episodeNumber: number;
  seasonNumber: number;
  title: string;
  overview: string;
  stillPath: string;
  airDate: string;
  runtime: number;
}

export interface SearchResult {
  id: string;
  title: string;
  posterPath: string;
  mediaType: 'movie' | 'tv' | 'person';
  releaseDate: string;
  rating: number;
  popularity?: number;
}

export interface StreamSource {
  url: string;
  quality: 'auto' | '1080p' | '720p' | '480p' | '360p';
  type: 'hls' | 'mp4';
  title?: string;
  language?: string;
  metadata?: {
    extractedAt?: number;
    source?: string;
    requiresProxy?: boolean;
    [key: string]: any;
  };
}

export interface SubtitleTrack {
  label: string;
  language: string;
  url: string;
}

export interface VideoData {
  sources: StreamSource[];
  subtitles: SubtitleTrack[];
  poster?: string;
  duration?: number;
}
