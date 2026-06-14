"use client";

/**
 * CountyMap — dynamic wrapper around CountyMapInner.
 *
 * Uses next/dynamic with ssr:false to prevent Leaflet from running during
 * server-side rendering (Leaflet requires browser globals like window and document).
 *
 * Usage: render <CountyMap {...props} /> anywhere in a client component.
 * The map only loads when this component is mounted.
 */

import dynamic from "next/dynamic";
import type { CountyMapProps } from "./CountyMapInner";

const CountyMapInner = dynamic(() => import("./CountyMapInner"), {
  ssr: false,
  loading: () => (
    <div style={{
      width: "100%", height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "#f9f7f4", fontSize: 14, color: "#999",
    }}>
      Loading map…
    </div>
  ),
});

export default function CountyMap(props: CountyMapProps) {
  return <CountyMapInner {...props} />;
}
