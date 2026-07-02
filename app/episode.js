// app/episode.js
// Pure, DOM-free episode model: which uploaded file is assigned to which speaker
// bucket, and which preset is selected. Kept free of browser APIs so it can be
// unit-tested under plain Node (tests/episode.test.mjs) and reused by the UI.
// Classic script — exposed on window.PDC.episode.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { SPEAKER_BUCKETS, DEFAULT_PRESET_ID, getPreset } = PDC.presets;

  function createEpisode(init) {
    return {
      title: (init && init.title) || "Untitled episode",
      // bucket -> { name, size, type } media descriptor (no bytes here; the UI
      // keeps the live <video> element + object URL alongside this model).
      media: {},
      // bucket -> social/profile URL string entered during setup, kept per
      // speaker so later steps can derive names/topics/references from it.
      socialLinks: {},
      presetId: DEFAULT_PRESET_ID,
      audioQuality: {
        leveling: "balanced",
        clarity: "balanced",
        noiseReduction: "balanced",
      },
      // Timed visual moments: lightweight contextual editing slice.
      // Each moment: { id, kind: "title"|"callout", text, start, end }
      moments: [],
    };
  }

  // Assign an uploaded file descriptor to a bucket. Returns the episode for
  // chaining. Unknown buckets are ignored so a stray input can't corrupt state.
  function assignMedia(episode, bucket, descriptor) {
    if (!SPEAKER_BUCKETS.includes(bucket)) return episode;
    episode.media[bucket] = descriptor;
    return episode;
  }

  // Removing a speaker drops that bucket's media AND its own social link, but
  // never touches other speakers' links (so removing one speaker can't lose the
  // social context attached to the others).
  function clearMedia(episode, bucket) {
    delete episode.media[bucket];
    if (episode.socialLinks) delete episode.socialLinks[bucket];
    return episode;
  }

  // Store (or clear, when blank) the social/profile link for one speaker bucket.
  function setSocialLink(episode, bucket, url) {
    if (!SPEAKER_BUCKETS.includes(bucket)) return episode;
    if (!episode.socialLinks) episode.socialLinks = {};
    const trimmed = (url || "").trim();
    if (trimmed) episode.socialLinks[bucket] = trimmed;
    else delete episode.socialLinks[bucket];
    return episode;
  }

  function getSocialLink(episode, bucket) {
    return (episode.socialLinks && episode.socialLinks[bucket]) || "";
  }

  const AUDIO_LEVELING = ["off", "balanced", "strong"];
  const AUDIO_CLARITY = ["natural", "balanced", "enhanced"];
  const AUDIO_NOISE_REDUCTION = ["off", "balanced", "strong"];

  function ensureAudioQuality(episode) {
    if (!episode.audioQuality) {
      episode.audioQuality = {
        leveling: "balanced",
        clarity: "balanced",
        noiseReduction: "balanced",
      };
    }
    return episode.audioQuality;
  }

  function setAudioQuality(episode, patch) {
    const next = ensureAudioQuality(episode);
    if (!patch || typeof patch !== "object") return episode;
    if (AUDIO_LEVELING.includes(patch.leveling)) next.leveling = patch.leveling;
    if (AUDIO_CLARITY.includes(patch.clarity)) next.clarity = patch.clarity;
    if (AUDIO_NOISE_REDUCTION.includes(patch.noiseReduction)) next.noiseReduction = patch.noiseReduction;
    return episode;
  }

  function getAudioQuality(episode) {
    const q = ensureAudioQuality(episode);
    return { leveling: q.leveling, clarity: q.clarity, noiseReduction: q.noiseReduction };
  }

  function ensureMoments(episode) {
    if (!episode.moments || !Array.isArray(episode.moments)) episode.moments = [];
    return episode.moments;
  }

  function clampNumber(v, fallback) {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizeMoment(raw) {
    const kind = raw && raw.kind === "callout" ? "callout" : "title";
    const text = String((raw && raw.text) || "").trim();
    let start = clampNumber(raw && raw.start, 0);
    let end = clampNumber(raw && raw.end, start + 1);
    start = Math.max(0, start);
    end = Math.max(start, end);
    return { kind, text, start, end };
  }

  function nextMomentId(episode) {
    episode._nextMomentId = clampNumber(episode._nextMomentId, 1);
    const id = "m" + episode._nextMomentId;
    episode._nextMomentId += 1;
    return id;
  }

  function addMoment(episode, raw) {
    const moments = ensureMoments(episode);
    const m = normalizeMoment(raw || {});
    const id = (raw && raw.id) || nextMomentId(episode);
    moments.push({ id, kind: m.kind, text: m.text, start: m.start, end: m.end });
    return id;
  }

  function updateMoment(episode, id, patch) {
    const moments = ensureMoments(episode);
    const idx = moments.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    const current = moments[idx];
    const merged = normalizeMoment({
      kind: patch && patch.kind != null ? patch.kind : current.kind,
      text: patch && patch.text != null ? patch.text : current.text,
      start: patch && patch.start != null ? patch.start : current.start,
      end: patch && patch.end !=null ? patch.end : current.end,
    });
    moments[idx] = { id: current.id, kind: merged.kind, text: merged.text, start: merged.start, end: merged.end };
    return true;
  }

  function removeMoment(episode, id) {
    const moments = ensureMoments(episode);
    const before = moments.length;
    episode.moments = moments.filter((m) => m.id !== id);
    return episode.moments.length !== before;
  }

  function listMoments(episode) {
    return ensureMoments(episode).slice().sort((a, b) => (a.start - b.start) || String(a.id).localeCompare(String(b.id)));
  }

  function activeMomentsAt(episode, timeSeconds) {
    const t = clampNumber(timeSeconds, 0);
    return listMoments(episode).filter((m) => t >= m.start && t < m.end);
  }

  // Pull a readable handle out of a social/profile URL (last path segment, or a
  // bare @handle, or the domain). Pure string work — no network, no scraping.
  function deriveHandle(raw) {
    let s = String(raw || "").trim();
    if (!s) return "";
    const at = s.match(/^@([A-Za-z0-9_.\-]+)$/);
    if (at) return at[1];
    s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[?#]/)[0];
    const parts = s.split("/").filter(Boolean);
    const last = parts.length > 1 ? parts[parts.length - 1] : "";
    const handle = (last || "").replace(/^@/, "");
    return handle;
  }

  // The name to display for a speaker: derived from their social link when one
  // is set, otherwise the default bucket label (Host / Guest 1 / Guest 2).
  function speakerName(episode, bucket) {
    const fallback = (PDC.presets.BUCKET_LABELS && PDC.presets.BUCKET_LABELS[bucket]) || bucket;
    return deriveHandle(getSocialLink(episode, bucket)) || fallback;
  }

  // Buckets that currently hold media, in canonical speaker order.
  function assignedBuckets(episode) {
    return SPEAKER_BUCKETS.filter((b) => episode.media[b]);
  }

  // A selectable layout is either a built-in preset or a saved/draft custom
  // template (templates.js loads after this module but is present at call time).
  function layoutExists(id) {
    if (getPreset(id)) return true;
    return !!(PDC.templates && PDC.templates.getTemplate && PDC.templates.getTemplate(id));
  }

  function setPreset(episode, presetId) {
    if (layoutExists(presetId)) episode.presetId = presetId;
    return episode;
  }

  // The product needs at least two speakers and a valid preset before it can
  // compose a meaningful preview. This is the single source of truth for the
  // "ready to preview" state — the UI never invents its own gate.
  const MIN_SPEAKERS = 2;

  function canCompose(episode) {
    return assignedBuckets(episode).length >= MIN_SPEAKERS && layoutExists(episode.presetId);
  }

  function readinessReason(episode) {
    const n = assignedBuckets(episode).length;
    if (n < MIN_SPEAKERS) {
      const need = MIN_SPEAKERS - n;
      return `Add ${need} more speaker video${need === 1 ? "" : "s"} to start the preview.`;
    }
    if (!layoutExists(episode.presetId)) return "Choose a preset layout.";
    return "";
  }

  PDC.episode = {
    MIN_SPEAKERS,
    createEpisode,
    assignMedia,
    clearMedia,
    assignedBuckets,
    setPreset,
    setSocialLink,
    getSocialLink,
    setAudioQuality,
    getAudioQuality,
    addMoment,
    updateMoment,
    removeMoment,
    listMoments,
    activeMomentsAt,
    deriveHandle,
    speakerName,
    canCompose,
    readinessReason,
  };
})();
