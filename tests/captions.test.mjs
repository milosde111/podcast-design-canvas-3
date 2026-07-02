// tests/captions.test.mjs — imported transcript captions model: WebVTT parsing
// (timestamp forms, cue identifiers, NOTE/STYLE blocks, cue settings, inline
// tag stripping, multi-line cues), [start, end) activation semantics, and
// persistence across preset and template switches.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const C = PDC.captions;
const E = PDC.episode;

test("parseTimestamp accepts HH:MM:SS.mmm and MM:SS.mmm forms", () => {
  assert.equal(C.parseTimestamp("00:00:00.000"), 0);
  assert.equal(C.parseTimestamp("00:00:03.000"), 3);
  assert.equal(C.parseTimestamp("00:01:05.500"), 65.5);
  assert.equal(C.parseTimestamp("01:00:00.000"), 3600);
  assert.equal(C.parseTimestamp("00:03.000"), 3); // short MM:SS form
  assert.equal(C.parseTimestamp("01:05.250"), 65.25);
  assert.equal(C.parseTimestamp("00:00:01,500"), 1.5); // comma decimal tolerated
});

test("parseTimestamp rejects non-timestamps", () => {
  for (const bad of ["", "abc", "1:2", "00:00:00", "0:0:0.0", null, undefined, "90:00.000"]) {
    assert.ok(Number.isNaN(C.parseTimestamp(bad)), `expected NaN for ${String(bad)}`);
  }
});

test("stripTags removes WebVTT/HTML inline markup and decodes entities", () => {
  assert.equal(C.stripTags("<v Roger>Hello there</v>"), "Hello there");
  assert.equal(C.stripTags("<c.loud>Big</c> <i>news</i>"), "Big news");
  assert.equal(C.stripTags("Ready<00:00:01.000> set"), "Ready set");
  assert.equal(C.stripTags("A &amp; B &lt;3"), "A & B <3");
});

test("parseVtt parses a standard two-cue file", () => {
  const vtt = [
    "WEBVTT",
    "",
    "1",
    "00:00:00.000 --> 00:00:03.000",
    "Welcome to the show.",
    "",
    "2",
    "00:00:04.000 --> 00:00:07.000",
    "Today we talk about captions.",
    "",
  ].join("\n");
  const out = C.parseVtt(vtt);
  assert.equal(out.ok, true);
  assert.equal(out.error, "");
  assert.deepEqual(out.cues, [
    { start: 0, end: 3, text: "Welcome to the show." },
    { start: 4, end: 7, text: "Today we talk about captions." },
  ]);
});

test("parseVtt handles CRLF, a header note, cue settings, and multi-line cues", () => {
  const vtt = [
    "WEBVTT - Some Title",
    "",
    "NOTE this is a comment block and must be ignored",
    "",
    "intro",
    "00:00:01.000 --> 00:00:04.000 align:start position:10%",
    "<v Host>First line",
    "second line</v>",
    "",
    "00:00:05.000 --> 00:00:06.500",
    "Later.",
    "",
  ].join("\r\n");
  const out = C.parseVtt(vtt);
  assert.equal(out.ok, true);
  assert.equal(out.cues.length, 2);
  assert.deepEqual(out.cues[0], { start: 1, end: 4, text: "First line\nsecond line" });
  assert.deepEqual(out.cues[1], { start: 5, end: 6.5, text: "Later." });
});

test("parseVtt sorts cues by start time and drops zero/negative-length cues", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:04.000 --> 00:00:07.000",
    "second",
    "",
    "00:00:00.000 --> 00:00:03.000",
    "first",
    "",
    "00:00:08.000 --> 00:00:08.000",
    "zero length dropped",
    "",
  ].join("\n");
  const out = C.parseVtt(vtt);
  assert.equal(out.ok, true);
  assert.deepEqual(out.cues.map((c) => c.text), ["first", "second"]);
});

test("parseVtt rejects a non-WebVTT file", () => {
  const out = C.parseVtt("1\n00:00:00,000 --> 00:00:03,000\nSRT not VTT\n");
  assert.equal(out.ok, false);
  assert.match(out.error, /WEBVTT/i);
  assert.deepEqual(out.cues, []);
});

test("parseVtt reports a file with a header but no valid cues", () => {
  const out = C.parseVtt("WEBVTT\n\nNOTE just a comment\n");
  assert.equal(out.ok, false);
  assert.match(out.error, /no caption cues/i);
});

test("setCaptions stores only sanitized cues and metadata on the episode", () => {
  const ep = E.createEpisode({});
  const stored = C.setCaptions(ep, "episode.vtt", [
    { start: 0, end: 3, text: "  hi  " },
    { start: 4, end: 4, text: "dropped: zero length" },
    { start: 6, end: 8, text: "" },
    { start: 9, end: 11, text: "bye" },
  ]);
  assert.ok(stored);
  assert.equal(stored.fileName, "episode.vtt");
  assert.deepEqual(stored.cues, [
    { start: 0, end: 3, text: "hi" },
    { start: 9, end: 11, text: "bye" },
  ]);
  assert.equal(C.hasCaptions(ep), true);
  assert.equal(JSON.stringify(ep.captions).includes("WEBVTT"), false, "raw file text must not be stored");
});

test("setCaptions with no valid cues clears the caption track", () => {
  const ep = E.createEpisode({});
  C.setCaptions(ep, "a.vtt", [{ start: 0, end: 3, text: "x" }]);
  assert.equal(C.hasCaptions(ep), true);
  const res = C.setCaptions(ep, "b.vtt", [{ start: 5, end: 5, text: "bad" }]);
  assert.equal(res, null);
  assert.equal(C.hasCaptions(ep), false);
  assert.deepEqual(C.listCues(ep), []);
});

test("clearCaptions removes the caption track", () => {
  const ep = E.createEpisode({});
  C.setCaptions(ep, "a.vtt", [{ start: 0, end: 3, text: "x" }]);
  C.clearCaptions(ep);
  assert.equal(C.hasCaptions(ep), false);
  assert.equal(C.getCaptions(ep), null);
  assert.deepEqual(C.activeCaptions(ep, 1), []);
});

test("activeCaptions is start-inclusive and end-exclusive", () => {
  const ep = E.createEpisode({});
  C.setCaptions(ep, "a.vtt", [
    { start: 0, end: 3, text: "FIRST" },
    { start: 4, end: 7, text: "SECOND" },
  ]);
  const texts = (t) => C.activeCaptions(ep, t).map((c) => c.text);
  assert.deepEqual(texts(0), ["FIRST"], "start boundary inclusive");
  assert.deepEqual(texts(2.999), ["FIRST"]);
  assert.deepEqual(texts(3), [], "end boundary exclusive");
  assert.deepEqual(texts(3.5), [], "gap shows nothing");
  assert.deepEqual(texts(4), ["SECOND"], "second cue starts exactly at 4");
  assert.deepEqual(texts(6.999), ["SECOND"]);
  assert.deepEqual(texts(7), [], "second cue gone at its end");
  assert.deepEqual(texts(-1), []);
  assert.deepEqual(texts(NaN), []);
});

test("overlapping cues are both active inside the overlap", () => {
  const ep = E.createEpisode({});
  C.setCaptions(ep, "a.vtt", [
    { start: 0, end: 5, text: "A" },
    { start: 3, end: 8, text: "B" },
  ]);
  assert.deepEqual(C.activeCaptions(ep, 4).map((c) => c.text), ["A", "B"]);
  assert.deepEqual(C.activeCaptions(ep, 1).map((c) => c.text), ["A"]);
  assert.deepEqual(C.activeCaptions(ep, 6).map((c) => c.text), ["B"]);
});

test("captions live on the episode and survive preset and template switches", () => {
  const ep = E.createEpisode({});
  const parsed = C.parseVtt("WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nHELLO\n\n00:00:04.000 --> 00:00:07.000\nWORLD\n");
  C.setCaptions(ep, "show.vtt", parsed.cues);
  const before = JSON.stringify(C.listCues(ep));
  for (const preset of ["stack", "spotlight", "split"]) {
    E.setPreset(ep, preset);
    assert.equal(ep.presetId, preset);
    assert.equal(JSON.stringify(C.listCues(ep)), before, `captions unchanged on ${preset}`);
    assert.deepEqual(C.activeCaptions(ep, 1.5).map((c) => c.text), ["HELLO"]);
    assert.deepEqual(C.activeCaptions(ep, 5).map((c) => c.text), ["WORLD"]);
  }
  const tpl = PDC.templates.saveTemplate("Custom", { host: { x: 0, y: 0, w: 50, h: 100 } });
  E.setPreset(ep, tpl.id);
  assert.equal(ep.presetId, tpl.id);
  assert.equal(JSON.stringify(C.listCues(ep)), before, "captions unchanged on a custom template");
  assert.deepEqual(C.activeCaptions(ep, 1.5).map((c) => c.text), ["HELLO"]);
});

test("resetEpisode clears the imported caption track", () => {
  const ep = E.createEpisode({});
  C.setCaptions(ep, "a.vtt", [{ start: 0, end: 3, text: "x" }]);
  assert.equal(C.hasCaptions(ep), true);
  E.resetEpisode(ep, { title: "fresh" });
  assert.equal(C.hasCaptions(ep), false);
  assert.equal(ep.captions, null);
});

test("episodes created before the captions feature still work (lazy track)", () => {
  const ep = E.createEpisode({});
  delete ep.captions; // simulate a pre-feature episode object
  assert.equal(C.hasCaptions(ep), false);
  assert.deepEqual(C.listCues(ep), []);
  assert.deepEqual(C.activeCaptions(ep, 1), []);
  assert.ok(C.setCaptions(ep, "a.vtt", [{ start: 0, end: 1, text: "x" }]));
  assert.equal(C.hasCaptions(ep), true);
});
