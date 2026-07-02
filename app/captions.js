// app/captions.js — creator-supplied transcript captions imported from a WebVTT
// (.vtt) file. Pure, DOM-free model in the spirit of app/moments.js: captions
// live ON THE EPISODE (not on a preset or the preview), so switching
// Split/Stack/Spotlight or applying a saved custom template keeps every cue
// attached and rendered over the new layout. The preview draws the active cues
// straight onto the stage canvas each frame, and because export records that
// same canvas, the captions are burned into the exported video at the same
// scheduled times.
//
// Scope: import of a user-supplied WebVTT file only. Automatic transcription,
// speaker diarization, and caption-style editing are intentionally NOT here.
// Classic script — exposed on window.PDC.captions.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  // A WebVTT timestamp: "HH:MM:SS.mmm" or the short "MM:SS.mmm" form. Returns a
  // finite non-negative number of seconds, or NaN when the input is not a time.
  // A comma decimal separator (as SRT uses) is tolerated so lightly-malformed
  // exports still import rather than silently dropping every cue.
  function parseTimestamp(raw) {
    const s = String(raw == null ? "" : raw).trim();
    // WebVTT requires two-digit minutes and seconds; hours (2+ digits) are
    // optional. A comma decimal separator is tolerated for lightly-malformed
    // exports, but sloppy single-digit fields ("0:0:0.0") are rejected.
    const m = s.match(/^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[.,](\d{1,3})$/);
    if (!m) return NaN;
    const h = m[1] ? Number(m[1]) : 0;
    const min = Number(m[2]);
    const sec = Number(m[3]);
    const ms = Number((m[4] + "00").slice(0, 3));
    return h * 3600 + min * 60 + sec + ms / 1000;
  }

  // Seconds -> "M:SS" (used by the cue list in the setup panel).
  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  // Drop WebVTT/HTML inline cue markup (<v Speaker>, <c.class>, <i>, timestamp
  // tags like <00:00:01.000>, etc.) so the burned-in caption shows the spoken
  // text only. Speaker labels inside <v> tags are intentionally discarded —
  // speaker diarization is out of scope for this step.
  function stripTags(s) {
    return String(s == null ? "" : s)
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&");
  }

  // Parse WebVTT text into an ordered list of { start, end, text } cues.
  // Returns { ok, cues, error }. A missing WEBVTT header or a file with no
  // well-timed cues fails with a creator-readable reason rather than throwing.
  function parseVtt(text) {
    const normalized = String(text == null ? "" : text)
      .replace(/^﻿/, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    if (!/^\s*WEBVTT/.test(normalized)) {
      return { ok: false, cues: [], error: "That file is not a WebVTT caption file (missing the WEBVTT header)." };
    }

    // Split into blocks separated by one or more blank lines.
    const blocks = [];
    let current = [];
    normalized.split("\n").forEach(function (line) {
      if (line.trim() === "") {
        if (current.length) blocks.push(current);
        current = [];
      } else {
        current.push(line);
      }
    });
    if (current.length) blocks.push(current);

    const cues = [];
    blocks.forEach(function (block) {
      const first = block[0].trim();
      // Skip the header block and non-cue blocks (NOTE / STYLE / REGION).
      if (/^WEBVTT/.test(first)) return;
      if (/^(NOTE|STYLE|REGION)\b/.test(first) || first === "NOTE" || first === "STYLE" || first === "REGION") return;

      let timingIdx = -1;
      for (let i = 0; i < block.length; i++) {
        if (block[i].indexOf("-->") !== -1) { timingIdx = i; break; }
      }
      if (timingIdx === -1) return; // no timing line -> not a cue

      const parts = block[timingIdx].split("-->");
      if (parts.length < 2) return;
      const start = parseTimestamp(parts[0]);
      // The end timestamp may be followed by cue settings ("align:start ...").
      const endToken = parts[1].trim().split(/\s+/)[0];
      const end = parseTimestamp(endToken);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

      const bodyLines = block
        .slice(timingIdx + 1)
        .map(stripTags)
        .map(function (l) { return l.trim(); })
        .filter(Boolean);
      const cueText = bodyLines.join("\n").trim();
      if (!cueText) return;

      cues.push({ start: start, end: end, text: cueText });
    });

    cues.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    if (!cues.length) {
      return { ok: false, cues: [], error: "No caption cues with valid times were found in that file." };
    }
    return { ok: true, cues: cues, error: "" };
  }

  // Attach parsed cues to the episode under a source file name. Only the parsed
  // cues (times + plain text) are stored — never the raw file bytes.
  function setCaptions(episode, fileName, cues) {
    if (!episode) return null;
    const clean = (Array.isArray(cues) ? cues : [])
      .filter(function (c) { return c && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && String(c.text || "").trim(); })
      .map(function (c) { return { start: Number(c.start), end: Number(c.end), text: String(c.text).trim() }; })
      .sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    if (!clean.length) {
      episode.captions = null;
      return null;
    }
    episode.captions = { fileName: String(fileName || "captions.vtt"), cues: clean };
    return episode.captions;
  }

  function clearCaptions(episode) {
    if (episode) episode.captions = null;
    return episode;
  }

  function getCaptions(episode) {
    return (episode && episode.captions) || null;
  }

  function hasCaptions(episode) {
    return !!(episode && episode.captions && episode.captions.cues && episode.captions.cues.length);
  }

  // Cues in start order (copy — safe for the UI to iterate/render).
  function listCues(episode) {
    if (!hasCaptions(episode)) return [];
    return episode.captions.cues.slice();
  }

  // Cues scheduled over time t (seconds): start inclusive, end exclusive — a
  // 0:00–0:03 cue is visible at exactly 0.0 and gone at exactly 3.0. Matches the
  // activation semantics of timed visual moments.
  function activeCaptions(episode, tSeconds) {
    const t = Number(tSeconds);
    if (!Number.isFinite(t)) return [];
    return listCues(episode).filter(function (c) { return t >= c.start && t < c.end; });
  }

  PDC.captions = {
    parseTimestamp,
    formatTime,
    stripTags,
    parseVtt,
    setCaptions,
    clearCaptions,
    getCaptions,
    hasCaptions,
    listCues,
    activeCaptions,
  };
})();
