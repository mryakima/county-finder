"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import type { AppStatus, LookupSuccess, CachedResult, PositionSnapshot } from "@/lib/types";
import { saveCache, loadCache, pointInGeometry, isOnline as checkOnline } from "@/lib/offline";

const CountyMap = dynamic(() => import("@/components/CountyMap"), { ssr: false });

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
  // timeZoneName: "short" appends the zone abbreviation (e.g. "MDT"/"MST"),
  // which itself encodes whether Daylight or Standard time is in effect.
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZoneName: "short",
  });
}
function formatIso(iso: string): string { return formatTimestamp(new Date(iso).getTime()); }

// ── County-detail formatting ──────────────────────────────────────────────────
const M2_PER_SQMI = 2589988.110336;

function sqMi(areaM2: number): number {
  return areaM2 / M2_PER_SQMI;
}
function formatArea(areaM2: number): string {
  const mi = sqMi(areaM2);
  if (mi > 0 && mi < 1) return "<1 sq mi";
  return `${Math.round(mi).toLocaleString()} sq mi`;
}
function formatPopulation(pop: number | null): string {
  return pop === null ? "—" : pop.toLocaleString();
}
function formatDensity(pop: number | null, landM2: number): string {
  const land = sqMi(landM2);
  if (pop === null || land <= 0) return "—";
  return `${Math.round(pop / land).toLocaleString()} /sq mi`;
}
function formatLandWaterRatio(landM2: number, waterM2: number): string {
  if (waterM2 <= 0) return "all land";
  if (landM2 <= 0) return "all water";
  const r = landM2 / waterM2;
  return r >= 1 ? `${Math.round(r).toLocaleString()} : 1` : `1 : ${Math.round(1 / r).toLocaleString()}`;
}

// ── eBird utilities ───────────────────────────────────────────────────────────

function eBirdRegionCode(stateAbbr: string, geoid: string): string {
  // eBird subnational2 (county) code, e.g. US-NM-003. geoid is the 5-digit FIPS;
  // dropping the 2-digit state prefix leaves the 3-digit county code.
  return `US-${stateAbbr}-${geoid.slice(2)}`;
}

function eBirdUrl(stateAbbr: string, geoid: string): string {
  return `https://ebird.org/region/${eBirdRegionCode(stateAbbr, geoid)}`;
}

// Outbound deep link to eBird's personal Targets ("needs") tool for this county.
// Matches the URL eBird itself emits (verified): ?r1=<region>. eBird applies the
// signed-in user's own comparison list / date defaults, and their login (session
// cookies) travels with the navigation — we never read, store, or proxy any eBird
// account data. Falls back to the bare Targets page if a region code can't be formed.
function eBirdTargetsUrl(stateAbbr: string, geoid: string): string {
  if (!stateAbbr || geoid.length < 3) return "https://ebird.org/targets";
  return `https://ebird.org/targets?r1=${eBirdRegionCode(stateAbbr, geoid)}`;
}

// eBird's hotspot MAP, framed to this county via a bounding-box viewport
// (env.* = west/south/east/north). county.bbox maps 1:1 onto those params, so the
// map opens directly on the county. Falls back to the region hotspot list, then the
// bare map, if a bbox isn't available. Public URL — no login, nothing fetched.
function eBirdHotspotsUrl(
  bbox: [number, number, number, number] | undefined,
  stateAbbr: string,
  geoid: string
): string {
  if (bbox && bbox.length === 4) {
    const [minX, minY, maxX, maxY] = bbox.map((n) => n.toFixed(6));
    return `https://ebird.org/hotspots?env.minX=${minX}&env.minY=${minY}&env.maxX=${maxX}&env.maxY=${maxY}`;
  }
  if (stateAbbr && geoid.length >= 3) return `https://ebird.org/region/${eBirdRegionCode(stateAbbr, geoid)}/hotspots`;
  return "https://ebird.org/hotspots";
}

const COUNTY_TYPE_ABBR: Record<string, string> = {
  "County": "Co.",
  "Parish": "Par",
  "Borough": "Bor",
  "Municipality": "Mun",
  "Census Area": "CA",
  "City and Borough": "C&B",
  "Municipio": "Mun",
  "District": "Dist",
  "City": "City",
};

function countyTypeAbbr(nameLsad: string, baseName: string): string {
  const suffix = nameLsad.slice(baseName.length).trim();
  return COUNTY_TYPE_ABBR[suffix] ?? suffix;
}

// ── Share / copy ──────────────────────────────────────────────────────────────

function coordsCopyText(lat: number, lon: number): string {
  return `${fmt6(lat)}, ${fmt6(lon)}`;
}

function buildShareText(result: LookupSuccess, position: PositionSnapshot | null): string {
  const lines = [`${result.countyName}, ${result.stateName}`];
  if (position) {
    lines.push(`${fmt6(position.lat)}, ${fmt6(position.lon)} (${formatAccuracy(position.accuracy)})`);
    if (position.altitude !== null) {
      lines.push(`Elevation: ${Math.round(position.altitude * 3.28084).toLocaleString()} ft`);
    }
  }
  lines.push("https://currentcounty.com");
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
    catch {
      const el = Object.assign(document.createElement("textarea"), { value: text, style: "position:fixed;opacity:0" });
      document.body.appendChild(el); el.select(); document.execCommand("copy"); el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return <button className={`btn btn-${variant}`} onClick={copy}>{copied ? "✓ Copied" : label}</button>;
}

// ── Staleness ────────────────────────────────────────────────────────────────

type StalenessLevel = "fresh" | "amber" | "red";

function formatStaleness(ts: number, now: number): { text: string; level: StalenessLevel; message: string } {
  const ms = now - ts;
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(ms / 3600000);

  const text =
    mins < 1  ? "Just now" :
    mins < 60 ? `${mins} min ago` :
    hrs === 1  ? "1 hr ago" :
                 `${hrs} hr ago`;

  const level: StalenessLevel =
    ms > 7_200_000  ? "red" :   // > 2 hours
    ms > 1_800_000  ? "amber" : // > 30 minutes
    "fresh";

  const message =
    level === "red"   ? "Location data is likely incorrect — you may have crossed county lines." :
    level === "amber" ? "Data may be outdated — county may have changed." :
    "Last known county shown.";

  return { text, level, message };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LIVE_MIN_INTERVAL_MS = 3000; // max ms between background lookups (time-based backstop)
const LIVE_MIN_DISTANCE_M  = 30;   // also fire when position moves this far, regardless of time
const LIVE_HARD_FLOOR_MS   = 1000; // never fire more than once per second even while moving fast
const CLOSE_BOUNDARY_M = 91;       // ~300 ft — threshold for dual-county banner
const GPS_GRACE_MS = 30_000;       // suppress stale warning while GPS acquires on open

// ── County-crossing banner pinning ────────────────────────────────────────────
// Near a county line the two counties hold FIXED sides — LEFT = the county you're
// leaving (origin), RIGHT = the county you're entering (destination) — and only the
// "you are here" highlight crosses the divider as you do. The API swaps
// current/adjacent the instant you cross the line, so we pin the origin/destination
// pair by name+state identity and keep it until a genuinely new line comes into
// play (a new pair), at which point the current county becomes the new "leaving".
interface CrossingSide { name: string; state: string; isCurrent: boolean }
interface CrossingLayout { left: CrossingSide; right: CrossingSide }
interface PinnedPair { left: { name: string; state: string }; right: { name: string; state: string } }

function countyId(name: string, state: string): string { return `${name}|${state}`; }

// Pure: given the live result (with a non-null adjacent county) and the current pin,
// return the resolved left/right layout plus the pin to store. Establishing or
// re-establishing always puts the current county on the left (leaving) and the
// adjacent county on the right (entering); a matching pair keeps the existing pin so
// names never swap sides — only `isCurrent` moves.
function resolveCrossing(
  result: LookupSuccess,
  pin: PinnedPair | null
): { layout: CrossingLayout; pin: PinnedPair } {
  const curName = result.countyName;
  const curState = result.stateAbbr;
  const adjName = result.adjacentCountyName as string; // caller guarantees non-null
  const adjState = result.adjacentCountyState ?? result.stateAbbr;

  const curId = countyId(curName, curState);
  const adjId = countyId(adjName, adjState);

  const pinIds = pin
    ? [countyId(pin.left.name, pin.left.state), countyId(pin.right.name, pin.right.state)]
    : null;
  const matches = !!pinIds && pinIds.includes(curId) && pinIds.includes(adjId);

  const nextPin: PinnedPair = matches
    ? pin!
    : { left: { name: curName, state: curState }, right: { name: adjName, state: adjState } };

  const leftIsCurrent = countyId(nextPin.left.name, nextPin.left.state) === curId;
  return {
    layout: {
      left: { ...nextPin.left, isCurrent: leftIsCurrent },
      right: { ...nextPin.right, isCurrent: !leftIsCurrent },
    },
    pin: nextPin,
  };
}

// ── What's New content ───────────────────────────────────────────────────────
// Bump WHATS_NEW_VERSION (YYYY-MM-DD or any string) when you update WHATS_NEW_ITEMS.
// The modal fires once per version, independent of build/deploy timestamps.
const WHATS_NEW_VERSION = "2026-06-15";
const WHATS_NEW_ITEMS = [
  "Map stays live — the blue dot and distance to county line now update in real time while the map is open.",
  "Faster refresh after backgrounding — coordinates and elevation update immediately when you return to the app.",
  "Coastlines labeled correctly — nearby water boundaries now show as \u201cCoastline\u201d instead of \u201cCounty line\u201d.",
  "eBird button — now shows the county name so you know exactly where you\u2019re linking to.",
];

// ── Main component ────────────────────────────────────────────────────────────

export default function HomePage() {
  const [status, setStatus] = useState<AppStatus>("init");
  const [position, setPosition] = useState<PositionSnapshot | null>(null);
  const [result, setResult] = useState<LookupSuccess | null>(null);
  const [cached, setCached] = useState<CachedResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [coordFormat, setCoordFormat] = useState<CoordFormat>("decimal");
  const [countyChangedAlert, setCountyChangedAlert] = useState<string | null>(null);
  const [cardFlash, setCardFlash] = useState(false);
  const [milestoneToast, setMilestoneToast] = useState<string | null>(null);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(false);

  const [isOnline, setIsOnline] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [showMap, setShowMap] = useState(false);
  const [showEbird, setShowEbird] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const lastGeoidRef = useRef<string | null>(null);
  const pinnedCrossingRef = useRef<PinnedPair | null>(null);
  const lastLookupMsRef = useRef<number>(0);
  const lastLookupPosRef = useRef<{ lat: number; lon: number } | null>(null);
  const offlineRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionStartRef = useRef<number>(Date.now());
  // True once the user has explicitly started location (tapped "Find my county")
  // or an offline returning-user flow began. Gates any code path that would
  // otherwise request location before the user has opted in.
  const hasStartedRef = useRef(false);

  // ── Modal sequencing: disclaimer (first-ever launch) then What’s New (each update) ──
  useEffect(() => {
    try {
      const disclaimerSeen = localStorage.getItem("cc_disclaimer_seen") === "true";
      if (!disclaimerSeen) {
        setShowDisclaimer(true);
        return;
      }
      // Disclaimer already seen — check if there's a new What's New version
      const lastSeen = localStorage.getItem("cc_whats_new_version");
      if (lastSeen !== WHATS_NEW_VERSION) {
        setShowWhatsNew(true);
      }
    } catch { /* localStorage unavailable */ }
  }, []);

  const handleDismissDisclaimer = () => {
    try {
      localStorage.setItem("cc_disclaimer_seen", "true");
      // Note: cc_whats_new_version is intentionally NOT set here so that
      // What’s New fires on the very next open after the disclaimer is dismissed.
    } catch { /* localStorage unavailable */ }
    setShowDisclaimer(false);
  };

  const handleDismissWhatsNew = () => {
    try {
      localStorage.setItem("cc_whats_new_version", WHATS_NEW_VERSION);
    } catch { /* localStorage unavailable */ }
    setShowWhatsNew(false);
  };

  // Load coord format preference
  useEffect(() => {
    const stored = localStorage.getItem("county-finder:coord-format") as CoordFormat | null;
    if (stored === "dms") setCoordFormat("dms");
  }, []);

  // Online/offline detection + staleness clock (ticks every 30 s)
  useEffect(() => {
    setIsOnline(navigator.onLine);
    const handleOnline  = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online",  handleOnline);
    window.addEventListener("offline", handleOffline);
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.removeEventListener("online",  handleOnline);
      window.removeEventListener("offline", handleOffline);
      clearInterval(timer);
    };
  }, []);

  // ── Umami: cumulative app-active heartbeat (every 5 min while page is visible) ──
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).umami?.track("app-active");
      }
    };
    activeTimerRef.current = setInterval(tick, 5 * 60 * 1000);
    return () => { if (activeTimerRef.current) clearInterval(activeTimerRef.current); };
  }, []);

  const toggleCoordFormat = () => {
    const next: CoordFormat = coordFormat === "decimal" ? "dms" : "decimal";
    setCoordFormat(next);
    localStorage.setItem("county-finder:coord-format", next);
  };

  // ── County-change detection (always-on) ──────────────────────────────────────
  // Fires automatically whenever the matched county changes — no user action needed.
  useEffect(() => {
    if (!result) return;
    const geoid = result.geoid;
    if (lastGeoidRef.current && lastGeoidRef.current !== geoid) {
      setCountyChangedAlert(`Entered ${result.countyName}`);
      setCardFlash(true);
      if ("vibrate" in navigator) navigator.vibrate([150, 80, 150]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).umami?.track("county-crossing");
      setTimeout(() => setCountyChangedAlert(null), 3500);
      setTimeout(() => setCardFlash(false), 900);

      // ── County crossing milestones ─────────────────────────────────────
      try {
        const MILESTONES: Record<number, string> = {
          5:  "5 county crossings — nice work! Tap the eBird button to see what’s been spotted in each one.",
          20: "20 county crossings — you’re a serious county lister. Keep exploring!",
        };
        const crossings = parseInt(localStorage.getItem("cc_county_crossings") || "0", 10) + 1;
        localStorage.setItem("cc_county_crossings", String(crossings));
        const shown: number[] = JSON.parse(localStorage.getItem("cc_milestones_shown") || "[]");
        const msg = MILESTONES[crossings];
        if (msg && !shown.includes(crossings)) {
          shown.push(crossings);
          localStorage.setItem("cc_milestones_shown", JSON.stringify(shown));
          setTimeout(() => {
            setMilestoneToast(msg);
            setTimeout(() => setMilestoneToast(null), 6000);
          }, 4000);
        }
      } catch { /* localStorage unavailable */ }

    }
    lastGeoidRef.current = geoid;
  }, [result?.geoid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Core lookup ───────────────────────────────────────────────────────────────
  const runLookup = useCallback(async (snap: PositionSnapshot, isBackgroundUpdate = false) => {
    // Coords + elevation come straight from the device GPS and must update on every
    // fix, independent of the network county lookup. (Previously a background update
    // only set position inside the successful-fetch block, so coords/elevation froze
    // whenever the server was unreachable — e.g. traveling at the edge of coverage.)
    setPosition(snap);
    if (!isBackgroundUpdate) {
      setStatus("looking_up");
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
        try {
          const today = new Date().toISOString().slice(0, 10);
          const KEY = "cc_state_tracked";
          const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
          const trackedToday: string[] = stored.date === today ? stored.states : [];
          if (!trackedToday.includes(r.stateAbbr)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).umami?.track("county-lookup", { state: r.stateAbbr });
            localStorage.setItem(KEY, JSON.stringify({ date: today, states: [...trackedToday, r.stateAbbr] }));
          }
        } catch { /* ignore analytics failures */ }
      } else {
        const code = data.errorCode as string;
        // On background updates, don't clobber a good result with an error
        if (!isBackgroundUpdate) {
          setStatus(code === "OUT_OF_SCOPE" ? "out_of_scope" : code === "NO_MATCH" ? "no_match" : "api_error");
          setErrorMessage(data.message);
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return; // superseded by a newer fix
      // The fetch failed. navigator.onLine can still report true at the edge of
      // coverage, so treat the server as unreachable and drop into offline mode:
      // this surfaces the offline indicator and starts the 15 s offline poll, which
      // keeps coords/elevation live if watchPosition itself stalls. Position was
      // already updated above, so a failed background update never freezes coords.
      const c = loadCache();
      if (c) {
        const inside = pointInGeometry(snap.lat, snap.lon, c.geometry);
        setCached(c);
        setStatus(inside ? "offline_verified" : "offline_unverified");
      } else if (!isBackgroundUpdate) {
        setStatus("api_error");
        setErrorMessage("Could not reach the server and no cached result is available.");
      }
    }
  }, []);

  // ── Always-on background tracking ────────────────────────────────────────────
  // Starts watchPosition automatically. The first fix triggers the initial lookup;
  // subsequent fixes update silently in the background (rate-limited to 3 s).
  // silent=true: restarts watch without showing the "locating" spinner or resetting
  // lastLookupMsRef — used when resuming from background so there's no UI flash.
  const startTracking = useCallback((silent = false) => {
    if (!navigator.geolocation) { if (!silent) setStatus("no_geolocation"); return; }

    // Clear any existing watch
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    if (!silent) {
      setStatus("locating");
      setErrorMessage(null);
      lastLookupMsRef.current = 0;   // allow immediate first lookup
      lastLookupPosRef.current = null;
    }
    // For silent restarts, lastLookupMsRef is left as-is so the rate limiter
    // still allows the next position through (it's been a while) but isFirstFix
    // stays false, meaning the first callback runs as a background update.

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const snap: PositionSnapshot = {
          lat: pos.coords.latitude, lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy, timestamp: pos.timestamp,
          altitude: pos.coords.altitude,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          heading: typeof pos.coords.heading === "number" && isFinite(pos.coords.heading)
            ? pos.coords.heading
            : null,
        };

        const isFirstFix = lastLookupMsRef.current === 0;
        const now = Date.now();

        if (isFirstFix) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).umami?.track("location-granted");
        }

        if (!isFirstFix) {
          const elapsed = now - lastLookupMsRef.current;
          if (elapsed < LIVE_HARD_FLOOR_MS) return; // never fire faster than 1/s
          const prev = lastLookupPosRef.current;
          const moved = prev
            ? (() => {
                const dLat = (snap.lat - prev.lat) * 111320;
                const dLon = (snap.lon - prev.lon) * 111320 * Math.cos((snap.lat + prev.lat) / 2 * Math.PI / 180);
                return Math.sqrt(dLat * dLat + dLon * dLon);
              })()
            : Infinity;
          if (elapsed < LIVE_MIN_INTERVAL_MS && moved < LIVE_MIN_DISTANCE_M) return;
        }
        lastLookupMsRef.current = now;
        lastLookupPosRef.current = { lat: snap.lat, lon: snap.lon };

        if (!checkOnline()) {
          const c = loadCache();
          if (c) {
            setCached(c); setPosition(snap);
            setStatus(pointInGeometry(snap.lat, snap.lon, c.geometry) ? "offline_verified" : "offline_unverified");
          } else {
            setStatus("offline_no_cache");
          }
          return;
        }

        runLookup(snap, !isFirstFix);
      },
      (err) => {
        if (!silent) {
          if (err.code === GeolocationPositionError.PERMISSION_DENIED) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).umami?.track("location-denied");
          }
          setStatus(
            err.code === GeolocationPositionError.PERMISSION_DENIED ? "permission_denied" :
            err.code === GeolocationPositionError.TIMEOUT ? "geo_timeout" : "geo_error"
          );
          setErrorMessage(err.message);
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
    watchIdRef.current = id;
  }, [runLookup]);

  // Cleanup watch on unmount
  useEffect(() => () => {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
  }, []);

  // ── Foreground resume handler ─────────────────────────────────────────────
  // Browsers (especially iOS Safari) suspend or kill watchPosition when the app
  // is backgrounded. On visibility restore: fire getCurrentPosition immediately
  // for a fresh fix (no UI flash), then silently restart the watch in case it
  // was killed.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (!hasStartedRef.current) return; // user hasn't opted in yet — don't request location
      if (!navigator.geolocation) return;

      // Immediate one-shot fix — updates coords/altitude without any UI flash
      if (checkOnline()) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const snap: PositionSnapshot = {
              lat: pos.coords.latitude, lon: pos.coords.longitude,
              accuracy: pos.coords.accuracy, timestamp: pos.timestamp,
              altitude: pos.coords.altitude,
              altitudeAccuracy: pos.coords.altitudeAccuracy,
              heading: typeof pos.coords.heading === "number" && isFinite(pos.coords.heading)
                ? pos.coords.heading : null,
            };
            lastLookupMsRef.current = Date.now();
            runLookup(snap, true); // background — keeps current result visible
          },
          () => { /* silently ignore — watch restart below will recover */ },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
      }

      // Silently restart watch — may have been suspended/killed while backgrounded
      startTracking(true);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [runLookup, startTracking]);

  // ── Offline position refresh ──────────────────────────────────────────────
  // watchPosition can stall on some devices when there's no cell signal.
  // Poll getCurrentPosition every 15 s while offline to keep coords + elevation fresh.
  useEffect(() => {
    const isOfflineState = status === "offline_verified" || status === "offline_unverified" || status === "offline_no_position";
    if (!isOfflineState || !navigator.geolocation) {
      if (offlineRefreshRef.current) { clearInterval(offlineRefreshRef.current); offlineRefreshRef.current = null; }
      return;
    }
    if (offlineRefreshRef.current) return; // already running
    offlineRefreshRef.current = setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const snap: PositionSnapshot = {
            lat: pos.coords.latitude, lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy, timestamp: pos.timestamp,
            altitude: pos.coords.altitude,
            altitudeAccuracy: pos.coords.altitudeAccuracy,
            heading: typeof pos.coords.heading === "number" && isFinite(pos.coords.heading) ? pos.coords.heading : null,
          };
          const c = loadCache();
          if (c) {
            setPosition(snap);
            setCached(c);
            setStatus(pointInGeometry(snap.lat, snap.lon, c.geometry) ? "offline_verified" : "offline_unverified");
          }
        },
        () => { /* silently ignore errors in background refresh */ },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
      );
    }, 15_000);
    return () => {
      if (offlineRefreshRef.current) { clearInterval(offlineRefreshRef.current); offlineRefreshRef.current = null; }
    };
  }, [status]);

  // ── Share ─────────────────────────────────────────────────────────────────────
  const handleShare = useCallback(async () => {
    if (!result) return;
    const text = buildShareText(result, position);
    if (navigator.share) {
      try { await navigator.share({ title: "Current County", text }); return; }
      catch { /* fall through */ }
    }
    await navigator.clipboard.writeText(text);
  }, [result, position]);

  // ── Initial load ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = loadCache();
    if (c) setCached(c);

    if (!checkOnline()) {
      if (c && navigator.geolocation) {
        hasStartedRef.current = true;
        setStatus("locating");
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const snap = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, timestamp: pos.timestamp, altitude: pos.coords.altitude, altitudeAccuracy: pos.coords.altitudeAccuracy, heading: null };
            setCached(c); setPosition(snap);
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

    // Decide between auto-starting and showing the idle gate.
    //
    // A native permission prompt fired on page load (before the user has any context)
    // is the main reason first-time iOS users tap "Don't Allow" — after which iOS won't
    // re-prompt and they're stuck. So first-timers / not-yet-granted users get the gate
    // (see the "idle" branch in renderContent) and we only request location on their tap.
    //
    // But a RETURNING user who already granted permission doesn't need that primer —
    // re-asking has no prompt risk, so we skip the gate and locate immediately. The
    // Permissions API is the clean way to detect this. It's unreliable on iOS Safari
    // (may be unsupported / reject), so every uncertain path falls back to the gate.
    const perms = navigator.permissions;
    if (perms?.query) {
      perms
        .query({ name: "geolocation" as PermissionName })
        .then((res) => {
          if (res.state === "granted") {
            hasStartedRef.current = true;
            startTracking(); // already granted — no prompt fires, so skip the gate
          } else {
            setStatus("idle");
          }
        })
        .catch(() => setStatus("idle"));
    } else {
      setStatus("idle");
    }

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

  const handleStart = () => { hasStartedRef.current = true; startTracking(); };

  const handleRefresh = () => { hasStartedRef.current = true; abortRef.current?.abort(); startTracking(); };

  const handleOpenMap = useCallback(() => {
    // Ensure cached state is populated (geometry lives in localStorage via saveCache)
    const c = loadCache();
    if (c) setCached(c);
    setShowMap(true);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────────
  // Resolve the dual-county banner layout, pinning the leaving/entering pair so the
  // two county names hold their sides across the crossing (see resolveCrossing).
  // Only computed when near a line with a real adjacent county; the coastline/border
  // case (no adjacent county) falls back to the simple "you are here" banner.
  let crossingLayout: CrossingLayout | null = null;
  if (result && result.distanceToBoundaryM <= CLOSE_BOUNDARY_M && result.adjacentCountyName) {
    const resolved = resolveCrossing(result, pinnedCrossingRef.current);
    pinnedCrossingRef.current = resolved.pin;
    crossingLayout = resolved.layout;
  }

  return (
    <div className="app-shell">
      {countyChangedAlert && (
        <div className="county-toast">🎉 {countyChangedAlert}</div>
      )}

      {milestoneToast && (
        <div className="county-toast" style={{ background: "var(--color-success)", maxWidth: 320, textAlign: "center", lineHeight: 1.4, padding: "10px 16px" }}>
          🏆 {milestoneToast}
        </div>
      )}

      {/* ── Disclaimer modal ────────────────────────────────────────── */}
      {showDisclaimer && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 10000,
          background: "rgba(0,0,0,0.55)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "24px",
        }}>
          <div style={{
            background: "var(--color-surface)", borderRadius: 16,
            padding: "28px 24px", maxWidth: 360, width: "100%",
            boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
            fontFamily: "inherit",
          }}>
            <div style={{ fontSize: 36, textAlign: "center", marginBottom: 12 }}>🚗</div>
            <h2 style={{ margin: "0 0 12px", fontSize: "var(--font-size-xl)", textAlign: "center" }}>
              Stay safe out there
            </h2>
            <p style={{ margin: "0 0 24px", color: "var(--color-text-muted)", lineHeight: 1.6, textAlign: "center", fontSize: "var(--font-size-base)" }}>
              Current County is designed to be used when you&apos;re stopped — not while driving.
              Please pull over before checking the app.
            </p>
            <button
              className="btn btn-primary"
              style={{ width: "100%" }}
              onClick={handleDismissDisclaimer}
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* ── What’s New modal ───────────────────────────────────────── */}
      {showWhatsNew && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 10000,
          background: "rgba(0,0,0,0.55)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "24px",
        }}>
          <div style={{
            background: "var(--color-surface)", borderRadius: 16,
            padding: "28px 24px", maxWidth: 360, width: "100%",
            boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
            fontFamily: "inherit",
          }}>
            <div style={{ fontSize: 36, textAlign: "center", marginBottom: 12 }}>✨</div>
            <h2 style={{ margin: "0 0 16px", fontSize: "var(--font-size-xl)", textAlign: "center" }}>
              What&apos;s New
            </h2>
            <ul style={{ margin: "0 0 16px", padding: "0 0 0 20px", lineHeight: 1.7, fontSize: "var(--font-size-sm)", color: "var(--color-text)" }}>
              {WHATS_NEW_ITEMS.map((item, i) => (
                <li key={i} style={{ marginBottom: 8 }}>{item}</li>
              ))}
            </ul>
            <p style={{ margin: "0 0 20px", fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)", textAlign: "center", lineHeight: 1.5 }}>
              For all improvements to take effect, you may need to close and reopen the app.
            </p>
            <button
              className="btn btn-primary"
              style={{ width: "100%" }}
              onClick={handleDismissWhatsNew}
            >
              Got it
            </button>
          </div>
        </div>
      )}

      <header className="app-header">
        <svg className="app-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="16" cy="14" r="9" fill="var(--color-primary)" />
          <circle cx="16" cy="14" r="4" fill="white" />
          <path d="M16 23 L16 30" stroke="var(--color-primary)" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <h1>Current County <span style={{ fontWeight: 400, color: "var(--color-text-muted)", fontSize: "var(--font-size-base)" }}>— Where am I?</span></h1>
        {!isOnline && (
          <div className="connectivity-offline" aria-label="No network connection">
            <div className="connectivity-offline-dot" />
            Offline
          </div>
        )}
      </header>

      <main className="app-main">
        {renderContent({
          status, position, result, cached, errorMessage, coordFormat, cardFlash,
          isOnline, now, sessionStart: sessionStartRef.current,
          crossingLayout,
          onStart: handleStart,
          onRefresh: handleRefresh,
          onShare: handleShare,
          onToggleCoordFormat: toggleCoordFormat,
          onOpenMap: handleOpenMap,
          onOpenEbird: () => setShowEbird(true),
          onOpenDetails: () => setShowDetails(true),
        })}
      </main>

      <footer className="app-footer">
        <button
            className="btn btn-secondary"
            style={{ marginBottom: "var(--spacing-3)", width: "100%" }}
            onClick={async () => {
              const text = "Current County — instantly find your U.S. county using GPS. Great for birders near county lines.";
              const url = "https://currentcounty.com";
              if (navigator.share) {
                try { await navigator.share({ title: "Current County", text, url }); return; }
                catch { /* fall through */ }
              }
              await navigator.clipboard.writeText(`${text}\n${url}`);
            }}
          >
            ⬆ Share app
          </button>
        <Link href="/privacy">Privacy</Link>
        {" · "}
        <Link href="/contact">Contact</Link>
        {" · "}
        Location is used only to find your county. GPS not stored. Lookups counted by state anonymously.
      </footer>

      {/* ── eBird tools sheet ──────────────────────────────────────────────── */}
      {showEbird && result && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowEbird(false); }}
        >
          <div style={{
            background: "var(--color-surface)",
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            padding: "var(--spacing-5) var(--spacing-4) calc(var(--spacing-6) + env(safe-area-inset-bottom, 0px))",
            boxShadow: "0 -4px 24px rgba(0,0,0,0.25)",
            maxWidth: 480, width: "100%", margin: "0 auto",
          }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "var(--spacing-4)" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: "var(--font-size-lg)" }}>eBird</div>
                <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-muted)" }}>{result.countyName}, {result.stateAbbr}</div>
              </div>
              <button
                onClick={() => setShowEbird(false)}
                aria-label="Close"
                style={{ background: "var(--color-border)", border: "none", borderRadius: 8, width: 36, height: 36, fontSize: 20, color: "var(--color-text)", cursor: "pointer", flexShrink: 0, lineHeight: 1 }}
              >
                ×
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-2)" }}>
              <a className="btn btn-ebird" style={{ width: "100%", justifyContent: "center" }} href={eBirdUrl(result.stateAbbr, result.geoid)} target="_blank" rel="noopener noreferrer" onClick={() => (window as any).umami?.track("ebird-click")}>
                County overview →
              </a>
              <a className="btn btn-ebird-outline" style={{ width: "100%", justifyContent: "center" }} href={eBirdTargetsUrl(result.stateAbbr, result.geoid)} target="_blank" rel="noopener noreferrer" onClick={() => (window as any).umami?.track("ebird-targets-click")}>
                My Targets →
              </a>
              <a className="btn btn-ebird-outline" style={{ width: "100%", justifyContent: "center" }} href={eBirdHotspotsUrl(result.bbox, result.stateAbbr, result.geoid)} target="_blank" rel="noopener noreferrer" onClick={() => (window as any).umami?.track("ebird-hotspots-click")}>
                Hotspot map →
              </a>
            </div>
            <div style={{ marginTop: "var(--spacing-3)", fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)", textAlign: "center", lineHeight: 1.5 }}>
              Opens eBird in a new tab · Targets need your eBird login
            </div>
          </div>
        </div>
      )}

      {/* ── County details sheet ───────────────────────────────────────────── */}
      {showDetails && result && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowDetails(false); }}
        >
          <div style={{
            background: "var(--color-surface)",
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            padding: "var(--spacing-5) var(--spacing-4) calc(var(--spacing-6) + env(safe-area-inset-bottom, 0px))",
            boxShadow: "0 -4px 24px rgba(0,0,0,0.25)",
            maxWidth: 480, width: "100%", margin: "0 auto",
          }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "var(--spacing-4)" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: "var(--font-size-lg)" }}>County details</div>
                <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-muted)" }}>{result.countyName}, {result.stateAbbr}</div>
              </div>
              <button
                onClick={() => setShowDetails(false)}
                aria-label="Close"
                style={{ background: "var(--color-border)", border: "none", borderRadius: 8, width: 36, height: 36, fontSize: 20, color: "var(--color-text)", cursor: "pointer", flexShrink: 0, lineHeight: 1 }}
              >
                ×
              </button>
            </div>
            <div className="details-list">
              <div className="detail-row"><span className="detail-label">Population</span><span className="detail-value">{formatPopulation(result.population)}</span></div>
              <div className="detail-row"><span className="detail-label">Population density</span><span className="detail-value">{formatDensity(result.population, result.aland)}</span></div>
              <div className="detail-row"><span className="detail-label">Land area</span><span className="detail-value">{formatArea(result.aland)}</span></div>
              <div className="detail-row"><span className="detail-label">Water area</span><span className="detail-value">{formatArea(result.awater)}</span></div>
              <div className="detail-row"><span className="detail-label">Land : water</span><span className="detail-value">{formatLandWaterRatio(result.aland, result.awater)}</span></div>
              <div className="detail-row"><span className="detail-label">GEOID</span><span className="detail-value">{result.geoid}</span></div>
            </div>
            <div style={{ marginTop: "var(--spacing-3)", fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)", textAlign: "center", lineHeight: 1.5 }}>
              Population: U.S. Census Bureau estimate · Areas: Census TIGER
            </div>
          </div>
        </div>
      )}

      {/* ── County map modal ───────────────────────────────────────────────── */}
      {showMap && position && cached && (() => {
        // Use live result when online, fall back to cached result when offline
        const mapResult = result ?? cached.result;
        const isOfflineMap = !result;
        return (
          <div
            style={{
              position: "fixed", inset: 0, zIndex: 200,
              background: "rgba(0,0,0,0.6)",
              display: "flex", flexDirection: "column",
            }}
            onClick={(e) => { if (e.target === e.currentTarget) setShowMap(false); }}
          >
            <div style={{
              position: "relative", flex: 1,
              display: "flex", flexDirection: "column",
              margin: "env(safe-area-inset-top, 0) 0 0",
            }}>
              {/* Header bar */}
              <div style={{
                background: "#4a7c3f", color: "#fff",
                padding: "12px 16px",
                display: "flex", alignItems: "center", justifyContent: "space-between",
                flexShrink: 0,
              }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{mapResult.countyName}</div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    {isOfflineMap
                      ? "Offline — boundary distance unavailable"
                      : `${formatBoundaryDistance(result!.distanceToBoundaryM)} ${bearingToCardinal(result!.bearingToBoundary)} to ${result!.adjacentCountyName ? `county line · → ${result!.adjacentCountyName}` : "coastline"}`
                    }
                  </div>
                </div>
                <button
                  onClick={() => setShowMap(false)}
                  aria-label="Close map"
                  style={{
                    background: "rgba(255,255,255,0.2)", border: "none",
                    borderRadius: 6, color: "#fff",
                    width: 36, height: 36, fontSize: 20,
                    cursor: "pointer", display: "flex",
                    alignItems: "center", justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  ×
                </button>
              </div>

              {/* Map fills remaining space */}
              <div style={{ flex: 1, minHeight: 0 }}>
                <CountyMap
                  userLat={position.lat}
                  userLon={position.lon}
                  accuracy={position.accuracy}
                  heading={position.heading}
                  nearestBoundaryLat={result?.nearestBoundaryLat ?? null}
                  nearestBoundaryLon={result?.nearestBoundaryLon ?? null}
                  distanceToBoundaryM={result?.distanceToBoundaryM ?? null}
                  currentCountyGeoid={mapResult.geoid}
                  currentCountyName={mapResult.countyName}
                  currentCountyGeometry={cached.geometry}
                  adjacentCountyName={result?.adjacentCountyName ?? null}
                  adjacentCountyState={result?.adjacentCountyState ?? null}
                  onClose={() => setShowMap(false)}
                />
              </div>
            </div>
          </div>
        );
      })()}
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
  coordFormat: CoordFormat;
  cardFlash: boolean;
  isOnline: boolean;
  now: number;
  sessionStart: number;
  crossingLayout: CrossingLayout | null;
  onStart: () => void;
  onRefresh: () => void;
  onShare: () => void;
  onToggleCoordFormat: () => void;
  onOpenMap: () => void;
  onOpenEbird: () => void;
  onOpenDetails: () => void;
}

function renderContent(p: ContentProps) {
  const { status, position, result, cached, errorMessage, coordFormat, cardFlash, now, sessionStart, crossingLayout } = p;
  const inGracePeriod = (now - sessionStart) < GPS_GRACE_MS;

  // ── Idle gate — wait for an explicit tap before requesting location ─────────
  // Priming the user with context here (and only prompting on tap) is what keeps
  // first-time iOS users from reflexively denying the cold permission prompt.
  // Returning users who already granted are auto-started before reaching this
  // branch (see the initial-load effect); a returning user only lands here when we
  // couldn't confirm the grant, so they get a lighter, primer-free version.

  if (status === "idle") {
    return (
      <div className="info-block">
        <span className="icon">📍</span>
        <h2>Find your county</h2>
        {cached ? (
          <p>
            Last time: <strong>{cached.result.countyName}</strong>, {cached.result.stateName}
          </p>
        ) : (
          <>
            <p>
              Current County uses your phone&apos;s location to find which county
              you&apos;re in. Your coordinates are used for the lookup, then
              discarded — not stored on any server, and no account is needed.
            </p>
            <p style={{ fontSize: "var(--font-size-xs)" }}>
              When you tap, your browser will ask to use your location. Choose
              <strong> Allow</strong> to continue.
            </p>
          </>
        )}
        <button className="btn btn-primary" style={{ marginTop: "var(--spacing-2)" }} onClick={p.onStart}>
          📍 Find my county
        </button>
      </div>
    );
  }

  // ── Locating / looking up ──────────────────────────────────────────────────

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

  // ── Success ────────────────────────────────────────────────────────────────

  if (status === "success" && result && position) {
    const isClose = result.distanceToBoundaryM <= CLOSE_BOUNDARY_M;
    const boundaryColor = boundaryDistanceColor(result.distanceToBoundaryM);
    const cardinal = bearingToCardinal(result.bearingToBoundary);
    const distLabel = formatBoundaryDistance(result.distanceToBoundaryM);

    return (
      <div className={`status-card${cardFlash ? " county-flash" : ""}`}>
        <div className="status-badge success" style={{ marginBottom: "var(--spacing-4)" }}>
          ✓ Located
        </div>

        {/* Dual-county banner when very close to a line. With a real adjacent
            county the layout is PINNED — LEFT = the county you're leaving, RIGHT =
            the county you're entering — and only the "you are here" highlight moves
            across the divider as you cross (see resolveCrossing). At a coastline or
            state edge (no adjacent county) it falls back to a simple banner. */}
        {crossingLayout ? (
          <div className="dual-county">
            <div className={`dual-county-side ${crossingLayout.left.isCurrent ? "current" : "adjacent"}`}>
              <div className="dual-county-label">Leaving</div>
              <div className={`dual-county-name ${crossingLayout.left.isCurrent ? "current" : "adjacent"}`}>{crossingLayout.left.name}</div>
              <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)" }}>{crossingLayout.left.state}</div>
              {crossingLayout.left.isCurrent && <div className="dual-county-here">📍 You are here</div>}
            </div>
            <div className="dual-county-divider">
              <div className="dual-county-dist">{distLabel}</div>
              <div className="dual-county-dir">{cardinal}</div>
            </div>
            <div className={`dual-county-side ${crossingLayout.right.isCurrent ? "current" : "adjacent"}`}>
              <div className="dual-county-label">Entering</div>
              <div className={`dual-county-name ${crossingLayout.right.isCurrent ? "current" : "adjacent"}`}>{crossingLayout.right.name}</div>
              <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)" }}>{crossingLayout.right.state}</div>
              {crossingLayout.right.isCurrent && <div className="dual-county-here">📍 You are here</div>}
            </div>
          </div>
        ) : isClose ? (
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
              <div className="dual-county-label" style={{ paddingTop: "var(--spacing-3)" }}>Water / border</div>
            </div>
          </div>
        ) : (
          <>
            {/* Normal county display */}
            <div className="county-display">
              <div className="county-name">{result.countyName}</div>
              <div className="state-name">{result.stateName}</div>
            </div>

            {/* County line distance */}
            <div style={{
              background: "var(--color-bg)", borderRadius: "var(--radius-md)",
              padding: "var(--spacing-3) var(--spacing-4)", marginBottom: "var(--spacing-3)",
              border: `2px solid ${boundaryColor}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-muted)" }}>{result.adjacentCountyName ? "Closest county line" : "Coastline"}</span>
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

        {/* Coordinate details */}
        <div className="details-list">
          <div className="detail-row">
            <span className="detail-label">Accuracy</span>
            <span className="detail-value">{formatAccuracy(position.accuracy)}</span>
          </div>
          {position.altitude !== null && (
            <div className="detail-row">
              <span className="detail-label">Elevation</span>
              <span className="detail-value">
                {Math.round(position.altitude * 3.28084).toLocaleString()} ft
                {position.altitudeAccuracy !== null && (
                  <span style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-xs)" }}>
                    {" "}(±{Math.round(position.altitudeAccuracy * 3.28084)} ft)
                  </span>
                )}
              </span>
            </div>
          )}
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
        </div>

        {/* Actions */}
        <div className="btn-group">
          <button className="btn btn-primary" onClick={p.onRefresh}>↻ Refresh</button>
          <button className="btn btn-ghost" onClick={p.onOpenMap}>🗺️ Map</button>

          {/* County details — opens a sheet of census facts for this county */}
          <button className="btn btn-ghost" style={{ width: "100%" }} onClick={p.onOpenDetails}>ⓘ County details</button>

          {/* eBird tools — opens a sheet of eBird links for this county */}
          <button className="btn btn-ebird" style={{ width: "100%" }} onClick={p.onOpenEbird}>
            eBird tools ▸
          </button>

          <button className="btn btn-ghost" style={{ width: "100%" }} onClick={p.onShare}>⬆ Share position data</button>
          <div className="btn-row">
            <CopyButton label="Copy coords" text={coordsCopyText(position.lat, position.lon)} variant="secondary" />
          </div>
        </div>
      </div>
    );
  }

  // ── Offline verified ───────────────────────────────────────────────────────

  if (status === "offline_verified" && cached) {
    const pos = position;
    const stale = formatStaleness(new Date(cached.result.lookupTimestamp).getTime(), now);
    return (
      <div className="status-card">
        <div className="status-badge offline-verified">✓ Offline — verified locally</div>
        <div className="county-display">
          <div className="county-name">{cached.result.countyName}</div>
          <div className="state-name">{cached.result.stateName}</div>
        </div>
        <div className={`staleness-banner ${inGracePeriod ? "fresh" : stale.level}`}>
          <span>{inGracePeriod ? "Acquiring GPS…" : `Last verified ${stale.text}`}</span>
          {!inGracePeriod && stale.level !== "fresh" && <div className="staleness-message">{stale.message}</div>}
        </div>
        <div className="details-list">
          {pos && <>
            <div className="detail-row"><span className="detail-label">Accuracy</span><span className="detail-value">{formatAccuracy(pos.accuracy)}</span></div>
            {pos.altitude !== null && (
              <div className="detail-row">
                <span className="detail-label">Elevation</span>
                <span className="detail-value">
                  {Math.round(pos.altitude * 3.28084).toLocaleString()} ft
                  {pos.altitudeAccuracy !== null && (
                    <span style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-xs)" }}>
                      {" "}(±{Math.round(pos.altitudeAccuracy * 3.28084)} ft)
                    </span>
                  )}
                </span>
              </div>
            )}
            <div className="detail-row">
              <span className="detail-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                Coords
                <button className="coord-toggle" onClick={p.onToggleCoordFormat}>{coordFormat === "decimal" ? "DMS" : "Dec"}</button>
              </span>
              <span className="detail-value" style={{ fontVariantNumeric: "tabular-nums" }}>
                {fmtLat(pos.lat, coordFormat)}<br />
                {fmtLon(pos.lon, coordFormat)}
              </span>
            </div>
            <div className="detail-row"><span className="detail-label">Location time</span><span className="detail-value">{formatTimestamp(pos.timestamp)}</span></div>
          </>}
        </div>
        <div className="btn-group">
          <button className="btn btn-primary" onClick={p.onRefresh}>↻ Try again</button>
          <button className="btn btn-secondary" onClick={p.onOpenMap}>🗺️ Map</button>
          {pos && <CopyButton label="Copy coords" text={coordsCopyText(pos.lat, pos.lon)} variant="ghost" />}
        </div>
      </div>
    );
  }

  // ── Offline unverified ─────────────────────────────────────────────────────

  if ((status === "offline_unverified" || status === "offline_no_position") && cached) {
    const pos = position;
    const stale = formatStaleness(new Date(cached.result.lookupTimestamp).getTime(), now);
    return (
      <div className="status-card">
        <div className="status-badge offline-unverified">⚠ Offline — not verified</div>
        <div className="county-display">
          <div className="county-name">{cached.result.countyName}</div>
          <div className="state-name">{cached.result.stateName}</div>
          <div className="unverified-label">Last known — not verified</div>
        </div>
        <div className={`staleness-banner ${inGracePeriod ? "fresh" : stale.level}`}>
          <span>{inGracePeriod ? "Acquiring GPS…" : `Last verified ${stale.text}`}</span>
          {!inGracePeriod && <div className="staleness-message">
            {stale.level !== "fresh"
              ? stale.message
              : status === "offline_no_position"
                ? "Could not get current location while offline."
                : "Current location appears to be outside the cached county boundary."}
          </div>}
        </div>
        <div className="details-list">
          {pos && <>
            <div className="detail-row"><span className="detail-label">Accuracy</span><span className="detail-value">{formatAccuracy(pos.accuracy)}</span></div>
            {pos.altitude !== null && (
              <div className="detail-row">
                <span className="detail-label">Elevation</span>
                <span className="detail-value">
                  {Math.round(pos.altitude * 3.28084).toLocaleString()} ft
                  {pos.altitudeAccuracy !== null && (
                    <span style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-xs)" }}>
                      {" "}(±{Math.round(pos.altitudeAccuracy * 3.28084)} ft)
                    </span>
                  )}
                </span>
              </div>
            )}
            <div className="detail-row">
              <span className="detail-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                Coords
                <button className="coord-toggle" onClick={p.onToggleCoordFormat}>{coordFormat === "decimal" ? "DMS" : "Dec"}</button>
              </span>
              <span className="detail-value" style={{ fontVariantNumeric: "tabular-nums" }}>
                {fmtLat(pos.lat, coordFormat)}<br />
                {fmtLon(pos.lon, coordFormat)}
              </span>
            </div>
            <div className="detail-row"><span className="detail-label">Location time</span><span className="detail-value">{formatTimestamp(pos.timestamp)}</span></div>
          </>}
        </div>
        <div className="btn-group">
          <button className="btn btn-primary" onClick={p.onRefresh}>↻ Try again</button>
          <button className="btn btn-secondary" onClick={p.onOpenMap}>🗺️ Map</button>
          {pos && <CopyButton label="Copy coords" text={coordsCopyText(pos.lat, pos.lon)} variant="ghost" />}
        </div>
      </div>
    );
  }

  // ── Offline no cache ───────────────────────────────────────────────────────

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

  // ── Permission denied ──────────────────────────────────────────────────────

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

  // ── No geolocation ─────────────────────────────────────────────────────────

  if (status === "no_geolocation") {
    return (
      <div className="info-block">
        <span className="icon">🌐</span>
        <h2>Geolocation not supported</h2>
        <p>Try opening Current County in Chrome, Safari, or Firefox on a mobile device.</p>
      </div>
    );
  }

  // ── Geo timeout ────────────────────────────────────────────────────────────

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

  // ── Out of scope ───────────────────────────────────────────────────────────

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

  // ── Catchall error ─────────────────────────────────────────────────────────

  return (
    <div className="info-block">
      <span className="icon">⚠️</span>
      <h2>{status === "no_match" ? "County not found" : "Something went wrong"}</h2>
      <p>{errorMessage ?? (status === "no_match" ? "Coordinates could not be matched to a county. You may be near a coast or border." : "An unexpected error occurred.")}</p>
      <button className="btn btn-primary" style={{ marginTop: "var(--spacing-4)" }} onClick={p.onRefresh}>↻ Try again</button>
    </div>
  );
}
