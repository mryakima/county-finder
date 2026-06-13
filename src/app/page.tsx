"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import type { AppStatus, LookupSuccess, CachedResult, PositionSnapshot } from "@/lib/types";
import { saveCache, loadCache, pointInGeometry, isOnline } from "@/lib/offline";

// ── Types ─────────────────────────────────────────────────────────────────────

type CoordFormat = "decimal" | "dms";

// ── Coordinate utilities ──────────────────────────────────────────────────────

function fmt6(n: number): string { return n.toFixed(6); }

function toDMS(decimal: number, isLat: boolean): string {
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const minFull = (abs - deg) * 60;
  const min = Math.floor(minFull);
  const sec = ((minFull - min) * 60).toFixed(1);
  const dir = isLat ? (decimal >= 0 ? "N" : "S") : (decimal >= 0 ? "E" : "W");
  return `${deg}°${min}′${sec}″${dir}`;
}

function fmtLat(n: number, fmt: CoordFormat): string {
  return fmt === "dms" ? toDMS(n, true) : fmt6(n);
}

function fmtLon(n: number, fmt: CoordFormat): string {
  return fmt === "dms" ? toDMS(n, false) : fmt6(n);
}

function formatAccuracy(m: number): string {
  return m < 10 ? `±${m.toFixed(1)} m` : `±${Math.round(m)} m`;
}

function formatBoundaryDistance(m: number): string {
  const ft = m * 3.28084;
  const mi = m / 1609.344;
  if (ft < 528) return `${Math.round(ft)} ft`;
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi)} mi`;
}

function bearingToCardinal(deg: number): string {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

function boundaryDistanceColor(m: number): string {
  const ft = m * 3.28084;
  if (ft < 300) return "var(--color-error)";
  if (ft < 2640) return "var(--color-warning)";
  return "var(--color-success)";
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatIso(iso: string): string {
  return formatTimestamp(new Date(iso).getTime());
}

// ── eBird utilities ───────────────────────────────────────────────────────────

/** Constructs the eBird region code, e.g. "US-NM-003" from stateAbbr + 5-digit GEOID. */
function eBirdRegionCode(stateAbbr: string, geoid: string): string {
  return `US-${stateAbbr}-${geoid.slice(2)}`;
}

function eBirdUrl(code: string): string {
  return `https://ebird.org/region/${code}/recent`;
}

// ── Share / copy text builders ────────────────────────────────────────────────

function coordsCopyText(lat: number, lon: number): string {
  return `${fmt6(lat)}, ${fmt6(lon)}`;
}

function buildShareText(result: LookupSuccess, position: PositionSnapshot | null): string {
  const code = eBirdRegionCode(result.stateAbbr, result.geoid);
  const lines = [`${result.countyName}, ${result.stateName}`, `eBird: ${code}`];
  if (position) {
    lines.push(`${fmt6(position.lat)}, ${fmt6(position.lon)} (${formatAccuracy(position.accuracy)})`);
  }
  lines.push("https://countyfinder.chasereport.com");
  return lines.join("\n");
}

function buildFullCopyText(result: LookupSuccess, position: PositionSnapshot | null): string {
  const lines = [`${result.countyName}, ${result.stateName}`];
  if (position) {
    lines.push(`${fmt6(position.lat)}, ${fmt6(position.lon)}`);
    lines.push(`Accuracy: ${formatAccuracy(position.accuracy)}`);
  }
  lines.push(`Located: ${result.lookupTimestamp}`);
  return lines.join("\n");
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyButton({ label, text, variant = "secondary" }: {
  label: string; text: string; variant?: "primary" | "secondary" | "ghost";
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch { /* fallback */ const el = Object.assign(document.createElement("textarea"), { value: text, style: "position:fixed;opacity:0" }); document.body.appendChild(el); el.select(); document.execCommand("copy"); el.remove(); }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return <button className={`btn btn-${variant}`} onClick={copy}>{copied ? "✓ Copied" : label}</button>;
}

// ── Main component ────────────────────────────────────────────────────────────

const LIVE_MIN_INTERVAL_MS = 3000;
const CLOSE_BOUNDARY_M = 91; // ~300 ft — threshold for dual-county banner

export default function HomePage() {
  // Core state
  const [status, setStatus] = useState<AppStatus>("init");
  const [position, setPosition] = useState<PositionSnapshot | null>(null);
  const [result, setResult] = useState<LookupSuccess | null>(null);
  const [cached, setCached] = useState<CachedResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // New feature state
  const [liveMode, setLiveMode] = useState(false);
  const [coordFormat, setCoordFormat] = useState<CoordFormat>("decimal");
  const [countyChangedAlert, setCountyChangedAlert] = useState<string | null>(null);
  const [cardFlash, setCardFlash] = useState(false);

  // Refs
  const abortRef = useRef<AbortController | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const lastGeoidRef = useRef<string | null>(null);
  const lastLookupMsRef = useRef<number>(0);

  // Load coord format preference
  useEffect(() => {
    const stored = localStorage.getItem("county-finder:coord-format") as CoordFormat | null;
    if (stored === "dms") setCoordFormat("dms");
  }, []);

  const toggleCoordFormat = () => {
    const next: CoordFormat = coordFormat === "decimal" ? "dms" : "decimal";
    setCoordFormat(next);
    localStorage.setItem("county-finder:coord-format", next);
  };

  // ── County-change detection ─────────────────────────────────────────────────
  useEffect(() => {
    if (!liveMode || !result) return;
    const geoid = result.geoid;
    if (lastGeoidRef.current && lastGeoidRef.current !== geoid) {
      // Crossed a county line
      setCountyChangedAlert(`Entered ${result.countyName}`);
      setCardFlash(true);
      if ("vibrate" in navigator) navigator.vibrate([150, 80, 150]);
      setTimeout(() => setCountyChangedAlert(null), 3500);
      setTimeout(() => setCardFlash(false), 900);
    }
    lastGeoidRef.current = geoid;
  }, [result?.geoid, liveMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Core lookup ─────────────────────────────────────────────────────────────
  const runLookup = useCallback(async (snap: PositionSnapshot, isLiveUpdate = false) => {
    if (!isLiveUpdate) {
      setStatus("looking_up");
      setPosition(snap);
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: snap.lat, lon: snap.lon }),
        signal: ctrl.signal,
      });
      const data = await res.json();

      if (data.ok) {
        const r: LookupSuccess = data;
        if (r.geometry) saveCache(r, snap.lat, snap.lon, snap.accuracy, snap.timestamp, r.geometry);
        const display: LookupSuccess = { ...r };
        delete display.geometry;
        setResult(display);
        setPosition(snap);
        setStatus("success");
        setErrorMessage(null);
      } else {
        const code = data.errorCode as string;
        setStatus(code === "OUT_OF_SCOPE" ? "out_of_scope" : code === "NO_MATCH" ? "no_match" : "api_error");
        setErrorMessage(data.message);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const c = loadCache();
      if (c) {
        const inside = pointInGeometry(snap.lat, snap.lon, c.geometry);
        setCached(c);
        setPosition(snap);
        setStatus(inside ? "offline_verified" : "offline_unverified");
      } else {
        setStatus("api_error");
        setErrorMessage("Could not reach the server and no cached result is available.");
      }
    }
  }, []);

  // ── Geolocation ─────────────────────────────────────────────────────────────
  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setStatus("no_geolocation");
      return;
    }
    setStatus("locating");
    setErrorMessage(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const snap: PositionSnapshot = {
          lat: pos.coords.latitude, lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy, timestamp: pos.timestamp,
        };
        if (!isOnline()) {
          const c = loadCache();
          if (c) {
            setCached(c);
            setPosition(snap);
            setStatus(pointInGeometry(snap.lat, snap.lon, c.geometry) ? "offline_verified" : "offline_unverified");
          } else {
            setStatus("offline_no_cache");
          }
          return;
        }
        runLookup(snap);
      },
      (err) => {
        setStatus(
          err.code === GeolocationPositionError.PERMISSION_DENIED ? "permission_denied" :
          err.code === GeolocationPositionError.TIMEOUT ? "geo_timeout" : "geo_error"
        );
        setErrorMessage(err.message);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  }, [runLookup]);

  // ── Live mode ────────────────────────────────────────────────────────────────
  const startLiveMode = useCallback(() => {
    if (!navigator.geolocation) return;
    setLiveMode(true);
    lastGeoidRef.current = result?.geoid ?? null;

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - lastLookupMsRef.current < LIVE_MIN_INTERVAL_MS) return;
        lastLookupMsRef.current = now;
        const snap: PositionSnapshot = {
          lat: pos.coords.latitude, lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy, timestamp: pos.timestamp,
        };
        runLookup(snap, true);
      },
      () => { /* ignore individual watch errors */ },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
    watchIdRef.current = id;
  }, [runLookup, result?.geoid]);

  const stopLiveMode = useCallback(() => {
    setLiveMode(false);
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  // Cleanup watch on unmount
  useEffect(() => () => {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
  }, []);

  // ── Share ────────────────────────────────────────────────────────────────────
  const handleShare = useCallback(async () => {
    if (!result) return;
    const text = buildShareText(result, position);
    if (navigator.share) {
      try { await navigator.share({ title: "Current County", text }); return; }
      catch { /* fall through to clipboard */ }
    }
    await navigator.clipboard.writeText(text);
  }, [result, position]);

  // ── Initial load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = loadCache();
    if (c) setCached(c);

    if (!isOnline()) {
      if (c && navigator.geolocation) {
        setStatus("locating");
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const snap = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, timestamp: pos.timestamp };
            setCached(c);
            setPosition(snap);
            setStatus(pointInGeometry(snap.lat, snap.lon, c.geometry) ? "offline_verified" : "offline_unverified");
          },
          () => { setCached(c); setStatus("offline_no_position"); },
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
        );
      } else {
        setStatus(c ? "offline_no_position" : "offline_no_cache");
      }
      return;
    }
    requestLocation();

    const handleOffline = () => {
      setStatus((s) => {
        if (s === "locating" || s === "looking_up") {
          const cc = loadCache();
          if (cc) { setCached(cc); return "offline_no_position"; }
          return "offline_no_cache";
        }
        return s;
      });
    };
    window.addEventListener("offline", handleOffline);
    return () => window.removeEventListener("offline", handleOffline);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => { stopLiveMode(); abortRef.current?.abort(); requestLocation(); };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">
      {/* County-change toast */}
      {countyChangedAlert && (
        <div className="county-toast">🎉 {countyChangedAlert}</div>
      )}

      <header className="app-header">
        <svg className="app-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="16" cy="14" r="9" fill="var(--color-primary)" />
          <circle cx="16" cy="14" r="4" fill="white" />
          <path d="M16 23 L16 30" stroke="var(--color-primary)" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <h1>Current County</h1>
      </header>

      <main className="app-main">
        {renderContent({
          status, position, result, cached, errorMessage,
          liveMode, coordFormat, cardFlash,
          onRefresh: handleRefresh,
          onStartLive: startLiveMode,
          onStopLive: stopLiveMode,
          onShare: handleShare,
          onToggleCoordFormat: toggleCoordFormat,
        })}
      </main>

      <footer className="app-footer">
        <Link href="/privacy">Privacy</Link>
        {" · "}
        Location is used only to find your county. Not stored.
      </footer>
    </div>
  );
}

// ── Content renderer ──────────────────────────────────────────────────────────

interface ContentProps {
  status: AppStatus;
  position: PositionSnapshot | null;
  result: LookupSuccess | null;
  cached: CachedResult | null;
  errorMessage: string | null;
  liveMode: boolean;
  coordFormat: CoordFormat;
  cardFlash: boolean;
  onRefresh: () => void;
  onStartLive: () => void;
  onStopLive: () => void;
  onShare: () => void;
  onToggleCoordFormat: () => void;
}

function renderContent(p: ContentProps) {
  const { status, position, result, cached, errorMessage, liveMode, coordFormat, cardFlash } = p;

  // ── Locating / looking up ─────────────────────────────────────────────────

  if (status === "init" || status === "locating" || status === "looking_up") {
    return (
      <div className="status-card">
        <div className="status-badge locating">
          <span className="pulse-dot" />
          {status === "looking_up" ? "Looking up county…" : "Locating…"}
        </div>
        {cached ? (
          <div className="county-display">
            <div className="county-name">{cached.result.countyBaseName}</div>
            <div className="state-name">{cached.result.stateName}</div>
            <div className="unverified-label">Last known — updating…</div>
          </div>
        ) : (
          <p style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-sm)" }}>
            Requesting location…
          </p>
        )}
      </div>
    );
  }

  // ── Success ───────────────────────────────────────────────────────────────

  if (status === "success" && result && position) {
    const isClose = result.distanceToBoundaryM <= CLOSE_BOUNDARY_M;
    const boundaryColor = boundaryDistanceColor(result.distanceToBoundaryM);
    const cardinal = bearingToCardinal(result.bearingToBoundary);
    const distLabel = formatBoundaryDistance(result.distanceToBoundaryM);
    const code = eBirdRegionCode(result.stateAbbr, result.geoid);

    return (
      <>
        <div className={`status-card${cardFlash ? " county-flash" : ""}`}>
          {/* Status + live indicator */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--spacing-4)" }}>
            <div className="status-badge success" style={{ margin: 0 }}>
              {liveMode ? <><span className="live-dot" /> Live</> : "✓ Located"}
            </div>
            {liveMode
              ? <button className="btn btn-live" style={{ padding: "4px 12px", minHeight: 32, fontSize: "var(--font-size-xs)" }} onClick={p.onStopLive}>■ Stop</button>
              : <button className="btn btn-ghost" style={{ padding: "4px 12px", minHeight: 32, fontSize: "var(--font-size-xs)" }} onClick={p.onStartLive}>▶ Live</button>
            }
          </div>

          {/* Dual-county banner when very close to line */}
          {isClose ? (
            <div className="dual-county">
              <div className="dual-county-side current">
                <div className="dual-county-label">You are here</div>
                <div className="dual-county-name current">{result.countyBaseName}</div>
                <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)" }}>{result.stateAbbr}</div>
              </div>
              <div className="dual-county-divider">
                <div className="dual-county-dist">{distLabel}</div>
                <div className="dual-county-dir">{cardinal}</div>
              </div>
              <div className="dual-county-side adjacent">
                {result.adjacentCountyName ? (
                  <>
                    <div className="dual-county-label">Next county</div>
                    <div className="dual-county-name adjacent">{result.adjacentCountyName}</div>
                    {result.adjacentCountyState && result.adjacentCountyState !== result.stateAbbr && (
                      <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)" }}>{result.adjacentCountyState}</div>
                    )}
                  </>
                ) : (
                  <div className="dual-county-label" style={{ paddingTop: "var(--spacing-3)" }}>Water / border</div>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Normal county display */}
              <div className="county-display">
                <div className="county-name">{result.countyName}</div>
                <div className="state-name">{result.stateName}</div>
              </div>

              {/* County line distance box */}
              <div style={{
                background: "var(--color-bg)", borderRadius: "var(--radius-md)",
                padding: "var(--spacing-3) var(--spacing-4)", marginBottom: "var(--spacing-3)",
                border: `2px solid ${boundaryColor}`,
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-muted)" }}>County line</span>
                  <span style={{ fontWeight: 700, fontSize: "var(--font-size-xl)", color: boundaryColor, fontVariantNumeric: "tabular-nums" }}>
                    {distLabel}{" "}
                    <span style={{ fontSize: "var(--font-size-base)", opacity: 0.8 }}>{cardinal}</span>
                  </span>
                </div>
                {result.adjacentCountyName && (
                  <div style={{ marginTop: "var(--spacing-1)", fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)", textAlign: "right" }}>
                    → {result.adjacentCountyName}
                    {result.adjacentCountyState && result.adjacentCountyState !== result.stateAbbr ? `, ${result.adjacentCountyState}` : ""}
                  </div>
                )}
              </div>
            </>
          )}

          {/* eBird row */}
          <div className="ebird-row">
            <span className="ebird-code">{code}</span>
            <div style={{ display: "flex", gap: "var(--spacing-2)" }}>
              <CopyButton label="Copy" text={code} variant="secondary" />
              <a className="btn btn-ebird" href={eBirdUrl(code)} target="_blank" rel="noopener noreferrer">
                eBird →
              </a>
            </div>
          </div>

          {/* Coordinate details with format toggle */}
          <div className="details-list">
            <div className="detail-row">
              <span className="detail-label">Accuracy</span>
              <span className="detail-value">{formatAccuracy(position.accuracy)}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                Coords
                <button className="coord-toggle" onClick={p.onToggleCoordFormat}>
                  {coordFormat === "decimal" ? "DMS" : "Dec"}
                </button>
              </span>
              <span className="detail-value" style={{ fontVariantNumeric: "tabular-nums" }}>
                {fmtLat(position.lat, coordFormat)}<br />
                {fmtLon(position.lon, coordFormat)}
              </span>
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

          {/* Action buttons */}
          <div className="btn-group">
            {!liveMode && (
              <div className="btn-row">
                <button className="btn btn-primary" onClick={p.onStartLive}>▶ Live</button>
                <button className="btn btn-secondary" onClick={p.onRefresh}>↻ Refresh</button>
              </div>
            )}
            <button className="btn btn-ghost" onClick={p.onShare}>⬆ Share</button>
            <div className="btn-row">
              <CopyButton label="Copy coords" text={coordsCopyText(position.lat, position.lon)} variant="secondary" />
              <CopyButton label="Copy result" text={buildFullCopyText(result, position)} variant="secondary" />
            </div>
          </div>
        </div>
      </>
    );
  }

  // ── Offline verified ──────────────────────────────────────────────────────

  if (status === "offline_verified" && cached) {
    const pos = position;
    return (
      <div className="status-card">
        <div className="status-badge offline-verified">✓ Offline — verified locally</div>
        <div className="county-display">
          <div className="county-name">{cached.result.countyName}</div>
          <div className="state-name">{cached.result.stateName}</div>
        </div>
        <p style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)", marginBottom: "var(--spacing-3)" }}>
          Offline — verified inside cached county boundary. Connect to the internet for a fresh lookup.
        </p>
        <div className="details-list">
          {pos && <>
            <div className="detail-row"><span className="detail-label">Accuracy</span><span className="detail-value">{formatAccuracy(pos.accuracy)}</span></div>
            <div className="detail-row"><span className="detail-label">Latitude</span><span className="detail-value">{fmtLat(pos.lat, coordFormat)}</span></div>
            <div className="detail-row"><span className="detail-label">Longitude</span><span className="detail-value">{fmtLon(pos.lon, coordFormat)}</span></div>
          </>}
          <div className="detail-row"><span className="detail-label">Last lookup</span><span className="detail-value">{formatIso(cached.result.lookupTimestamp)}</span></div>
        </div>
        <div className="btn-group">
          <button className="btn btn-primary" onClick={p.onRefresh}>↻ Try again</button>
          {pos && <CopyButton label="Copy coords" text={coordsCopyText(pos.lat, pos.lon)} variant="ghost" />}
        </div>
      </div>
    );
  }

  // ── Offline unverified ────────────────────────────────────────────────────

  if ((status === "offline_unverified" || status === "offline_no_position") && cached) {
    const pos = position;
    return (
      <div className="status-card">
        <div className="status-badge offline-unverified">⚠ Offline — not verified</div>
        <div className="county-display">
          <div className="county-name">{cached.result.countyName}</div>
          <div className="state-name">{cached.result.stateName}</div>
          <div className="unverified-label">Last known — not verified</div>
        </div>
        <p style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)", marginBottom: "var(--spacing-3)" }}>
          {status === "offline_no_position"
            ? "Could not get your current location while offline. Showing last known county only."
            : "Current location appears to be outside the cached county boundary."}
        </p>
        <div className="details-list">
          <div className="detail-row"><span className="detail-label">Last lookup</span><span className="detail-value">{formatIso(cached.result.lookupTimestamp)}</span></div>
          {pos && <>
            <div className="detail-row"><span className="detail-label">Current lat</span><span className="detail-value">{fmtLat(pos.lat, coordFormat)}</span></div>
            <div className="detail-row"><span className="detail-label">Current lon</span><span className="detail-value">{fmtLon(pos.lon, coordFormat)}</span></div>
          </>}
        </div>
        <button className="btn btn-primary" onClick={p.onRefresh}>↻ Try again</button>
      </div>
    );
  }

  // ── Offline no cache ──────────────────────────────────────────────────────

  if (status === "offline_no_cache") {
    return (
      <div className="info-block">
        <span className="icon">📡</span>
        <h2>You&apos;re offline</h2>
        <p>No cached county on this device. Connect to the internet to get started.</p>
        <button className="btn btn-primary" onClick={p.onRefresh}>↻ Try again</button>
      </div>
    );
  }

  // ── Permission denied ─────────────────────────────────────────────────────

  if (status === "permission_denied") {
    return (
      <div className="info-block">
        <span className="icon">📍</span>
        <h2>Location permission needed</h2>
        <p>Current County needs your location to identify which county you&apos;re in.</p>
        <ol>
          <li>Open your browser&apos;s site settings</li>
          <li>Find <strong>Location</strong> permissions</li>
          <li>Change to <strong>Allow</strong></li>
          <li>Reload the page</li>
        </ol>
        <div className="btn-group" style={{ marginTop: "var(--spacing-4)" }}>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>↻ Reload</button>
        </div>
      </div>
    );
  }

  // ── No geolocation ────────────────────────────────────────────────────────

  if (status === "no_geolocation") {
    return (
      <div className="info-block">
        <span className="icon">🌐</span>
        <h2>Geolocation not supported</h2>
        <p>Try opening Current County in Chrome, Safari, or Firefox on a mobile device.</p>
      </div>
    );
  }

  // ── Geo timeout ───────────────────────────────────────────────────────────

  if (status === "geo_timeout") {
    return (
      <div className="info-block">
        <span className="icon">⏱</span>
        <h2>Location timed out</h2>
        <p>Move to a more open area or check that location services are enabled.</p>
        <button className="btn btn-primary" style={{ marginTop: "var(--spacing-4)" }} onClick={p.onRefresh}>↻ Try again</button>
      </div>
    );
  }

  // ── Out of scope ──────────────────────────────────────────────────────────

  if (status === "out_of_scope") {
    return (
      <div className="info-block">
        <span className="icon">🗺️</span>
        <h2>Outside the US</h2>
        <p>Current County only covers the 50 states and Washington, DC.</p>
        {position && <p style={{ fontVariantNumeric: "tabular-nums" }}>{fmt6(position.lat)}, {fmt6(position.lon)}</p>}
        <button className="btn btn-primary" style={{ marginTop: "var(--spacing-4)" }} onClick={p.onRefresh}>↻ Try again</button>
      </div>
    );
  }

  // ── Catchall error ────────────────────────────────────────────────────────

  return (
    <div className="info-block">
      <span className="icon">⚠️</span>
      <h2>{status === "no_match" ? "County not found" : "Something went wrong"}</h2>
      <p>{errorMessage ?? (status === "no_match" ? "Coordinates could not be matched to a county. You may be near a coast or border." : "An unexpected error occurred.")}</p>
      <button className="btn btn-primary" style={{ marginTop: "var(--spacing-4)" }} onClick={p.onRefresh}>↻ Try again</button>
    </div>
  );
}
