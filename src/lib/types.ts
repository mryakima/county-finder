/**
 * Shared types for County Finder.
 *
 * COORDINATE ORDER NOTE:
 *   Browser Geolocation API → { latitude, longitude }
 *   GeoJSON coordinates      → [longitude, latitude]  (lon first!)
 *   rbush bbox               → { minX, minY, maxX, maxY } where X=lon, Y=lat
 *
 * Always be explicit when converting between these.
 */

import type { Polygon, MultiPolygon } from "geojson";

// ── Processed county record (server-side, loaded from JSON) ──────────────────

export interface CountyRecord {
  geoid: string; // "35003"
  stateFp: string; // "35"
  countyFp: string; // "003"
  name: string; // "Catron"
  nameLsad: string; // "Catron County"
  stateName: string; // "New Mexico"
  stateAbbr: string; // "NM"
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  geometry: Polygon | MultiPolygon;
}

export interface ProcessedDataFile {
  meta: {
    source: string;
    downloadedAt: string;
    featureCount: number;
    datasetYear: string;
    datasetScale: string;
  };
  counties: CountyRecord[];
}

// ── API request / response ────────────────────────────────────────────────────

export interface LookupRequest {
  lat: number;
  lon: number;
}

export interface LookupSuccess {
  ok: true;
  stateName: string; // "New Mexico"
  stateAbbr: string; // "NM"
  countyName: string; // "Catron County"
  countyBaseName: string; // "Catron"
  geoid: string; // "35003"
  lat: number;
  lon: number;
  lookupTimestamp: string; // ISO-8601
  dataset: string; // "U.S. Census TIGER 2024 cartographic boundary / 1:20m"
  matchMethod: "point-in-polygon";
  boundaryWarning: boolean;
  /**
   * County geometry included in the API response so the client can cache it
   * for offline verification. Clients should save this, then strip it from
   * display data.
   */
  geometry?: Polygon | MultiPolygon;
}

export type ErrorCode =
  | "INVALID_COORDINATES"
  | "OUT_OF_SCOPE"
  | "NO_MATCH"
  | "SERVER_ERROR"
  | "DATA_NOT_READY";

export interface LookupError {
  ok: false;
  errorCode: ErrorCode;
  message: string;
}

export type LookupResponse = LookupSuccess | LookupError;

// ── Client-side cache ─────────────────────────────────────────────────────────

export interface CachedResult {
  result: LookupSuccess;
  positionLat: number;
  positionLon: number;
  positionAccuracy: number;
  positionTimestamp: number; // Date.now()
  cachedAt: number; // Date.now()
  /** Simplified county geometry for offline PIP verification */
  geometry: Polygon | MultiPolygon;
  datasetVersion: string;
}

// ── UI state ──────────────────────────────────────────────────────────────────

export type AppStatus =
  | "init" // Starting up
  | "locating" // Waiting for geolocation fix
  | "permission_denied" // User denied location permission
  | "no_geolocation" // Browser doesn't support geolocation
  | "geo_timeout" // Geolocation timed out
  | "geo_error" // Other geolocation error
  | "looking_up" // Have position, calling API
  | "success" // Got county result
  | "out_of_scope" // Coordinates outside 50 states + DC
  | "no_match" // API couldn't match (rare boundary case)
  | "api_error" // API call failed
  | "offline_verified" // Offline, position confirmed inside cached county
  | "offline_unverified" // Offline, position outside or unknown vs cached county
  | "offline_no_position" // Offline, couldn't get position, showing cache only
  | "offline_no_cache"; // Offline and no cache available

export interface PositionSnapshot {
  lat: number;
  lon: number;
  accuracy: number; // meters
  timestamp: number; // milliseconds since epoch
}
