"use client";

/**
 * CountyMapInner — Leaflet map rendered inside the county map modal.
 *
 * Layers (bottom → top):
 *   1. OpenStreetMap tile layer
 *   2. Nearby county polygons (gray outline, faint fill, tap for name)
 *   3. Current county polygon (green outline + fill)
 *   4. Dashed line: user position → nearest boundary point
 *   5. Boundary point dot
 *   6. Heading track line (orange, when device is moving)
 *   7. GPS accuracy circle
 *   8. User position dot (blue)
 *
 * County name labels appear on tap/click (Leaflet popup). The current county
 * name is shown as a permanent tooltip so it is always visible.
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

// ── Distance formatting (mirrors page.tsx) ──────────────────────────────────

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
  if (ft < 300)  return "#e53935"; // red   — inside 300 ft
  if (ft < 2640) return "#fb8c00"; // amber — inside 0.5 mi
  return "#2e7d32";                // green — further out
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let leafletMap: any = null;

    (async () => {
      try {
        // Dynamic import — avoids SSR issues with window/document
        const L = (await import("leaflet")).default;

        if (cancelled || !containerRef.current) return;

        // ── Fetch nearby counties ─────────────────────────────────────────────
        const resp = await fetch(
          `/api/nearby-counties?lat=${props.userLat}&lon=${props.userLon}`
        );
        if (!resp.ok) throw new Error("Failed to load county grid.");
        const { counties }: { counties: NearbyCounty[] } = await resp.json();

        if (cancelled || !containerRef.current) return;

        // ── Create map ────────────────────────────────────────────────────────
        leafletMap = L.map(containerRef.current, {
          center: [props.userLat, props.userLon],
          zoom: 10,
          zoomControl: true,
          attributionControl: true,
        });

        // OSM tile layer
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19,
        }).addTo(leafletMap);

        // ── County grid ───────────────────────────────────────────────────────
        for (const county of counties) {
          const isCurrent = county.geoid === props.currentCountyGeoid;
          const layer = L.geoJSON(county.geometry as Parameters<typeof L.geoJSON>[0], {
            style: isCurrent
              ? { color: "#4a7c3f", weight: 2.5, fillColor: "#c8e6c9", fillOpacity: 0.35, dashArray: undefined }
              : { color: "#888",    weight: 1,   fillColor: "#ffffff",  fillOpacity: 0.05 },
          });

          // Popup on tap/click shows county name
          const label = county.stateAbbr
            ? `${county.nameLsad}, ${county.stateAbbr}`
            : county.nameLsad;

          layer.bindPopup(`<strong style="font-size:13px">${label}</strong>`, {
            closeButton: false,
            maxWidth: 200,
          });

          layer.addTo(leafletMap);

          // Permanent label for current county only
          if (isCurrent) {
            const [labelLon, labelLat] = county.labelCenter;
            L.marker([labelLat, labelLon], {
              icon: L.divIcon({
                html: `<span style="
                  background:rgba(74,124,63,0.85);color:#fff;
                  font-size:10px;font-weight:700;
                  padding:2px 6px;border-radius:3px;
                  white-space:nowrap;pointer-events:none;
                  box-shadow:0 1px 3px rgba(0,0,0,.3)
                ">${county.nameLsad}</span>`,
                className: "",
                iconAnchor: undefined,
              }),
              interactive: false,
              zIndexOffset: 100,
            }).addTo(leafletMap);
          }
        }

        // ── Nearest boundary line (omitted when offline — data not available) ──
        if (props.nearestBoundaryLat !== null && props.nearestBoundaryLon !== null && props.distanceToBoundaryM !== null) {
          const lineColor = boundaryColor(props.distanceToBoundaryM);

          L.polyline(
            [
              [props.userLat, props.userLon],
              [props.nearestBoundaryLat, props.nearestBoundaryLon],
            ],
            { color: lineColor, weight: 2.5, dashArray: "7 5", opacity: 0.85 }
          ).addTo(leafletMap);

          const midLat = (props.userLat + props.nearestBoundaryLat) / 2;
          const midLon = (props.userLon + props.nearestBoundaryLon) / 2;
          const distLabel = formatBoundaryDistance(props.distanceToBoundaryM);

          L.marker([midLat, midLon], {
            icon: L.divIcon({
              html: `<span style="
                background:${lineColor};color:#fff;
                font-size:11px;font-weight:700;
                padding:2px 7px;border-radius:10px;
                white-space:nowrap;pointer-events:none;
                box-shadow:0 1px 4px rgba(0,0,0,.35);
                letter-spacing:0.01em;
              ">${distLabel}</span>`,
              className: "",
              iconAnchor: undefined,
            }),
            interactive: false,
            zIndexOffset: 200,
          }).addTo(leafletMap);

          L.circleMarker([props.nearestBoundaryLat, props.nearestBoundaryLon], {
            radius: 5,
            color: "#fff",
            weight: 2,
            fillColor: lineColor,
            fillOpacity: 1,
          })
            .bindPopup(
              props.adjacentCountyName
                ? `<strong style="font-size:12px">County line</strong><br>→ ${props.adjacentCountyName}${props.adjacentCountyState ? `, ${props.adjacentCountyState}` : ""}`
                : "<strong>County line</strong>",
              { closeButton: false }
            )
            .addTo(leafletMap);
        }

        // ── Heading track (direction of travel) ───────────────────────────────
        if (props.heading !== null) {
          // Extend 3 km in the direction of travel
          const trackEnd = destinationPoint(props.userLat, props.userLon, props.heading, 3000);

          // Track line
          L.polyline([[props.userLat, props.userLon], trackEnd], {
            color: "#FF6D00",
            weight: 3,
            opacity: 0.8,
          }).addTo(leafletMap);

          // Arrowhead at the end using a rotated divIcon
          L.marker(trackEnd, {
            icon: L.divIcon({
              html: `<div style="
                width:0;height:0;
                border-left:6px solid transparent;
                border-right:6px solid transparent;
                border-bottom:12px solid #FF6D00;
                transform:rotate(${props.heading}deg);
                transform-origin:center bottom;
              "></div>`,
              className: "",
              iconSize: [12, 12],
              iconAnchor: [6, 12],
            }),
            interactive: false,
          }).addTo(leafletMap);
        }

        // ── GPS accuracy circle ───────────────────────────────────────────────
        L.circle([props.userLat, props.userLon], {
          radius: props.accuracy,
          color: "#1976D2",
          fillColor: "#1976D2",
          fillOpacity: 0.08,
          weight: 1,
          dashArray: "4 3",
        }).addTo(leafletMap);

        // ── User position dot ─────────────────────────────────────────────────
        L.circleMarker([props.userLat, props.userLon], {
          radius: 8,
          color: "#fff",
          weight: 2.5,
          fillColor: "#1976D2",
          fillOpacity: 1,
        })
          .bindPopup("<strong>Your position</strong>", { closeButton: false })
          .addTo(leafletMap);

        // ── Fit to current county ─────────────────────────────────────────────
        // Fit bounds to the current county geometry, then ensure user is visible.
        const countyLayer = L.geoJSON(props.currentCountyGeometry as Parameters<typeof L.geoJSON>[0]);
        const countyBounds = countyLayer.getBounds();
        leafletMap.fitBounds(countyBounds, { padding: [24, 24], maxZoom: 12 });

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
      if (leafletMap) {
        leafletMap.remove();
        leafletMap = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Loading overlay */}
      {loadState === "loading" && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(249,247,244,0.85)",
          fontSize: 14, color: "#666",
        }}>
          Loading map…
        </div>
      )}

      {/* Error state */}
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

      {/* Map container */}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
