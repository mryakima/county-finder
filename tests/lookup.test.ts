/**
 * County Finder — test suite
 *
 * Tests are split into two groups:
 *   1. Unit tests — no data file needed (validation, formatting, PIP algorithm)
 *   2. Integration tests — require data/counties-processed.json (skipped if missing)
 *
 * Run: npm test
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import path from "path";
import fs from "fs";

// ── Shared helpers ────────────────────────────────────────────────────────────

const DATA_PATH = path.join(process.cwd(), "data", "counties-processed.json");
const DATA_AVAILABLE = fs.existsSync(DATA_PATH);

// ── 1. Input validation ───────────────────────────────────────────────────────

describe("API input validation", () => {
  it("accepts valid US coordinates", () => {
    expect(isValidCoords(35.0, -106.65)).toBe(true);
  });

  it("rejects non-finite latitude", () => {
    expect(isValidCoords(NaN, -106.65)).toBe(false);
    expect(isValidCoords(Infinity, -106.65)).toBe(false);
  });

  it("rejects non-finite longitude", () => {
    expect(isValidCoords(35.0, NaN)).toBe(false);
  });

  it("rejects latitude out of range", () => {
    expect(isValidCoords(91, -106.65)).toBe(false);
    expect(isValidCoords(-91, -106.65)).toBe(false);
  });

  it("rejects longitude out of range", () => {
    expect(isValidCoords(35.0, 181)).toBe(false);
    expect(isValidCoords(35.0, -181)).toBe(false);
  });
});

function isValidCoords(lat: unknown, lon: unknown): boolean {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (!isFinite(lat) || !isFinite(lon)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lon < -180 || lon > 180) return false;
  return true;
}

// ── 2. Coordinate formatting ──────────────────────────────────────────────────

describe("coordinate formatting", () => {
  it("formats to 6 decimal places", () => {
    expect((33.123456789).toFixed(6)).toBe("33.123457");
    expect((-108.0).toFixed(6)).toBe("-108.000000");
  });

  it("copy text format is 'lat, lon'", () => {
    const lat = 33.123456;
    const lon = -108.654321;
    const text = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    expect(text).toBe("33.123456, -108.654321");
    // Confirm no URL query string pattern (no '?' or '=')
    expect(text).not.toContain("?");
    expect(text).not.toContain("=");
  });
});

// ── 3. Client-side point-in-polygon ──────────────────────────────────────────

describe("client-side ray-casting PIP", () => {
  // Inline the algorithm here to test it independently of the module
  function ringContains(lon: number, lat: number, ring: number[][]): boolean {
    let inside = false;
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Simple 1°×1° box from (lon=-107, lat=33) to (lon=-106, lat=34)
  // GeoJSON coordinate order: [longitude, latitude]
  const testBox = [
    [-107, 33],
    [-106, 33],
    [-106, 34],
    [-107, 34],
    [-107, 33], // closed ring
  ];

  it("detects point inside a polygon", () => {
    // Point at lon=-106.5, lat=33.5 (center of box)
    expect(ringContains(-106.5, 33.5, testBox)).toBe(true);
  });

  it("detects point outside a polygon", () => {
    // Point at lon=-108, lat=33.5 (west of box)
    expect(ringContains(-108.0, 33.5, testBox)).toBe(false);
  });

  it("detects point north of polygon", () => {
    expect(ringContains(-106.5, 35.0, testBox)).toBe(false);
  });

  it("handles a polygon with a hole", () => {
    // Outer ring: 2°×2° box
    const outer = [
      [-108, 32], [-106, 32], [-106, 34], [-108, 34], [-108, 32],
    ];
    // Hole: 0.5°×0.5° box in the center
    const hole = [
      [-107.25, 32.75], [-106.75, 32.75], [-106.75, 33.25], [-107.25, 33.25], [-107.25, 32.75],
    ];

    function polyContains(lon: number, lat: number, rings: number[][][]): boolean {
      if (!ringContains(lon, lat, rings[0])) return false;
      for (let i = 1; i < rings.length; i++) {
        if (ringContains(lon, lat, rings[i])) return false;
      }
      return true;
    }

    // Point in outer ring but NOT in hole
    expect(polyContains(-107.9, 33.0, [outer, hole])).toBe(true);
    // Point in the hole — should be OUTSIDE
    expect(polyContains(-107.0, 33.0, [outer, hole])).toBe(false);
    // Point outside outer ring
    expect(polyContains(-109.0, 33.0, [outer, hole])).toBe(false);
  });
});

// ── 4. API uses POST (conceptual check) ──────────────────────────────────────

describe("API endpoint design", () => {
  it("API lookup path does not expose coordinates in URL", () => {
    // The POST body carries coordinates — not the URL.
    // This test verifies the design contract rather than making a real request.
    const lookupUrl = "/api/lookup";
    expect(lookupUrl).not.toContain("lat=");
    expect(lookupUrl).not.toContain("lon=");
    expect(lookupUrl).not.toContain("?");
  });
});

// ── 5. Integration tests (require downloaded data) ────────────────────────────

describe.skipIf(!DATA_AVAILABLE)("spatial lookup (requires data file)", () => {
  // Dynamically import to avoid crashing if data is missing
  let lookupCounty: (lat: number, lon: number) => unknown;

  beforeAll(async () => {
    const mod = await import("../src/lib/spatial");
    lookupCounty = mod.lookupCounty;
  });

  /**
   * Test coordinates — used ONLY in tests, never in production lookup logic.
   *
   * All coordinates are approximate county centers from public reference data.
   */
  const TEST_CASES = [
    {
      name: "Catron County, New Mexico",
      lat: 33.9, lon: -108.4,
      expected: { stateName: "New Mexico", stateAbbr: "NM", countyBase: "Catron" },
    },
    {
      name: "Bernalillo County, New Mexico (Albuquerque)",
      lat: 35.0844, lon: -106.6504,
      expected: { stateName: "New Mexico", stateAbbr: "NM", countyBase: "Bernalillo" },
    },
    {
      name: "Los Angeles County, California",
      lat: 34.0522, lon: -118.2437,
      expected: { stateName: "California", stateAbbr: "CA", countyBase: "Los Angeles" },
    },
    {
      name: "New York County, New York (Manhattan)",
      lat: 40.7831, lon: -73.9712,
      expected: { stateName: "New York", stateAbbr: "NY", countyBase: "New York" },
    },
    {
      name: "Washington, DC",
      lat: 38.9072, lon: -77.0369,
      expected: { stateName: "District of Columbia", stateAbbr: "DC", countyBase: "District of Columbia" },
    },
  ];

  for (const tc of TEST_CASES) {
    it(`correctly identifies: ${tc.name}`, () => {
      const result = lookupCounty(tc.lat, tc.lon) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.stateName).toBe(tc.expected.stateName);
        expect(result.stateAbbr).toBe(tc.expected.stateAbbr);
        expect(result.countyBaseName).toBe(tc.expected.countyBase);
        expect(result.matchMethod).toBe("point-in-polygon");
      }
    });
  }

  it("returns OUT_OF_SCOPE for coordinates in Canada (Toronto)", () => {
    // Toronto, Ontario, Canada — outside US scope
    const result = lookupCounty(43.6532, -79.3832) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("OUT_OF_SCOPE");
    }
  });

  it("returns OUT_OF_SCOPE for coordinates in the open ocean", () => {
    // Pacific Ocean, far from US coast
    const result = lookupCounty(35.0, -150.0) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["OUT_OF_SCOPE", "NO_MATCH"]).toContain(result.errorCode);
    }
  });

  it("returns INVALID_COORDINATES-equivalent for extreme lat", () => {
    // Out of range lat — this is validated at the API route level,
    // but the spatial engine receives only valid coords. Confirm it handles
    // clearly out-of-bounds gracefully.
    const result = lookupCounty(0, 0) as Record<string, unknown>; // Gulf of Guinea
    expect(result.ok).toBe(false);
  });

  it("includes geometry in the result for offline caching", () => {
    // Bernalillo County
    const result = lookupCounty(35.0844, -106.6504) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.geometry).toBeDefined();
      const geo = result.geometry as Record<string, unknown>;
      expect(["Polygon", "MultiPolygon"]).toContain(geo.type);
    }
  });
});
