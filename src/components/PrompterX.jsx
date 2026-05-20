'use client'

import { useState, useRef, useCallback, useEffect } from "react";

const SAMPLE = `Welcome to PrompterX.

Tap RUN to start. The gold play button starts scrolling.

Double-tap anywhere to pause and resume.

Swipe left or right to adjust speed on the fly.

Keep reading and the scroll will follow you.`;

const GOLD = "#f5a623";
const RED  = "#e84040";
const fmt  = s => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
const isoStamp = () => new Date().toISOString().replace("T", "_").replace(/[:.]/g, "-").slice(0, 19);

// ── IndexedDB ─────────────────────────────────────────────────
const DB_NAME  = "prompterx-recs";
const DB_STORE = "recs";

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE, { keyPath: "id" });
    req.onsuccess  = e => res(e.target.result);
    req.onerror    = () => rej(req.error);
  });
}
async function dbSave(rec) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(rec);
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
}
async function dbLoad() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(DB_STORE).objectStore(DB_STORE).getAll();
    req.onsuccess = () => res((req.result || []).sort((a, b) => b.id - a.id));
    req.onerror   = () => rej(req.error);
  });
}
async function dbDelete(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
}

// ── File parsing ──────────────────────────────────────────────
function readAsText(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = () => rej(new Error("fail")); r.readAsText(file, "utf-8"); });
}
function readAsArrayBuffer(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = () => rej(new Error("fail")); r.readAsArrayBuffer(file); });
}
function stripRtf(s) { return s.replace(/\{\\[^{}]*\}/g, "").replace(/\\[a-z]+\d* ?/g, " ").replace(/[{}\\]/g, "").replace(/ +/g, " ").trim(); }
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
async function parseFile(file) {
  const n = file.name.toLowerCase();
  if (/\.(txt|text|md)$/.test(n)) return readAsText(file);
  if (/\.rtf$/.test(n)) return stripRtf(await readAsText(file));
  if (/\.pdf$/.test(n)) {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await window.pdfjsLib.getDocument({ data: await readAsArrayBuffer(file) }).promise;
    let out = "";
    for (let i = 1; i <= pdf.numPages; i++) out += (await (await pdf.getPage(i)).getTextContent()).items.map(x => x.str).join(" ") + "\n\n";
    return out;
  }
  if (/\.docx?$/.test(n)) {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js");
    return (await window.mammoth.extractRawText({ arrayBuffer: await readAsArrayBuffer(file) })).value;
  }
  return readAsText(file);
}

// ── TimerSheet ────────────────────────────────────────────────
function TimerSheet({ tMin, setTMin, tSec, setTSec, noLimit, setNoLimit, onConfirm, onCancel }) {
  const col = (label, val, onUp, onDn) => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <button onClick={onUp} style={{ width: 56, height: 42, background: "rgba(255,255,255,.07)", border: "1px solid #333", borderBottom: "none", borderRadius: "10px 10px 0 0", color: "#fff", fontSize: 22, cursor: "pointer" }}>▲</button>
      <div style={{ width: 56, height: 56, background: "rgba(245,166,35,.08)", border: "1px solid rgba(245,166,35,.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, fontWeight: 900, color: GOLD }}>{String(val).padStart(2, "0")}</div>
      <button onClick={onDn} style={{ width: 56, height: 42, background: "rgba(255,255,255,.07)", border: "1px solid #333", borderTop: "none", borderRadius: "0 0 10px 10px", color: "#fff", fontSize: 22, cursor: "pointer" }}>▼</button>
    </div>
  );
  return (
    <div style={{ background: "#161616", borderRadius: "20px 20px 0 0", padding: "18px 20px 36px", width: "100%", borderTop: "1px solid #2a2a2a" }}
         onClick={e => e.stopPropagation()}>
      <div style={{ width: 38, height: 4, background: "#333", borderRadius: 2, margin: "0 auto 18px" }} />
      <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 2, marginBottom: 4 }}>SET TARGET TIME</div>
      <div style={{ fontSize: 13, color: "#666", marginBottom: 20 }}>Countdown shown during your run</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 20, opacity: noLimit ? 0.3 : 1, pointerEvents: noLimit ? "none" : "auto" }}>
        {col("Min", tMin, () => setTMin(v => Math.min(99, v + 1)), () => setTMin(v => Math.max(0, v - 1)))}
        <div style={{ fontSize: 34, fontWeight: 900, color: GOLD, paddingBottom: 4 }}>:</div>
        {col("Sec", tSec, () => setTSec(v => (v + 1) % 60), () => setTSec(v => (v - 1 + 60) % 60))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0", borderTop: "1px solid #222", borderBottom: "1px solid #222", marginBottom: 20, cursor: "pointer" }}
           onClick={() => setNoLimit(v => !v)}>
        <div style={{ width: 24, height: 24, borderRadius: 7, border: `2px solid ${noLimit ? GOLD : "#444"}`, background: noLimit ? GOLD : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: "#000", flexShrink: 0 }}>{noLimit ? "✓" : ""}</div>
        <div style={{ fontSize: 15, color: "#f0ede8" }}>No time limit — show elapsed time</div>
      </div>
      <button onClick={onConfirm} style={{ width: "100%", background: GOLD, color: "#000", fontSize: 16, fontWeight: 700, border: "none", borderRadius: 12, padding: 15, cursor: "pointer", marginBottom: 10 }}>
        {noLimit ? "Confirm: No Limit" : `Confirm: ${String(tMin).padStart(2, "0")}:${String(tSec).padStart(2, "0")}`}
      </button>
      <button onClick={onCancel} style={{ width: "100%", background: "transparent", border: "1px solid #2a2a2a", borderRadius: 12, padding: 13, color: RED, fontSize: 15, cursor: "pointer" }}>Cancel</button>
    </div>
  );
}

// ── Replay modal ──────────────────────────────────────────────
function ReplayModal({ rec, onClose, onDownload }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.97)", zIndex: 200,
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  padding: "24px 20px", paddingTop: "max(24px, calc(env(safe-area-inset-top) + 12px))",
                  paddingBottom: "max(24px, calc(env(safe-area-inset-bottom) + 12px))" }}>
      <video src={rec.url} controls autoPlay playsInline
             style={{ width: "100%", maxHeight: "62vh", borderRadius: 12, background: "#111", objectFit: "contain" }} />
      <div style={{ marginTop: 14, textAlign: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#f0ede8" }}>{rec.scriptTitle}</div>
        <div style={{ fontSize: 12, color: "#555", marginTop: 4 }}>{rec.label} · {fmt(rec.duration)}</div>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 20, width: "100%" }}>
        <button onClick={onDownload}
          style={{ flex: 1, background: GOLD, color: "#000", border: "none", borderRadius: 12,
                   padding: "13px 0", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
          ↓ Download
        </button>
        <button onClick={onClose}
          style={{ flex: 1, background: "rgba(255,255,255,.07)", color: "#f0ede8",
                   border: "1px solid #2a2a2a", borderRadius: 12, padding: "13px 0",
                   fontSize: 15, cursor: "pointer" }}>
          Close
        </button>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────
export default function PrompterX() {
  const [screen, setScreen]             = useState("home");
  const [scripts, setScripts]           = useState([{ title: "Sample", text: SAMPLE }]);
  const [editIdx, setEditIdx]           = useState(null);
  const [scriptText, setScriptText]     = useState(SAMPLE);
  const [title, setTitle]               = useState("Sample");
  const [playing, setPlaying]           = useState(false);
  const [speed, setSpeed]               = useState(1.0);
  const [fontSize, setFontSize]         = useState(24);
  const [progress, setProgress]         = useState(0);
  const [elapsed, setElapsed]           = useState(0);
  const [targetSec, setTargetSec]       = useState(0);
  const [tMin, setTMin]                 = useState(5);
  const [tSec, setTSec]                 = useState(0);
  const [noLimit, setNoLimit]           = useState(true);
  const [showTimer, setShowTimer]       = useState(false);
  const [showRunTimer, setShowRunTimer] = useState(false);
  const [uploadMsg, setUploadMsg]       = useState("");
  // recording
  const [recordings, setRecordings]     = useState([]);
  const [isRecording, setIsRecording]   = useState(false);
  const [recElapsed, setRecElapsed]     = useState(0);
  const [replayRec, setReplayRec]       = useState(null);
  const [recError, setRecError]         = useState("");

  const scrollRef    = useRef(null);
  const playingRef   = useRef(false);
  const scrollYRef   = useRef(0);
  const maxYRef      = useRef(0);
  const speedRef     = useRef(1.0);
  const fsRef        = useRef(24);
  const rafRef       = useRef(null);
  const lastTRef     = useRef(null);
  const tBaseRef     = useRef(null);
  const tIntRef      = useRef(null);
  const touchRef     = useRef({ x: 0, y: 0, start: 0, down: false, lastTap: 0 });
  // recording refs
  const mediaRecRef  = useRef(null);
  const chunksRef    = useRef([]);
  const streamRef    = useRef(null);
  const recStartRef  = useRef(null);
  const recIntRef    = useRef(null);
  const replayUrlRef = useRef(null);
  const titleRef     = useRef(title);

  useEffect(() => { titleRef.current = title; }, [title]);

  // load recordings from IndexedDB on mount
  useEffect(() => {
    dbLoad().then(setRecordings).catch(() => {});
    return () => {
      stopRecNow();
      if (replayUrlRef.current) URL.revokeObjectURL(replayUrlRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── scroll engine ─────────────────────────────────────────────
  const measure = useCallback(() => {
    const sc = scrollRef.current; if (!sc) return;
    maxYRef.current = Math.max(0, sc.scrollHeight - sc.clientHeight);
  }, []);

  const setProg = useCallback(() => {
    const m = maxYRef.current; setProgress(m > 0 ? Math.min(100, scrollYRef.current / m * 100) : 0);
  }, []);

  const loop = useCallback((ts) => {
    if (!playingRef.current) return;
    if (lastTRef.current === null) { lastTRef.current = ts; rafRef.current = requestAnimationFrame(loop); return; }
    const dt = Math.min(ts - lastTRef.current, 100); lastTRef.current = ts;
    scrollYRef.current += speedRef.current * fsRef.current * 2.0 * dt / 1000;
    const sc = scrollRef.current; if (!sc) return;
    if (scrollYRef.current >= maxYRef.current) {
      scrollYRef.current = maxYRef.current; sc.scrollTop = scrollYRef.current;
      playingRef.current = false; setPlaying(false); setProg(); clearInterval(tIntRef.current); return;
    }
    sc.scrollTop = scrollYRef.current; setProg(); rafRef.current = requestAnimationFrame(loop);
  }, [setProg]);

  const doPlay = useCallback(() => {
    measure(); if (maxYRef.current <= 0) return;
    if (scrollYRef.current >= maxYRef.current) scrollYRef.current = 0;
    playingRef.current = true; lastTRef.current = null; setPlaying(true);
    if (!tBaseRef.current) tBaseRef.current = Date.now();
    clearInterval(tIntRef.current);
    tIntRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - tBaseRef.current) / 1000)), 500);
    rafRef.current = requestAnimationFrame(loop);
  }, [measure, loop]);

  const doPause = useCallback(() => {
    playingRef.current = false; lastTRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setPlaying(false); clearInterval(tIntRef.current);
  }, []);

  const doRun = useCallback((text, ttl) => {
    setScriptText(text); setTitle(ttl);
    scrollYRef.current = 0; maxYRef.current = 0; lastTRef.current = null;
    playingRef.current = false; tBaseRef.current = null;
    setPlaying(false); setProgress(0); setElapsed(0);
    setScreen("run");
    setTimeout(measure, 150); setTimeout(measure, 400);
  }, [measure]);

  const doExit = useCallback(() => {
    doPause(); clearInterval(tIntRef.current);
    stopRecNow();
    setScreen("home");
  }, [doPause]); // eslint-disable-line react-hooks/exhaustive-deps

  const doRestart = useCallback(() => {
    const was = playingRef.current; doPause();
    scrollYRef.current = 0; tBaseRef.current = null; setElapsed(0); setProgress(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (was) doPlay();
  }, [doPause, doPlay]);

  const applyTimer = useCallback(() => {
    setTargetSec(noLimit ? 0 : tMin * 60 + tSec);
    setShowTimer(false); setShowRunTimer(false);
  }, [noLimit, tMin, tSec]);

  const handleFile = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    setUploadMsg("Reading…");
    try {
      const text = (await parseFile(file)).trim();
      if (!text) { setUploadMsg("No text found"); return; }
      const ttl = file.name.replace(/\.[^.]+$/, "");
      setTitle(ttl); setScriptText(text);
      setScripts(ss => [{ title: ttl, text }, ...ss.filter(s => s.title !== ttl)]);
      setEditIdx(0);
      setUploadMsg("✓ " + file.name);
      setTimeout(() => setUploadMsg(""), 3000);
      setScreen("edit");
    } catch (err) { setUploadMsg("Error: " + (err.message || err)); }
    e.target.value = "";
  }, []);

  // ── touch handlers ────────────────────────────────────────────
  const onTouchStart = useCallback((e) => {
    if (e.target.closest("button")) return;
    const now = Date.now(), t = touchRef.current;
    if (now - t.lastTap < 280) { playingRef.current ? doPause() : doPlay(); t.lastTap = 0; return; }
    t.lastTap = now; t.x = e.touches[0].clientX; t.y = e.touches[0].clientY;
    t.start = scrollYRef.current; t.down = true;
    if (playingRef.current && rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }, [doPause, doPlay]);

  const onTouchMove = useCallback((e) => {
    const t = touchRef.current; if (!t.down) return;
    const dx = e.touches[0].clientX - t.x, dy = e.touches[0].clientY - t.y;
    if (Math.abs(dx) > Math.abs(dy) + 10) {
      setSpeed(s => { const v = Math.max(0.1, Math.min(10, Math.round((s - dx * 0.003) * 10) / 10)); speedRef.current = v; return v; });
      t.x = e.touches[0].clientX;
    } else {
      const p = Math.max(0, Math.min(maxYRef.current, t.start - dy));
      scrollYRef.current = p; if (scrollRef.current) scrollRef.current.scrollTop = p; setProg();
    }
  }, [setProg]);

  const onTouchEnd = useCallback(() => {
    touchRef.current.down = false;
    if (playingRef.current) { lastTRef.current = null; rafRef.current = requestAnimationFrame(loop); }
  }, [loop]);

  // ── recording ─────────────────────────────────────────────────
  function stopRecNow() {
    clearInterval(recIntRef.current);
    if (mediaRecRef.current && mediaRecRef.current.state !== "inactive") {
      try { mediaRecRef.current.stop(); } catch {}
    }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    setIsRecording(false);
  }

  const startRec = useCallback(async () => {
    setRecError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setRecError("Camera/mic not available in this browser"); return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: true });
      streamRef.current = stream;

      const mimeType = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
        .find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || "";

      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data?.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        clearInterval(recIntRef.current);
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "video/webm" });
        const id   = Date.now();
        const rec  = {
          id,
          scriptTitle: titleRef.current,
          mimeType: mr.mimeType || "video/webm",
          blob,
          duration: Math.round((Date.now() - recStartRef.current) / 1000),
          stamp: isoStamp(),
          label: new Date(id).toLocaleString("en-US", {
            month: "short", day: "numeric", year: "numeric",
            hour: "2-digit", minute: "2-digit"
          }),
        };
        try { await dbSave(rec); } catch {}
        setRecordings(rs => [rec, ...rs]);
        if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
        setIsRecording(false);
        setRecElapsed(0);
      };

      recStartRef.current = Date.now();
      mr.start(1000);
      mediaRecRef.current = mr;
      setIsRecording(true);
      setRecElapsed(0);
      clearInterval(recIntRef.current);
      recIntRef.current = setInterval(() =>
        setRecElapsed(Math.floor((Date.now() - recStartRef.current) / 1000)), 500);
    } catch (err) {
      setRecError(err.name === "NotAllowedError" ? "Camera/mic permission denied" : "Recording unavailable: " + (err.message || err));
      if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    }
  }, []);

  const stopRec = useCallback(() => {
    clearInterval(recIntRef.current);
    if (mediaRecRef.current && mediaRecRef.current.state !== "inactive") {
      try { mediaRecRef.current.stop(); } catch {}
    }
  }, []);

  const openReplay = useCallback((rec) => {
    if (replayUrlRef.current) URL.revokeObjectURL(replayUrlRef.current);
    replayUrlRef.current = URL.createObjectURL(rec.blob);
    setReplayRec({ ...rec, url: replayUrlRef.current });
  }, []);

  const closeReplay = useCallback(() => {
    if (replayUrlRef.current) { URL.revokeObjectURL(replayUrlRef.current); replayUrlRef.current = null; }
    setReplayRec(null);
  }, []);

  const downloadRec = useCallback((rec) => {
    const url = URL.createObjectURL(rec.blob);
    const ext = (rec.mimeType || "").includes("mp4") ? "mp4" : "webm";
    const a   = document.createElement("a");
    a.href = url; a.download = `PrompterX_${rec.stamp}.${ext}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, []);

  const deleteRec = useCallback(async (id) => {
    try { await dbDelete(id); } catch {}
    setRecordings(rs => rs.filter(r => r.id !== id));
  }, []);

  // ── derived ───────────────────────────────────────────────────
  const remaining  = targetSec > 0 ? Math.max(0, targetSec - elapsed) : null;
  const timerStr   = remaining !== null ? fmt(remaining) : fmt(elapsed);
  const timerWarn  = remaining !== null && remaining <= 30 && remaining > 0;

  // ── HOME ─────────────────────────────────────────────────────
  if (screen === "home") return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#f0ede8", fontFamily: "sans-serif",
                  display: "flex", flexDirection: "column", padding: "20px 20px 48px", gap: 12 }}>

      <div style={{ fontSize: 26, fontWeight: 900, color: GOLD, letterSpacing: 3, marginBottom: 4 }}>
        PROMPTER<span style={{ opacity: .35 }}>X</span>
      </div>

      {/* Scripts */}
      {scripts.length > 0 && <>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#555" }}>Scripts</div>
        {scripts.map((s, i) => (
          <div key={i} style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: 14,
                                padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}
                 onClick={() => { setTitle(s.title); setScriptText(s.text); setEditIdx(i); setScreen("edit"); }}>
              <div style={{ fontSize: 22, flexShrink: 0 }}>📜</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#f0ede8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{s.text.trim().split(/\s+/).filter(Boolean).length} words</div>
              </div>
              <div style={{ fontSize: 18, color: "#444" }}>›</div>
            </div>
            <button onClick={() => setScripts(ss => ss.filter((_, j) => j !== i))}
              style={{ background: "rgba(232,64,64,.1)", border: "none", borderRadius: 8,
                       width: 32, height: 32, color: RED, fontSize: 15, cursor: "pointer",
                       display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>🗑</button>
          </div>
        ))}
      </>}

      {/* Add script */}
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#555", marginTop: 4 }}>Add Script</div>

      <label style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: 14,
                      padding: "14px 16px", display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}>
        <div style={{ fontSize: 22, flexShrink: 0 }}>📎</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#f0ede8" }}>Upload File</div>
          <div style={{ fontSize: 12, color: uploadMsg && !uploadMsg.startsWith("Error") ? GOLD : uploadMsg.startsWith("Error") ? RED : "#666", marginTop: 2 }}>
            {uploadMsg || ".txt · .md · .rtf · .docx · .pdf"}
          </div>
        </div>
        <div style={{ fontSize: 18, color: "#444" }}>›</div>
        <input type="file" accept=".txt,.text,.md,.rtf,.doc,.docx,.pdf" onChange={handleFile} style={{ display: "none" }} />
      </label>

      <div style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: 14,
                    padding: "14px 16px", display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}
           onClick={() => { setTitle("New Script"); setScriptText(""); setEditIdx(null); setScreen("edit"); }}>
        <div style={{ fontSize: 22, flexShrink: 0 }}>✏️</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#f0ede8" }}>New Script</div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>Type or paste your script</div>
        </div>
        <div style={{ fontSize: 18, color: "#444" }}>›</div>
      </div>

      {/* Timer */}
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#555", marginTop: 4 }}>Timer</div>
      <div style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: 14,
                    padding: "14px 16px", display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}
           onClick={() => setShowTimer(true)}>
        <div style={{ fontSize: 22, flexShrink: 0 }}>⏱</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#f0ede8" }}>Target Time</div>
          <div style={{ fontSize: 12, color: targetSec > 0 ? GOLD : "#666", marginTop: 2 }}>
            {targetSec > 0 ? `Countdown from ${fmt(targetSec)}` : "No limit — tap to set"}
          </div>
        </div>
        <div style={{ fontSize: 18, color: "#444" }}>›</div>
      </div>

      {/* Recordings */}
      {recordings.length > 0 && <>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#555", marginTop: 4 }}>Recordings</div>
        {recordings.map(rec => (
          <div key={rec.id} style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: 14,
                                     padding: "14px 16px", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}
                 onClick={() => openReplay(rec)}>
              <div style={{ fontSize: 22, flexShrink: 0 }}>🎬</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#f0ede8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rec.scriptTitle}</div>
                <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{rec.label} · {fmt(rec.duration)}</div>
              </div>
              <div style={{ fontSize: 16, color: GOLD, flexShrink: 0 }}>▶</div>
            </div>
            <button onClick={() => downloadRec(rec)}
              style={{ background: "rgba(245,166,35,.1)", border: "none", borderRadius: 8,
                       width: 34, height: 34, color: GOLD, fontSize: 16, cursor: "pointer",
                       display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>↓</button>
            <button onClick={() => deleteRec(rec.id)}
              style={{ background: "rgba(232,64,64,.1)", border: "none", borderRadius: 8,
                       width: 34, height: 34, color: RED, fontSize: 15, cursor: "pointer",
                       display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>🗑</button>
          </div>
        ))}
      </>}

      {showTimer && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 50, display: "flex", alignItems: "flex-end" }}
             onClick={() => setShowTimer(false)}>
          <TimerSheet tMin={tMin} setTMin={setTMin} tSec={tSec} setTSec={setTSec}
            noLimit={noLimit} setNoLimit={setNoLimit} onConfirm={applyTimer} onCancel={() => setShowTimer(false)} />
        </div>
      )}

      {replayRec && (
        <ReplayModal rec={replayRec} onClose={closeReplay} onDownload={() => downloadRec(replayRec)} />
      )}
    </div>
  );

  // ── EDIT ─────────────────────────────────────────────────────
  if (screen === "edit") {
    const wc = scriptText.trim().split(/\s+/).filter(Boolean).length;
    const saveAndRun = () => {
      if (!scriptText.trim()) return;
      const entry = { title: title || "Untitled", text: scriptText };
      setScripts(ss => {
        if (editIdx !== null) { const n = [...ss]; n[editIdx] = entry; return n; }
        return [entry, ...ss];
      });
      doRun(scriptText, title || "Untitled");
    };
    return (
      <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#f0ede8", fontFamily: "sans-serif",
                    display: "flex", flexDirection: "column", padding: "20px 20px 32px", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setScreen("home")}
            style={{ background: "#1e1e1e", border: "1px solid #2a2a2a", borderRadius: 9,
                     width: 36, height: 36, color: "#f0ede8", fontSize: 22, cursor: "pointer",
                     display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>‹</button>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Script title…"
            style={{ flex: 1, background: "transparent", border: "none", outline: "none",
                     color: "#f0ede8", fontSize: 17, fontWeight: 700 }} />
        </div>
        <textarea value={scriptText} onChange={e => setScriptText(e.target.value)}
          placeholder="Paste or type your script here…"
          style={{ flex: 1, minHeight: 260, background: "#161616", border: "1px solid #2a2a2a", borderRadius: 12,
                   color: "#f0ede8", fontSize: 16, lineHeight: 1.7, padding: 14, resize: "none", outline: "none", fontFamily: "sans-serif" }} />
        <div style={{ fontSize: 12, color: "#444" }}>{wc} words</div>
        <button onClick={saveAndRun}
          style={{ background: GOLD, color: "#000", border: "none", borderRadius: 12, padding: 16,
                   fontSize: 17, fontWeight: 700, cursor: "pointer", width: "100%" }}>▶ RUN</button>
      </div>
    );
  }

  // ── RUN ──────────────────────────────────────────────────────
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden", userSelect: "none" }}
         onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>

      <div ref={scrollRef}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                 overflowY: "scroll", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
        <div style={{ paddingTop: "33vh", paddingBottom: "67vh", paddingLeft: "8vw", paddingRight: "8vw",
                      fontSize, lineHeight: 1.8, color: "rgba(255,255,255,.92)",
                      whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "'Courier New',monospace" }}>
          {scriptText.split(/\n\n+/).filter(p => p.trim()).map((p, i) => (
            <p key={i} style={{ marginBottom: "1.3em" }}>{p.replace(/\n/g, " ")}</p>
          ))}
        </div>
      </div>

      {/* Fades */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "20%", background: "linear-gradient(to bottom,#000,transparent)", pointerEvents: "none", zIndex: 5 }} />
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "30%", background: "linear-gradient(to top,#000,transparent)", pointerEvents: "none", zIndex: 5 }} />
      <div style={{ position: "absolute", top: "33%", left: 0, right: 0, height: 2, background: `linear-gradient(90deg,transparent,${GOLD} 20%,${GOLD} 80%,transparent)`, boxShadow: `0 0 10px ${GOLD}`, opacity: .55, pointerEvents: "none", zIndex: 6 }} />

      {/* Top HUD */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, display: "flex", alignItems: "center",
                    justifyContent: "space-between", padding: "16px 18px 12px",
                    paddingTop: "max(16px, calc(env(safe-area-inset-top) + 8px))",
                    background: "linear-gradient(to bottom,rgba(0,0,0,.9),transparent)", zIndex: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 2, opacity: .8, maxWidth: "28%",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title.toUpperCase()}
        </div>

        <button onClick={() => setShowRunTimer(true)}
          style={{ fontSize: 20, fontWeight: 900, letterSpacing: 2, background: "none", border: "none",
                   cursor: "pointer", padding: 0, fontFamily: "sans-serif",
                   color: timerWarn ? "#f44" : remaining !== null ? GOLD : "rgba(255,255,255,.4)" }}>
          {timerStr}
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Record / Stop button */}
          <button onClick={isRecording ? stopRec : startRec}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 9px",
                     borderRadius: 8, border: `1px solid ${isRecording ? RED : "rgba(232,64,64,.4)"}`,
                     background: isRecording ? "rgba(232,64,64,.2)" : "transparent", cursor: "pointer" }}>
            <span style={{ width: isRecording ? 8 : 10, height: isRecording ? 8 : 10,
                           borderRadius: isRecording ? 2 : "50%",
                           background: RED, display: "block", flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: isRecording ? RED : "rgba(232,64,64,.7)",
                           letterSpacing: 1 }}>
              {isRecording ? fmt(recElapsed) : "REC"}
            </span>
          </button>

          <div style={{ fontSize: 11, fontWeight: 700, padding: "5px 9px", borderRadius: 6, letterSpacing: 1,
                        background: playing ? RED : GOLD, color: playing ? "#fff" : "#000" }}>
            {playing ? "LIVE" : "READY"}
          </div>
        </div>
      </div>

      {/* rec error toast */}
      {recError && (
        <div style={{ position: "absolute", top: 70, left: 16, right: 16, background: "rgba(232,64,64,.9)",
                      borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#fff", zIndex: 20,
                      display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {recError}
          <button onClick={() => setRecError("")} style={{ background: "none", border: "none", color: "#fff", fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1 }}>✕</button>
        </div>
      )}

      {/* Bottom controls */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "8px 16px 28px",
                    paddingBottom: "max(28px, calc(env(safe-area-inset-bottom) + 12px))",
                    background: "linear-gradient(to top,rgba(0,0,0,.95) 70%,transparent)", zIndex: 10 }}>
        <div style={{ height: 3, background: "rgba(255,255,255,.12)", borderRadius: 2, marginBottom: 12, overflow: "hidden" }}>
          <div style={{ height: "100%", background: GOLD, width: progress.toFixed(1) + "%", borderRadius: 2 }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 10 }}>
          <button onClick={() => { const v = Math.max(0.1, Math.round((speed - .1) * 10) / 10); setSpeed(v); speedRef.current = v; }}
            style={{ width: 44, height: 38, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.12)", borderRight: "none", borderRadius: "9px 0 0 9px", color: "#fff", fontSize: 22, cursor: "pointer" }}>−</button>
          <div style={{ minWidth: 100, height: 38, background: "rgba(245,166,35,.1)", border: "1px solid rgba(245,166,35,.3)", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "0 14px" }}>
            <span style={{ fontSize: 20, fontWeight: 900, color: GOLD }}>{speed.toFixed(1)}</span>
            <span style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>speed</span>
          </div>
          <button onClick={() => { const v = Math.min(10, Math.round((speed + .1) * 10) / 10); setSpeed(v); speedRef.current = v; }}
            style={{ width: 44, height: 38, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.12)", borderLeft: "none", borderRadius: "0 9px 9px 0", color: "#fff", fontSize: 22, cursor: "pointer" }}>+</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <button onClick={doRestart} style={{ width: 48, height: 48, borderRadius: "50%", border: "none", background: "rgba(255,255,255,.09)", color: "#fff", fontSize: 20, cursor: "pointer" }}>↺</button>
          <div style={{ display: "flex", gap: 5 }}>
            {[{ sz: 18, l: "Sm" }, { sz: 24, l: "Md" }, { sz: 30, l: "Lg" }, { sz: 38, l: "XL" }].map(({ sz, l }) => (
              <button key={sz} onClick={() => { setFontSize(sz); fsRef.current = sz; setTimeout(measure, 60); }}
                style={{ padding: "5px 10px", borderRadius: 18, fontSize: 12, cursor: "pointer",
                         border: `1px solid ${fontSize === sz ? GOLD : "rgba(255,255,255,.15)"}`,
                         background: fontSize === sz ? "rgba(245,166,35,.12)" : "transparent",
                         color: fontSize === sz ? GOLD : "#555" }}>{l}</button>
            ))}
          </div>
          <button onClick={() => playing ? doPause() : doPlay()}
            style={{ width: 62, height: 62, borderRadius: "50%", background: GOLD, color: "#000", border: "none", fontSize: 26, cursor: "pointer", boxShadow: "0 0 20px rgba(245,166,35,.4)" }}>
            {playing ? "⏸" : "▶"}
          </button>
          <button onClick={doExit}
            style={{ width: 44, height: 44, borderRadius: 10, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.12)", color: "#fff", fontSize: 18, cursor: "pointer" }}>✕</button>
        </div>
      </div>

      {showRunTimer && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 50, display: "flex", alignItems: "flex-end" }}
             onClick={() => setShowRunTimer(false)}>
          <TimerSheet tMin={tMin} setTMin={setTMin} tSec={tSec} setTSec={setTSec}
            noLimit={noLimit} setNoLimit={setNoLimit} onConfirm={applyTimer} onCancel={() => setShowRunTimer(false)} />
        </div>
      )}
    </div>
  );
}
