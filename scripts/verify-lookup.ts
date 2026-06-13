/**
 * scripts/verify-lookup.ts
 *
 * CLI verification script. Runs a set of known coordinates through the
 * spatial lookup engine and prints pass/fail results.
 *
 * Requires: data/counties-processed.json (run `npm run data:download` first)
 *
 * Run: npm run verify
 */

import path from "path";
import fs from "fs";

process.chdir(path.resolve(__dirname, ".."));

import { lookupCounty } from "../src/lib/spatial";
import type { LookupSuccess, LookupError } from "../src/lib/types";

interface TestCase {
  description: string;
  lat: number;
  lon: number;
  expectOk: boolean;
  expectedCounty?: string; // partial match on countyBaseName
  expectedState?: string;
  expectedErrorCode?: string;
}

const TEST_CASES: TestCase[] = [
  // ── Happy paths ──────────────────────────────────────────────────────────
  {
    description: "Catron County, New Mexico (33.9, -108.4)",
    lat: 33.9,
    lon: -108.4,
    expectOk: true,
    expectedCounty: "Catron",
    expectedState: "New Mexico",
  },
  {
    description: "Bernalillo County, NM — Albuquerque (35.0844, -106.6504)",
    lat: 35.0844,
    lon: -106.6504,
    expectOk: true,
    expectedCounty: "Bernalillo",
    expectedState: "New Mexico",
  },
  {
    description: "Los Angeles County, CA (34.0522, -118.2437)",
    lat: 34.0522,
    lon: -118.2437,
    expectOk: true,
    expectedCounty: "Los Angeles",
    expectedState: "California",
  },
  {
    description: "New York County, NY — Manhattan (40.7831, -73.9712)",
    lat: 40.7831,
    lon: -73.9712,
    expectOk: true,
    expectedCounty: "New York",
    expectedState: "New York",
  },
  {
    description: "Washington, DC (38.9072, -77.0369)",
    lat: 38.9072,
    lon: -77.0369,
    expectOk: true,
    expectedCounty: "District of Columbia",
    expectedState: "District of Columbia",
  },
  {
    description: "Cook County, IL — Chicago (41.8781, -87.6298)",
    lat: 41.8781,
    lon: -87.6298,
    expectOk: true,
    expectedCounty: "Cook",
    expectedState: "Illinois",
  },
  {
    description: "Maui County, HI (20.7984, -156.3319)",
    lat: 20.7984,
    lon: -156.3319,
    expectOk: true,
    expectedCounty: "Maui",
    expectedState: "Hawaii",
  },
  {
    description: "Anchorage Borough, AK (61.2181, -149.9003)",
    lat: 61.2181,
    lon: -149.9003,
    expectOk: true,
    expectedState: "Alaska",
  },
  // ── Out of scope ─────────────────────────────────────────────────────────
  {
    description: "Canada — Toronto (43.6532, -79.3832)",
    lat: 43.6532,
    lon: -79.3832,
    expectOk: false,
    expectedErrorCode: "OUT_OF_SCOPE",
  },
  {
    description: "Mexico — Mexico City (19.4326, -99.1332)",
    lat: 19.4326,
    lon: -99.1332,
    expectOk: false,
    expectedErrorCode: "OUT_OF_SCOPE",
  },
  {
    description: "Pacific Ocean (35.0, -150.0)",
    lat: 35.0,
    lon: -150.0,
    expectOk: false,
    // Could be OUT_OF_SCOPE or NO_MATCH depending on bbox
  },
  {
    description: "Atlantic Ocean (35.0, -40.0)",
    lat: 35.0,
    lon: -40.0,
    expectOk: false,
    expectedErrorCode: "OUT_OF_SCOPE",
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

const DATA_PATH = path.join(process.cwd(), "data", "counties-processed.json");
if (!fs.existsSync(DATA_PATH)) {
  console.error("\n[verify] ERROR: data/counties-processed.json not found.");
  console.error("[verify] Run: npm run data:download\n");
  process.exit(1);
}

let passed = 0;
let failed = 0;

console.log("\n=== County Finder — Verification Script ===\n");

for (const tc of TEST_CASES) {
  const result = lookupCounty(tc.lat, tc.lon);
  let ok = true;
  const issues: string[] = [];

  if (tc.expectOk && !result.ok) {
    ok = false;
    issues.push(`Expected ok=true, got error: ${(result as LookupError).errorCode}`);
  }

  if (!tc.expectOk && result.ok) {
    ok = false;
    issues.push(`Expected error, got: ${(result as LookupSuccess).countyName}, ${(result as LookupSuccess).stateName}`);
  }

  if (result.ok && tc.expectedCounty) {
    const success = result as LookupSuccess;
    if (!success.countyBaseName.includes(tc.expectedCounty)) {
      ok = false;
      issues.push(`Expected county "${tc.expectedCounty}", got "${success.countyBaseName}"`);
    }
  }

  if (result.ok && tc.expectedState) {
    const success = result as LookupSuccess;
    if (success.stateName !== tc.expectedState) {
      ok = false;
      issues.push(`Expected state "${tc.expectedState}", got "${success.stateName}"`);
    }
  }

  if (!result.ok && tc.expectedErrorCode) {
    const err = result as LookupError;
    if (err.errorCode !== tc.expectedErrorCode) {
      ok = false;
      issues.push(`Expected errorCode "${tc.expectedErrorCode}", got "${err.errorCode}"`);
    }
  }

  if (ok) {
    passed++;
    const detail = result.ok
      ? `${(result as LookupSuccess).countyName}, ${(result as LookupSuccess).stateName}`
      : `[${(result as LookupError).errorCode}]`;
    console.log(`  ✓  ${tc.description}`);
    console.log(`       → ${detail}`);
  } else {
    failed++;
    console.log(`  ✗  ${tc.description}`);
    for (const issue of issues) {
      console.log(`       ✗ ${issue}`);
    }
  }
  console.log();
}

console.log(`=== Results: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
  process.exit(1);
}
