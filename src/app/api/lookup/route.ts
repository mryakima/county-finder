/**
 * POST /api/lookup
 *
 * Accepts { lat, lon } in the request body and returns the U.S. county/state
 * for those coordinates.
 *
 * PRIVACY: Coordinates are passed in the POST body — NOT in query strings —
 * to reduce the risk of lat/lon appearing in server access logs, browser
 * history, or proxy/CDN logs.
 *
 * Server-side logging is intentionally minimal. Raw coordinates are not logged.
 * If LOG_COUNTY_RESULTS=true, only the resolved county name (not the coordinates)
 * is written to stdout.
 */

import { NextRequest, NextResponse } from "next/server";
import { lookupCounty } from "@/lib/spatial";
import type { LookupRequest, LookupError } from "@/lib/types";

// Only POST is allowed — GET with coordinates in the URL is intentionally unsupported.
export async function GET() {
  return NextResponse.json(
    {
      ok: false as const,
      errorCode: "SERVER_ERROR" as const,
      message: "Use POST with a JSON body: { lat, lon }",
    } satisfies LookupError,
    { status: 405, headers: { Allow: "POST" } }
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        errorCode: "INVALID_COORDINATES",
        message: "Request body must be valid JSON: { lat: number, lon: number }",
      } satisfies LookupError,
      { status: 400 }
    );
  }

  // Validate input
  if (!body || typeof body !== "object") {
    return jsonError("INVALID_COORDINATES", "Request body must be an object.", 400);
  }

  const req = body as Partial<LookupRequest>;

  const lat = req.lat;
  const lon = req.lon;

  if (typeof lat !== "number" || typeof lon !== "number") {
    return jsonError("INVALID_COORDINATES", "lat and lon must be numbers.", 400);
  }

  if (!isFinite(lat) || !isFinite(lon)) {
    return jsonError("INVALID_COORDINATES", "lat and lon must be finite numbers.", 400);
  }

  // Valid geographic range
  if (lat < -90 || lat > 90) {
    return jsonError("INVALID_COORDINATES", "lat must be between -90 and 90.", 400);
  }
  if (lon < -180 || lon > 180) {
    return jsonError("INVALID_COORDINATES", "lon must be between -180 and 180.", 400);
  }

  // Perform lookup
  const result = lookupCounty(lat, lon);

  if (!result.ok) {
    const status =
      result.errorCode === "DATA_NOT_READY"
        ? 503
        : result.errorCode === "INVALID_COORDINATES"
          ? 400
          : result.errorCode === "OUT_OF_SCOPE" || result.errorCode === "NO_MATCH"
            ? 404
            : 500;

    return NextResponse.json(result, { status });
  }

  // PRIVACY: Only log the county name, never the raw coordinates.
  if (process.env.LOG_COUNTY_RESULTS === "true") {
    console.log(`[lookup] ${result.countyName}, ${result.stateName}`);
  }

  // Include the geometry in the response so the client can cache it for offline verification.
  // The geometry is looked up from the spatial module here.
  return NextResponse.json(result);
}

function jsonError(
  errorCode: LookupError["errorCode"],
  message: string,
  status: number
): NextResponse {
  return NextResponse.json({ ok: false, errorCode, message } satisfies LookupError, { status });
}
