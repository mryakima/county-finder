/**
 * Client-side offline cache and point-in-polygon utilities.
 *
 * Uses localStorage to persist the last successful lookup result,
 * including the county geometry for offline verification.
 *
 * COORDINATE ORDER:
 *   All functions accept lat/lon in browser convention (lat first).
 *   GeoJSON geometry coordinates are [longitude, latitude] internally.
 */

import type { CachedResult, LookupSuccess } from "./types";
import type { Polygon, MultiPolygon, Position } from "geojson";

const STORAGE_KEY = "county-finder:cached-result";

// ── Cache persistence ─────────────────────────────────────────────────────────

export function saveCache(
  result: LookupSuccess,
  lat: number,
  lon: number,
  accuracy: number,
  positionTimestamp: number,
  geometry: Polygon | MultiPolygon
): void {
  const entry: CachedResult = {
    result,
    positionLat: lat,
    positionLon: lon,
    positionAccuracy: accuracy,
    positionTimestamp,
    cachedAt: Date.now(),
    geometry,
    datasetVersion: result.dataset,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // localStorage might be unavailable (private mode, quota exceeded, etc.)
    console.warn("[offline] Could not save to localStorage");
  }
}

export function loadCache(): CachedResult | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedResult;
  } catch {
    return null;
  }
}

export function clearCache(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Client-side point-in-polygon ──────────────────────────────────────────────
// Ray-casting algorithm — avoids shipping turf.js to the browser bundle.
//
// ⚠ GeoJSON coordinate order: Position = [longitude, latitude]
// Our inputs are (lat, lon) in browser convention; we convert internally.

function ringContains(lon: number, lat: number, ring: Position[]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    // ring[i] = [longitude, latitude]
    const xi = ring[i][0]; // longitude of vertex i
    const yi = ring[i][1]; // latitude of vertex i
    const xj = ring[j][0];
    const yj = ring[j][1];
    // Ray cast along the latitude line
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonContains(lon: number, lat: number, rings: Position[][]): boolean {
  // First ring is the exterior boundary; subsequent rings are holes.
  if (!ringContains(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (ringContains(lon, lat, rings[i])) return false; // inside a hole → outside polygon
  }
  return true;
}

/**
 * Returns true if the given (lat, lon) is inside the geometry.
 *
 * @param lat - Latitude (browser convention)
 * @param lon - Longitude (browser convention)
 * @param geometry - GeoJSON Polygon or MultiPolygon (coordinates in [lon, lat] order)
 */
export function pointInGeometry(
  lat: number,
  lon: number,
  geometry: Polygon | MultiPolygon
): boolean {
  if (geometry.type === "Polygon") {
    return polygonContains(lon, lat, geometry.coordinates);
  }
  if (geometry.type === "MultiPolygon") {
    // Point is inside the MultiPolygon if it's inside any of its polygons.
    return geometry.coordinates.some((rings) => polygonContains(lon, lat, rings));
  }
  return false;
}

// ── Online/offline detection ──────────────────────────────────────────────────

export function isOnline(): boolean {
  // navigator.onLine can be unreliable but is the best we have in a browser.
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}
