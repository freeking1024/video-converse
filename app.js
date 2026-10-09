const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const video = $("#sourceVideo");
const canvas = $("#previewCanvas");
const ctx = canvas.getContext("2d", { alpha: false });
const orientedCanvas = document.createElement("canvas");
const orientedCtx = orientedCanvas.getContext("2d", { alpha: false });

const ratioPresets = {
  "9:16": [9, 16], "16:9": [16, 9], "1:1": [1, 1],
  "4:5": [4, 5], "3:4": [3, 4], "21:9": [21, 9],
};

const fitCopy = {
  cover: "等比放大并裁掉画幅外区域，可拖动调整人物位置。",
  blur: "完整保留原画面，并用同一视频的模糊画面填满背景。",
  contain: "完整保留原画面，空余区域使用所选颜色填充。",
};

const safeZones = {
  none: null,
  douyin: { label: "抖音 / TikTok 安全区", top: 8, right: 18, bottom: 22, left: 7 },
  xiaohongshu: { label: "小红书安全区", top: 8, right: 7, bottom: 20, left: 7 },
  wechat: { label: "微信视频号安全区", top: 8, right: 8, bottom: 19, left: 8 },
  youtube: { label: "YouTube Shorts 安全区", top: 7, right: 13, bottom: 17, left: 7 },
  instagram: { label: "Instagram Reels 安全区", top: 9, right: 8, bottom: 20, left: 8 },
};

const state = {
  queue: [], activeIndex: -1, file: null, objectUrl: null,
  ratio: "9:16", fit: "cover", focusX: 0.5, focusY: 0.5,
  blur: 28, background: "#090b10", rotation: 0, flipX: false, flipY: false, speed: 1,
  safeZone: "none", segments: [], selectedSegmentId: null, subtitles: [],
  subtitleStyle: { size: 46, position: "bottom", color: "#ffffff", background: "#000000", showBackground: true },
  loaded: false, exporting: false, exportCancelled: false, batchRunning: false, batchCancelled: false,
  recorder: null, animationFrame: 0, previewMax: 720,
  audioContext: null, audioSource: null, audioDestination: null, monitorGain: null,
  loadResolver: null, replaceMode: false, previewAdvancePending: false,
  recognition: null, transcribing: false, lastTranscriptEnd: 0,
};

let idCounter = 0;
const makeId = (prefix) => `${prefix}-${Date.now()}-${++idCounter}`;

function formatTime(value, decimals = false) {
  if (!Number.isFinite(value)) return decimals ? "00:00.0" : "00:00";
  const mins = Math.floor(value / 60);
  const secs = Math.max(0, value % 60);
  return `${String(mins).padStart(2, "0")}:${decimals ? secs.toFixed(1).padStart(4, "0") : String(Math.floor(secs)).padStart(2, "0")}`;
}

function setRangeFill(input) {
  if (!input) return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = ((Number(input.value) - min) / Math.max(1, max - min)) * 100;
  input.style.setProperty("--value", `${value}%`);
}

function showNotice(message, type = "info", duration = 3600) {
  const notice = $("#notice");
  notice.textContent = message;
  notice.classList.toggle("error", type === "error");
  notice.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { notice.hidden = true; }, duration);
}

const currentItem = () => state.queue[state.activeIndex] || null;
const activeSegments = () => [...state.segments].sort((a, b) => a.start - b.start);
const selectedSegment = () => state.segments.find((segment) => segment.id === state.selectedSegmentId) || state.segments[0] || null;
const totalKeptDuration = () => state.segments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
const segmentAt = (time) => activeSegments().find((segment) => time >= segment.start - 0.02 && time < segment.end - 0.02) || null;

function createQueueItem(file) {
  return { id: makeId("media"), file, duration: 0, width: 0, height: 0, segments: [], subtitles: [], status: "ready" };
}

function outputDimensions(base = Number($("#resolutionSelect").value)) {
  const [rw, rh] = ratioPresets[state.ratio];
  return rw >= rh ? [Math.round((base * rw) / rh), base] : [base, Math.round((base * rh) / rw)];
}

function previewDimensions() {
  const [rw, rh] = ratioPresets[state.ratio];
  return rw >= rh ? [state.previewMax, Math.round((state.previewMax * rh) / rw)] : [Math.round((state.previewMax * rw) / rh), state.previewMax];
}

function resizePreviewCanvas() {
  if (state.exporting) return;
  [canvas.width, canvas.height] = previewDimensions();
  const [rw, rh] = ratioPresets[state.ratio];
  const stage = $("#stage");
  const maxWidth = Math.max(220, stage.clientWidth - 56);
  const maxHeight = Math.max(240, stage.clientHeight - 56);
  let displayWidth = maxWidth;
  let displayHeight = (displayWidth * rh) / rw;
  if (displayHeight > maxHeight) {
    displayHeight = maxHeight;
    displayWidth = (displayHeight * rw) / rh;
  }
  $("#canvasWrap").style.width = `${displayWidth}px`;
  $("#canvasWrap").style.height = `${displayHeight}px`;
  drawFrame();
}

function cropRect(sourceWidth, sourceHeight, targetWidth, targetHeight, focusX = state.focusX, focusY = state.focusY) {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  let sw;
  let sh;
  if (sourceRatio > targetRatio) { sh = sourceHeight; sw = sourceHeight * targetRatio; }
  else { sw = sourceWidth; sh = sourceWidth / targetRatio; }
  const sx = Math.max(0, Math.min(sourceWidth - sw, (sourceWidth - sw) * focusX));
  const sy = Math.max(0, Math.min(sourceHeight - sh, (sourceHeight - sh) * focusY));
  return { sx, sy, sw, sh };
}

function drawCover(targetCtx, source, targetWidth, targetHeight, focusX = state.focusX, focusY = state.focusY) {
  const sourceWidth = source.videoWidth || source.width;
  const sourceHeight = source.videoHeight || source.height;
  const { sx, sy, sw, sh } = cropRect(sourceWidth, sourceHeight, targetWidth, targetHeight, focusX, focusY);
  targetCtx.drawImage(source, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
}

function drawContain(targetCtx, source, targetWidth, targetHeight) {
  const sourceWidth = source.videoWidth || source.width;
  const sourceHeight = source.videoHeight || source.height;
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  targetCtx.drawImage(source, (targetWidth - width) / 2, (targetHeight - height) / 2, width, height);
}

function getRenderSource() {
  if (state.rotation === 0 && !state.flipX && !state.flipY) return video;
  const rotated = state.rotation === 90 || state.rotation === 270;
  const width = rotated ? video.videoHeight : video.videoWidth;
  const height = rotated ? video.videoWidth : video.videoHeight;
  if (orientedCanvas.width !== width || orientedCanvas.height !== height) { orientedCanvas.width = width; orientedCanvas.height = height; }
  orientedCtx.save();
  orientedCtx.fillStyle = "#000";
  orientedCtx.fillRect(0, 0, width, height);
  orientedCtx.translate(width / 2, height / 2);
  orientedCtx.scale(state.flipX ? -1 : 1, state.flipY ? -1 : 1);
  orientedCtx.rotate((state.rotation * Math.PI) / 180);
  orientedCtx.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
  orientedCtx.restore();
  return orientedCanvas;
}

function wrapText(text, maxWidth) {
  const lines = [];
  let line = "";
  Array.from(text || "").forEach((char) => {
    const test = line + char;
    if (line && ctx.measureText(test).width > maxWidth) { lines.push(line.trim()); line = char; }
    else line = test;
  });
  if (line.trim()) lines.push(line.trim());
  return lines.slice(0, 3);
}

function drawSubtitles(width, height) {
  const active = state.subtitles.filter((subtitle) => video.currentTime >= subtitle.start && video.currentTime <= subtitle.end && subtitle.text.trim());
  if (!active.length) return;
  const text = active.map((subtitle) => subtitle.text.trim()).join("\n");
  const fontSize = Math.max(16, state.subtitleStyle.size * (width / 1080));
  const lineHeight = fontSize * 1.35;
  ctx.save();
  ctx.font = `700 ${fontSize}px Inter, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = text.split("\n").flatMap((paragraph) => wrapText(paragraph, width * 0.82));
  const blockHeight = lines.length * lineHeight;
  const centerY = { top: height * 0.16, middle: height * 0.5, bottom: height * 0.84 }[state.subtitleStyle.position];
  const maxLineWidth = Math.max(...lines.map((line) => ctx.measureText(line).width), 0);
  if (state.subtitleStyle.showBackground) {
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = state.subtitleStyle.background;
    const x = (width - maxLineWidth) / 2 - fontSize * 0.45;
    const y = centerY - blockHeight / 2 - fontSize * 0.25;
    const w = maxLineWidth + fontSize * 0.9;
    const h = blockHeight + fontSize * 0.5;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, fontSize * 0.22); ctx.fill(); }
    else ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = state.subtitleStyle.color;
  ctx.shadowColor = "rgba(0,0,0,.75)";
  ctx.shadowBlur = fontSize * 0.12;
  lines.forEach((line, index) => ctx.fillText(line, width / 2, centerY - blockHeight / 2 + lineHeight * (index + 0.5)));
  ctx.restore();
}

function drawFrame() {
  if (!state.loaded || !video.videoWidth || !canvas.width || video.readyState < 2) return;
  const width = canvas.width;
  const height = canvas.height;
  const source = getRenderSource();
  ctx.save();
  ctx.fillStyle = state.background;
  ctx.fillRect(0, 0, width, height);
  if (state.fit === "cover") drawCover(ctx, source, width, height);
  else if (state.fit === "blur") {
    ctx.save();
    ctx.filter = `blur(${state.blur * Math.max(1, width / 720)}px) brightness(0.62)`;
    ctx.translate(-width * 0.06, -height * 0.06);
    drawCover(ctx, source, width * 1.12, height * 1.12, 0.5, 0.5);
    ctx.restore();
    ctx.fillStyle = "rgba(0,0,0,.08)";
    ctx.fillRect(0, 0, width, height);
    drawContain(ctx, source, width, height);
  } else drawContain(ctx, source, width, height);
  ctx.restore();
  drawSubtitles(width, height);
}

async function keepPreviewInsideSegments() {
  if (state.exporting || state.previewAdvancePending || video.paused || !state.segments.length || segmentAt(video.currentTime)) return;
  const segments = activeSegments();
  const next = segments.find((segment) => segment.start > video.currentTime);
  state.previewAdvancePending = true;
  if (next) { await seekVideo(next.start); if (!state.exporting) await video.play(); }
  else { video.pause(); await seekVideo(segments[0].start); }
  state.previewAdvancePending = false;
}

function paintLoop() {
  drawFrame();
  keepPreviewInsideSegments();
  if (!video.paused && !video.ended) state.animationFrame = requestAnimationFrame(paintLoop);
}

function updateTimeline() {
  if (!state.loaded || state.exporting) return;
  const current = video.currentTime || 0;
  $("#timeline").value = current;
  setRangeFill($("#timeline"));
  $("#currentTime").textContent = formatTime(current, true);
  $("#clipPlayhead").style.left = `calc(${video.duration ? (current / video.duration) * 100 : 0}% + 3px)`;
}

function renderSegments() {
  const track = $("#clipTrack");
  track.replaceChildren();
  const duration = video.duration || currentItem()?.duration || 1;
  activeSegments().forEach((segment, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `clip-segment${segment.id === state.selectedSegmentId ? " active" : ""}`;
    button.style.left = `${(segment.start / duration) * 100}%`;
    button.style.width = `${((segment.end - segment.start) / duration) * 100}%`;
    button.setAttribute("aria-label", `选择片段 ${index + 1}，${formatTime(segment.start, true)} 到 ${formatTime(segment.end, true)}`);
    button.addEventListener("click", () => { state.selectedSegmentId = segment.id; video.currentTime = segment.start; renderSegments(); });
    track.append(button);
  });
  const selected = selectedSegment();
  const selectedIndex = Math.max(0, activeSegments().findIndex((segment) => segment.id === state.selectedSegmentId));
  $("#selectedClipLabel").textContent = selected ? `片段 ${selectedIndex + 1} · ${formatTime(selected.end - selected.start, true)}` : "无片段";
  $("#clipDurationOut").textContent = state.loaded ? `${formatTime(totalKeptDuration() / state.speed, true)} 输出` : "—";
}

function updateCurrentItemData() {
  const item = currentItem();
  if (item) { item.segments = state.segments; item.subtitles = state.subtitles; }
}

function setRatio(ratio) {
  if (!ratioPresets[ratio] || state.exporting) return;
  state.ratio = ratio;
  $$("[data-ratio]").forEach((button) => {
    const active = button.dataset.ratio === ratio;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#ratioOutput").textContent = ratio;
  $("#canvasRatioLabel").textContent = ratio;
  const [width, height] = outputDimensions();
  $("#canvasSizeLabel").textContent = `${width} × ${height}`;
  resizePreviewCanvas();
}

function setFit(mode) {
  if (!fitCopy[mode] || state.exporting) return;
  state.fit = mode;
  $$("#fitModes button").forEach((button) => {
    const active = button.dataset.fit === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
  $("#fitHelper").textContent = fitCopy[mode];
  $("#focusControls").hidden = mode !== "cover";
  $("#backgroundControls").hidden = mode === "cover";
  $(".blur-control").hidden = mode !== "blur";
  $("#dragHint").hidden = mode !== "cover";
  drawFrame();
}

function updateFocus(x, y) {
  state.focusX = Math.max(0, Math.min(1, x));
  state.focusY = Math.max(0, Math.min(1, y));
  $("#focusX").value = Math.round(state.focusX * 100);
  $("#focusY").value = Math.round(state.focusY * 100);
  $("#focusXOut").textContent = `${Math.round(state.focusX * 100)}%`;
  $("#focusYOut").textContent = `${Math.round(state.focusY * 100)}%`;
  setRangeFill($("#focusX"));
  setRangeFill($("#focusY"));
  $("#focusGuide").style.left = `${state.focusX * 100}%`;
  $("#focusGuide").style.top = `${state.focusY * 100}%`;
  drawFrame();
}

function updateSafeZone(value) {
  state.safeZone = value;
  const config = safeZones[value];
  $("#safeZoneOverlay").hidden = !config || !state.loaded;
  if (!config) return;
  $("#safeZoneFrame").style.inset = `${config.top}% ${config.right}% ${config.bottom}% ${config.left}%`;
  $("#safeZoneLabel").textContent = config.label;
}

function drawActiveThumbnail() {
  const thumb = $(`.media-card[data-index="${state.activeIndex}"] canvas`);
  if (!thumb || video.readyState < 2) return;
  thumb.width = 116;
  thumb.height = 84;
  const thumbContext = thumb.getContext("2d", { alpha: false });
  thumbContext.fillStyle = "#090b10";
  thumbContext.fillRect(0, 0, 116, 84);
  drawCover(thumbContext, video, 116, 84, 0.5, 0.5);
}

function renderMediaLists() {
  const mediaList = $("#mediaList");
  const batchQueue = $("#batchQueue");
  mediaList.replaceChildren();
  batchQueue.replaceChildren();
  state.queue.forEach((item, index) => {
    const mediaButton = document.createElement("button");
    mediaButton.type = "button";
    mediaButton.dataset.index = index;
    mediaButton.className = `media-card${index === state.activeIndex ? " active" : ""}${item.status === "done" ? " done" : ""}`;
    mediaButton.innerHTML = `<span class="media-thumb"><canvas aria-hidden="true"></canvas><span class="media-duration">${formatTime(item.duration)}</span></span><span class="media-copy"><strong></strong><span class="media-status"></span></span><span class="media-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m7 12 3 3 7-7"/></svg></span>`;
    mediaButton.querySelector("strong").textContent = item.file.name;
    mediaButton.querySelector(".media-status").textContent = item.status === "done" ? "已导出" : item.width ? `${item.width} × ${item.height}` : `${(item.file.size / 1024 / 1024).toFixed(1)} MB`;
    mediaButton.addEventListener("click", () => loadQueueItem(index));
    mediaList.append(mediaButton);
    const batchButton = document.createElement("button");
    batchButton.type = "button";
    batchButton.className = `batch-item${index === state.activeIndex ? " active" : ""}${item.status === "done" ? " done" : ""}`;
    batchButton.innerHTML = `<span class="batch-item-index">${index + 1}</span><span class="batch-item-name"></span><span class="batch-item-status">${item.status === "done" ? "已完成" : "待处理"}</span>`;
    batchButton.querySelector(".batch-item-name").textContent = item.file.name;
    batchButton.addEventListener("click", () => loadQueueItem(index));
    batchQueue.append(batchButton);
  });
  $("#batchCount").textContent = state.queue.length;
  $("#batchSummaryTitle").textContent = state.queue.length ? `${state.queue.length} 个视频待处理` : "还没有批量任务";
  $("#batchExportBtn").disabled = !state.queue.length || state.batchRunning;
  $("#dropZone").hidden = Boolean(state.queue.length);
  drawActiveThumbnail();
}

function addFiles(files, replaceActive = false) {
  const valid = [...files].filter((file) => file.type.startsWith("video/"));
  if (!valid.length) return showNotice("请选择有效的视频文件。", "error");
  if (replaceActive && state.activeIndex >= 0) {
    state.queue.splice(state.activeIndex, 1, createQueueItem(valid[0]));
    loadQueueItem(state.activeIndex);
  } else {
    const known = new Set(state.queue.map((item) => `${item.file.name}-${item.file.size}-${item.file.lastModified}`));
    valid.forEach((file) => {
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      if (!known.has(key)) { state.queue.push(createQueueItem(file)); known.add(key); }
    });
    if (state.activeIndex < 0) loadQueueItem(0);
  }
  renderMediaLists();
  if (valid.length > 1) showNotice(`已加入 ${valid.length} 个视频，可在“批量”中统一导出。`);
}

function loadQueueItem(index) {
  const item = state.queue[index];
  if (!item) return Promise.resolve(false);
  if (state.exporting && !state.batchRunning) return Promise.resolve(false);
  if (index === state.activeIndex && state.loaded && video.src) return Promise.resolve(true);
  video.pause();
  state.activeIndex = index;
  state.file = item.file;
  state.loaded = false;
  state.segments = item.segments;
  state.subtitles = item.subtitles;
  state.selectedSegmentId = item.segments[0]?.id || null;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(item.file);
  video.src = state.objectUrl;
  video.load();
  $("#projectName").textContent = item.file.name.replace(/\.[^/.]+$/, "");
  renderMediaLists();
  renderSubtitles();
  return new Promise((resolve) => { state.loadResolver = resolve; });
}

function switchTool(panelId) {
  $$(".tool-tabs button").forEach((button) => {
    const active = button.dataset.panel === panelId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $$(".tool-panel").forEach((panel) => {
    const active = panel.id === panelId;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

function renderSubtitles() {
  const list = $("#subtitleList");
  list.replaceChildren();
  $("#subtitleEmpty").hidden = Boolean(state.subtitles.length);
  state.subtitles.sort((a, b) => a.start - b.start).forEach((subtitle, index) => {
    const item = document.createElement("div");
    item.dataset.id = subtitle.id;
    item.className = `subtitle-item${video.currentTime >= subtitle.start && video.currentTime <= subtitle.end ? " active" : ""}`;
    const top = document.createElement("div");
    top.className = "subtitle-item-top";
    const start = document.createElement("input");
    Object.assign(start, { type: "number", min: "0", step: "0.1", value: Number(subtitle.start).toFixed(1) });
    start.setAttribute("aria-label", `字幕 ${index + 1} 开始时间`);
    const separator = document.createElement("span"); separator.textContent = "至";
    const end = document.createElement("input");
    Object.assign(end, { type: "number", min: "0", step: "0.1", value: Number(subtitle.end).toFixed(1) });
    end.setAttribute("aria-label", `字幕 ${index + 1} 结束时间`);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `删除字幕 ${index + 1}`);
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10 4v5m4-5v5M9 7l1-3h4l1 3m3 0-1 13H7L6 7"/></svg>';
    top.append(start, separator, end, remove);
    const textarea = document.createElement("textarea");
    textarea.value = subtitle.text;
    textarea.setAttribute("aria-label", `字幕 ${index + 1} 内容`);
    item.append(top, textarea);
    item.addEventListener("click", (event) => {
      if (!event.target.matches("textarea,input,button")) video.currentTime = subtitle.start;
    });
    start.addEventListener("change", () => {
      subtitle.start = Math.max(0, Math.min(Number(start.value), subtitle.end - 0.1));
      start.value = Number(subtitle.start).toFixed(1); updateCurrentItemData(); drawFrame();
    });
    end.addEventListener("change", () => {
      subtitle.end = Math.min(video.duration || Infinity, Math.max(Number(end.value), subtitle.start + 0.1));
      end.value = Number(subtitle.end).toFixed(1); updateCurrentItemData(); drawFrame();
    });
    textarea.addEventListener("input", () => { subtitle.text = textarea.value; updateCurrentItemData(); drawFrame(); });
    remove.addEventListener("click", () => {
      state.subtitles.splice(state.subtitles.indexOf(subtitle), 1); updateCurrentItemData(); renderSubtitles(); drawFrame();
    });
    list.append(item);
  });
}

function updateSubtitleActiveStates() {
  $$(".subtitle-item").forEach((element) => {
    const subtitle = state.subtitles.find((item) => item.id === element.dataset.id);
    element.classList.toggle("active", Boolean(subtitle && video.currentTime >= subtitle.start && video.currentTime <= subtitle.end));
  });
}

function addSubtitle(text = "输入字幕", startTime = video.currentTime, endTime = Math.min(video.duration || startTime + 2.5, startTime + 2.5)) {
  if (!state.loaded) return;
  state.subtitles.push({ id: makeId("subtitle"), start: Math.max(0, startTime), end: Math.max(startTime + 0.2, endTime), text });
  updateCurrentItemData(); renderSubtitles(); drawFrame();
}

function srtTimeToSeconds(value) {
  const match = value.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, "0").slice(0, 3)) / 1000 : 0;
}

function parseSrt(text) {
  return text.replace(/\r/g, "").trim().split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) return null;
    const [start, end] = lines[timeIndex].split("-->").map(srtTimeToSeconds);
    return { id: makeId("subtitle"), start, end, text: lines.slice(timeIndex + 1).join("\n").replace(/<[^>]+>/g, "").trim() };
  }).filter((item) => item && item.end > item.start && item.text);
}

function stopTranscription(message) {
  state.transcribing = false;
  if (state.recognition) { try { state.recognition.stop(); } catch (_) { /* already stopped */ } }
  state.recognition = null;
  $("#autoSubtitleBtn").classList.remove("recording");
  $("#autoSubtitleBtn").innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5M20 4v5h-5M20 12a8 8 0 0 1-14 5M4 20v-5h5"/><path d="M9 10v4m3-7v10m3-7v4"/></svg>自动听写';
  if (message) showNotice(message);
}

async function toggleAutoTranscription() {
  if (state.transcribing) { video.pause(); stopTranscription("自动听写已停止，可以逐条校正字幕。" ); return; }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return showNotice("当前浏览器不支持自动听写，请使用 Chrome/Edge，或导入 SRT 字幕。", "error", 5000);
  if (!state.loaded) return;
  const recognition = new Recognition();
  recognition.lang = $("#subtitleLanguage").value;
  recognition.continuous = true;
  recognition.interimResults = false;
  state.recognition = recognition;
  state.transcribing = true;
  state.lastTranscriptEnd = activeSegments()[0]?.start || 0;
  $("#autoSubtitleBtn").classList.add("recording");
  $("#autoSubtitleBtn").textContent = "停止听写";
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      if (!event.results[index].isFinal) continue;
      const text = event.results[index][0].transcript.trim();
      if (!text) continue;
      const end = video.currentTime;
      const start = Math.max(state.lastTranscriptEnd, end - Math.min(5, Math.max(1.2, text.length * 0.18)));
      addSubtitle(text, start, Math.max(start + 0.4, end));
      state.lastTranscriptEnd = end;
    }
  };
  recognition.onerror = (event) => {
    if (event.error !== "no-speech" && event.error !== "aborted") stopTranscription("语音识别未能继续，请检查麦克风权限或改用 SRT。" );
  };
  recognition.onend = () => {
    if (state.transcribing && !video.paused) { try { recognition.start(); } catch (_) { stopTranscription("自动听写已结束。" ); } }
  };
  try {
    await seekVideo(activeSegments()[0]?.start || 0);
    video.muted = false;
    $("#volumeBtn").classList.remove("muted-audio");
    recognition.start();
    await video.play();
    showNotice("正在自动听写：请保持视频声音开启，并允许浏览器使用麦克风。", "info", 5200);
  } catch (error) { console.error(error); stopTranscription("无法启动自动听写，请检查浏览器麦克风权限。" ); }
}

function setupFormatOptions() {
  const select = $("#formatSelect");
  const candidates = [
    { mime: "video/mp4;codecs=h264,aac", label: "MP4 · H.264", ext: "mp4" }, { mime: "video/mp4", label: "MP4", ext: "mp4" },
    { mime: "video/webm;codecs=vp9,opus", label: "WebM · VP9", ext: "webm" }, { mime: "video/webm;codecs=vp8,opus", label: "WebM · VP8", ext: "webm" },
    { mime: "video/webm", label: "WebM", ext: "webm" },
  ];
  const seen = new Set();
  candidates.forEach((item) => {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(item.mime) && !seen.has(item.ext)) {
      seen.add(item.ext);
      const option = document.createElement("option"); option.value = JSON.stringify(item); option.textContent = item.label; select.append(option);
    }
  });
  if (!select.options.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "当前浏览器不支持导出"; select.append(option); }
}

function initAudioCapture() {
  if (!$("#includeAudio").checked) return [];
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return [];
  if (!state.audioContext) {
    state.audioContext = new AudioContextClass();
    state.audioSource = state.audioContext.createMediaElementSource(video);
    state.audioDestination = state.audioContext.createMediaStreamDestination();
    state.monitorGain = state.audioContext.createGain();
    state.audioSource.connect(state.audioDestination);
    state.audioSource.connect(state.monitorGain);
    state.monitorGain.connect(state.audioContext.destination);
  }
  state.monitorGain.gain.value = 0;
  state.audioContext.resume();
  return state.audioDestination.stream.getAudioTracks().map((track) => track.clone());
}

async function seekVideo(time) {
  const target = Math.max(0, Math.min(time, Math.max(0, (video.duration || time) - 0.001)));
  if (Math.abs(video.currentTime - target) < 0.025) return;
  await new Promise((resolve) => { video.addEventListener("seeked", resolve, { once: true }); video.currentTime = target; });
}

function downloadBlob(blob, item, format) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${item.file.name.replace(/\.[^/.]+$/, "")}_${state.ratio.replace(":", "x")}.${format.ext}`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

async function performExport(batchPosition = null) {
  if (!state.loaded || state.exporting) return null;
  if (!canvas.captureStream || !window.MediaRecorder || !$("#formatSelect").value) {
    showNotice("当前浏览器不支持本地视频导出，请使用最新版 Chrome、Edge 或 Safari。", "error"); return null;
  }
  const segments = activeSegments().filter((segment) => segment.end - segment.start > 0.04);
  if (!segments.length) { showNotice("至少需要保留一个有效视频片段。", "error"); return null; }
  const format = JSON.parse($("#formatSelect").value);
  const [width, height] = outputDimensions();
  const fps = Number($("#fpsSelect").value);
  const totalSourceDuration = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  const restoreTime = video.currentTime;
  const restoreRate = video.playbackRate;
  const item = currentItem();
  const chunks = [];
  state.exporting = true;
  state.exportCancelled = false;
  video.pause();
  video.playbackRate = state.speed;
  $("#playBtn").classList.remove("playing");
  $("#exportBtn").disabled = true;
  $("#batchExportBtn").disabled = true;
  $("#exportToast").hidden = false;
  $("#exportProgress").style.width = "0%";
  $("#exportPercent").textContent = "0%";
  $("#exportTitle").textContent = batchPosition ? `批量导出 ${batchPosition.current}/${batchPosition.total}` : "正在生成视频";
  $("#exportDetail").textContent = `${width} × ${height} · ${state.speed}× · ${segments.length} 个片段`;
  return new Promise(async (resolve) => {
    let stream;
    let recorder;
    let segmentIndex = 0;
    let completedSource = 0;
    let switching = false;
    const finish = async (blob = null) => {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (state.monitorGain) state.monitorGain.gain.value = video.muted ? 0 : 1;
      state.exporting = false; state.recorder = null;
      $("#exportToast").hidden = true;
      $("#exportBtn").disabled = false;
      $("#batchExportBtn").disabled = !state.queue.length || state.batchRunning;
      video.playbackRate = restoreRate;
      resizePreviewCanvas();
      await seekVideo(Math.min(restoreTime, video.duration || restoreTime));
      drawFrame(); updateTimeline();
      resolve(blob ? { blob, format, item } : null);
    };
    try {
      await seekVideo(segments[0].start);
      canvas.width = width; canvas.height = height; drawFrame();
      stream = canvas.captureStream(fps);
      initAudioCapture().forEach((track) => stream.addTrack(track));
      const bitsPerSecond = width * height >= 3840 * 2160 ? 32_000_000 : width * height >= 1920 * 1080 ? 12_000_000 : 6_000_000;
      recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: bitsPerSecond });
      state.recorder = recorder;
      recorder.ondataavailable = (event) => { if (event.data && event.data.size > 0) chunks.push(event.data); };
      recorder.onerror = () => showNotice("导出时发生错误，请降低清晰度后重试。", "error");
      recorder.onstop = () => finish(!state.exportCancelled && chunks.length ? new Blob(chunks, { type: format.mime.split(";")[0] }) : null);
      recorder.start(600);
      await video.play();
      const renderExport = async () => {
        if (!state.exporting || state.exportCancelled) return;
        drawFrame();
        const segment = segments[segmentIndex];
        const withinSegment = Math.max(0, Math.min(segment.end - segment.start, video.currentTime - segment.start));
        const percent = Math.round(Math.min(1, (completedSource + withinSegment) / totalSourceDuration) * 100);
        $("#exportPercent").textContent = `${percent}%`; $("#exportProgress").style.width = `${percent}%`;
        if (!switching && (video.currentTime >= segment.end - 0.035 || video.ended)) {
          if (segmentIndex >= segments.length - 1) { video.pause(); if (recorder.state !== "inactive") recorder.stop(); return; }
          switching = true;
          completedSource += segment.end - segment.start;
          segmentIndex += 1;
          video.pause();
          if (recorder.state === "recording") recorder.pause();
          await seekVideo(segments[segmentIndex].start);
          if (recorder.state === "paused") recorder.resume();
          await video.play();
          switching = false;
        }
        requestAnimationFrame(renderExport);
      };
      requestAnimationFrame(renderExport);
    } catch (error) {
      console.error(error);
      if (recorder && recorder.state !== "inactive") recorder.stop(); else finish(null);
      showNotice("无法开始导出，请尝试降低清晰度或更换浏览器。", "error");
    }
  });
}

async function exportVideo() {
  const result = await performExport();
  if (!result) { if (state.exportCancelled) showNotice("已取消导出。" ); return; }
  downloadBlob(result.blob, result.item, result.format);
  result.item.status = "done"; renderMediaLists(); showNotice("视频已生成，下载已开始。" );
}

async function batchExport() {
  if (!state.queue.length || state.batchRunning) return;
  const restoreIndex = Math.max(0, state.activeIndex);
  state.batchRunning = true; state.batchCancelled = false; $("#batchExportBtn").disabled = true;
  showNotice("批量任务已开始，浏览器可能询问是否允许多个下载。", "info", 5000);
  for (let index = 0; index < state.queue.length; index += 1) {
    if (state.batchCancelled) break;
    await loadQueueItem(index);
    const result = await performExport({ current: index + 1, total: state.queue.length });
    if (!result) { if (state.exportCancelled) state.batchCancelled = true; break; }
    downloadBlob(result.blob, result.item, result.format);
    result.item.status = "done"; renderMediaLists();
  }
  state.batchRunning = false;
  await loadQueueItem(Math.min(restoreIndex, state.queue.length - 1));
  $("#batchExportBtn").disabled = !state.queue.length;
  showNotice(state.batchCancelled ? "批量导出已停止。" : "批量导出完成，文件已逐个下载。" );
}

video.addEventListener("loadedmetadata", () => {
  const item = currentItem();
  if (!item) return;
  state.loaded = true;
  Object.assign(item, { duration: video.duration, width: video.videoWidth, height: video.videoHeight });
  if (!item.segments.length) item.segments.push({ id: makeId("clip"), start: 0, end: video.duration });
  state.segments = item.segments; state.subtitles = item.subtitles;
  state.selectedSegmentId = state.segments.some((segment) => segment.id === state.selectedSegmentId) ? state.selectedSegmentId : state.segments[0].id;
  $("#emptyState").hidden = true; $("#canvasWrap").hidden = false; $("#clipEditor").hidden = false;
  $("#timeline").max = video.duration; $("#totalTime").textContent = formatTime(video.duration, true);
  ["#replaceBtn", "#exportBtn", "#playBtn", "#timeline", "#volumeBtn", "#autoSubtitleBtn", "#addSubtitleBtn"].forEach((selector) => { $(selector).disabled = false; });
  video.playbackRate = state.speed;
  renderMediaLists(); renderSegments(); renderSubtitles(); updateSafeZone(state.safeZone); resizePreviewCanvas();
  video.currentTime = Math.max(0, Math.min(state.segments[0].start + 0.1, state.segments[0].end - 0.01));
  if (state.loadResolver) { state.loadResolver(true); state.loadResolver = null; }
});

video.addEventListener("seeked", () => { drawFrame(); drawActiveThumbnail(); updateTimeline(); updateSubtitleActiveStates(); });
video.addEventListener("timeupdate", () => { updateTimeline(); if (!state.exporting) updateSubtitleActiveStates(); });
video.addEventListener("play", () => { $("#playBtn").classList.add("playing"); $("#playBtn").setAttribute("aria-label", "暂停"); cancelAnimationFrame(state.animationFrame); paintLoop(); });
video.addEventListener("pause", () => { $("#playBtn").classList.remove("playing"); $("#playBtn").setAttribute("aria-label", "播放"); drawFrame(); });
video.addEventListener("ended", () => {
  if (state.transcribing) stopTranscription("自动听写完成，可以逐条校正字幕。" );
  if (!state.exporting && state.segments.length) video.currentTime = activeSegments()[0].start;
});
video.addEventListener("error", () => showNotice("无法读取这个视频，请尝试 MP4、MOV 或 WebM 文件。", "error"));

$("#fileInput").addEventListener("change", (event) => { addFiles(event.target.files, state.replaceMode); state.replaceMode = false; event.target.value = ""; });
$("#addMediaBtn").addEventListener("click", () => $("#fileInput").click());
$("#emptyUploadBtn").addEventListener("click", () => $("#fileInput").click());
$("#replaceBtn").addEventListener("click", () => { state.replaceMode = true; $("#fileInput").click(); });

const dropZone = $("#dropZone");
["dragenter", "dragover"].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add("dragover"); }));
["dragleave", "drop"].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove("dragover"); }));
dropZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));

$$(".tool-tabs button").forEach((button) => button.addEventListener("click", () => switchTool(button.dataset.panel)));
$$("[data-ratio]").forEach((button) => button.addEventListener("click", () => setRatio(button.dataset.ratio)));
$$("#fitModes button").forEach((button) => button.addEventListener("click", () => setFit(button.dataset.fit)));
$("#focusX").addEventListener("input", (event) => updateFocus(Number(event.target.value) / 100, state.focusY));
$("#focusY").addEventListener("input", (event) => updateFocus(state.focusX, Number(event.target.value) / 100));
$("#centerFocusBtn").addEventListener("click", () => updateFocus(0.5, 0.5));
$("#blurAmount").addEventListener("input", (event) => { state.blur = Number(event.target.value); $("#blurOut").textContent = state.blur; setRangeFill(event.target); drawFrame(); });
$("#backgroundColor").addEventListener("input", (event) => { state.background = event.target.value; $("#colorValue").textContent = state.background.toUpperCase(); drawFrame(); });

$("#rotateBtn").addEventListener("click", () => {
  state.rotation = (state.rotation + 90) % 360;
  $("#rotateBtn span").textContent = state.rotation ? `旋转 ${state.rotation}°` : "旋转";
  $("#rotateBtn").classList.toggle("active", state.rotation !== 0); drawFrame(); drawActiveThumbnail();
});
$("#flipXBtn").addEventListener("click", () => { state.flipX = !state.flipX; $("#flipXBtn").classList.toggle("active", state.flipX); $("#flipXBtn").setAttribute("aria-pressed", String(state.flipX)); drawFrame(); });
$("#flipYBtn").addEventListener("click", () => { state.flipY = !state.flipY; $("#flipYBtn").classList.toggle("active", state.flipY); $("#flipYBtn").setAttribute("aria-pressed", String(state.flipY)); drawFrame(); });
$("#speedSelect").addEventListener("change", (event) => { state.speed = Number(event.target.value); video.playbackRate = state.speed; renderSegments(); });

$("#setInBtn").addEventListener("click", () => {
  const segment = selectedSegment();
  if (!segment || video.currentTime >= segment.end - 0.1) return showNotice("入点必须早于片段结束位置。", "error");
  segment.start = Math.max(0, video.currentTime); updateCurrentItemData(); renderSegments();
});
$("#setOutBtn").addEventListener("click", () => {
  const segment = selectedSegment();
  if (!segment || video.currentTime <= segment.start + 0.1) return showNotice("出点必须晚于片段开始位置。", "error");
  segment.end = Math.min(video.duration, video.currentTime); updateCurrentItemData(); renderSegments();
});
$("#splitBtn").addEventListener("click", () => {
  const segment = state.segments.find((clip) => video.currentTime > clip.start + 0.08 && video.currentTime < clip.end - 0.08);
  if (!segment) return showNotice("请把播放头放在片段内部再分割。", "error");
  const index = state.segments.indexOf(segment);
  const left = { id: makeId("clip"), start: segment.start, end: video.currentTime };
  const right = { id: makeId("clip"), start: video.currentTime, end: segment.end };
  state.segments.splice(index, 1, left, right); state.selectedSegmentId = right.id; updateCurrentItemData(); renderSegments();
});
$("#deleteClipBtn").addEventListener("click", () => {
  if (state.segments.length <= 1) return showNotice("至少保留一个片段；可通过入点和出点继续裁剪。", "error");
  const index = state.segments.findIndex((segment) => segment.id === state.selectedSegmentId);
  if (index < 0) return;
  state.segments.splice(index, 1); state.selectedSegmentId = state.segments[Math.min(index, state.segments.length - 1)].id;
  video.currentTime = selectedSegment().start; updateCurrentItemData(); renderSegments();
});

$("#playBtn").addEventListener("click", async () => {
  if (!video.paused) { video.pause(); return; }
  if (!segmentAt(video.currentTime) && state.segments.length) await seekVideo(selectedSegment()?.start || activeSegments()[0].start);
  video.play();
});
$("#timeline").addEventListener("input", (event) => { video.currentTime = Number(event.target.value); updateTimeline(); drawFrame(); });
$("#volumeBtn").addEventListener("click", () => {
  video.muted = !video.muted; $("#volumeBtn").classList.toggle("muted-audio", video.muted);
  $("#volumeBtn").setAttribute("aria-label", video.muted ? "取消静音" : "静音");
  if (state.monitorGain && !state.exporting) state.monitorGain.gain.value = video.muted ? 0 : 1;
});

$("#safeZoneSelect").addEventListener("change", (event) => updateSafeZone(event.target.value));
$("#resolutionSelect").addEventListener("change", () => setRatio(state.ratio));
$("#addSubtitleBtn").addEventListener("click", () => addSubtitle());
$("#autoSubtitleBtn").addEventListener("click", toggleAutoTranscription);
$("#srtInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file || !state.loaded) return;
  const subtitles = parseSrt(await file.text());
  if (!subtitles.length) showNotice("没有在文件中找到有效的 SRT 字幕。", "error");
  else { state.subtitles.splice(0, state.subtitles.length, ...subtitles); updateCurrentItemData(); renderSubtitles(); drawFrame(); showNotice(`已导入 ${subtitles.length} 条字幕。`); }
  event.target.value = "";
});
$("#subtitleSize").addEventListener("input", (event) => { state.subtitleStyle.size = Number(event.target.value); $("#subtitleSizeOut").textContent = event.target.value; setRangeFill(event.target); drawFrame(); });
$("#subtitlePosition").addEventListener("change", (event) => { state.subtitleStyle.position = event.target.value; drawFrame(); });
$("#subtitleColor").addEventListener("input", (event) => { state.subtitleStyle.color = event.target.value; drawFrame(); });
$("#subtitleBg").addEventListener("input", (event) => { state.subtitleStyle.background = event.target.value; drawFrame(); });
$("#subtitleBackground").addEventListener("change", (event) => { state.subtitleStyle.showBackground = event.target.checked; drawFrame(); });

$("#resetBtn").addEventListener("click", () => {
  setRatio("9:16"); setFit("cover"); updateFocus(0.5, 0.5);
  Object.assign(state, { blur: 28, background: "#090b10", rotation: 0, flipX: false, flipY: false, speed: 1 });
  $("#blurAmount").value = 28; $("#blurOut").textContent = "28"; $("#backgroundColor").value = state.background;
  $("#colorValue").textContent = state.background.toUpperCase(); $("#resolutionSelect").value = "1080"; $("#fpsSelect").value = "30";
  $("#speedSelect").value = "1"; $("#includeAudio").checked = true; $("#rotateBtn span").textContent = "旋转";
  $$("#transformControls button").forEach((button) => { button.classList.remove("active"); if (button.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", "false"); });
  if (state.loaded) video.playbackRate = 1;
  setRangeFill($("#blurAmount")); renderSegments(); drawFrame();
});

let dragging = false;
function pointerToFocus(event) {
  const rect = $("#canvasWrap").getBoundingClientRect();
  updateFocus((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
}
$("#canvasWrap").addEventListener("pointerdown", (event) => {
  if (state.fit !== "cover" || state.exporting) return;
  dragging = true; $("#canvasWrap").classList.add("dragging"); $("#canvasWrap").setPointerCapture(event.pointerId); pointerToFocus(event);
});
$("#canvasWrap").addEventListener("pointermove", (event) => { if (dragging) pointerToFocus(event); });
$("#canvasWrap").addEventListener("pointerup", (event) => {
  dragging = false; $("#canvasWrap").classList.remove("dragging"); $("#canvasWrap").releasePointerCapture(event.pointerId); $("#dragHint").classList.add("fade");
});

$("#fitPreviewBtn").addEventListener("click", resizePreviewCanvas);
$("#exportBtn").addEventListener("click", exportVideo);
$("#batchExportBtn").addEventListener("click", batchExport);
$("#cancelExportBtn").addEventListener("click", () => {
  if (!state.exporting) return;
  state.exportCancelled = true; if (state.batchRunning) state.batchCancelled = true; video.pause();
  if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
});

window.addEventListener("resize", resizePreviewCanvas);
window.addEventListener("beforeunload", () => { if (state.objectUrl) URL.revokeObjectURL(state.objectUrl); if (state.transcribing) stopTranscription(); });

setupFormatOptions();
setRatio("9:16");
setFit("cover");
renderMediaLists();
[$("#focusX"), $("#focusY"), $("#blurAmount"), $("#timeline"), $("#subtitleSize")].forEach(setRangeFill);
