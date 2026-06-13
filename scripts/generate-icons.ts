/**
 * scripts/generate-icons.ts
 *
 * Converts public/icons/icon.svg → public/icons/icon-192.png and icon-512.png.
 * Requires: npm install --save-dev sharp
 *
 * Run: npm run icons:generate
 */

import sharp from "sharp";
import path from "path";
import fs from "fs";

const ICONS_DIR = path.resolve(__dirname, "../public/icons");
const SVG_PATH = path.join(ICONS_DIR, "icon.svg");

async function main() {
  if (!fs.existsSync(SVG_PATH)) {
    console.error(`[generate-icons] SVG not found: ${SVG_PATH}`);
    process.exit(1);
  }

  for (const size of [192, 512]) {
    const outPath = path.join(ICONS_DIR, `icon-${size}.png`);
    await sharp(SVG_PATH)
      .resize(size, size)
      .png()
      .toFile(outPath);
    console.log(`[generate-icons] Wrote ${outPath}`);
  }

  console.log("[generate-icons] Done.");
}

main().catch((err) => {
  console.error("[generate-icons] ERROR:", err.message ?? err);
  process.exit(1);
});
