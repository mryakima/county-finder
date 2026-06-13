# County Finder

A mobile-first installable PWA that tells you what U.S. county (or county-equivalent) you're currently in.

Open the app, grant location permission, and it immediately shows your county and state. Works for all 50 U.S. states plus Washington, DC.

---

## Features

- Identifies your U.S. county using browser geolocation + server-side point-in-polygon
- Shows GPS accuracy, decimal coordinates, and timestamps
- Copy coordinates or full result to clipboard
- Installable PWA (add to home screen on Android/iOS)
- **Privacy-first**: coordinates sent via POST body, never in URL; nothing stored server-side
- **Offline verification**: if you open the app offline, it checks whether you're still inside the last known county boundary using locally cached geometry

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 15](https://nextjs.org) (App Router) |
| Language | TypeScript |
| Spatial index | [rbush](https://github.com/mourner/rbush) (R-tree bounding box prefilter) |
| Point-in-polygon | [@turf/boolean-point-in-polygon](https://turfjs.org) (server-side) |
| Offline PIP | Custom ray-casting (client-side, no bundle bloat) |
| County data | U.S. Census Bureau TIGER cartographic boundary files (2024, 1:20m scale) |
| PWA | Custom service worker + Web App Manifest |

---

## Quickstart

### 1. Install dependencies

```bash
npm install
```

### 2. Download and prepare county boundary data

```bash
npm run data:download
```

This downloads the U.S. Census TIGER county shapefile (~1.2 MB), converts it to GeoJSON, filters to the 50 states + DC, and writes `data/counties-processed.json` (~5–8 MB). The file is excluded from git.

**Data source:** U.S. Census Bureau, Cartographic Boundary Files, 2024 edition  
URL: `https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_20m.zip`

### 3. Generate PNG icons (optional but recommended for full PWA install support)

```bash
npm run icons:generate
```

Requires `sharp` (already in devDependencies). Outputs `public/icons/icon-192.png` and `icon-512.png`. SVG icon works on Chrome 111+ without this step.

### 4. Set up environment (optional)

```bash
cp .env.example .env.local
```

The defaults work out of the box. See `.env.example` for privacy-relevant settings.

### 5. Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser (use a phone or browser devtools with location override for realistic testing).

---

## Build and run production

```bash
npm run build
npm run start
```

---

## Run tests

```bash
npm test
```

Unit tests run without the data file. Integration tests are automatically skipped if `data/counties-processed.json` is not present.

## Run the verification script

After downloading data:

```bash
npm run verify
```

Tests ~12 known coordinates including Catron County NM, Bernalillo County NM, Los Angeles CA, Manhattan NY, Washington DC, Chicago IL, Maui HI, Alaska, Canada, Mexico, and ocean points.

---

## Deploy

### Vercel (recommended)

```bash
npx vercel
```

**Important:** `data/counties-processed.json` must be present in the repo or generated at build time. Since it's in `.gitignore`, run `npm run data:download` before deploying, or add a `vercel.json` build step:

```json
{
  "buildCommand": "npm run data:download && npm run build"
}
```

### Self-hosted Node.js

```bash
npm run build
NODE_ENV=production npm run start
```

Set a `PORT` environment variable if needed (Next.js defaults to 3000).

---

## Privacy

### How it works

1. The browser requests location permission
2. If granted, coordinates are sent as a JSON POST body to `/api/lookup` — **never in a URL query string**
3. The server performs point-in-polygon lookup, returns the county name, and discards the coordinates
4. The server **does not log coordinates** (`LOG_COUNTY_RESULTS=false` by default)
5. The client stores only the most recent result + county geometry in `localStorage` (never sent anywhere)

### Avoiding coordinate leaks in production

- **Do NOT enable `LOG_COUNTY_RESULTS=true`** in production
- Configure your reverse proxy (nginx, Caddy) to avoid logging POST bodies
- Use HTTPS (always — TLS encrypts POST bodies from network observers)
- If using a CDN, confirm it does not cache or log POST request bodies

### What is stored locally (browser)

The last successful result is stored in `localStorage` under the key `county-finder:cached-result`. It includes the county name, state, timestamp, coordinates at the time of lookup, and the county boundary geometry. It does not leave the device.

---

## Architecture

```
county-finder/
├── src/
│   ├── app/
│   │   ├── page.tsx          ← Main UI (client component, all state)
│   │   ├── layout.tsx        ← Root layout, SW registration, PWA metadata
│   │   ├── globals.css       ← All styles (mobile-first, dark mode)
│   │   ├── privacy/page.tsx  ← Privacy policy page
│   │   └── api/lookup/
│   │       └── route.ts      ← POST /api/lookup
│   └── lib/
│       ├── types.ts          ← Shared TypeScript types
│       ├── spatial.ts        ← Server: loads data, rbush index, PIP lookup
│       └── offline.ts        ← Client: localStorage cache, ray-casting PIP
├── scripts/
│   ├── download-data.ts      ← Downloads and processes Census shapefile
│   ├── generate-icons.ts     ← Converts SVG icon to PNG
│   └── verify-lookup.ts      ← CLI test against known coordinates
├── public/
│   ├── sw.js                 ← Service worker
│   ├── manifest.json         ← Web App Manifest
│   └── icons/               ← App icons (SVG + generated PNGs)
├── tests/
│   └── lookup.test.ts        ← Vitest unit + integration tests
└── data/
    └── counties-processed.json  ← Generated by data:download (gitignored)
```

**Spatial lookup flow:**

1. `spatial.ts` loads `counties-processed.json` once on first request (module singleton)
2. Builds an [rbush](https://github.com/mourner/rbush) R-tree index with county bounding boxes
3. For a lookup: finds candidate counties whose bbox contains the point (fast O(log n))
4. Runs precise `@turf/boolean-point-in-polygon` against each candidate
5. Returns the first match

The 1:20m scale data has ~3,100 county features. Bounding box prefilter typically reduces candidates to 1–3 before the exact PIP check.

---

## Known limitations

- **Offline verification only covers the last cached county.** If you travel to a new county while offline, the app shows the cached county as unverified.
- **Coastal and border accuracy** is limited by the 1:20m scale simplification. Points very close to a coastline or state border may fail to match (`NO_MATCH` error).
- **First load requires a network connection.** The PWA caches the app shell for subsequent offline loads, but the initial data download and lookup require connectivity.
- **Geolocation accuracy** depends on the device. Indoor or urban-canyon GPS can be off by hundreds of meters.

---

## Future: native app path

The architecture is intentionally portable:

- The spatial lookup logic (`src/lib/spatial.ts`) is pure Node.js with no Next.js dependencies — it can be extracted into a standalone service
- The client logic (`src/lib/offline.ts`, the PIP algorithm, and the cache) can be ported to React Native or a native Swift/Kotlin wrapper
- The county data file (`data/counties-processed.json`) can be bundled with a native app for fully offline operation

For a native app, the main change is replacing the `POST /api/lookup` fetch with a bundled local lookup using the same spatial engine.

---

## Data source

U.S. Census Bureau, Cartographic Boundary Files  
County Boundaries, 2024 edition, 1:20,000,000 scale  
https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html

The cartographic boundary files are simplified representations of the Census TIGER/Line data, designed for small-scale thematic mapping. They are in the public domain.
