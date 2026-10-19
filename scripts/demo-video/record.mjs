// Records the Frog Day demo, one take of the whole scenario, in headless Chrome with a drawn pointer and no overlay.
// It reacts to the page instead of following a timeline: it co-signs and approves when the desk asks, cues each beat
// and court step, and cuts the waits (a CRE run, a model call) by pausing the recording after a few quiet seconds.
//   npm run reset, start the desk server with BEAT_PAUSE_MS=6000 (each result stays up before the next trade), then:
//   node scripts/demo-video/record.mjs [http://127.0.0.1:8787]
//   cd scripts/demo-video/out && ffmpeg -f concat -safe 0 -i list.txt -vf "scale=1920:1200,format=yuv420p" -r 30 \
//     -c:v libx264 -crf 18 due-process-silent.mp4
import { launch, sleep } from "./cdp.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const B = process.argv[2] ?? "http://127.0.0.1:8787";
const DIR = new URL("./out/", import.meta.url).pathname;
// a wait is cut from the video after this long; a result (blocked, refused, recorded...) stays up longer
const QUIET_S = 2.5;
const RESULT_S = 5;
const WORKING = /is checking the token|is reviewing it|Desk Writer is recording|recording the refusal|is hearing the case/;
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR + "frames", { recursive: true });

const b = await launch({ width: 1440, height: 900, scale: 4 / 3, frameDir: DIR + "frames" });
const now = () => Date.now() / 1000;
const cues = [];
const captions = [];
const cue = (text) => {
  cues.push({ at: b.mark(), text });
  console.log(b.mark().toFixed(1), text);
};
let paused = false;
const pause = () => {
  if (!paused) b.pause();
  paused = true;
};
const resume = async () => {
  if (paused) await b.resume();
  paused = false;
};

const js = (expr) => b.evaluate(expr);
const centre = (sel, nth = 0) =>
  js(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return null;
    const q = e.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
const byText = (sel, text) =>
  js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.includes(${JSON.stringify(text)}));
    if (!e) return null; const q = e.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
const into = (sel, block = "center") => js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ behavior: "smooth", block: "${block}" })`);
/** Your decision: a real click, then wait for the desk to take the button away (no second click). */
const decide = async (text) => {
  await b.clickAt(await b.find(text));
  for (let i = 0; i < 40 && (await b.find(text)); i++) {
    if (i === 12) {
      console.error("click had no effect:", text, await js(`JSON.stringify(window.__rec?.slice(-8))`));
      if (await b.find(text)) await js(`document.querySelector('[data-rec-target]')?.click()`);
    }
    await sleep(250);
  }
};
const ring = (name) => centre(`li[aria-label^="${name}:"] > div:last-child`);
const hover = async (p, ms) => {
  if (p) await b.moveTo(p);
  await sleep(ms);
};

/** What the viewer sees change: the caption, the gates, the trade cards, the court's steps and the decisions asked. */
const SNAPSHOT = `(async () => {
  const desk = document.querySelector('[aria-label="The desk"]');
  const court = [...document.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === 'The court');
  const buttons = [...document.querySelectorAll('button')].map((x) => x.textContent.trim());
  const cards = [...document.querySelectorAll('[aria-label="Trades"] article')];
  const state = await fetch('/state').then((r) => r.json());
  return {
    caption: desk?.querySelector('[aria-live]')?.textContent ?? '',
    gates: [...(desk?.querySelectorAll('ol li') ?? [])].map((li) => li.innerText).join('|'),
    beats: cards.length,
    beatTitle: cards.at(-1)?.querySelector('h3')?.textContent ?? '',
    court: court?.querySelector('ol')?.innerText.replace(/\\s+/g, ' ') ?? '',
    cosign: buttons.find((t) => t.startsWith('Co-sign')) ?? null,
    sanctions: buttons.includes('Approve sanctions'),
    status: state.run.status,
  };
})()`;

try {
  await b.goto(B, 4000);
  // what the page saw of each press and decision, for a click that does nothing
  await js(`(() => { window.__rec = []; const f = window.fetch; window.fetch = async (...a) => { const post = a[1]?.method === 'POST';
    if (post) window.__rec.push(['POST', String(a[0])]); const r = await f(...a); if (post) window.__rec.push([String(a[0]), r.status]); return r; };
    for (const t of ['pointerdown', 'click']) addEventListener(t, (e) => window.__rec.push([t, e.target.tagName, e.target.textContent.slice(0, 24), e.target.disabled]), true); })()`);
  const s0 = await js(SNAPSHOT);
  if (s0.beats > 0 || s0.status === "running") throw new Error("reset the desk first: npm run reset, then restart the server");
  await b.startRec();

  // 1. the desk at rest
  cue("intro: the desk");
  await sleep(2500);
  for (const name of ["KOL Narrative", "Whale Tracker", "News Checker", "Meme Hunter", "Dip Buyer"]) await hover(await ring(name), 1300);
  cue("intro: the five gates");
  await hover(await centre('[aria-label="The desk"] ol'), 2500);
  await hover(await centre('[aria-label="Market tape"]'), 1500);
  cue("run");
  await b.click("Run the scenario", { expect: "Running" });

  // 2. the run: react to the page, cut the waits
  let last = "";
  let lastChange = now();
  let beats = 0;
  let court = "";
  let caption = "";
  for (;;) {
    const s = await js(SNAPSHOT);
    const print = JSON.stringify([s.caption, s.gates, s.beats, s.court, s.cosign, s.sanctions]);
    if (print !== last) {
      last = print;
      lastChange = now();
      await resume();
    }
    if (s.caption !== caption) {
      caption = s.caption;
      captions.push({ at: b.mark(), caption });
    }
    if (s.beats > beats) {
      beats = s.beats;
      cue(`beat ${beats}: ${s.beatTitle}`);
    }
    if (s.court && s.court !== court) {
      if (!court) cue("court opens");
      court = s.court;
      cue(`court: ${court}`);
    }
    if (s.cosign) {
      await resume();
      cue(`co-sign: ${s.cosign}`);
      await hover(await centre('[aria-label="The desk"] ol li', 3), 1800);
      await decide(s.cosign);
      lastChange = now();
      continue;
    }
    if (s.sanctions) {
      await resume();
      // walk the case before deciding: the alerts, the counts with their rulings, the judge's summary
      cue("court: the alerts");
      await hover(await centre("section ul li.bg-rose-50"), 4000);
      cue("court: the counts");
      await into("ul.clear-both");
      await hover(await centre("ul.clear-both"), 5000);
      cue("court: the judge's summary");
      await into("blockquote");
      await hover(await centre("blockquote"), 5000);
      cue("sanctions: your decision");
      await into("section div.border-amber-300");
      await sleep(1200);
      await hover(await centre("section div.border-amber-300"), 3500);
      await decide("Approve sanctions");
      lastChange = now();
      continue;
    }
    if (s.status !== "running") break;
    if (!paused && now() - lastChange > (WORKING.test(s.caption) ? QUIET_S : RESULT_S)) pause();
    await sleep(250);
  }
  await resume();

  // 3. the record: judgments, the desk after them, and why FROG was blocked
  cue("finale: judgments on the record");
  await into("blockquote + ul");
  await hover(await centre("blockquote + ul"), 4500);
  await js(`window.scrollTo({ top: 0, behavior: 'smooth' })`);
  await sleep(1800);
  cue("finale: the desk after the judgment");
  await hover(await ring("Meme Hunter"), 2800);
  await hover(await centre('[aria-label="The desk"] > div:first-child > div'), 2200);
  cue("finale: why FROG was blocked");
  const panel = await centre('[aria-label="Trades"] > div');
  await b.moveTo(panel);
  await b.wheel(-4000, panel);
  await sleep(1500);
  await b.clickAt(await centre('[aria-label="Trades"] article button'));
  await sleep(3500);
  const log = await byText('[aria-label="Trades"] article button', "CRE workflow log");
  if (log) {
    await b.clickAt(log);
    await sleep(4000);
  }
  cue("end");
  await sleep(2500);
} finally {
  const { frames, end } = await b.stopRec();
  b.close();
  if (frames.length) {
    // frames -> constant 30 fps: each output slot shows the newest frame captured by then
    const FPS = 30;
    const start = frames[0].t;
    const slots = Math.ceil((end - start) * FPS);
    const list = [];
    let j = 0;
    for (let s = 0; s < slots; s++) {
      const t = start + s / FPS;
      while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
      list.push(`file 'frames/${basename(frames[j].file)}'`, `duration ${(1 / FPS).toFixed(6)}`);
    }
    list.push(list[list.length - 2]);
    writeFileSync(DIR + "list.txt", list.join("\n") + "\n");
    const rel = (xs) => xs.map((c) => ({ ...c, at: +Math.max(0, c.at - start).toFixed(2) }));
    writeFileSync(DIR + "cues.json", JSON.stringify(rel(cues), null, 1));
    writeFileSync(DIR + "captions.json", JSON.stringify(rel(captions), null, 1));
    console.log(`frames ${frames.length}, length ${(end - start).toFixed(1)} s`);
  }
}
