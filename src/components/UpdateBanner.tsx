"use client";

import { useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

export default function UpdateBanner() {
  const [show, setShow] = useState(false);
  const initialVersion = useRef<number | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (initialVersion.current === null) {
          initialVersion.current = data.v;
        } else if (data.v !== initialVersion.current) {
          setShow(true);
        }
      } catch {
        // offline or fetch failed — ignore silently
      }
    };

    check();
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  if (!show) return null;

  return (
    <div style={{
      position: "fixed", bottom: "env(safe-area-inset-bottom, 16px)", left: "50%",
      transform: "translateX(-50%)",
      zIndex: 999,
      background: "#1d4ed8", color: "#fff",
      borderRadius: 12, padding: "12px 20px",
      display: "flex", alignItems: "center", gap: 12,
      boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
      fontSize: 14, fontWeight: 600,
      maxWidth: "calc(100vw - 32px)",
      whiteSpace: "nowrap",
    }}>
      <span>✨ Update available</span>
      <button
        onClick={() => window.location.reload()}
        style={{
          background: "#fff", color: "#1d4ed8",
          border: "none", borderRadius: 8,
          padding: "6px 14px", fontSize: 13,
          fontWeight: 700, cursor: "pointer",
        }}
      >
        Refresh
      </button>
      <button
        onClick={() => setShow(false)}
        aria-label="Dismiss"
        style={{
          background: "rgba(255,255,255,0.2)", color: "#fff",
          border: "none", borderRadius: 6,
          width: 26, height: 26, fontSize: 16,
          cursor: "pointer", display: "flex",
          alignItems: "center", justifyContent: "center",
          flexShrink: 0, padding: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
