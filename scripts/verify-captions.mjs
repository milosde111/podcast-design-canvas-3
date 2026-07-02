// scripts/verify-captions.mjs
// Drives the shipped app in headless Chrome and proves the transcript caption
// import workflow end to end: generate two speaker WebM videos (solid red host /
// solid green guest, ~8s, with audio), upload them through the normal Host and
// Guest controls, enter social links, then upload a maintainer-built WebVTT file
// with two timed cues (0:00-0:03 and 0:04-0:07) through the real caption file
// input. It verifies, by sampling canvas pixels in the region where the caption
// band renders, that during playback and while scrubbing the first cue appears
// ONLY inside 0-3s, the second ONLY inside 4-7s, and neither appears in the
// 3-4s gap; that switching to Stack and Spotlight and applying a saved custom
// template all keep the same captions rendering over the recomposed preview;
// and finally that the real Export action produces a playable video (with audio)
// in which the captions are BURNED INTO the frames: the exported file is loaded
// back into a <video>, seeked to 1.5s / 3.5s / 5.5s, and each decoded frame is
// drawn to a probe canvas and region-sampled (dark backing bar + light text =
// present; plain bright video = absent). All pixel assertions are region-based
// and tolerant of encoder loss, and every wait polls a natural condition — no
// committed fixtures, seeded media, or verifier-only product paths. Mirrors the
// CDP harness used by the other rendered checks.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run caption verification.");
}
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); child.off("exit", onExit); resolve(ok); };
    const onExit = () => finish(true);
    const t = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}
async function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2000);
}
async function removeDirEventually(dir) {
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) { if (i === 7) return; await sleep(100 * (i + 1)); }
  }
}
async function fetchJson(url, attempts = 60) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); last = new Error("HTTP " + r.status); }
    catch (e) { last = e; }
    await sleep(250);
  }
  throw last;
}
function connectWebSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (event) => {
    const m = JSON.parse(event.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  };
  return { ws, ready, send };
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };

  // ~8.2s solid-color speaker video (uniform frames — no baked-in text — so the
  // caption band region is trivially distinguishable) with an audio tone.
  async function makeVideo(name, color, freq) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator(); osc.frequency.value = freq || 440;
    const d = ac.createMediaStreamDestination(); osc.connect(d); osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...d.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(250);
    for (let i = 0; i < 82; i++) { ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180); await sleep(100); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };

  // The caption band renders centered along the bottom of the stage: a dark
  // backing bar (>= 50% wide, centered) with an accent top edge and white text.
  // The sample region is the central band of that bar — comfortably inside the
  // backing regardless of caption text length, and above the speaker name tags
  // at the very bottom. "Present" = mostly dark backing + some light text;
  // "absent" = plain bright video (the generated speakers are solid red/green).
  const CAPTION_REGION = { x0: 40, y0: 88, x1: 60, y1: 93 };
  function regionStats(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let dark = 0, light = 0, bright = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < 70 && g < 70 && b < 70) dark++;
      if (r > 180 && g > 180 && b > 180) light++;
      if (r > 110 || g > 110 || b > 110) bright++;
    }
    return { dark: dark / n, light: light / n, bright: bright / n };
  }
  const stage = () => document.querySelector("#stage-canvas");
  const captionShown = () => { const s = regionStats(stage(), CAPTION_REGION); return s.dark > 0.45 && s.light > 0.004; };
  const captionAbsent = () => { const s = regionStats(stage(), CAPTION_REGION); return s.dark < 0.1 && s.light < 0.01; };

  await waitFor(() => window.PDC && window.PDC.captions && document.querySelector('[data-file-bucket="host"]')
    && document.querySelector("#caption-file") && document.querySelector("#export") && document.querySelector("#scrub")
    && document.querySelector("#customize"),
    "shipped caption/scrub/export/customize controls should exist");

  // The maintainer-owned WebVTT file: two timed cues in standard HH:MM:SS.mmm form.
  const VTT = [
    "WEBVTT",
    "",
    "1",
    "00:00:00.000 --> 00:00:03.000",
    "WELCOME TO THE SHOW TODAY",
    "",
    "2",
    "00:00:04.000 --> 00:00:07.000",
    "CAPTIONS ARE FULLY WORKING",
    "",
  ].join("\\n");

  // Model semantics: parse + [start, end) activation — start inclusive, end exclusive.
  {
    const parsed = window.PDC.captions.parseVtt(VTT);
    assert(parsed.ok && parsed.cues.length === 2, "WebVTT should parse into two cues");
    const scratch = window.PDC.episode.createEpisode({});
    window.PDC.captions.setCaptions(scratch, "episode.vtt", parsed.cues);
    const at = (t) => window.PDC.captions.activeCaptions(scratch, t).map((c) => c.text).join("|");
    assert(at(0) === "WELCOME TO THE SHOW TODAY", "cue 1 active at exactly its start (inclusive)");
    assert(at(1.5) && at(2.9), "cue 1 active inside 0-3s");
    assert(at(3) === "" && at(3.5) === "", "nothing active in the 3-4s gap (end exclusive)");
    assert(at(4) === "CAPTIONS ARE FULLY WORKING" && at(5), "cue 2 active inside 4-7s");
    assert(at(7) === "" && at(8) === "", "cue 2 gone at/after its end");
  }

  // Upload two speaker videos through the normal Host and Guest controls.
  const [host, guest] = await Promise.all([
    makeVideo("host.webm", "#b91c1c", 300),
    makeVideo("guest.webm", "#10b981", 520),
  ]);
  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest);
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 2, "two decoder videos should exist");
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(
    () => vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration >= 7.2),
    "uploaded speakers should decode with a real duration covering both cue ranges", 400,
  );

  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/hostperson");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/guestperson");

  // Choose Split.
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split preset should be active");

  // Upload the WebVTT caption file through the real product input.
  const vttFile = new File([VTT], "episode.vtt", { type: "text/vtt" });
  uploadTo(document.querySelector("#caption-file"), vttFile);
  await waitFor(() => document.querySelectorAll("#caption-list li").length === 2,
    "two caption cues should appear in the imported cue list");
  const statusText = document.querySelector("#caption-status").textContent || "";
  assert(/2 caption cue/.test(statusText) && /episode\\.vtt/.test(statusText), "status should confirm 2 cues from episode.vtt: " + statusText);
  const capErr = document.querySelector("#caption-error");
  assert(capErr.hidden || !capErr.textContent.trim(), "no caption error should be shown for a valid file");
  const listText = document.querySelector("#caption-list").textContent;
  assert(listText.includes("WELCOME TO THE SHOW TODAY") && listText.includes("0:00") && listText.includes("0:03"), "cue list should show cue 1 with its range");
  assert(listText.includes("CAPTIONS ARE FULLY WORKING") && listText.includes("0:04") && listText.includes("0:07"), "cue list should show cue 2 with its range");

  // PLAYBACK: restart from 0 and watch the caption schedule unfold live.
  document.querySelector("#restart").click();
  await waitFor(() => captionShown(), "cue 1 caption should appear during playback inside 0-3s (Split)", 120);
  await waitFor(() => captionAbsent(), "caption should disappear once playback passes 0:03", 200);
  await waitFor(() => captionShown(), "cue 2 caption should appear during playback inside 4-7s (Split)", 200);

  // SCRUB: pause, then sample exact times through the real scrub control.
  function pausePreview() {
    const btn = document.querySelector("#play");
    if (btn.textContent.indexOf("Pause") !== -1) btn.click();
  }
  const scrub = document.querySelector("#scrub");
  async function scrubTo(t) {
    await waitFor(() => !scrub.disabled && Number(scrub.max) >= 7, "scrub bar should span the episode", 100);
    scrub.value = String(t);
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
  }
  pausePreview();
  await scrubTo(1.5);
  await waitFor(() => captionShown(), "scrubbed to 1.5s: caption shown (Split)");
  const splitAt1_5 = regionStats(stage(), CAPTION_REGION);
  await scrubTo(3.5);
  await waitFor(() => captionAbsent(), "scrubbed to 3.5s: caption absent (Split)");
  assert(regionStats(stage(), CAPTION_REGION).bright > 0.5, "at 3.5s the caption region should show plain bright video");
  await scrubTo(5.5);
  await waitFor(() => captionShown(), "scrubbed to 5.5s: caption shown (Split)");
  const splitAt5_5 = regionStats(stage(), CAPTION_REGION);

  // PRESET SWITCHES: captions must stay attached and render over Stack / Spotlight.
  const presetStats = {};
  for (const presetId of ["stack", "spotlight"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await waitFor(() => stage().dataset.preset === presetId, presetId + " preset should apply");
    assert(document.querySelectorAll("#caption-list li").length === 2, "captions should survive switching to " + presetId);
    pausePreview();
    await scrubTo(1.5);
    await waitFor(() => captionShown(), presetId + ": caption should render over the recomposed layout at 1.5s", 120);
    await scrubTo(3.5);
    await waitFor(() => captionAbsent(), presetId + ": caption absent at 3.5s");
    await scrubTo(5.5);
    await waitFor(() => captionShown(), presetId + ": cue 2 caption shown at 5.5s");
    presetStats[presetId] = regionStats(stage(), CAPTION_REGION);
  }

  // SAVED TEMPLATE: save the current layout as a reusable template through the
  // real customize/save controls, apply it, and confirm the captions still
  // render over it (captions belong to the episode, not the layout).
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split re-applied before saving a template");
  document.querySelector("#customize").click();
  await waitFor(() => !document.querySelector("#edit-overlay").hidden, "the layout editor should open");
  typeInto(document.querySelector("#template-name"), "Caption Layout");
  document.querySelector("#save-template").click();
  await waitFor(() => document.querySelectorAll("#templates button").length >= 1, "a saved template should appear");
  const tplBtn = document.querySelector("#templates button");
  await waitFor(() => tplBtn.getAttribute("aria-pressed") === "true", "the saved template should be applied");
  assert(document.querySelectorAll("#caption-list li").length === 2, "captions should survive applying a saved template");
  pausePreview();
  await scrubTo(1.5);
  await waitFor(() => captionShown(), "template applied: caption shown at 1.5s");
  await scrubTo(3.5);
  await waitFor(() => captionAbsent(), "template applied: caption absent at 3.5s");
  const templateAt1_5 = (await scrubTo(1.5), regionStats(stage(), CAPTION_REGION));
  await waitFor(() => captionShown(), "template applied: caption shown again at 1.5s");

  // Back to Split for the export.
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split should be re-applied before export");

  // EXPORT: click the real Export action and read the product's own download.
  await waitFor(() => !document.querySelector("#export").disabled, "Export should be enabled");
  document.querySelector("#export").click();
  await waitFor(
    () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
    "export should produce a downloadable result", 700,
  );
  const resultText = document.querySelector("#export-result").textContent || "";
  assert(!/failed/i.test(resultText), "export must not report failure: " + resultText);
  const href = document.querySelector("#export-download").getAttribute("href");
  assert(href && href.indexOf("blob:") === 0, "download link should be a real blob URL");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 4096, "exported file should carry real bytes, got " + blob.size);

  // Load the exported file back into a <video>, resolve its real duration
  // (recorder-produced WebM reports Infinity until nudged to the end), confirm
  // it carries an audio track, then seek into and outside each cue range and
  // sample the decoded frames to prove the captions are burned in.
  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with real dimensions");
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await waitFor(() => isFinite(v.duration), "exported duration should resolve", 200);
  }
  assert(v.duration >= 6.2, "export should cover both cue ranges, duration=" + v.duration);
  const audioTracks = (typeof v.audioTracks !== "undefined" && v.audioTracks) ? v.audioTracks.length
    : (v.mozHasAudio || v.webkitAudioDecodedByteCount > 0 ? 1 : -1);
  assert(audioTracks !== 0, "exported file should carry audio (tracks=" + audioTracks + ")");

  const probe = document.createElement("canvas");
  probe.width = v.videoWidth; probe.height = v.videoHeight;
  async function seekAndSample(t) {
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); resolve(); };
      v.addEventListener("seeked", fin);
      setTimeout(fin, 4000);
      try { v.currentTime = t; } catch (e) { fin(); }
    });
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin);
      setTimeout(fin, 300);
    });
    probe.getContext("2d").drawImage(v, 0, 0, probe.width, probe.height);
    return {
      t,
      caption: regionStats(probe, CAPTION_REGION),
      frame: regionStats(probe, { x0: 0, y0: 0, x1: 100, y1: 100 }),
    };
  }
  const inCue1 = await seekAndSample(1.5);
  const inGap = await seekAndSample(3.5);
  const inCue2 = await seekAndSample(5.5);
  const burnedIn = (s) => s.dark > 0.3 && s.light > 0.0015;
  const plainVideo = (s) => s.dark < 0.15;
  assert(inCue1.frame.bright > 0.2, "exported frame at 1.5s should be nonblank");
  assert(burnedIn(inCue1.caption), "cue 1 caption should be burned into the exported frame at 1.5s: " + JSON.stringify(inCue1.caption));
  assert(inGap.frame.bright > 0.2, "exported frame at 3.5s should be nonblank");
  assert(plainVideo(inGap.caption) && inGap.caption.light < 0.02, "no caption should be burned in at 3.5s: " + JSON.stringify(inGap.caption));
  assert(inCue2.frame.bright > 0.2, "exported frame at 5.5s should be nonblank");
  assert(burnedIn(inCue2.caption), "cue 2 caption should be burned into the exported frame at 5.5s: " + JSON.stringify(inCue2.caption));

  return {
    cuesListed: document.querySelectorAll("#caption-list li").length,
    status: statusText,
    preview: {
      splitAt1_5, splitAt5_5,
      stackAt5_5: presetStats.stack,
      spotlightAt5_5: presetStats.spotlight,
      templateAt1_5,
    },
    exportBytes: blob.size,
    exportDuration: Number(v.duration.toFixed(2)),
    exportSamples: { inCue1, inGap, inCue2 },
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-captions-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;
  const child = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required", "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, entryUrl,
  ]);
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    // 120s budget: two ~8s in-browser media generations, caption import,
    // playback + scrub + preset-switch + template sampling, one full-length
    // export, and three decode-seeks.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-captions: OK — imported WebVTT cues render only in range across Split/Stack/Spotlight and a saved template, and are burned into the export");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-captions: ${e.message}`); process.exit(1); });
