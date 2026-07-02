// scripts/verify-timed-moments.mjs
// Headless rendered workflow for Issue #118: add timed title/callout moments,
// prove they appear only during their scheduled ranges across preset switches,
// and prove they burn into the exported video frames at the same times.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return candidate;
  }
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run timed moments verification.");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", finish);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.off("exit", finish);
      resolve(false);
    }, timeoutMs);
    child.once("exit", finish);
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
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) return;
      await sleep(100 * (attempt + 1));
    }
  }
}

async function fetchJson(url, attempts = 60) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError;
}

function connectWebSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  function send(method, params = {}) {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  }

  return { ws, ready, send };
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };

  async function makeVideo(name, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
      ? "video/webm;codecs=vp8"
      : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.start();
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.font = "26px sans-serif";
      ctx.fillText(name.slice(0, 18), 18, 78);
      ctx.fillText("frame " + i, 18, 118);
      await sleep(40);
    }
    await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
    stream.getTracks().forEach((track) => track.stop());
    return new File(chunks, name, { type: "video/webm" });
  }

  function uploadTo(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function typeInto(el, value) {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function avgColorRect(x, y, w, h) {
    const c = document.getElementById("stage-canvas");
    const ctx = c.getContext("2d");
    const data = ctx.getImageData(x, y, w, h).data;
    let r = 0, g = 0, b = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i+1]; b += data[i+2]; }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  }

  function isClose(color, target, tol) {
    const t = tol || 40;
    return Math.abs(color.r - target.r) <= t && Math.abs(color.g - target.g) <= t && Math.abs(color.b - target.b) <= t;
  }

  async function seekExportedVideo(blob, seconds) {
    const v = document.createElement("video");
    v.muted = true;
    v.src = URL.createObjectURL(blob);
    await new Promise((resolve) => { v.onloadedmetadata = resolve; v.onerror = resolve; setTimeout(resolve, 5000); });
    assert(v.videoWidth > 0 && v.videoHeight > 0, "exported video should have real dimensions");
    const cv = document.createElement("canvas");
    cv.width = v.videoWidth;
    cv.height = v.videoHeight;
    const cctx = cv.getContext("2d");
    v.currentTime = seconds;
    await new Promise((resolve) => { v.onseeked = resolve; setTimeout(resolve, 5000); });
    cctx.drawImage(v, 0, 0);
    return { canvas: cv, ctx: cctx };
  }

  await waitFor(() => window.PDC && window.PDC.app && window.PDC.app.preview, "PDC app should load");
  await waitFor(() => document.querySelector("#stage-canvas"), "composed preview canvas should exist");
  await waitFor(() => document.querySelector('[data-file-bucket="host"]'), "Host upload control should exist");
  await waitFor(() => document.querySelector('[data-file-bucket="guest1"]'), "Guest upload control should exist");
  await waitFor(() => document.querySelector("#moment-save"), "moment UI should exist");

  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857"));
  await sleep(1200);

  const preview = window.PDC.app.preview;
  await waitFor(() => preview.getDuration && preview.getDuration() > 0.5, "preview duration should be available");

  // Add title moment 0-3
  typeInto(document.querySelector("#moment-kind"), "title");
  typeInto(document.querySelector("#moment-text"), "Episode Title");
  typeInto(document.querySelector("#moment-start"), "0");
  typeInto(document.querySelector("#moment-end"), "3");
  document.querySelector("#moment-save").click();
  await sleep(100);

  // Add callout moment 4-7
  typeInto(document.querySelector("#moment-kind"), "callout");
  typeInto(document.querySelector("#moment-text"), "Callout Ref");
  typeInto(document.querySelector("#moment-start"), "4");
  typeInto(document.querySelector("#moment-end"), "7");
  document.querySelector("#moment-save").click();
  await sleep(100);

  // Verify markers by sampling deterministic marker pixels.
  const c = document.getElementById("stage-canvas");
  const w = c.width, h = c.height;
  const titleMarker = { x: 18, y: 18, w: 16, h: 16, rgb: { r: 210, g: 0, b: 255 } };
  const calloutMarker = { x: w - 34, y: h - 34, w: 16, h: 16, rgb: { r: 0, g: 214, b: 255 } };

  function sample(marker) {
    return avgColorRect(marker.x, marker.y, marker.w, marker.h);
  }

  function assertMarker(marker, present, label) {
    const color = sample(marker);
    if (present) assert(isClose(color, marker.rgb, 55), label + ": marker should be present, got " + JSON.stringify(color));
    else assert(!isClose(color, marker.rgb, 55), label + ": marker should be absent, got " + JSON.stringify(color));
    return color;
  }

  // Scrub to 1s => title present, callout absent
  preview.setTime(1.0);
  await sleep(120);
  assertMarker(titleMarker, true, "t=1 title");
  assertMarker(calloutMarker, false, "t=1 callout");

  // Scrub to 5s => callout present, title absent
  preview.setTime(5.0);
  await sleep(120);
  assertMarker(titleMarker, false, "t=5 title");
  assertMarker(calloutMarker, true, "t=5 callout");

  // Scrub to 8s => neither present
  preview.setTime(8.0);
  await sleep(120);
  assertMarker(titleMarker, false, "t=8 title");
  assertMarker(calloutMarker, false, "t=8 callout");

  // Switch presets and ensure markers still work (moments persist).
  document.querySelector('[data-preset="stack"]').click();
  await sleep(250);
  preview.setTime(1.0);
  await sleep(120);
  assertMarker(titleMarker, true, "stack t=1 title");

  document.querySelector('[data-preset="spotlight"]').click();
  await sleep(250);
  preview.setTime(5.0);
  await sleep(120);
  assertMarker(calloutMarker, true, "spotlight t=5 callout");

  // Export and confirm markers are burned into exported frames.
  await waitFor(() => !document.querySelector("#export").disabled, "export should be enabled");
  document.querySelector("#export").click();
  await waitFor(() => document.querySelector("#export-download"), "export should produce a download link", 800);
  const href = document.querySelector("#export-download").getAttribute("href");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 2048, "export blob should have real bytes");

  // Seek into exported video and sample the same marker pixels from frames.
  const f1 = await seekExportedVideo(blob, 1.0);
  const t1Title = (function(){ const d = f1.ctx.getImageData(titleMarker.x, titleMarker.y, titleMarker.w, titleMarker.h).data; let r=0,g=0,b=0,n=d.length/4; for (let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];} return {r:Math.round(r/n),g:Math.round(g/n),b:Math.round(b/n)}; })();
  assert(isClose(t1Title, titleMarker.rgb, 60), "export t=1 should include title marker, got " + JSON.stringify(t1Title));

  const f5 = await seekExportedVideo(blob, 5.0);
  const t5Call = (function(){ const d = f5.ctx.getImageData(calloutMarker.x, calloutMarker.y, calloutMarker.w, calloutMarker.h).data; let r=0,g=0,b=0,n=d.length/4; for (let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];} return {r:Math.round(r/n),g:Math.round(g/n),b:Math.round(b/n)}; })();
  assert(isClose(t5Call, calloutMarker.rgb, 60), "export t=5 should include callout marker, got " + JSON.stringify(t5Call));

  const f8 = await seekExportedVideo(blob, 8.0);
  const t8Title = (function(){ const d = f8.ctx.getImageData(titleMarker.x, titleMarker.y, titleMarker.w, titleMarker.h).data; let r=0,g=0,b=0,n=d.length/4; for (let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];} return {r:Math.round(r/n),g:Math.round(g/n),b:Math.round(b/n)}; })();
  assert(!isClose(t8Title, titleMarker.rgb, 60), "export t=8 should not include title marker");

  return { duration: preview.getDuration(), exportedBytes: blob.size };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-timed-moments-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;

  const child = spawn(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    entryUrl,
  ]);

  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");

    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", {
      expression: browserExpression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 90000,
    });
    ws.close();

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }

    console.log("verify-timed-moments: OK");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((error) => {
  console.error(`verify-timed-moments: ${error.message}`);
  process.exit(1);
});

