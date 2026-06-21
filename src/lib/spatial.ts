/**
 * Server-side spatial lookup engine.
 *
 * COORDINATE ORDER:
 *   Input: lat (latitude), lon (longitude) — browser convention
 *   rbush and GeoJSON use: X = longitude, Y = latitude
 *   @turf/boolean-point-in-polygon expects: point([longitude, latitude])
 *
 * This module is server-only. Never import it in client components.
 */

import path from "path";
import fs from "fs";
import RBush from "rbush";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, Polygon, MultiPolygon } from "geojson";
import type { CountyRecord, ProcessedDataFile, LookupSuccess, LookupError } from "./types";

// ── Data loading ──────────────────────────────────────────────────────────────

interface BBoxItem {
  // rbush uses X = longitude, Y = latitude
  minX: number; // min longitude
  minY: number; // min latitude
  maxX: number; // max longitude
  maxY: number; // max latitude
  county: CountyRecord;
}

interface LoadedData {
  tree: RBush<BBoxItem>;
  counties: CountyRecord[];
  meta: ProcessedDataFile["meta"];
}

let loadedData: LoadedData | null = null;
let loadError: string | null = null;

function getDataPath(): string {
  const envPath = process.env.COUNTY_DATA_PATH;
  if (envPath) return path.isAbsolute(envPath) ? envPath : path.join(process.cwd(), envPath);
  return path.join(process.cwd(), "data", "counties-processed.json");
}

function loadDataSync(): LoadedData | null {
  const dataPath = getDataPath();

  if (!fs.existsSync(dataPath)) {
    loadError = `County data file not found at: ${dataPath}. Run: npm run data:download`;
    console.error("[spatial] " + loadError);
    return null;
  }

  try {
    console.log("[spatial] Loading county data from:", dataPath);
    const raw = fs.readFileSync(dataPath, "utf-8");
    const parsed: ProcessedDataFile = JSON.parse(raw);

    const tree = new RBush<BBoxItem>(16);
    const items: BBoxItem[] = parsed.counties.map((county) => ({
      // bbox in CountyRecord is [minLon, minLat, maxLon, maxLat]
      minX: county.bbox[0],
      minY: county.bbox[1],
      maxX: county.bbox[2],
      maxY: county.bbox[3],
      county,
    }));

    tree.load(items);

    console.log(`[spatial] Loaded ${parsed.counties.length} counties; index built.`);
    loadError = null;
    return { tree, counties: parsed.counties, meta: parsed.meta };
  } catch (err) {
    loadError = `Failed to load county data: ${err instanceof Error ? err.message : String(err)}`;
    console.error("[spatial] " + loadError);
    return null;
  }
}

function getData(): LoadedData | null {
  if (loadedData) return loadedData;
  loadedData = loadDataSync();
  return loadedData;
}

// ── Lookup ────────────────────────────────────────────────────────────────────

/**
 * Internal: find the CountyRecord for a lat/lon without computing derived fields.
 * Does NOT call adjacentCountyLookup — use this to avoid recursion.
 */
function findCountyRecord(lat: number, lon: number): CountyRecord | null {
  const data = getData();
  if (!data) return null;

  const candidates = data.tree.search({ minX: lon, minY: lat, maxX: lon, maxY: lat });
  const turfPoint = {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Point" as const, coordinates: [lon, lat] },
  };

  for (const item of candidates) {
    const feature: Feature<Polygon | MultiPolygon> = {
      type: "Feature", properties: {}, geometry: item.county.geometry,
    };
    if (booleanPointInPolygon(turfPoint, feature)) return item.county;
  }
  return null;
}

/**
 * Look up the county/state for a given lat/lon pair.
 *
 * @param lat - Latitude (browser convention, degrees north)
 * @param lon - Longitude (browser convention, degrees east; negative = west)
 */
export function lookupCounty(
  lat: number,
  lon: number
): LookupSuccess | LookupError {
  const data = getData();

  if (!data) {
    return {
      ok: false,
      errorCode: "DATA_NOT_READY",
      message: loadError ?? "County data not loaded. Run: npm run data:download",
    };
  }

  // Quick bounding-box pre-filter before PIP
  const bboxCandidates = data.tree.search({ minX: lon, minY: lat, maxX: lon, maxY: lat });
  if (bboxCandidates.length === 0) {
    return {
      ok: false,
      errorCode: "OUT_OF_SCOPE",
      message: "Coordinates are outside the 50 states and Washington, DC.",
    };
  }

  const county = findCountyRecord(lat, lon);

  if (!county) {
    // Had bbox candidates but no PIP match — coastal or boundary edge case
    return {
      ok: false,
      errorCode: "NO_MATCH",
      message: "Could not match coordinates to a county. The point may be near a boundary, coastline, or outside the mapped area.",
    };
  }

  // Compute distance/bearing to nearest boundary, and find the adjacent county.
  const { distanceM, bearing, nearLat, nearLon } = distanceToBoundary(lat, lon, county.geometry);
  const adj = adjacentCountyLookup(nearLat, nearLon, bearing, county.geoid);

  return {
    ok: true,
    stateName: county.stateName,
    stateAbbr: county.stateAbbr,
    countyName: county.nameLsad,
    countyBaseName: county.name,
    geoid: county.geoid,
    bbox: county.bbox,
    geometry: county.geometry,
    distanceToBoundaryM: distanceM,
    bearingToBoundary: bearing,
    nearestBoundaryLat: nearLat,
    nearestBoundaryLon: nearLon,
    adjacentCountyName: adj?.name ?? null,
    adjacentCountyState: adj?.stateAbbr ?? null,
    lat,
    lon,
    lookupTimestamp: new Date().toISOString(),
    dataset: `U.S. Census TIGER ${data.meta.datasetYear} cartographic boundary / 1:${data.meta.datasetScale}`,
    matchMethod: "point-in-polygon",
    boundaryWarning: false,
  };
}

// ── Boundary distance / bearing ──────────────────────────────────────────────
// Implemented without extra dependencies.
// All inputs/outputs in lat/lon (browser convention).
// GeoJSON coordinates are [longitude, latitude] — conversions noted inline.

/** Haversine distance in meters between two lat/lon points. */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing in degrees (0–360, clockwise from north) from point 1 to point 2. */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/**
 * Find the nearest point on a polygon ring to (lat, lon).
 * Ring coordinates are GeoJSON order: [longitude, latitude].
 */
function nearestOnRing(
  lat: number,
  lon: number,
  ring: number[][]
): { nearLat: number; nearLon: number; distM: number } {
  let minDist = Infinity;
  let nearLat = lat;
  let nearLon = lon;

  for (let i = 0; i < ring.length - 1; i++) {
    // GeoJSON: coord = [longitude, latitude]
    const ax = ring[i][0],     ay = ring[i][1];     // lon, lat of vertex A
    const bx = ring[i + 1][0], by = ring[i + 1][1]; // lon, lat of vertex B

    // Project (lon, lat) onto segment A→B in lon/lat space.
    // Not perfectly geodetic, but accurate enough at county scale.
    const dx = bx - ax;
    const dy = by - ay;
    let t = 0;
    if (dx !== 0 || dy !== 0) {
      t = Math.max(0, Math.min(1, ((lon - ax) * dx + (lat - ay) * dy) / (dx * dx + dy * dy)));
    }
    const nx = ax + t * dx; // nearest lon on segment
    const ny = ay + t * dy; // nearest lat on segment

    // ny = latitude, nx = longitude (GeoJSON was [lon, lat])
    const d = haversineMeters(lat, lon, ny, nx);
    if (d < minDist) {
      minDist = d;
      nearLat = ny;
      nearLon = nx;
    }
  }

  return { nearLat, nearLon, distM: minDist };
}

/**
 * Returns the distance in meters and bearing to the nearest county boundary
 * from the given (lat, lon).
 *
 * Checks all rings (exterior + holes, all polygons of a MultiPolygon)
 * so enclaves are handled correctly.
 */
/**
 * Compute a destination point given origin, bearing (degrees), and distance (meters).
 * Uses the spherical law of cosines (accurate for county-scale distances).
 */
function destinationPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distanceM: number
): { lat: number; lon: number } {
  const R = 6371000;
  const δ = distanceM / R;
  const θ = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
  return { lat: (φ2 * 180) / Math.PI, lon: (λ2 * 180) / Math.PI };
}

export function distanceToBoundary(
  lat: number,
  lon: number,
  geometry: Polygon | MultiPolygon
): { distanceM: number; bearing: number; nearLat: number; nearLon: number } {
  let minDist = Infinity;
  let bestLat = lat;
  let bestLon = lon;

  const rings: number[][][] =
    geometry.type === "Polygon"
      ? (geometry.coordinates as number[][][])
      : (geometry.coordinates.flat() as number[][][]);

  for (const ring of rings) {
    const { nearLat, nearLon, distM } = nearestOnRing(lat, lon, ring as number[][]);
    if (distM < minDist) {
      minDist = distM;
      bestLat = nearLat;
      bestLon = nearLon;
    }
  }

  return {
    distanceM: minDist,
    bearing: bearingDeg(lat, lon, bestLat, bestLon),
    nearLat: bestLat,
    nearLon: bestLon,
  };
}

/**
 * Look up the county on the other side of the nearest boundary.
 * Steps 200 m past the boundary point in the same direction.
 * Returns null if the adjacent area is water or outside scope.
 */
export function adjacentCountyLookup(
  nearLat: number,
  nearLon: number,
  bearing: number,
  currentGeoid: string
): { name: string; stateAbbr: string } | null {
  // Step 200 m beyond the boundary point.
  // Uses findCountyRecord (not lookupCounty) to avoid infinite recursion.
  const beyond = destinationPoint(nearLat, nearLon, bearing, 200);
  const county = findCountyRecord(beyond.lat, beyond.lon);

  if (!county) return null;
  if (county.geoid === currentGeoid) return null; // guard: still same county
  return { name: county.nameLsad, stateAbbr: county.stateAbbr };
}

/**
 * Return all county records whose bounding boxes overlap a box of `degreePad`
 * degrees around (lat, lon). Used to fetch a county grid for map rendering.
 * Returns an empty array if data is not loaded.
 */
export function getNearbyCounties(
  lat: number,
  lon: number,
  degreePad: number = 1.5
): CountyRecord[] {
  const data = getData();
  if (!data) return [];
  const results = data.tree.search({
    minX: lon - degreePad,
    minY: lat - degreePad,
    maxX: lon + degreePad,
    maxY: lat + degreePad,
  });
  return results.map((r) => r.county);
}

/** Return dataset metadata for use in diagnostics. */
export function getDatasetMeta(): ProcessedDataFile["meta"] | null {
  return getData()?.meta ?? null;
}
