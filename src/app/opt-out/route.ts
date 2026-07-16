import { NextRequest } from "next/server";

// Private analytics opt-out, gated by OPTOUT_KEY so ordinary visitors can't
// disable their own counting. Without a configured/matching key this 404s.
// Returned as a route handler (not a page) so it does NOT inherit the root
// layout's Umami tracker — visiting it is never itself counted.
// ?on=1 re-enables tracking for the browser.
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") ?? "";
  const expected = process.env.OPTOUT_KEY ?? "";
  if (!expected || key !== expected) {
    return new Response("Not Found", { status: 404 });
  }
  const on = req.nextUrl.searchParams.get("on") === "1";
  const actionJs = on
    ? "localStorage.removeItem('umami.disabled');"
    : "localStorage['umami.disabled']='1';";
  const icon = on ? "\u{1F4CA}" : "✅";
  const msg = on
    ? "Analytics re-enabled for this browser on this site."
    : "Analytics disabled for this browser on this site.";
  const k = encodeURIComponent(key);
  const toggleUrl = on ? `/opt-out?key=${k}` : `/opt-out?key=${k}&on=1`;
  const toggleLabel = on ? "Disable analytics again" : "Re-enable analytics";
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Analytics</title>
<style>body{font-family:system-ui,sans-serif;max-width:400px;margin:60px auto;padding:0 20px;text-align:center}
.ok{font-size:3rem}.msg{margin-top:16px;font-size:1.1rem;color:#222}
.sub{margin-top:8px;font-size:.85rem;color:#666}a{color:#4a7c3f}</style></head>
<body>
<div class="ok">${icon}</div>
<div class="msg">${msg}</div>
<div class="sub" id="host"></div>
<div class="sub" style="margin-top:20px"><a href="${toggleUrl}">${toggleLabel}</a></div>
<script>
${actionJs}
document.getElementById('host').textContent=location.hostname;
</script>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
