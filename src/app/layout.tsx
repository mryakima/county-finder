import type { Metadata, Viewport } from "next";
import "./globals.css";
import UpdateBanner from "@/components/UpdateBanner";

export const metadata: Metadata = {
  title: "Current County",
  description: "Find the U.S. county or county-equivalent you're currently in.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "County",
    statusBarStyle: "default",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#1d4ed8" },
    { media: "(prefers-color-scheme: dark)", color: "#0f172a" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <script
          defer
          src="https://umami.chasereport.com/script.js"
          data-website-id="28f4304d-300f-49a6-8f4d-8c8bc80ac3ff"
        />
      </head>
      <body>
        <ServiceWorkerRegistration />
        {children}
        <UpdateBanner />

      </body>
    </html>
  );
}

// Inline client component for SW registration — keeps layout otherwise server-only.
function ServiceWorkerRegistration() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `
          if ('serviceWorker' in navigator) {
            window.addEventListener('load', function() {
              navigator.serviceWorker.register('/sw.js').catch(function(err) {
                console.warn('SW registration failed:', err);
              });
            });
          }
        `,
      }}
    />
  );
}
