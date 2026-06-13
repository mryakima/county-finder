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

  // Spatial pre-filter: find candidate counties whose bounding box contains the point.
  // rbush X = longitude, Y = latitude
  const candidates = data.tree.search({
    minX: lon,
    minY: lat,
    maxX: lon,
    maxY: lat,
  });

  if (candidates.length === 0) {
    return {
      ok: false,
      errorCode: "OUT_OF_SCOPE",
      message: "Coordinates are outside the 50 states and Washington, DC.",
    };
  }

  // Exact point-in-polygon check against each candidate.
  // GeoJSON point expects [longitude, latitude] — NOT [latitude, longitude].
  const turfPoint = {
    type: "Feature" as const,
    properties: {},
    geometry: {
      type: "Point" as const,
      // ⚠ GeoJSON order: [longitude, latitude]
      coordinates: [lon, lat],
    },
  };

  for (const item of candidates) {
    const feature: Feature<Polygon | MultiPolygon> = {
      type: "Feature",
      properties: {},
      geometry: item.county.geometry,
    };

    if (booleanPointInPolygon(turfPoint, feature)) {
      const county = item.county;
      return {
        ok: true,
        stateName: county.stateName,
        stateAbbr: county.stateAbbr,
        countyName: county.nameLsad,
        countyBaseName: county.name,
        geoid: county.geoid,
        // Include geometry so client can cache it for offline PIP verification.
        geometry: county.geometry,
        lat,
        lon,
        lookupTimestamp: new Date().toISOString(),
        dataset: `U.S. Census TIGER ${data.meta.datasetYear} cartographic boundary / 1:${data.meta.datasetScale}`,
        matchMethod: "point-in-polygon",
        boundaryWarning: false,
      };
    }
  }

  // Point was within a bounding box but not inside any actual polygon.
  // This can happen for coastal/border points.
  return {
    ok: false,
    errorCode: "NO_MATCH",
    message:
      "Could not match coordinates to a county. The point may be near a boundary, coastline, or outside the mapped area.",
  };
}

/** Return dataset metadata for use in diagnostics. */
export function getDatasetMeta(): ProcessedDataFile["meta"] | null {
  return getData()?.meta ?? null;
}
