/**
 * scripts/download-data.ts
 *
 * Downloads the U.S. Census Bureau TIGER/Line cartographic county boundary
 * shapefile (1:20,000,000 scale), converts it to GeoJSON, filters to the
 * 50 states + Washington DC, and writes data/counties-processed.json.
 *
 * Data source:
 *   U.S. Census Bureau — Cartographic Boundary Files
 *   https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html
 *   File: cb_2024_us_county_20m.zip (shapefile, ~1.2 MB)
 *
 * Run: npm run data:download
 */

import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import unzipper from "unzipper";
import * as shapefile from "shapefile";
import type { Feature, Polygon, MultiPolygon, GeoJsonProperties } from "geojson";
import type { CountyRecord, ProcessedDataFile } from "../src/lib/types";

// ── Configuration ─────────────────────────────────────────────────────────────

const DATASET_YEAR = "2024";
const DATASET_SCALE = "500k";
const SHAPEFILE_URL =
  `https://www2.census.gov/geo/tiger/GENZ${DATASET_YEAR}/shp/cb_${DATASET_YEAR}_us_county_${DATASET_SCALE}.zip`;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const TMP_DIR = path.join(DATA_DIR, "tmp");
const ZIP_PATH = path.join(TMP_DIR, "counties.zip");
const OUTPUT_PATH = path.join(DATA_DIR, "counties-processed.json");

// ── State FIPS → name/abbreviation mapping ────────────────────────────────────
// Includes all 50 states + DC. Territories (60, 66, 69, 72, 78) are excluded.

const STATE_FIPS: Record<string, { name: string; abbr: string }> = {
  "01": { name: "Alabama", abbr: "AL" },
  "02": { name: "Alaska", abbr: "AK" },
  "04": { name: "Arizona", abbr: "AZ" },
  "05": { name: "Arkansas", abbr: "AR" },
  "06": { name: "California", abbr: "CA" },
  "08": { name: "Colorado", abbr: "CO" },
  "09": { name: "Connecticut", abbr: "CT" },
  "10": { name: "Delaware", abbr: "DE" },
  "11": { name: "District of Columbia", abbr: "DC" },
  "12": { name: "Florida", abbr: "FL" },
  "13": { name: "Georgia", abbr: "GA" },
  "15": { name: "Hawaii", abbr: "HI" },
  "16": { name: "Idaho", abbr: "ID" },
  "17": { name: "Illinois", abbr: "IL" },
  "18": { name: "Indiana", abbr: "IN" },
  "19": { name: "Iowa", abbr: "IA" },
  "20": { name: "Kansas", abbr: "KS" },
  "21": { name: "Kentucky", abbr: "KY" },
  "22": { name: "Louisiana", abbr: "LA" },
  "23": { name: "Maine", abbr: "ME" },
  "24": { name: "Maryland", abbr: "MD" },
  "25": { name: "Massachusetts", abbr: "MA" },
  "26": { name: "Michigan", abbr: "MI" },
  "27": { name: "Minnesota", abbr: "MN" },
  "28": { name: "Mississippi", abbr: "MS" },
  "29": { name: "Missouri", abbr: "MO" },
  "30": { name: "Montana", abbr: "MT" },
  "31": { name: "Nebraska", abbr: "NE" },
  "32": { name: "Nevada", abbr: "NV" },
  "33": { name: "New Hampshire", abbr: "NH" },
  "34": { name: "New Jersey", abbr: "NJ" },
  "35": { name: "New Mexico", abbr: "NM" },
  "36": { name: "New York", abbr: "NY" },
  "37": { name: "North Carolina", abbr: "NC" },
  "38": { name: "North Dakota", abbr: "ND" },
  "39": { name: "Ohio", abbr: "OH" },
  "40": { name: "Oklahoma", abbr: "OK" },
  "41": { name: "Oregon", abbr: "OR" },
  "42": { name: "Pennsylvania", abbr: "PA" },
  "44": { name: "Rhode Island", abbr: "RI" },
  "45": { name: "South Carolina", abbr: "SC" },
  "46": { name: "South Dakota", abbr: "SD" },
  "47": { name: "Tennessee", abbr: "TN" },
  "48": { name: "Texas", abbr: "TX" },
  "49": { name: "Utah", abbr: "UT" },
  "50": { name: "Vermont", abbr: "VT" },
  "51": { name: "Virginia", abbr: "VA" },
  "53": { name: "Washington", abbr: "WA" },
  "54": { name: "West Virginia", abbr: "WV" },
  "55": { name: "Wisconsin", abbr: "WI" },
  "56": { name: "Wyoming", abbr: "WY" },
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[download-data] ${msg}`);
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Downloading: ${url}`);
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    const req = client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(res.headers.location!, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    });

    req.on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function computeBbox(
  geometry: Polygon | MultiPolygon
): [number, number, number, number] {
  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity;

  const processRings = (rings: number[][][]) => {
    for (const ring of rings) {
      for (const coord of ring) {
        // GeoJSON: coord = [longitude, latitude]
        const lon = coord[0];
        const lat = coord[1];
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
  };

  if (geometry.type === "Polygon") {
    processRings(geometry.coordinates as number[][][]);
  } else {
    for (const poly of geometry.coordinates) {
      processRings(poly as number[][][]);
    }
  }

  return [minLon, minLat, maxLon, maxLat];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // 1. Download the ZIP
  if (!fs.existsSync(ZIP_PATH)) {
    await downloadFile(SHAPEFILE_URL, ZIP_PATH);
    log(`Downloaded to: ${ZIP_PATH}`);
  } else {
    log(`Using cached ZIP: ${ZIP_PATH}`);
  }

  // 2. Extract relevant shapefile entries
  log("Extracting shapefile...");
  let shpBuffer: Buffer | null = null;
  let dbfBuffer: Buffer | null = null;

  const zip = fs.createReadStream(ZIP_PATH).pipe(unzipper.Parse({ forceStream: true }));
  for await (const entry of zip) {
    const fileName: string = entry.path;
    if (fileName.endsWith(".shp")) {
      const chunks: Buffer[] = [];
      for await (const chunk of entry) chunks.push(chunk as Buffer);
      shpBuffer = Buffer.concat(chunks);
    } else if (fileName.endsWith(".dbf")) {
      const chunks: Buffer[] = [];
      for await (const chunk of entry) chunks.push(chunk as Buffer);
      dbfBuffer = Buffer.concat(chunks);
    } else {
      await entry.autodrain();
    }
  }

  if (!shpBuffer || !dbfBuffer) {
    throw new Error("Could not find .shp or .dbf files in the downloaded ZIP.");
  }

  // 3. Parse shapefile to GeoJSON features
  log("Parsing shapefile...");
  const source = await shapefile.open(
    shpBuffer.buffer as ArrayBuffer,
    dbfBuffer.buffer as ArrayBuffer
  );

  const counties: CountyRecord[] = [];
  let total = 0;
  let skipped = 0;

  while (true) {
    const result = await source.read();
    if (result.done) break;

    const feature = result.value as Feature<Polygon | MultiPolygon, GeoJsonProperties>;
    if (!feature.geometry) continue;
    total++;

    const props = feature.properties ?? {};
    const stateFp: string = String(props.STATEFP ?? props.statefp ?? "").padStart(2, "0");

    // Filter: only 50 states + DC
    if (!STATE_FIPS[stateFp]) {
      skipped++;
      continue;
    }

    const stateInfo = STATE_FIPS[stateFp];
    // Prefer STUSPS/STATE_NAME from shapefile if present; fall back to our map.
    const stateAbbr: string = String(props.STUSPS ?? props.stusps ?? stateInfo.abbr);
    const stateName: string = String(props.STATE_NAME ?? props.state_name ?? stateInfo.name);
    const countyFp: string = String(props.COUNTYFP ?? props.countyfp ?? "").padStart(3, "0");
    const geoid: string = String(props.GEOID ?? props.geoid ?? `${stateFp}${countyFp}`);
    const name: string = String(props.NAME ?? props.name ?? "Unknown");
    const nameLsad: string = String(props.NAMELSAD ?? props.namelsad ?? name);

    const geometry = feature.geometry as Polygon | MultiPolygon;
    const bbox = computeBbox(geometry);

    counties.push({
      geoid,
      stateFp,
      countyFp,
      name,
      nameLsad,
      stateName,
      stateAbbr,
      bbox,
      geometry,
    });
  }

  log(`Processed ${total} features; kept ${counties.length}, skipped ${skipped} territories.`);

  // 4. Write output
  const output: ProcessedDataFile = {
    meta: {
      source: `U.S. Census Bureau TIGER/Line cartographic boundary files, ${DATASET_YEAR} edition`,
      downloadedAt: new Date().toISOString(),
      featureCount: counties.length,
      datasetYear: DATASET_YEAR,
      datasetScale: DATASET_SCALE,
    },
    counties,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output));
  const sizeMb = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(1);
  log(`Wrote ${OUTPUT_PATH} (${sizeMb} MB, ${counties.length} counties)`);

  // 5. Clean up temp files
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  log("Done. Temp files removed.");
}

main().catch((err) => {
  console.error("[download-data] ERROR:", err.message ?? err);
  process.exit(1);
});
