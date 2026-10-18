// Full-page screenshots of the desk UI at phone, tablet and laptop sizes, with device emulation (headless Chrome has
// a ~500 px minimum window, so --window-size alone would clip phones) and a horizontal-overflow check.
//   node scripts/responsive/shots.mjs http://127.0.0.1:8787 <out-dir>
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url = "http://127.0.0.1:8787", out = "responsive-shots"] = process.argv.slice(2);
const sizes = [
  { name: "phone-390", width: 390, height: 844, mobile: true },
  { name: "tablet-820", width: 820, height: 1180, mobile: true },
  { name: "laptop-1180", width: 1180, height: 820, mobile: false },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const port = 9351;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "dp-shots-"))}`,
  "--hide-scrollbars", "--no-first-run", "about:blank",
], { stdio: "ignore" });
let target;
for (let i = 0; i < 60 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { await sleep(200); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.result.value;

const report = [];
for (const s of sizes) {
  await send("Emulation.setDeviceMetricsOverride", { width: s.width, height: s.height, deviceScaleFactor: 2, mobile: s.mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: s.mobile });
  await send("Page.navigate", { url });
  await sleep(4000); // state poll + event replay
  const overflow = await evaluate("document.documentElement.scrollWidth - window.innerWidth");
  const wide = await evaluate(`[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map(e => e.tagName + '.' + (e.className || '').toString().slice(0, 60))`);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(out, `${s.name}.png`), Buffer.from(shot.result.data, "base64"));
  report.push({ size: s.name, horizontalOverflowPx: overflow, widestOffenders: wide });
}
console.log(JSON.stringify(report, null, 1));
ws.close();
chrome.kill();
