// app/preview.js
// Composes the preview on a 16:9 canvas by drawing real uploaded video frames
// (ctx.drawImage) into preset layout rects. Hidden <video> elements decode files;
// the canvas is what users and screenshot-based review see — canvas pixels are
// always captured, unlike raw <video> layers in some headless environments.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { getPreset } = PDC.presets;

  function createPreview(canvasEl) {
    const ctx = canvasEl.getContext("2d");
    const videos = {};
    const videoHost = document.createElement("div");
    videoHost.setAttribute("aria-hidden", "true");
    videoHost.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
    document.body.appendChild(videoHost);
    let playing = false;
    let rafId = 0;
    let episodeRef = null;
    let referenceTime = 0;

    function syncReferenceTime() {
      const times = Object.values(videos)
        .map((video) => video.currentTime)
        .filter((time) => Number.isFinite(time))
        .filter((time) => time > 0);
      if (!times.length) return referenceTime;
      const next = Math.min(...times);
      referenceTime = next;
      return next;
    }

    function seekAll(time) {
      if (!Number.isFinite(time)) return;
      Object.values(videos).forEach((video) => {
        try {
          video.currentTime = time;
        } catch (error) {
          /* not seekable yet */
        }
      });
    }

    function alignPlayback(time) {
      referenceTime = syncReferenceTime();
      const target = Number.isFinite(time) ? Math.min(referenceTime, time) : referenceTime;
      seekAll(target);
      return target;
    }

    function ensureVideo(bucket) {
      let v = videos[bucket];
      if (!v) {
        v = document.createElement("video");
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.setAttribute("playsinline", "");
        v.preload = "auto";
        v.dataset.speaker = bucket;
        v.addEventListener("loadeddata", drawFrame);
        v.addEventListener("canplay", drawFrame);
        videoHost.appendChild(v);
        videos[bucket] = v;
      }
      return v;
    }

    // Recorded WebM (e.g. MediaRecorder output) can report Infinity duration
    // until the element is nudged to its end once. Resolving a real duration
    // lets the scrub bar span the episode and lets export record a full pass.
    // Every path here is bounded — a stuck probe-seek can never wedge loading.
    function normalizeDuration(v, then) {
      if (isFinite(v.duration)) {
        then();
        return;
      }
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        v.removeEventListener("durationchange", onChange);
        try {
          v.currentTime = 0;
        } catch (e) {
          /* not seekable */
        }
        then();
      }
      function onChange() {
        if (isFinite(v.duration)) finish();
      }
      v.addEventListener("durationchange", onChange);
      setTimeout(finish, 3000);
      try {
        v.currentTime = 1e7;
      } catch (e) {
        finish();
      }
    }

    function setSource(bucket, file) {
      const v = ensureVideo(bucket);
      if (v.dataset.objectUrl) URL.revokeObjectURL(v.dataset.objectUrl);
      const url = URL.createObjectURL(file);
      v.dataset.objectUrl = url;
      v.src = url;
      v.load();
      v.addEventListener(
        "loadeddata",
        function seekFirstFrame() {
          v.removeEventListener("loadeddata", seekFirstFrame);
          normalizeDuration(v, function () {
            try {
              if (v.currentTime === 0) v.currentTime = Math.max(0, referenceTime);
            } catch (e) {
              /* not seekable yet */
            }
            alignPlayback(referenceTime);
            drawFrame();
            if (playing) {
              const p = v.play();
              if (p && typeof p.catch === "function") p.catch(function () {});
            }
          });
        },
        { once: true },
      );
      return v;
    }

    function clear(bucket) {
      const v = videos[bucket];
      if (v) {
        if (v.dataset.objectUrl) URL.revokeObjectURL(v.dataset.objectUrl);
        v.remove();
      }
      delete videos[bucket];
    }

    function drawFrame() {
      if (!episodeRef) return;
      const buckets = PDC.episode.assignedBuckets(episodeRef);
      const rects = PDC.templates
        ? PDC.templates.resolveLayout(episodeRef, buckets.length)
        : (getPreset(episodeRef.presetId) || PDC.presets.PRESETS[0]).layout(buckets.length);
      const w = canvasEl.width;
      const h = canvasEl.height;

      ctx.fillStyle = "#05070c";
      ctx.fillRect(0, 0, w, h);

      buckets.forEach(function (bucket, i) {
        const rect = rects[i] || rects[rects.length - 1];
        const x = (rect.x / 100) * w;
        const y = (rect.y / 100) * h;
        const rw = (rect.w / 100) * w;
        const rh = (rect.h / 100) * h;
        const v = videos[bucket];

        ctx.fillStyle = "#000";
        ctx.fillRect(x, y, rw, rh);

        // Clip each speaker to its layout rect so cover-scaled frames cannot bleed
        // into neighboring rows (Stack) or outside their PiP inset (Spotlight).
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, rw, rh);
        ctx.clip();

        if (v && v.videoWidth > 0) {
          const scale = Math.max(rw / v.videoWidth, rh / v.videoHeight);
          const dw = v.videoWidth * scale;
          const dh = v.videoHeight * scale;
          const dx = x + (rw - dw) / 2;
          const dy = y + (rh - dh) / 2;
          ctx.drawImage(v, dx, dy, dw, dh);
        }
        ctx.restore();

        // Spotlight guest feeds are small insets — a light frame makes them read
        // as clearly subordinate picture-in-picture overlays on the host frame.
        if (rw < w * 0.75 && rh < h * 0.75) {
          ctx.strokeStyle = "rgba(255,255,255,0.88)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, rw - 2, rh - 2);
        }

        const label = PDC.episode.speakerName(episodeRef, bucket);
        if (label) {
          ctx.fillStyle = "rgba(8,10,16,0.72)";
          ctx.fillRect(x + 8, y + rh - 28, Math.min(rw - 16, label.length * 9 + 20), 22);
          ctx.fillStyle = "#fff";
          ctx.font = "600 14px system-ui, sans-serif";
          ctx.fillText(label, x + 14, y + rh - 12);
        }
      });

      drawActiveMoments(w, h);
      drawActiveCaptions(w, h);

      canvasEl.dataset.preset = episodeRef.presetId;
      canvasEl.dataset.speakers = String(buckets.length);
    }

    // Timed visual moments are painted straight onto the stage canvas, over the
    // composed layout, ONLY while the reference playback time is inside their
    // scheduled [start, end) range. Because export records this same canvas,
    // whatever is drawn here is burned into the exported video at the same
    // times. Solid backing bars keep the text legible in screenshots over any
    // preset (Split / Stack / Spotlight) or custom template.
    function drawActiveMoments(w, h) {
      if (!PDC.moments || !episodeRef) return;
      const active = PDC.moments.activeMoments(episodeRef, referenceTime);
      if (!active.length) return;
      ctx.save();
      ctx.textBaseline = "middle";
      active.forEach(function (moment) {
        if (moment.type === "title") drawTitleMoment(moment, w, h);
        else if (moment.type === "callout") drawCalloutMoment(moment, w, h);
        else drawImageMoment(moment, w, h);
      });
      ctx.restore();
    }

    // Episode title: a prominent centered bar across the top of the stage with
    // a dark backing and an accent underline, distinct from speaker labels.
    function drawTitleMoment(moment, w, h) {
      const barX = Math.round(w * 0.07);
      const barY = Math.round(h * 0.055);
      const barW = w - barX * 2;
      const barH = Math.round(h * 0.13);
      ctx.fillStyle = "rgba(5, 7, 12, 0.88)";
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = "#6c8cff";
      ctx.fillRect(barX, barY + barH - Math.max(3, Math.round(h * 0.006)), barW, Math.max(3, Math.round(h * 0.006)));
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 " + Math.round(h * 0.062) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(moment.text, w / 2, barY + barH / 2, barW - Math.round(w * 0.04));
    }

    // Callout / reference: a lower-third banner anchored left with an accent
    // edge — visually distinct from the title bar and from speaker name tags.
    function drawCalloutMoment(moment, w, h) {
      ctx.font = "600 " + Math.round(h * 0.046) + "px system-ui, sans-serif";
      const maxTextW = w * 0.7;
      const textW = Math.min(ctx.measureText(moment.text).width, maxTextW);
      const edgeW = Math.max(5, Math.round(w * 0.006));
      const padX = Math.round(w * 0.018);
      const barX = Math.round(w * 0.045);
      const barY = Math.round(h * 0.76);
      const barH = Math.round(h * 0.105);
      const barW = Math.max(Math.round(textW) + edgeW + padX * 2, Math.round(w * 0.34));
      ctx.fillStyle = "rgba(8, 10, 16, 0.9)";
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = "#8a6cff";
      ctx.fillRect(barX, barY, edgeW, barH);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "left";
      ctx.fillText(moment.text, barX + edgeW + padX, barY + barH / 2, maxTextW);
    }

    // B-roll image: a real uploaded PNG, decoded in app/moment-images.js and
    // drawn as a large centered overlay. Export records this same canvas, so
    // the image burns into the output whenever this draw path is active.
    function drawImageMoment(moment, w, h) {
      if (!PDC.momentImages) return;
      const record = PDC.momentImages.get(moment.id);
      if (!record || !record.image) return;
      const img = record.image;
      const maxW = Math.round(w * 0.56);
      const maxH = Math.round(h * 0.52);
      const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
      const dw = Math.round(img.naturalWidth * scale);
      const dh = Math.round(img.naturalHeight * scale);
      const x = Math.round((w - dw) / 2);
      const y = Math.round(h * 0.18);
      const pad = Math.max(10, Math.round(w * 0.012));
      ctx.fillStyle = "rgba(5, 7, 12, 0.78)";
      ctx.fillRect(x - pad, y - pad, dw + pad * 2, dh + pad * 2);
      ctx.drawImage(img, x, y, dw, dh);
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = Math.max(3, Math.round(w * 0.003));
      ctx.strokeRect(x - 1, y - 1, dw + 2, dh + 2);
    }

    // Wrap a caption line to fit maxW at the currently-set ctx.font. Returns one
    // or more display lines (empty array for blank input).
    function wrapCaptionLine(text, maxW) {
      const words = String(text).split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      const out = [];
      let line = words[0];
      for (let i = 1; i < words.length; i++) {
        const test = line + " " + words[i];
        if (ctx.measureText(test).width > maxW) {
          out.push(line);
          line = words[i];
        } else {
          line = test;
        }
      }
      out.push(line);
      return out;
    }

    // Imported transcript captions: the cue(s) active at the current reference
    // time, drawn as a centered lower caption band with a dark backing and an
    // accent top edge — anchored at the very bottom of the stage, below the
    // callout lower-third and distinct from the title bar. Captions live on the
    // episode, so this renders identically over any preset or custom template;
    // and because export records this same canvas, the caption text is burned
    // into the exported video at each cue's scheduled time.
    function drawActiveCaptions(w, h) {
      if (!PDC.captions || !episodeRef) return;
      const cues = PDC.captions.activeCaptions(episodeRef, referenceTime);
      if (!cues.length) return;
      const fs = Math.max(15, Math.round(h * 0.05));
      const lineH = Math.round(fs * 1.3);
      const padX = Math.round(w * 0.022);
      const padY = Math.round(h * 0.02);
      const maxTextW = Math.round(w * 0.76);

      ctx.save();
      ctx.font = "600 " + fs + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const lines = [];
      cues.forEach(function (cue) {
        String(cue.text).split("\n").forEach(function (para) {
          wrapCaptionLine(para, maxTextW).forEach(function (l) { lines.push(l); });
        });
      });
      if (!lines.length) { ctx.restore(); return; }

      let textW = 0;
      lines.forEach(function (l) { textW = Math.max(textW, ctx.measureText(l).width); });
      const minBarW = Math.round(w * 0.5);
      const maxBarW = Math.round(w * 0.86);
      const barW = Math.min(maxBarW, Math.max(minBarW, Math.round(textW) + padX * 2));
      const barH = lines.length * lineH + padY * 2;
      const barX = Math.round((w - barW) / 2);
      const barY = Math.round(h * 0.955) - barH;
      const edge = Math.max(3, Math.round(h * 0.006));

      ctx.fillStyle = "rgba(5, 7, 12, 0.82)";
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = "#43d6a0";
      ctx.fillRect(barX, barY, barW, edge);
      ctx.fillStyle = "#ffffff";
      lines.forEach(function (l, i) {
        const cy = barY + padY + lineH * i + lineH / 2;
        ctx.fillText(l, w / 2, cy, maxTextW);
      });
      ctx.restore();
    }

    function loop() {
      syncReferenceTime();
      drawFrame();
      rafId = requestAnimationFrame(loop);
    }

    function ensureLoop() {
      if (!rafId) rafId = requestAnimationFrame(loop);
    }

    function stopLoop() {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    }

    function render(episode) {
      episodeRef = episode;
      const buckets = PDC.episode.assignedBuckets(episode);
      if (buckets.length) ensureLoop();
      else {
        stopLoop();
        ctx.fillStyle = "#05070c";
        ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
        canvasEl.dataset.preset = "";
        canvasEl.dataset.speakers = "0";
      }
      drawFrame();
      return buckets.length;
    }

    function play() {
      playing = true;
      const targetTime = alignPlayback(0);
      Object.keys(videos).forEach(function (b) {
        const p = videos[b].play();
        if (p && typeof p.catch === "function") p.catch(function () {});
      });
      ensureLoop();
      if (Number.isFinite(targetTime)) {
        seekAll(targetTime);
      }
    }

    function pause() {
      playing = false;
      syncReferenceTime();
      Object.keys(videos).forEach(function (b) {
        videos[b].pause();
      });
    }

    function restart() {
      referenceTime = 0;
      Object.keys(videos).forEach(function (b) {
        try {
          videos[b].currentTime = 0;
        } catch (e) {
          /* not seekable yet */
        }
      });
      play();
    }

    function setMuted(muted) {
      Object.keys(videos).forEach(function (b) {
        videos[b].muted = muted;
      });
    }

    // Longest known speaker duration — the episode timeline the scrubber spans.
    function getDuration() {
      let longest = 0;
      Object.values(videos).forEach(function (v) {
        if (isFinite(v.duration) && v.duration > longest) longest = v.duration;
      });
      return longest;
    }

    function getTime() {
      return referenceTime;
    }

    // Scrub the shared playback timeline to t seconds. Works while playing or
    // paused; the rAF loop keeps compositing, so timed moments show/hide to
    // match the new time on the very next drawn frame.
    function seekTo(t) {
      if (!Number.isFinite(t) || t < 0) return;
      referenceTime = t;
      seekAll(t);
      drawFrame();
    }

    return {
      setSource,
      clear,
      render,
      play,
      pause,
      restart,
      setMuted,
      isPlaying: function () {
        return playing;
      },
      getDuration,
      getTime,
      seekTo,
      drawFrame,
    };
  }

  PDC.preview = { createPreview };
})();
