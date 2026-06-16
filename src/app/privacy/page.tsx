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

      <h2>What we collect</h2>
      <p>
        Nothing. Current County does not require an account, does not collect
        personal information, and does not store location history.
      </p>

      <h2>How your location is used</h2>
      <p>
        When you tap the locate button, your browser asks permission to access
        your device&apos;s location. If you allow it, your coordinates are sent
        to our server over HTTPS, used to identify which county you&apos;re in,
        and then discarded. <strong>Your location is never stored.</strong> We do keep an anonymous
        count of lookups by state (for example, &ldquo;NM: 12&rdquo;) to understand where the app is used.
      </p>

      <h2>Saved on your device</h2>
      <p>
        After a successful lookup, the result (county name, state, and boundary)
        is saved in your browser&apos;s local storage so the app works offline.
        This data never leaves your device and can be cleared at any time by
        clearing your browser&apos;s site data.
      </p>

      <h2>Contact</h2>
      <p>
        Questions? Use the <Link href="/contact">contact form</Link>.
      </p>
    </div>
  );
}
