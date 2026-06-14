/**
 * GET /api/nearby-counties?lat=&lon=
 *
 * Returns county geometries for all counties whose bounding boxes overlap
 * a ~1.5-degree box around the supplied coordinates. Used by the map modal
 * to render a county grid around the user's current position.
 *
 * Response is not privacy-sensitive (coordinates used only for bbox search;
 * not logged). GET is intentional — results are the same for any nearby point
 * within the same general area.
 */

import { NextRequest, NextResponse } from "next/server";
import { getNearbyCounties } from "@/lib/spatial";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const lat = parseFloat(searchParams.get("lat") ?? "");
  const lon = parseFloat(searchParams.get("lon") ?? "");

  if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json({ error: "Invalid lat/lon parameters." }, { status: 400 });
  }

  const counties = getNearbyCounties(lat, lon, 1.5);

  return NextResponse.json({
    counties: counties.map((c) => ({
      geoid: c.geoid,
      nameLsad: c.nameLsad,
      stateAbbr: c.stateAbbr,
      // bbox midpoint used for label positioning: [midLon, midLat]
      labelCenter: [
        (c.bbox[0] + c.bbox[2]) / 2,
        (c.bbox[1] + c.bbox[3]) / 2,
      ] as [number, number],
      geometry: c.geometry,
    })),
  });
}
