import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy — Current County",
};

export default function PrivacyPage() {
  return (
    <div className="prose">
      <Link href="/" className="back-link">← Back to County Finder</Link>

      <h1>Privacy Policy</h1>

      <p>
        <strong>Current County</strong> is designed with privacy as a first
        priority. Here is exactly how it works.
      </p>

      <h2>What we collect</h2>
      <p>
        Nothing. County Finder does not require an account, does not collect
        personal information, and does not store location history.
      </p>

      <h2>How your location is used</h2>
      <p>
        When you open County Finder, your browser asks for permission to access
        your device&apos;s GPS or network location. If you grant permission,
        your latitude and longitude are sent to the app server in a single
        request to identify which county you are in.
      </p>
      <p>
        The coordinates are sent in the body of an HTTPS POST request — not in
        the URL. This reduces the likelihood of your coordinates appearing in
        server access logs, browser history, or network proxy logs.
      </p>
      <p>
        The server uses your coordinates to perform a point-in-polygon lookup
        against U.S. Census Bureau county boundary data, then discards them.
        <strong> Your coordinates are never written to a database or log file.</strong>
      </p>

      <h2>Local storage on your device</h2>
      <p>
        After a successful lookup, County Finder stores the most recent result
        (county name, state, timestamp, and county boundary geometry) in your
        browser&apos;s <code>localStorage</code>. This stored data:
      </p>
      <ul>
        <li>Never leaves your device</li>
        <li>Is only used to show a cached result when you open the app offline</li>
        <li>Can be cleared at any time by clearing your browser&apos;s site data</li>
      </ul>

      <h2>Third-party services</h2>
      <p>
        County Finder does not include analytics, advertising, or third-party
        tracking by default. If you deploy your own instance and add analytics,
        that is your responsibility to disclose.
      </p>

      <h2>Data sharing</h2>
      <p>
        We do not sell, share, or transmit your location data to any third party.
      </p>

      <h2>Server logs</h2>
      <p>
        The app server may record routine access logs (HTTP status codes,
        timestamps, and request paths) as part of normal server operation.
        However, because coordinates are submitted in the POST body and
        application-level coordinate logging is disabled by default, precise
        location data does not appear in these logs.
      </p>

      <h2>Contact</h2>
      <p>
        Questions? File an issue on the project repository or contact the
        operator of the instance you are using.
      </p>

      <p style={{ marginTop: "2rem", fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
        This privacy policy applies to the County Finder application as
        distributed. Operators of self-hosted instances are responsible for
        their own data handling.
      </p>
    </div>
  );
}
