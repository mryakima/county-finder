"use client";

/**
 * CountyMapInner — Leaflet map rendered inside the county map modal.
 *
 * Layers (bottom → top):
 *   1. OpenStreetMap tile layer
 *   2. Nearby county polygons (gray outline, faint fill, tap for name)
 *   3. Current county polygon (green outline + fill)
 *   4. [LIVE] Dashed line: user position → nearest boundary point
 *   5. [LIVE] Boundary point dot
 *   6. [LIVE] Heading track line (orange, when device is moving)
 *   7. [LIVE] GPS accuracy circle
 *   8. [LIVE] User position dot (blue)
 *
 * LIVE layers are updated in-place whenever position props change — no map
 * recreation or flash. County polygons are static after initial load.
 */

import { useEffect, useRef, useState } from "react";
import type { Polygon, MultiPolygon } from "geojson";
import "leaflet/dist/leaflet.css";

// ── Types ─────────────────────────────────────────────────────────────────────

interface NearbyCounty {
  geoid: string;
  nameLsad: string;
  stateAbbr: string;
  labelCenter: [number, number]; // [lon, lat]
  geometry: Polygon | MultiPolygon;
}

export interface CountyMapProps {
  userLat: number;
  userLon: number;
  accuracy: number;
  /** Device heading in degrees (0–360, N=0, clockwise). Null when stationary. */
  heading: number | null;
  nearestBoundaryLat: number | null;
  nearestBoundaryLon: number | null;
  distanceToBoundaryM: number | null;
  currentCountyGeoid: string;
  currentCountyName: string;
  currentCountyGeometry: Polygon | MultiPolygon;
  adjacentCountyName: string | null;
  adjacentCountyState: string | null;
  onClose: () => void;
}

// ── Distance formatting (mirrors page.tsx) ────────────────────────────────────

function formatBoundaryDistance(m: number): string {
  const ft = m * 3.28084;
  const mi = m / 1609.344;
  if (ft < 528) return `${Math.round(ft)} ft`;
  if (mi < 10)  return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi)} mi`;
}

// ── Distance-based color (matches main UI) ────────────────────────────────────

function boundaryColor(m: number): string {
  const ft = m * 3.28084;
  if (ft < 300)  return "#e53935";
  if (ft < 2640) return "#fb8c00";
  return "#2e7d32";
}

// ── Destination point given origin, bearing (°), distance (m) ────────────────

function destinationPoint(
  lat: number, lon: number, bearingDeg: number, distM: number
): [number, number] {
  const R = 6371000;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const θ = (bearingDeg * Math.PI) / 180;
  const δ = distM / R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [(φ2 * 180) / Math.PI, ((λ2 * 180) / Math.PI + 540) % 360 - 180];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CountyMapInner(props: CountyMapProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef        = useRef<any>(null);   // Leaflet map instance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leafletRef    = useRef<any>(null);   // Leaflet library (loaded once)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const liveLayersRef = useRef<any[]>([]);   // layers removed+re-added on each position update

  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg,  setErrorMsg]  = useState("");

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Remove all live layers from the map.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function clearLiveLayers(map: any) {
    for (const layer of liveLayersRef.current) {
      try { map.removeLayer(layer); } catch { /* already removed */ }
    }
    liveLayersRef.current = [];
  }

  // Add all position-dependent layers and store refs for future cleanup.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function drawLiveLayers(L: any, map: any, p: CountyMapProps) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const added: any[] = [];

    // ── Nearest boundary line ───────────────────────────────────────────────
    if (p.nearestBoundaryLat !== null && p.nearestBoundaryLon !== null && p.distanceToBoundaryM !== null) {
      const lineColor  = boundaryColor(p.distanceToBoundaryM);
      const distLabel  = formatBoundaryDistance(p.distanceToBoundaryM);

      const line = L.polyline(
        [[p.userLat, p.userLon], [p.nearestBoundaryLat, p.nearestBoundaryLon]],
        { color: lineColor, weight: 2.5, dashArray: "7 5", opacity: 0.85 }
      ).addTo(map);
      added.push(line);

      const midLat = (p.userLat + p.nearestBoundaryLat) / 2;
      const midLon = (p.userLon + p.nearestBoundaryLon) / 2;
      const midMarker = L.marker([midLat, midLon], {
        icon: L.divIcon({
          html: `<span style="background:${lineColor};color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:10px;white-space:nowrap;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.35);">${distLabel}</span>`,
          className: "",
          iconAnchor: undefined,
        }),
        interactive: false,
        zIndexOffset: 200,
      }).addTo(map);
      added.push(midMarker);

      const boundaryDot = L.circleMarker([p.nearestBoundaryLat, p.nearestBoundaryLon], {
        radius: 5, color: "#fff", weight: 2,
        fillColor: lineColor, fillOpacity: 1,
      })
        .bindPopup(
          p.adjacentCountyName
            ? `<strong style="font-size:12px">County line</strong><br>→ ${p.adjacentCountyName}${p.adjacentCountyState ? `, ${p.adjacentCountyState}` : ""}`
            : "<strong>Coastline</strong>",
          { closeButton: false }
        )
        .addTo(map);
      added.push(boundaryDot);
    }

    // ── Heading track (direction of travel) ─────────────────────────────────
    if (p.heading !== null) {
      const trackEnd = destinationPoint(p.userLat, p.userLon, p.heading, 3000);
      const trackLine = L.polyline([[p.userLat, p.userLon], trackEnd], {
        color: "#FF6D00", weight: 3, opacity: 0.8,
      }).addTo(map);
      added.push(trackLine);

      const arrowMarker = L.marker(trackEnd, {
        icon: L.divIcon({
          html: `<div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:12px solid #FF6D00;transform:rotate(${p.heading}deg);transform-origin:center bottom;"></div>`,
          className: "",
          iconSize: [12, 12],
          iconAnchor: [6, 12],
        }),
        interactive: false,
      }).addTo(map);
      added.push(arrowMarker);
    }

    // ── GPS accuracy circle ──────────────────────────────────────────────────
    const accCircle = L.circle([p.userLat, p.userLon], {
      radius: p.accuracy,
      color: "#1976D2", fillColor: "#1976D2",
      fillOpacity: 0.08, weight: 1, dashArray: "4 3",
    }).addTo(map);
    added.push(accCircle);

    // ── User position dot ────────────────────────────────────────────────────
    const dot = L.circleMarker([p.userLat, p.userLon], {
      radius: 8, color: "#fff", weight: 2.5,
      fillColor: "#1976D2", fillOpacity: 1,
    })
      .bindPopup("<strong>Your position</strong>", { closeButton: false })
      .addTo(map);
    added.push(dot);

    liveLayersRef.current = added;
  }

  // ── Init effect — runs once ────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    (async () => {
      try {
        const L = (await import("leaflet")).default;
        if (cancelled || !containerRef.current) return;

        leafletRef.current = L;

        // Fetch nearby counties
        const resp = await fetch(`/api/nearby-counties?lat=${props.userLat}&lon=${props.userLon}`);
        if (!resp.ok) throw new Error("Failed to load county grid.");
        const { counties }: { counties: NearbyCounty[] } = await resp.json();
        if (cancelled || !containerRef.current) return;

        // Create map
        const map = L.map(containerRef.current, {
          center: [props.userLat, props.userLon],
          zoom: 10,
          zoomControl: true,
          attributionControl: true,
        });
        mapRef.current = map;

        // OSM tile layer
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19,
        }).addTo(map);

        // County grid (static — not updated on position change)
        for (const county of counties) {
          const isCurrent = county.geoid === props.currentCountyGeoid;
          const layer = L.geoJSON(county.geometry as Parameters<typeof L.geoJSON>[0], {
            style: isCurrent
              ? { color: "#4a7c3f", weight: 2.5, fillColor: "#c8e6c9", fillOpacity: 0.35 }
              : { color: "#888",    weight: 1,   fillColor: "#ffffff",  fillOpacity: 0.05 },
          });
          const label = county.stateAbbr ? `${county.nameLsad}, ${county.stateAbbr}` : county.nameLsad;
          layer.bindPopup(`<strong style="font-size:13px">${label}</strong>`, { closeButton: false, maxWidth: 200 });
          layer.addTo(map);

          if (isCurrent) {
            const [labelLon, labelLat] = county.labelCenter;
            L.marker([labelLat, labelLon], {
              icon: L.divIcon({
                html: `<span style="background:rgba(74,124,63,0.85);color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;white-space:nowrap;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.3)">${county.nameLsad}</span>`,
                className: "",
                iconAnchor: undefined,
              }),
              interactive: false,
              zIndexOffset: 100,
            }).addTo(map);
          }
        }

        // Initial live layers (position at mount time)
        drawLiveLayers(L, map, props);

        // Fit to current county
        const countyLayer = L.geoJSON(props.currentCountyGeometry as Parameters<typeof L.geoJSON>[0]);
        map.fitBounds(countyLayer.getBounds(), { padding: [24, 24], maxZoom: 12 });

        if (cancelled) return;
        setLoadState("ready");
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : "Map failed to load.");
        setLoadState("error");
      }
    })();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live update effect — re-draws moving layers on each position fix ────────
  useEffect(() => {
    const L   = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return; // map not ready yet (init still loading)

    clearLiveLayers(map);
    drawLiveLayers(L, map, props);
  }, [ // eslint-disable-line react-hooks/exhaustive-deps
    props.userLat,
    props.userLon,
    props.accuracy,
    props.heading,
    props.nearestBoundaryLat,
    props.nearestBoundaryLon,
    props.distanceToBoundaryM,
  ]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {loadState === "loading" && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(249,247,244,0.85)", fontSize: 14, color: "#666",
        }}>
          Loading map…
        </div>
      )}

      {loadState === "error" && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 1000,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          background: "#f9f7f4", padding: 24, textAlign: "center",
        }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontSize: 14, color: "#c62828", marginBottom: 8 }}>{errorMsg}</div>
          <button
            onClick={props.onClose}
            style={{
              marginTop: 8, padding: "8px 20px", borderRadius: 6,
              background: "#4a7c3f", color: "#fff", border: "none",
              fontSize: 14, fontWeight: 700, cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      )}

      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
