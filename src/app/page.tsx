"use client";

/**
 * County Finder — main page
 *
 * State machine:
 *   init → locating → looking_up → success
 *                  ↘ permission_denied
 *                  ↘ no_geolocation
 *                  ↘ geo_timeout / geo_error
 *                               ↘ out_of_scope / no_match / api_error
 *
 *   On offline open:
 *   init → locating → offline_verified  (position inside cached county)
 *                   ↘ offline_unverified (position outside or unknown)
 *                   ↘ offline_no_position (can't get position, show cache only)
 *       → offline_no_cache (no position, no cache)
 */

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import type {
  AppStatus,
  LookupSuccess,
  CachedResult,
  PositionSnapshot,
} from "@/lib/types";
import { saveCache, loadCache, pointInGeometry, isOnline } from "@/lib/offline";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AppState {
  status: AppStatus;
  position: PositionSnapshot | null;
  result: LookupSuccess | null;
  cached: CachedResult | null;
  errorMessage: string | null;
}

// ── Coordinate formatting ─────────────────────────────────────────────────────

function fmt6(n: number): string {
  return n.toFixed(6);
}

function formatAccuracy(meters: number): string {
  if (meters < 10) return `±${meters.toFixed(1)} m`;
  return `±${Math.round(meters)} m`;
}

function formatBoundaryDistance(meters: number): string {
  const feet = meters * 3.28084;
  const miles = meters / 1609.344;
  if (feet < 528) return `${Math.round(feet)} ft`;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

function bearingToCardinal(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

function boundaryDistanceColor(meters: number): string {
  const feet = meters * 3.28084;
  if (feet < 300) return "var(--color-error)";
  if (feet < 2640) return "var(--color-warning)"; // < 0.5 mi
  return "var(--color-success)";
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatIso(iso: string): string {
  return formatTimestamp(new Date(iso).getTime());
}

function coordsCopyText(lat: number, lon: number): string {
  return `${fmt6(lat)}, ${fmt6(lon)}`;
}

function fullResultCopyText(
  result: LookupSuccess,
  position: PositionSnapshot | null
): string {
  const lines = [
    `${result.countyName}, ${result.stateName}`,
  ];
  if (position) {
    lines.push(`${fmt6(position.lat)}, ${fmt6(position.lon)}`);
    lines.push(`Accuracy: ${formatAccuracy(position.accuracy)}`);
  }
  lines.push(`Located: ${result.lookupTimestamp}`);
  return lines.join("\n");
}

// ── Copy button component ─────────────────────────────────────────────────────

function CopyButton({
  label,
  text,
  variant = "secondary",
}: {
  label: string;
  text: string;
  variant?: "primary" | "secondary" | "ghost";
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for browsers without clipboard API
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      className={`btn btn-${variant}`}
      onClick={handleCopy}
      aria-label={copied ? "Copied!" : label}
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function HomePage() {
  const [state, setState] = useState<AppState>({
    status: "init",
    position: null,
    result: null,
    cached: null,
    errorMessage: null,
  });

  const abortRef = useRef<AbortController | null>(null);

  // ── Core lookup flow ────────────────────────────────────────────────────────

  const runLookup = useCallback(async (position: PositionSnapshot) => {
    setState((s) => ({ ...s, status: "looking_up", position }));

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Coordinates go in the POST body — NOT in the URL.
        body: JSON.stringify({ lat: position.lat, lon: position.lon }),
        signal: controller.signal,
      });

      const data = await res.json();

      if (data.ok) {
        const result: LookupSuccess = data;
        const geometry = result.geometry;

        // Save to cache (with geometry for offline verification)
        if (geometry) {
          saveCache(
            result,
            position.lat,
            position.lon,
            position.accuracy,
            position.timestamp,
            geometry
          );
        }

        // Strip geometry from display state (it's large and not needed for UI)
        const displayResult: LookupSuccess = { ...result };
        delete displayResult.geometry;

        setState((s) => ({
          ...s,
          status: "success",
          result: displayResult,
          errorMessage: null,
        }));
      } else {
        const errorCode = data.errorCode as string;
        const status: AppStatus =
          errorCode === "OUT_OF_SCOPE"
            ? "out_of_scope"
            : errorCode === "NO_MATCH"
              ? "no_match"
              : "api_error";
        setState((s) => ({
          ...s,
          status,
          errorMessage: data.message,
        }));
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      // Network failure — try offline path with cached data
      const cached = loadCache();
      if (cached) {
        const inCounty = pointInGeometry(
          position.lat,
          position.lon,
          cached.geometry
        );
        setState((s) => ({
          ...s,
          cached,
          position,
          status: inCounty ? "offline_verified" : "offline_unverified",
          errorMessage: null,
        }));
      } else {
        setState((s) => ({
          ...s,
          status: "api_error",
          errorMessage: "Could not reach the server and no cached result is available.",
        }));
      }
    }
  }, []);

  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setState((s) => ({
        ...s,
        status: "no_geolocation",
        errorMessage: "Your browser does not support geolocation.",
      }));
      return;
    }

    setState((s) => ({ ...s, status: "locating", errorMessage: null }));

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const snapshot: PositionSnapshot = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        };

        if (!isOnline()) {
          // Offline: try local verification
          const cached = loadCache();
          if (cached) {
            const inCounty = pointInGeometry(
              snapshot.lat,
              snapshot.lon,
              cached.geometry
            );
            setState((s) => ({
              ...s,
              cached,
              position: snapshot,
              status: inCounty ? "offline_verified" : "offline_unverified",
            }));
          } else {
            setState((s) => ({
              ...s,
              position: snapshot,
              status: "offline_no_cache",
            }));
          }
          return;
        }

        runLookup(snapshot);
      },
      (err) => {
        let status: AppStatus = "geo_error";
        let message = err.message;

        if (err.code === GeolocationPositionError.PERMISSION_DENIED) {
          status = "permission_denied";
          message = "Location permission was denied.";
        } else if (err.code === GeolocationPositionError.TIMEOUT) {
          status = "geo_timeout";
          message = "Location request timed out. Try again in an open area.";
        }

        setState((s) => ({ ...s, status, errorMessage: message }));
      },
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 30000,
      }
    );
  }, [runLookup]);

  // ── Initial load ────────────────────────────────────────────────────────────

  useEffect(() => {
    const cached = loadCache();

    if (!isOnline()) {
      // Offline on first load — show cached or empty
      if (cached) {
        // Try to get current location for verification
        if (navigator.geolocation) {
          setState((s) => ({ ...s, cached, status: "locating" }));
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const snapshot: PositionSnapshot = {
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
                timestamp: pos.timestamp,
              };
              const inCounty = pointInGeometry(
                snapshot.lat,
                snapshot.lon,
                cached.geometry
              );
              setState((s) => ({
                ...s,
                position: snapshot,
                status: inCounty ? "offline_verified" : "offline_unverified",
              }));
            },
            () => {
              setState((s) => ({
                ...s,
                status: "offline_no_position",
              }));
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
          );
        } else {
          setState((s) => ({ ...s, cached, status: "offline_no_position" }));
        }
      } else {
        setState((s) => ({ ...s, status: "offline_no_cache" }));
      }
      return;
    }

    // Online: preload cached display while waiting, then request location
    if (cached) {
      setState((s) => ({ ...s, cached }));
    }
    requestLocation();

    // Listen for online/offline transitions
    const handleOffline = () => {
      setState((s) => {
        if (s.status === "locating" || s.status === "looking_up") {
          const c = loadCache();
          return c
            ? { ...s, cached: c, status: "offline_no_position" }
            : { ...s, status: "offline_no_cache" };
        }
        return s;
      });
    };
    window.addEventListener("offline", handleOffline);
    return () => window.removeEventListener("offline", handleOffline);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => {
    abortRef.current?.abort();
    requestLocation();
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="app-shell">
      <header className="app-header">
        <svg
          className="app-icon"
          viewBox="0 0 32 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <circle cx="16" cy="14" r="9" fill="var(--color-primary)" />
          <circle cx="16" cy="14" r="4" fill="white" />
          <path d="M16 23 L16 30" stroke="var(--color-primary)" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <h1>County Finder</h1>
      </header>

      <main className="app-main">
        {renderContent(state, handleRefresh)}
      </main>

      <footer className="app-footer">
        <Link href="/privacy">Privacy</Link>
        {" · "}
        Location is used only to find your county. Not stored.
      </footer>
    </div>
  );
}

// ── Content renderer (separated for clarity) ──────────────────────────────────

function renderContent(state: AppState, onRefresh: () => void) {
  const { status, position, result, cached, errorMessage } = state;

  // ── Locating / looking up ─────────────────────────────────────────────────

  if (status === "init" || status === "locating" || status === "looking_up") {
    return (
      <div className="status-card">
        <div className="status-badge locating">
          <span className="pulse-dot" />
          {status === "looking_up" ? "Looking up county…" : "Locating…"}
        </div>
        {/* Show stale cached result while we wait */}
        {cached && (
          <div className="county-display">
            <div className="county-name">{cached.result.countyBaseName}</div>
            <div className="state-name">{cached.result.stateName}</div>
            <div className="unverified-label">Last known — updating…</div>
          </div>
        )}
        {!cached && (
          <p style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-sm)" }}>
            Requesting location permission…
          </p>
        )}
      </div>
    );
  }

  // ── Success ───────────────────────────────────────────────────────────────

  if (status === "success" && result && position) {
    return (
      <>
        <div className="status-card">
          <div className="status-badge success">✓ Located</div>

          <div className="county-display">
            <div className="county-name">{result.countyName}</div>
            <div className="state-name">{result.stateName}</div>
          </div>

          {/* County line distance — prominent for birders */}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--color-bg)",
            borderRadius: "var(--radius-md)",
            padding: "var(--spacing-3) var(--spacing-4)",
            marginBottom: "var(--spacing-3)",
            border: `2px solid ${boundaryDistanceColor(result.distanceToBoundaryM)}`,
          }}>
            <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-muted)" }}>
              County line
            </span>
            <span style={{
              fontWeight: 700,
              fontSize: "var(--font-size-xl)",
              color: boundaryDistanceColor(result.distanceToBoundaryM),
              fontVariantNumeric: "tabular-nums",
            }}>
              {formatBoundaryDistance(result.distanceToBoundaryM)}{" "}
              <span style={{ fontSize: "var(--font-size-base)", opacity: 0.8 }}>
                {bearingToCardinal(result.bearingToBoundary)}
              </span>
            </span>
          </div>

          <div className="details-list">
            <div className="detail-row">
              <span className="detail-label">Accuracy</span>
              <span className="detail-value">{formatAccuracy(position.accuracy)}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Latitude</span>
              <span className="detail-value">{fmt6(position.lat)}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Longitude</span>
              <span className="detail-value">{fmt6(position.lon)}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Location time</span>
              <span className="detail-value">{formatTimestamp(position.timestamp)}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Lookup time</span>
              <span className="detail-value">{formatIso(result.lookupTimestamp)}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">GEOID</span>
              <span className="detail-value">{result.geoid}</span>
            </div>
          </div>

          <div className="btn-group">
            <button className="btn btn-primary" onClick={onRefresh}>
              ↻ Refresh
            </button>
            <CopyButton
              label="Copy coordinates"
              text={coordsCopyText(position.lat, position.lon)}
              variant="ghost"
            />
            <CopyButton
              label="Copy full result"
              text={fullResultCopyText(result, position)}
              variant="secondary"
            />
          </div>
        </div>
      </>
    );
  }

  // ── Offline verified ──────────────────────────────────────────────────────

  if (status === "offline_verified" && cached) {
    const pos = state.position;
    return (
      <div className="status-card">
        <div className="status-badge offline-verified">✓ Offline — verified locally</div>

        <div className="county-display">
          <div className="county-name">{cached.result.countyName}</div>
          <div className="state-name">{cached.result.stateName}</div>
        </div>

        <p style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)", marginBottom: "var(--spacing-3)" }}>
          Offline — verified inside cached county boundary.
          Connect to the internet to get a fresh lookup.
        </p>

        <div className="details-list">
          {pos && (
            <>
              <div className="detail-row">
                <span className="detail-label">Accuracy</span>
                <span className="detail-value">{formatAccuracy(pos.accuracy)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Latitude</span>
                <span className="detail-value">{fmt6(pos.lat)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Longitude</span>
                <span className="detail-value">{fmt6(pos.lon)}</span>
              </div>
            </>
          )}
          <div className="detail-row">
            <span className="detail-label">Last server lookup</span>
            <span className="detail-value">{formatIso(cached.result.lookupTimestamp)}</span>
          </div>
        </div>

        <div className="btn-group">
          <button className="btn btn-primary" onClick={onRefresh}>
            ↻ Try again
          </button>
          {pos && (
            <CopyButton
              label="Copy coordinates"
              text={coordsCopyText(pos.lat, pos.lon)}
              variant="ghost"
            />
          )}
        </div>
      </div>
    );
  }

  // ── Offline unverified ────────────────────────────────────────────────────

  if ((status === "offline_unverified" || status === "offline_no_position") && cached) {
    const pos = state.position;
    return (
      <div className="status-card">
        <div className="status-badge offline-unverified">
          ⚠ Offline — not verified
        </div>

        <div className="county-display">
          <div className="county-name">{cached.result.countyName}</div>
          <div className="state-name">{cached.result.stateName}</div>
          <div className="unverified-label">Last known — not verified</div>
        </div>

        <p style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)", marginBottom: "var(--spacing-3)" }}>
          {status === "offline_no_position"
            ? "Could not get your current location while offline. Showing last known county only."
            : "Your current location appears to be outside the last known county boundary. Connect to the internet to get a fresh lookup."}
        </p>

        <div className="details-list">
          <div className="detail-row">
            <span className="detail-label">Last server lookup</span>
            <span className="detail-value">{formatIso(cached.result.lookupTimestamp)}</span>
          </div>
          {pos && (
            <>
              <div className="detail-row">
                <span className="detail-label">Current latitude</span>
                <span className="detail-value">{fmt6(pos.lat)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Current longitude</span>
                <span className="detail-value">{fmt6(pos.lon)}</span>
              </div>
            </>
          )}
        </div>

        <div className="btn-group">
          <button className="btn btn-primary" onClick={onRefresh}>
            ↻ Try again
          </button>
        </div>
      </div>
    );
  }

  // ── Offline, no cache ─────────────────────────────────────────────────────

  if (status === "offline_no_cache") {
    return (
      <div className="info-block">
        <span className="icon">📡</span>
        <h2>You&apos;re offline</h2>
        <p>
          No previous county lookup is cached on this device.
          Connect to the internet and open County Finder to get started.
        </p>
        <div className="btn-group">
          <button className="btn btn-primary" onClick={onRefresh}>
            ↻ Try again
          </button>
        </div>
      </div>
    );
  }

  // ── Permission denied ─────────────────────────────────────────────────────

  if (status === "permission_denied") {
    return (
      <div className="info-block">
        <span className="icon">📍</span>
        <h2>Location permission needed</h2>
        <p>
          County Finder needs access to your device&apos;s location to identify
          which county you&apos;re in.
        </p>
        <p>To enable location access:</p>
        <ol>
          <li>Open your browser&apos;s site settings</li>
          <li>Find <strong>Location</strong> permissions</li>
          <li>Change it to <strong>Allow</strong></li>
          <li>Reload the page</li>
        </ol>
        <div className="btn-group">
          <button
            className="btn btn-primary"
            onClick={() => window.location.reload()}
          >
            ↻ Reload page
          </button>
        </div>
      </div>
    );
  }

  // ── No geolocation support ────────────────────────────────────────────────

  if (status === "no_geolocation") {
    return (
      <div className="info-block">
        <span className="icon">🌐</span>
        <h2>Geolocation not supported</h2>
        <p>
          Your browser does not support geolocation. Try opening County Finder
          in Chrome, Safari, or Firefox on a mobile device.
        </p>
      </div>
    );
  }

  // ── Out of scope ──────────────────────────────────────────────────────────

  if (status === "out_of_scope") {
    return (
      <div className="info-block">
        <span className="icon">🗺️</span>
        <h2>Outside the US</h2>
        <p>
          Your current coordinates appear to be outside the 50 U.S. states and
          Washington, DC. County Finder only covers the United States.
        </p>
        {state.position && (
          <p style={{ fontVariantNumeric: "tabular-nums" }}>
            {fmt6(state.position.lat)}, {fmt6(state.position.lon)}
          </p>
        )}
        <div className="btn-group">
          <button className="btn btn-primary" onClick={onRefresh}>
            ↻ Try again
          </button>
        </div>
      </div>
    );
  }

  // ── Geo timeout ───────────────────────────────────────────────────────────

  if (status === "geo_timeout") {
    return (
      <div className="info-block">
        <span className="icon">⏱</span>
        <h2>Location timed out</h2>
        <p>
          Could not get a location fix in time. Move to a more open area or
          check that location services are enabled, then try again.
        </p>
        <div className="btn-group">
          <button className="btn btn-primary" onClick={onRefresh}>
            ↻ Try again
          </button>
        </div>
      </div>
    );
  }

  // ── Catchall error ────────────────────────────────────────────────────────

  return (
    <div className="info-block">
      <span className="icon">⚠️</span>
      <h2>
        {status === "no_match"
          ? "County not found"
          : "Something went wrong"}
      </h2>
      <p>
        {errorMessage ??
          (status === "no_match"
            ? "Your coordinates could not be matched to a county. You may be near a coast or border."
            : "An unexpected error occurred.")}
      </p>
      <div className="btn-group">
        <button className="btn btn-primary" onClick={onRefresh}>
          ↻ Try again
        </button>
      </div>
    </div>
  );
}
