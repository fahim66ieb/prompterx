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

// AI scroll constants
const SPEED_MAP  = { slow: 0.55, normal: 1.0, fast: 1.55 };
const TONE_COLOR = { urgent: RED, energetic: GOLD, serious: "#aaa", warm: "#f0a060", calm: "rgba(255,255,255,0.4)" };

// ElevenLabs pre-made professional voices
// Cost: eleven_turbo_v2 ~$0.08/1k chars · free tier 10k chars/month
const VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel",  gender: "F", desc: "Calm · American"          },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh",    gender: "M", desc: "Deep · American"           },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam",    gender: "M", desc: "Authoritative · American"  },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni",  gender: "M", desc: "Warm · American"           },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam",   gender: "M", desc: "Neutral · American"        },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi",   gender: "F", desc: "Confident · American"      },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella",  gender: "F", desc: "Expressive · American"     },
  { id: "VR6AewLTigWG4xSOukaG", name: "Arnold", gender: "M", desc: "Crisp · American"          },
  { id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum", gender: "M", desc: "Intense · Transatlantic"   },
  { id: "ThT5KcBeYPX3keUQqHPh", name: "Dorothy",gender: "F", desc: "Pleasant · British"        },
];
const VOICE_SETTINGS = { stability: 0.70, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true };

async function fetchTTSAudio(text, voiceId, voiceSettings, apiKey) {
  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": apiKey, "Accept": "audio/mpeg" },
    body: JSON.stringify({ text, model_id: "eleven_turbo_v2", voice_settings: voiceSettings }),
  });
  if (!resp.ok) throw new Error(`TTS API error ${resp.status}`);
  return resp.arrayBuffer();
}

function splitIntoChunks(text, maxChars = 300) {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  const chunks = [];
  for (const para of paragraphs) {
    if (para.length <= maxChars) { chunks.push(para.trim()); continue; }
    const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
    let current = "";
    for (const s of sentences) {
      if ((current + s).length > maxChars && current) { chunks.push(current.trim()); current = s; }
      else current += " " + s;
    }
    if (current.trim()) chunks.push(current.trim());
  }
  return chunks.filter(Boolean);
}

function splitIntoAiChunks(segments) {
  const chunks = [];
  let i = 0;
  while (i < segments.length) {
    const spd = segments[i].speed || "normal";
    const group = [];
    while (i < segments.length && group.length < 3 && (segments[i].speed || "normal") === spd) {
      group.push(segments[i].text); i++;
    }
    chunks.push({ text: group.join(" "), speed: spd });
  }
  return chunks;
}

// ── Speech Tracking helpers ───────────────────────────────────
function tokenizeScript(text) {
  const words = text.split(/\s+/).filter(Boolean);
  return words.map((w, i) => ({
    index: i,
    original: w,
    word: w.toLowerCase().replace(/[^a-z0-9']/g, ""),
  }));
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[a.length][b.length];
}

function findBestMatch(transcript, tokens, lastIdx) {
  const heard = transcript.trim().toLowerCase()
    .split(/\s+/).filter(Boolean).slice(-4)
    .map(w => w.replace(/[^a-z0-9']/g, ""));
  if (!heard.length) return lastIdx;
  const searchEnd = Math.min(tokens.length, lastIdx + 60);
  let bestScore = 0, bestIdx = lastIdx;
  for (let i = lastIdx; i < searchEnd; i++) {
    let score = 0, matched = 0;
    for (let j = 0; j < heard.length && i + j < tokens.length; j++) {
      const a = heard[j], b = tokens[i + j].word;
      if (a === b)                      { score += 1.0; matched++; }
      else if (editDistance(a, b) <= 2) { score += 0.7; matched++; }
    }
    const normalised = heard.length > 0 ? score / heard.length : 0;
    if (normalised > bestScore && matched >= 1) { bestScore = normalised; bestIdx = i + heard.length - 1; }
  }
  return bestScore >= 0.45 ? bestIdx : lastIdx;
}

function renderScriptContent(text, useSpeechSpans) {
  if (!useSpeechSpans) {
    return text.split(/\n\n+/).filter(p => p.trim()).map((p, i) => (
      <p key={i} style={{ marginBottom: "1.3em" }}>{p.replace(/\n/g, " ")}</p>
    ));
  }
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  let globalIdx = 0;
  return paragraphs.map((para, pi) => {
    const tokens = para.replace(/\n/g, " ").split(/(\s+)/);
    const spans = tokens.map((token, ti) => {
      if (/\S/.test(token)) {
        const idx = globalIdx++;
        return (
          <span key={ti} data-word-index={idx}
            style={{ transition: "background 0.15s, color 0.15s" }}>
            {token}
          </span>
        );
      }
      return <span key={ti}>{token}</span>;
    });
    return <p key={pi} style={{ marginBottom: "1.3em" }}>{spans}</p>;
  });
}

// ── Recording helpers ─────────────────────────────────────────
function fmtDuration(sec) {
  if (!sec) return "0:00";
  return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
}
function fmtTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
         " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function redownload(rec) {
  if (!rec.blob) return;
  const ext = rec.mimeType?.includes("mp4") ? "mp4"
            : rec.mimeType?.includes("mpeg") || rec.mimeType?.includes("mp3") ? "mp3"
            : "webm";
  const url = URL.createObjectURL(rec.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = rec.filename || `prompterx-${rec.id}.${ext}`;
  a.target = "_blank"; // required for iOS Safari/Chrome to trigger save
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// ── IndexedDB ─────────────────────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open("prompterx", 1);
    req.onupgradeneeded = e => { e.target.result.createObjectStore("recordings", { keyPath: "id" }); };
    req.onsuccess = e => res(e.target.result);
    req.onerror = () => rej(req.error);
  });
}
async function saveRecordingToDB(rec) {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction("recordings", "readwrite");
      tx.objectStore("recordings").put(rec);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch {}
}
async function loadRecordingsFromDB() {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const tx = db.transaction("recordings", "readonly");
      const req = tx.objectStore("recordings").getAll();
      req.onsuccess = () => res(req.result || []); req.onerror = () => rej(req.error);
    });
  } catch { return []; }
}
async function deleteRecordingFromDB(id) {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction("recordings", "readwrite");
      tx.objectStore("recordings").delete(id);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch {}
}

// ── localStorage (scripts) ────────────────────────────────────
const LS_SCRIPTS = "prompterx-scripts";
function lsLoadScripts() {
  try { const s = localStorage.getItem(LS_SCRIPTS); return s !== null ? JSON.parse(s) : null; } catch { return null; }
}
function lsSaveScripts(scripts) {
  try { localStorage.setItem(LS_SCRIPTS, JSON.stringify(scripts)); } catch {}
}

// ── Sentence splitter ─────────────────────────────────────────
function splitSentences(text) {
  const segs = [];
  const paras = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  for (const para of paras) {
    const parts = para.trim().split(/([.!?…]+)\s+/);
    let cur = "";
    for (let i = 0; i < parts.length; i++) {
      cur += parts[i];
      if (/[.!?…]$/.test(cur)) { const t = cur.replace(/\n/g, " ").trim(); if (t.length > 2) segs.push(t); cur = ""; }
    }
    if (cur.trim().length > 2) segs.push(cur.replace(/\n/g, " ").trim());
  }
  return segs;
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

// ── Main ──────────────────────────────────────────────────────
export default function PrompterX() {
  // ── state ─────────────────────────────────────────────────────
  const [screen, setScreen]                     = useState("home");
  const [scripts, setScripts]                   = useState([{ title: "Sample", text: SAMPLE }]);
  const [editIdx, setEditIdx]                   = useState(null);
  const [scriptText, setScriptText]             = useState(SAMPLE);
  const [title, setTitle]                       = useState("Sample");
  const [playing, setPlaying]                   = useState(false);
  const [speed, setSpeed]                       = useState(1.0);
  const [fontSize, setFontSize]                 = useState(24);
  const [progress, setProgress]                 = useState(0);
  const [elapsed, setElapsed]                   = useState(0);
  const [targetSec, setTargetSec]               = useState(0);
  const [tMin, setTMin]                         = useState(5);
  const [tSec, setTSec]                         = useState(0);
  const [noLimit, setNoLimit]                   = useState(true);
  const [showTimer, setShowTimer]               = useState(false);
  const [showRunTimer, setShowRunTimer]         = useState(false);
  const [uploadMsg, setUploadMsg]               = useState("");
  // recording
  const [recordingEnabled, setRecordingEnabled] = useState(false);
  const [isRecording, setIsRecording]           = useState(false);
  const [recToast, setRecToast]                 = useState("");
  const [recordings, setRecordings]             = useState([]);
  const [activePlaybackId, setActivePlaybackId] = useState(null);
  // AI upload
  const [aiUploading, setAiUploading]           = useState(false);
  const [aiUploadMsg, setAiUploadMsg]           = useState("");
  const [aiProgressMsg, setAiProgressMsg]       = useState("");
  const [aiToast, setAiToast]                   = useState("");
  const [dotStr, setDotStr]                     = useState("");
  // AI run
  const [runSegments, setRunSegments]           = useState([]);
  const [currentSeg, setCurrentSeg]             = useState(0);
  const [chipVisible, setChipVisible]           = useState(true);
  // voiceover
  const [facingMode, setFacingMode]               = useState("user"); // "user" = front, "environment" = rear
  const [voicePersona, setVoicePersona]           = useState(null);
  const [showVoiceSheet, setShowVoiceSheet]       = useState(false);
  const [voiceoverSpeaking, setVoiceoverSpeaking] = useState(false);
  const [voiceoverLoading, setVoiceoverLoading]   = useState(false);
  // speech tracking
  const [speechTrackingEnabled, setSpeechTrackingEnabled] = useState(() => {
    try { if (typeof window === "undefined") return false; return localStorage.getItem("px_speech_tracking") === "true"; } catch { return false; }
  });
  const [speechStatus, setSpeechStatus]           = useState("stopped"); // stopped | listening | paused | error | unsupported
  // base speed + speed sheet
  const [baseSpeed, setBaseSpeed]                 = useState(() => {
    try { const s = parseFloat(localStorage.getItem("px_base_speed")); return isNaN(s) ? 1.0 : s; } catch { return 1.0; }
  });
  const [showSpeedSheet, setShowSpeedSheet]       = useState(false);

  // ── refs ──────────────────────────────────────────────────────
  const scrollRef              = useRef(null);
  const playingRef             = useRef(false);
  const scrollYRef             = useRef(0);
  const maxYRef                = useRef(0);
  const speedRef               = useRef(1.0);
  const fsRef                  = useRef(24);
  const rafRef                 = useRef(null);
  const lastTRef               = useRef(null);
  const tBaseRef               = useRef(null);
  const tIntRef                = useRef(null);
  const touchRef               = useRef({ x: 0, y: 0, start: 0, down: false, lastTap: 0 });
  // recording refs
  const mediaRecorderRef       = useRef(null);
  const recordedChunksRef      = useRef([]);
  const mediaStreamRef         = useRef(null);
  const recordingEnabledRef    = useRef(false);
  const isRecordingRef         = useRef(false);
  const facingModeRef          = useRef("user");
  const recordingStartTimeRef  = useRef(null);
  const recTitleRef            = useRef("");
  const videoUrlRef            = useRef({});
  const wakeLockRef            = useRef(null);
  const titleRef               = useRef(title);
  const scriptsReadyRef        = useRef(false);
  // AI scroll refs
  const aiFormattedRef         = useRef(false);
  const segmentsRef            = useRef([]);
  const currentSegRef          = useRef(0);
  const actualSpeedRef         = useRef(1.0);
  const pauseStateRef          = useRef("idle");
  const pauseFrameRef          = useRef(0);
  const pauseSegRef            = useRef(-1);
  const preDecelSpeedRef       = useRef(1.0);
  // voiceover refs
  const voicePersonaRef        = useRef(null);
  const voiceoverActiveRef     = useRef(false);
  const audioCtxRef            = useRef(null);
  const mp3ChunksRef           = useRef([]);
  const voiceStartTimeRef      = useRef(null);
  const runTextRef             = useRef("");
  // speech tracking refs
  const recognitionRef         = useRef(null);
  const lastWordIdxRef         = useRef(0);
  const scriptTokensRef        = useRef([]);
  const speechRestartRef       = useRef(null);
  const speechTrackingRef      = useRef(false); // mirrors state — safe inside async callbacks
  const screenRef              = useRef("home"); // mirrors state — safe inside async callbacks
  const baseSpeedRef           = useRef(1.0);   // mirrors state — used in doRun without dep
  // smooth scroll (speech tracking)
  const targetScrollRef        = useRef(0);     // where speech wants us (updated by recognition)
  const smoothScrollRef        = useRef(0);     // current glide position
  const smoothRafRef           = useRef(null);  // smooth scroll RAF id
  const activeSentenceRef      = useRef(-1);    // sentence index currently highlighted
  const speechVelocityRef      = useRef(0);     // words per second (EMA)
  const lastMatchTimeRef       = useRef(0);     // ms timestamp of last word match
  const wordMatchCountRef      = useRef(0);     // consecutive match count
  const speechPausedRef        = useRef(false); // true while speaker is silent
  const sentencesRef           = useRef([]);    // [{start,end,text}]
  const wordToSentenceRef      = useRef({});    // wordIdx → sentenceIdx

  // ── constants ─────────────────────────────────────────────────
  const voiceApiKey = process.env.NEXT_PUBLIC_ELEVENLABS_API_KEY || "";

  // ── effects ───────────────────────────────────────────────────
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { recordingEnabledRef.current = recordingEnabled; }, [recordingEnabled]);
  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);
  useEffect(() => { voicePersonaRef.current = voicePersona; }, [voicePersona]);
  useEffect(() => { speechTrackingRef.current = speechTrackingEnabled; }, [speechTrackingEnabled]);
  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { baseSpeedRef.current = baseSpeed; }, [baseSpeed]);
  useEffect(() => {
    try { localStorage.setItem("px_speech_tracking", speechTrackingEnabled); } catch {}
  }, [speechTrackingEnabled]);
  useEffect(() => {
    try { localStorage.setItem("px_base_speed", baseSpeed); } catch {}
  }, [baseSpeed]);
  // Inject slider thumb CSS + speech sentence highlight classes once on mount
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = [
      `.px-slider::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;border-radius:50%;background:#f5a623;cursor:pointer;box-shadow:0 0 6px rgba(245,166,35,0.4)}`,
      `.px-slider::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:#f5a623;cursor:pointer;border:none;box-shadow:0 0 6px rgba(245,166,35,0.4)}`,
      `.px-sent-current{background:rgba(245,166,35,0.18)!important;border-radius:3px;}`,
      `.px-sent-past{opacity:0.35!important;}`,
      `.px-sent-current,.px-sent-next,.px-sent-past{transition:opacity 0.3s ease,background 0.3s ease;}`,
    ].join("");
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  useEffect(() => {
    if (!aiUploading) { setDotStr(""); return; }
    const id = setInterval(() => setDotStr(d => d.length >= 3 ? "" : d + "."), 500);
    return () => clearInterval(id);
  }, [aiUploading]);

  useEffect(() => {
    if (!aiToast) return;
    const id = setTimeout(() => setAiToast(""), 10000);
    return () => clearTimeout(id);
  }, [aiToast]);

  useEffect(() => {
    if (!recToast) return;
    const id = setTimeout(() => setRecToast(""), 5000);
    return () => clearTimeout(id);
  }, [recToast]);

  useEffect(() => {
    if (scriptsReadyRef.current) lsSaveScripts(scripts);
  }, [scripts]);

  useEffect(() => {
    setChipVisible(false);
    const t = setTimeout(() => setChipVisible(true), 150);
    return () => clearTimeout(t);
  }, [currentSeg]);

  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === "visible" && screen === "run") {
        await requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const saved = lsLoadScripts();
    if (saved !== null) setScripts(saved);
    scriptsReadyRef.current = true;
    // Load recordings from IndexedDB
    loadRecordingsFromDB().then(recs => {
      if (recs.length > 0) setRecordings(recs.sort((a, b) => b.id - a.id));
    });
    return () => {
      stopRecording();
      stopVoiceover();
      stopSpeechTracking();
      Object.values(videoUrlRef.current).forEach(url => URL.revokeObjectURL(url));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Start/stop speech tracking when entering/leaving run screen or toggling the setting
  useEffect(() => {
    if (screen === "run" && speechTrackingEnabled) {
      startSpeechTracking();
    } else {
      stopSpeechTracking();
    }
    return () => stopSpeechTracking();
  }, [screen, speechTrackingEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── wake lock ─────────────────────────────────────────────────
  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
        wakeLockRef.current.addEventListener("release", () => { wakeLockRef.current = null; });
      }
    } catch {}
  }

  function releaseWakeLock() {
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  }

  // ── voiceover ─────────────────────────────────────────────────
  function saveVoiceRecording() {
    const chunks = mp3ChunksRef.current;
    if (!chunks.length) return;
    const totalLen = chunks.reduce((s, b) => s + b.byteLength, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const b of chunks) { combined.set(new Uint8Array(b), offset); offset += b.byteLength; }
    const blob     = new Blob([combined], { type: "audio/mpeg" });
    const now      = Date.now();
    const duration = voiceStartTimeRef.current ? Math.round((now - voiceStartTimeRef.current) / 1000) : 0;
    const entry    = { id: now, filename: `prompterx-voice-${now}.mp3`, scriptTitle: recTitleRef.current || "Untitled",
                       duration, timestamp: now, blob, mimeType: "audio/mpeg", isAudio: true };
    mp3ChunksRef.current   = []; // clear so stopVoiceover doesn't double-save
    voiceStartTimeRef.current = null;
    setRecordings(prev => [entry, ...prev]);
    saveRecordingToDB(entry);
  }

  function stopVoiceover() {
    voiceoverActiveRef.current = false;
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }
    saveVoiceRecording(); // saves partial recording if any chunks collected
    setVoiceoverSpeaking(false);
    setVoiceoverLoading(false);
  }

  async function startVoiceover() {
    if (!voicePersonaRef.current || !voiceApiKey) return;
    stopVoiceover();
    const voice = VOICES.find(v => v.id === voicePersonaRef.current);
    if (!voice) return;

    const isAi  = aiFormattedRef.current && segmentsRef.current.length > 0;
    const chunks = isAi
      ? splitIntoAiChunks(segmentsRef.current)
      : splitIntoChunks(runTextRef.current).map(text => ({ text, speed: "normal" }));
    if (!chunks.length) return;

    voiceoverActiveRef.current = true;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    audioCtxRef.current = audioCtx;

    // iOS WebKit requires explicit resume + a silent buffer played synchronously
    // to unlock the audio context before any real audio can be scheduled
    try { await audioCtx.resume(); } catch {}
    const silentBuf = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    const silentSrc = audioCtx.createBufferSource();
    silentSrc.buffer = silentBuf;
    silentSrc.connect(audioCtx.destination);
    silentSrc.start(0);

    let nextStartTime = audioCtx.currentTime + 0.15;
    let audioStarted  = false;
    mp3ChunksRef.current   = [];
    voiceStartTimeRef.current = Date.now();

    // Pre-fetch buffers keyed by index so chunks 0+1 can be fetched concurrently
    const fetched = new Map();
    function prefetch(idx) {
      if (idx >= chunks.length || fetched.has(idx)) return;
      fetched.set(idx, fetchTTSAudio(chunks[idx].text, voice.id, VOICE_SETTINGS, voiceApiKey));
    }

    // iOS WebKit may not return a Promise from decodeAudioData — use callback form
    function decodeAudio(buf) {
      return new Promise((resolve, reject) => audioCtx.decodeAudioData(buf, resolve, reject));
    }

    async function playChunk(idx) {
      if (!voiceoverActiveRef.current || idx >= chunks.length) return;
      prefetch(idx + 1);

      try {
        const raw = await fetched.get(idx);
        if (!voiceoverActiveRef.current) return;

        mp3ChunksRef.current.push(raw.slice(0)); // copy before decodeAudio may detach the buffer

        // iOS can re-suspend the context during async fetch; resume before decode
        if (audioCtx.state !== "running") try { await audioCtx.resume(); } catch {}

        const decoded = await decodeAudio(raw);
        if (!voiceoverActiveRef.current) return;

        // Re-resume before scheduling — iOS sometimes suspends again after decode
        if (audioCtx.state !== "running") try { await audioCtx.resume(); } catch {}

        const source = audioCtx.createBufferSource();
        source.buffer = decoded;
        source.connect(audioCtx.destination);

        const startAt = Math.max(nextStartTime, audioCtx.currentTime + 0.1);
        source.start(startAt);
        nextStartTime = startAt + decoded.duration;

        if (!audioStarted) { audioStarted = true; setVoiceoverLoading(false); setVoiceoverSpeaking(true); }

        const msLeft = (nextStartTime - audioCtx.currentTime - 0.5) * 1000;
        setTimeout(() => playChunk(idx + 1), Math.max(0, msLeft));

        source.onended = () => {
          if (idx === chunks.length - 1) stopVoiceover();
        };
      } catch (err) {
        setVoiceoverLoading(false);
        stopVoiceover();
        setRecToast("Voiceover: " + (err.message || "unknown error"));
      }
    }

    // Pre-fetch first two chunks then play in order
    prefetch(0);
    prefetch(1);
    setVoiceoverLoading(true);
    playChunk(0);
  }

  // ── recording ─────────────────────────────────────────────────
  function saveRecording(mimeType) {
    const chunks = recordedChunksRef.current;
    if (!chunks.length) return;
    const now      = Date.now();
    const ext      = (mimeType || "").includes("mp4") ? "mp4" : "webm";
    const blob     = new Blob(chunks, { type: mimeType || "video/webm" });
    const filename = `prompterx-${now}.${ext}`;
    const duration = recordingStartTimeRef.current
      ? Math.round((now - recordingStartTimeRef.current) / 1000) : 0;
    const entry = {
      id: now,
      filename,
      scriptTitle: recTitleRef.current || "Untitled",
      duration,
      timestamp: now,
      blob,
      mimeType: mimeType || "video/webm",
    };
    setRecordings(prev => [entry, ...prev]);
    saveRecordingToDB(entry);
    recordedChunksRef.current = [];
  }

  async function startRecording() {
    if (!recordingEnabledRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: facingModeRef.current, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      mediaStreamRef.current        = stream;
      recordedChunksRef.current     = [];
      recordingStartTimeRef.current = Date.now();
      const mimeType =
        MediaRecorder.isTypeSupported("video/mp4")             ? "video/mp4" :
        MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" :
        MediaRecorder.isTypeSupported("video/webm")            ? "video/webm" : "";
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mr.ondataavailable = e => { if (e.data.size > 0) recordedChunksRef.current.push(e.data); };
      mr.onstop = () => {
        saveRecording(mr.mimeType || mimeType);
        // Stop tracks only after data is fully flushed via onstop
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach(t => t.stop());
          mediaStreamRef.current = null;
        }
      };
      mr.start(100); // 100ms timeslice — flushes data regularly, not only on stop
      mediaRecorderRef.current = mr;
      setIsRecording(true);
      isRecordingRef.current = true;
    } catch {
      setRecordingEnabled(false);
      recordingEnabledRef.current = false;
      setRecToast("Camera/mic access denied — recording disabled");
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try { mediaRecorderRef.current.stop(); } catch {}
    } else if (mediaStreamRef.current) {
      // recorder already inactive — stop tracks directly
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    setIsRecording(false);
    isRecordingRef.current = false;
  }

  async function switchCamera() {
    const newFacing = facingModeRef.current === "user" ? "environment" : "user";
    facingModeRef.current = newFacing;
    setFacingMode(newFacing);
    if (isRecordingRef.current) {
      // Stop current recording (saves it via mr.onstop), then restart with new camera+audio
      stopRecording();
      await new Promise(r => setTimeout(r, 350)); // wait for onstop to flush & save
      await startRecording();
    }
  }

  function deleteRecording(id) {
    // Revoke any cached object URL for this recording
    if (videoUrlRef.current[id]) {
      URL.revokeObjectURL(videoUrlRef.current[id]);
      delete videoUrlRef.current[id];
    }
    if (activePlaybackId === id) setActivePlaybackId(null);
    setRecordings(prev => prev.filter(r => r.id !== id));
    deleteRecordingFromDB(id);
  }

  // ── speech tracking ───────────────────────────────────────────

  // ── sentence map ──────────────────────────────────────────────
  function buildSentenceMap(text) {
    // Build the flat token list (shared with findBestMatch)
    scriptTokensRef.current = tokenizeScript(text);
    // Split text into sentences on . ! ? boundaries
    const rawSentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    let wordCursor = 0;
    const sentences = [];
    const w2s = {};
    rawSentences.forEach((sent, si) => {
      const sentWords = sent.trim().split(/\s+/).filter(Boolean);
      if (!sentWords.length) return;
      const start = wordCursor;
      const end   = wordCursor + sentWords.length - 1;
      sentences.push({ start, end, text: sent.trim() });
      for (let w = start; w <= end; w++) w2s[w] = si;
      wordCursor += sentWords.length;
    });
    sentencesRef.current    = sentences;
    wordToSentenceRef.current = w2s;
  }

  function getSentenceForWordIndex(wordIdx) {
    return wordToSentenceRef.current[wordIdx] ?? 0;
  }

  // ── sentence-level highlight (CSS classes only, so AI container styles survive) ──
  function updateSentenceHighlights(sentenceIdx) {
    document.querySelectorAll("[data-word-index]").forEach(el => {
      el.classList.remove("px-sent-current", "px-sent-next", "px-sent-past");
    });
    const sentences = sentencesRef.current;
    if (!sentences.length) return;
    sentences.forEach((sent, si) => {
      const cls = si === sentenceIdx     ? "px-sent-current"
                : si === sentenceIdx + 1 ? "px-sent-next"
                : si < sentenceIdx       ? "px-sent-past"
                : "";
      if (!cls) return;
      for (let i = sent.start; i <= sent.end; i++) {
        const el = document.querySelector(`[data-word-index="${i}"]`);
        if (el) el.classList.add(cls);
      }
    });
  }

  // ── adaptive glide factor ──────────────────────────────────────
  function getAdaptiveFactor() {
    if (speechPausedRef.current) return 0.015; // decelerate to a stop when speaker is silent
    const wps = speechVelocityRef.current; // words per second (EMA)
    if (wps <= 0) return 0.06;
    // Typical speech: 2.0–3.5 wps → map to factor 0.04–0.10
    const normalised = Math.max(0, Math.min(1, (wps - 1.5) / 2.5));
    return 0.04 + normalised * 0.06;
  }

  // ── smooth scroll RAF loop ─────────────────────────────────────
  function startSmoothScrollLoop() {
    if (smoothRafRef.current) return; // already running
    function frame() {
      const sc = scrollRef.current;
      if (!sc) { smoothRafRef.current = null; return; }
      const target  = targetScrollRef.current;
      const current = smoothScrollRef.current;
      const diff    = target - current;
      if (Math.abs(diff) > 0.3) {
        const factor = getAdaptiveFactor();
        smoothScrollRef.current += diff * factor;
        sc.scrollTop = smoothScrollRef.current;
        scrollYRef.current = smoothScrollRef.current;
        setProg();
      }
      smoothRafRef.current = requestAnimationFrame(frame);
    }
    smoothScrollRef.current = scrollRef.current?.scrollTop ?? 0;
    smoothRafRef.current = requestAnimationFrame(frame);
  }

  function stopSmoothScrollLoop() {
    if (smoothRafRef.current) {
      cancelAnimationFrame(smoothRafRef.current);
      smoothRafRef.current = null;
    }
  }

  // ── scrollToWordIndex — sets target only, never jumps ─────────
  function scrollToWordIndex(idx) {
    const sc = scrollRef.current;
    if (!sc) return;
    const sentenceIdx = getSentenceForWordIndex(idx);
    // Update sentence highlighting if we've moved to a new sentence
    if (sentenceIdx !== activeSentenceRef.current) {
      updateSentenceHighlights(sentenceIdx);
      activeSentenceRef.current = sentenceIdx;
    }
    const el = document.querySelector(`[data-word-index="${idx}"]`);
    if (!el) return;
    // Compute target so matched word sits at the focus line (33% from top)
    const scRect = sc.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const focusPx = scRect.height * 0.33;
    const raw = sc.scrollTop + (elRect.top - scRect.top) - focusPx;
    targetScrollRef.current = Math.max(0, Math.min(maxYRef.current, raw));
    // Update speech velocity EMA
    const now = Date.now();
    if (lastMatchTimeRef.current > 0) {
      const elapsed = (now - lastMatchTimeRef.current) / 1000;
      if (elapsed > 0 && elapsed < 3) {
        const instant = 1 / elapsed;
        speechVelocityRef.current = speechVelocityRef.current * 0.7 + instant * 0.3;
      }
    }
    lastMatchTimeRef.current = now;
  }

  // ── reset speech state (called on start and restart) ──────────
  function resetSpeechState() {
    targetScrollRef.current   = 0;
    smoothScrollRef.current   = 0;
    activeSentenceRef.current = -1;
    speechVelocityRef.current = 0;
    lastMatchTimeRef.current  = 0;
    wordMatchCountRef.current = 0;
    speechPausedRef.current   = false;
    wordToSentenceRef.current = {};
    sentencesRef.current      = [];
  }

  function startSpeechTracking() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setSpeechStatus("unsupported"); return; }
    // Build sentence map (also builds scriptTokensRef)
    const isAiMode = aiFormattedRef.current && segmentsRef.current.length > 0;
    const text = isAiMode
      ? segmentsRef.current.map(s => s.text).join(" ")
      : runTextRef.current;
    resetSpeechState();
    buildSentenceMap(text);
    lastWordIdxRef.current = 0;
    // Start the smooth scroll glide loop
    startSmoothScrollLoop();
    const rec = new SR();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = "en-US";
    rec.maxAlternatives = 1;
    rec.onstart  = () => setSpeechStatus("listening");
    rec.onresult = (e) => {
      let transcript = "";
      for (let i = e.resultIndex; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      const newIdx = findBestMatch(transcript, scriptTokensRef.current, lastWordIdxRef.current);
      if (newIdx > lastWordIdxRef.current) {
        lastWordIdxRef.current = newIdx;
        speechPausedRef.current = false;  // speaker is talking
        scrollToWordIndex(newIdx);
      }
      setSpeechStatus("listening");
      clearTimeout(speechRestartRef.current);
      // After 1.5 s of no new matches → pause state (glide decelerates)
      speechRestartRef.current = setTimeout(() => {
        speechPausedRef.current = true;
        setSpeechStatus("paused");
      }, 1500);
    };
    rec.onspeechend = () => { speechPausedRef.current = true; setSpeechStatus("paused"); };
    rec.onerror = (e) => {
      if (e.error === "not-allowed") setSpeechStatus("error");
      else if (e.error !== "no-speech") { speechPausedRef.current = true; setSpeechStatus("paused"); }
    };
    rec.onend = () => {
      if (speechTrackingRef.current && screenRef.current === "run") {
        try { rec.start(); } catch {}
      }
    };
    recognitionRef.current = rec;
    try { rec.start(); } catch { setSpeechStatus("error"); }
  }

  function stopSpeechTracking() {
    clearTimeout(speechRestartRef.current);
    stopSmoothScrollLoop();
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
      recognitionRef.current = null;
    }
    setSpeechStatus("stopped");
    // Remove all sentence highlight classes
    document.querySelectorAll("[data-word-index]").forEach(el => {
      el.classList.remove("px-sent-current", "px-sent-next", "px-sent-past");
    });
  }

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
    const sc = scrollRef.current; if (!sc) return;

    if (aiFormattedRef.current && segmentsRef.current.length > 0) {
      const segs   = segmentsRef.current;
      const focusY = sc.clientHeight * 0.33;
      const cTop   = sc.getBoundingClientRect().top;

      const lo = Math.max(0, currentSegRef.current - 1);
      const hi = Math.min(segs.length - 1, currentSegRef.current + 1);
      let closestSeg = currentSegRef.current, closestDist = Infinity, closestRect = null;
      for (let i = lo; i <= hi; i++) {
        const el = sc.querySelector(`[data-seg="${i}"]`);
        if (!el) continue;
        const r    = el.getBoundingClientRect();
        const dist = Math.abs(r.top - cTop - focusY);
        if (dist < closestDist) { closestDist = dist; closestSeg = i; closestRect = r; }
      }

      if (
        closestRect &&
        segs[closestSeg]?.pauseBefore &&
        pauseSegRef.current !== closestSeg &&
        pauseStateRef.current === "idle"
      ) {
        const dist = closestRect.top - cTop - focusY;
        if (Math.abs(dist) < 30) {
          pauseStateRef.current    = "decelerating";
          pauseFrameRef.current    = 20;
          preDecelSpeedRef.current = Math.max(actualSpeedRef.current, 0.05);
          pauseSegRef.current      = closestSeg;
        }
      }

      if (closestSeg !== currentSegRef.current) {
        currentSegRef.current = closestSeg;
        setCurrentSeg(closestSeg);
      }

      let increment = 0;
      const ps = pauseStateRef.current;
      if (ps === "idle") {
        const target = speedRef.current * (SPEED_MAP[segs[currentSegRef.current]?.speed] ?? 1.0);
        actualSpeedRef.current += (target - actualSpeedRef.current) * 0.05;
        increment = actualSpeedRef.current * fsRef.current * 2.0 * dt / 1000;
      } else if (ps === "decelerating") {
        pauseFrameRef.current--;
        const t = Math.max(0, pauseFrameRef.current / 20);
        actualSpeedRef.current = preDecelSpeedRef.current * t;
        increment = actualSpeedRef.current * fsRef.current * 2.0 * dt / 1000;
        if (pauseFrameRef.current <= 0) {
          actualSpeedRef.current = 0;
          pauseStateRef.current  = "holding";
          pauseFrameRef.current  = 40;
        }
      } else if (ps === "holding") {
        pauseFrameRef.current--;
        increment = 0;
        if (pauseFrameRef.current <= 0) pauseStateRef.current = "resuming";
      } else {
        pauseStateRef.current = "idle";
        increment = 0;
      }

      scrollYRef.current += increment;
    } else {
      scrollYRef.current += speedRef.current * fsRef.current * 2.0 * dt / 1000;
    }

    if (scrollYRef.current >= maxYRef.current) {
      scrollYRef.current = maxYRef.current; sc.scrollTop = scrollYRef.current;
      playingRef.current = false; setPlaying(false); setProg(); clearInterval(tIntRef.current);
      if (isRecordingRef.current) stopRecording();
      stopVoiceover();
      releaseWakeLock();
      return;
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
    if (speechTrackingRef.current) {
      // Speech tracking drives scroll — skip RAF, but recording/voiceover still work
      if (recordingEnabledRef.current && !isRecordingRef.current) startRecording();
      if (voicePersonaRef.current) startVoiceover();
      return;
    }
    rafRef.current = requestAnimationFrame(loop);
    if (recordingEnabledRef.current && !isRecordingRef.current) startRecording();
    if (voicePersonaRef.current) startVoiceover();
  }, [measure, loop]); // eslint-disable-line react-hooks/exhaustive-deps

  const doPause = useCallback(() => {
    playingRef.current = false; lastTRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setPlaying(false); clearInterval(tIntRef.current);
    if (isRecordingRef.current) stopRecording();
    stopVoiceover();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const doRun = useCallback((text, ttl, segments, aiFormatted) => {
    const useAi = aiFormatted === true && Array.isArray(segments) && segments.length > 0;
    recTitleRef.current = ttl;
    runTextRef.current  = text;
    setActivePlaybackId(null);
    setScriptText(text); setTitle(ttl);
    segmentsRef.current    = useAi ? segments : [];
    aiFormattedRef.current = useAi;
    setRunSegments(useAi ? segments : []);
    currentSegRef.current  = 0; setCurrentSeg(0);
    actualSpeedRef.current = 1.0;
    pauseStateRef.current  = "idle"; pauseFrameRef.current = 0;
    pauseSegRef.current    = -1;    preDecelSpeedRef.current = 1.0;
    scrollYRef.current = 0; maxYRef.current = 0; lastTRef.current = null;
    playingRef.current = false; tBaseRef.current = null;
    setSpeed(baseSpeedRef.current); speedRef.current = baseSpeedRef.current;
    setPlaying(false); setProgress(0); setElapsed(0);
    setScreen("run");
    setTimeout(measure, 150); setTimeout(measure, 400);
    requestWakeLock();
  }, [measure]); // eslint-disable-line react-hooks/exhaustive-deps

  const doExit = useCallback(() => {
    const wasRecording = isRecordingRef.current; // capture before doPause clears it
    doPause(); clearInterval(tIntRef.current);
    releaseWakeLock();
    stopSpeechTracking();   // also calls stopSmoothScrollLoop internally
    stopSmoothScrollLoop(); // safety net in case stopSpeechTracking was already called
    if (wasRecording) {
      stopRecording();
      setTimeout(() => setScreen("home"), 500); // wait for mr.onstop to flush and save
    } else {
      setScreen("home");
    }
  }, [doPause]); // eslint-disable-line react-hooks/exhaustive-deps

  const doRestart = useCallback(() => {
    const was = playingRef.current; doPause();
    scrollYRef.current = 0; tBaseRef.current = null; setElapsed(0); setProgress(0);
    pauseStateRef.current = "idle"; pauseFrameRef.current = 0;
    pauseSegRef.current   = -1;    currentSegRef.current = 0;
    actualSpeedRef.current = 1.0;  setCurrentSeg(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    // Reset smooth scroll and sentence highlights
    resetSpeechState();
    if (speechTrackingRef.current) {
      // Rebuild sentence map from same text and restart glide loop
      const isAiMode = aiFormattedRef.current && segmentsRef.current.length > 0;
      const text = isAiMode ? segmentsRef.current.map(s => s.text).join(" ") : runTextRef.current;
      buildSentenceMap(text);
      lastWordIdxRef.current = 0;
      stopSmoothScrollLoop();
      startSmoothScrollLoop();
      document.querySelectorAll("[data-word-index]").forEach(el => {
        el.classList.remove("px-sent-current", "px-sent-next", "px-sent-past");
      });
    }
    if (was) doPlay();
  }, [doPause, doPlay]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyTimer = useCallback(() => {
    setTargetSec(noLimit ? 0 : tMin * 60 + tSec);
    setShowTimer(false); setShowRunTimer(false);
  }, [noLimit, tMin, tSec]);

  // ── upload handler ────────────────────────────────────────────
  const handleFile = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    setUploadMsg("Reading…");
    try {
      const text = (await parseFile(file)).trim();
      if (!text) { setUploadMsg("No text found"); return; }
      const ttl = file.name.replace(/\.[^.]+$/, "");
      setScripts(ss => [{ title: ttl, text }, ...ss.filter(s => s.title !== ttl)]);
      setUploadMsg("✓ " + file.name);
      setTimeout(() => setUploadMsg(""), 3000);
    } catch (err) { setUploadMsg("Error: " + (err.message || err)); }
    e.target.value = "";
  }, []);

  // ── AI upload handler ─────────────────────────────────────────
  const handleAiFile = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    e.target.value = "";

    const apiKey = process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY;
    if (!apiKey) {
      setAiToast("Set NEXT_PUBLIC_ANTHROPIC_API_KEY in Vercel environment variables to use AI Upload");
      return;
    }

    setAiUploading(true); setAiToast("");

    let text = "";
    try {
      text = (await parseFile(file)).trim();
      if (!text) { setAiToast("No text found in file"); setAiUploading(false); return; }
    } catch (err) {
      setAiToast("Error reading file: " + (err.message || err));
      setAiUploading(false); return;
    }

    const ttl = file.name.replace(/\.[^.]+$/, "");
    let segments = null;
    let toast    = "";

    const BATCH_SIZE = 150;
    const fallback   = { speed: "normal", emphasis: "none", pauseBefore: false, pauseAfter: false, tone: "calm" };
    const sentences  = splitSentences(text).slice(0, 1000);
    const batches    = [];
    for (let i = 0; i < sentences.length; i += BATCH_SIZE) batches.push(sentences.slice(i, i + BATCH_SIZE));

    const parseTags = raw => {
      const attempts = [
        () => JSON.parse(raw.trim()),
        () => JSON.parse(raw.replace(/^```[\w]*\r?\n?/m, "").replace(/\r?\n?```$/m, "").trim()),
        () => { const m = raw.match(/\[[\s\S]*?\]/); if (m) return JSON.parse(m[0]); throw new Error("x"); },
        () => { const m = raw.match(/\[[\s\S]*/);    if (m) return JSON.parse(m[0] + (m[0].endsWith("]") ? "" : "]")); throw new Error("x"); },
      ];
      for (const fn of attempts) { try { const r = fn(); if (Array.isArray(r) && r.length > 0) return r; } catch {} }
      return null;
    };

    let allTags    = [];
    let anyFailed  = false;
    let fatalToast = "";

    for (let b = 0; b < batches.length; b++) {
      setAiProgressMsg(batches.length > 1 ? `batch ${b + 1} of ${batches.length}` : "");
      const batch    = batches[b];
      const numbered = batch.map((s, i) => `${i + 1}. ${s}`).join("\n");

      try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 45000);

        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 4096,
            system: `You are a speech delivery coach. For each numbered sentence, assign delivery tags.
Return ONLY a JSON array — one object per sentence, in the same order. Each object must have exactly these keys:
speed (slow|normal|fast), emphasis (none|moderate|strong), pauseBefore (true|false), pauseAfter (true|false), tone (calm|energetic|serious|warm|urgent).
Vary the values meaningfully across sentences. Return raw JSON only — no markdown, no explanation.`,
            messages: [{ role: "user", content: `Tag each sentence:\n${numbered}` }],
          }),
        });
        clearTimeout(tid);

        if (!resp.ok) {
          const errBody = await resp.json().catch(() => ({}));
          console.error("[PrompterX] API error", resp.status, JSON.stringify(errBody));
          if (!fatalToast) fatalToast = `AI API error ${resp.status} — check API key in Vercel settings`;
          allTags = allTags.concat(batch.map(() => fallback)); anyFailed = true; continue;
        }
        const data = await resp.json();
        const tags = parseTags(data.content?.[0]?.text || "");
        if (!tags) { allTags = allTags.concat(batch.map(() => fallback)); anyFailed = true; continue; }
        allTags = allTags.concat(batch.map((_, i) => tags[i] || fallback));
      } catch (err) {
        if (!fatalToast) {
          if (err.name === "AbortError") fatalToast = "A batch timed out — partial AI formatting applied";
          else if (err.name === "TypeError") fatalToast = "AI network error — partial AI formatting applied";
          else fatalToast = `AI error: ${err.message}`;
        }
        allTags = allTags.concat(batch.map(() => fallback)); anyFailed = true;
      }
    }

    setAiProgressMsg("");

    if (allTags.length > 0) {
      segments = sentences.map((t, i) => ({ text: t, ...(allTags[i] || fallback) }));
      if (anyFailed) toast = fatalToast || "Some batches failed — partial AI formatting applied";
    } else {
      toast = fatalToast || "AI returned no segments — saved as plain script";
    }

    const entry = segments
      ? { title: ttl, text, aiFormatted: true,  segments }
      : { title: ttl, text, aiFormatted: false };

    setScripts(ss => [entry, ...ss.filter(s => s.title !== ttl)]);
    if (toast) setAiToast(toast);
    setAiProgressMsg("");
    setAiUploading(false);
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

  // ── derived ───────────────────────────────────────────────────
  const speechSupported = typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
  const remaining = targetSec > 0 ? Math.max(0, targetSec - elapsed) : null;
  const timerStr  = remaining !== null ? fmt(remaining) : fmt(elapsed);
  const timerWarn = remaining !== null && remaining <= 30 && remaining > 0;
  const curSegObj = runSegments[currentSeg];

  // ── HOME ─────────────────────────────────────────────────────
  if (screen === "home") {
    const hasAiScript      = scripts.some(s => s.aiFormatted);
    const anySettingActive = targetSec > 0 || voicePersona !== null ||
      (speechTrackingEnabled && speechSupported) || recordingEnabled || baseSpeed !== 1.0 || hasAiScript;
    const pillBase  = { borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" };
    const pillGold  = { ...pillBase, background: "rgba(245,166,35,0.1)",  border: "1px solid rgba(245,166,35,0.25)",  color: GOLD };
    const pillRed   = { ...pillBase, background: "rgba(232,64,64,0.1)",   border: "1px solid rgba(232,64,64,0.25)",   color: RED,       cursor: "default" };
    const pillGreen = { ...pillBase, background: "rgba(62,207,110,0.1)",  border: "1px solid rgba(62,207,110,0.25)",  color: "#3ecf6e", cursor: "default" };
    const speedPct  = ((baseSpeed - 0.3) / (3.0 - 0.3)) * 100;

    const chipStyle = (active, clr) => ({
      flex: 1, borderRadius: 10, padding: "8px 4px", textAlign: "center", cursor: "pointer",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 3, minHeight: 64,
      background: active ? `rgba(${clr},0.1)` : "#161616",
      border: `1px solid ${active ? `rgba(${clr},0.45)` : "#2a2a2a"}`,
    });
    const chipLabel = { fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "#555" };

    return (
      <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#f0ede8", fontFamily: "sans-serif",
                    display: "flex", flexDirection: "column", padding: "16px 16px 48px", gap: 10 }}>

        {/* ── Logo ─────────────────────────────────── */}
        <div style={{ fontSize: 24, fontWeight: 900, color: GOLD, letterSpacing: 3, lineHeight: "1.2" }}>
          PROMPTER<span style={{ opacity: .35 }}>X</span>
        </div>

        {/* ── Session Summary Bar ──────────────────── */}
        <div style={{ background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 10,
                      padding: "10px 14px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
                      minHeight: 44 }}>
          {targetSec > 0 && <span style={pillGold} onClick={() => setShowTimer(true)}>⏱ {fmt(targetSec)}</span>}
          {voicePersona && (() => { const v = VOICES.find(x => x.id === voicePersona); return (
            <span style={pillGold} onClick={() => setShowVoiceSheet(true)}>🔊 {v ? v.name : "Voice"}</span>
          ); })()}
          {baseSpeed !== 1.0 && <span style={pillGold} onClick={() => setShowSpeedSheet(true)}>→ {baseSpeed.toFixed(1)}×</span>}
          {recordingEnabled && <span style={pillRed}>⏺ REC</span>}
          {speechTrackingEnabled && speechSupported && <span style={pillGreen}>🎙 Speech</span>}
          {hasAiScript && <span style={pillGold}>✦ AI</span>}
          {!anySettingActive && (
            <span style={{ fontSize: 12, color: "#444", fontStyle: "italic" }}>
              All defaults — tap settings below to configure
            </span>
          )}
        </div>

        {/* ── Settings Panel ───────────────────────── */}
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#555" }}>
          Session Settings
        </div>

        {/* Row 1: Timer + Base Speed */}
        <div style={{ display: "flex", gap: 8 }}>
          <div role="button" tabIndex={0}
               onClick={() => setShowTimer(true)}
               onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setShowTimer(true); }}
               style={{ flex: 1, background: "#161616", border: "1px solid #2a2a2a", borderRadius: 12,
                        padding: "12px 14px", cursor: "pointer", minHeight: 66 }}>
            <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>⏱ Timer</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: targetSec > 0 ? GOLD : "#666" }}>
                {targetSec > 0 ? fmt(targetSec) : "No limit"}
              </span>
              <span style={{ color: "#444", fontSize: 16 }}>›</span>
            </div>
          </div>

          <div role="button" tabIndex={0}
               onClick={() => setShowSpeedSheet(true)}
               onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setShowSpeedSheet(true); }}
               style={{ flex: 1, background: "#161616", border: "1px solid #2a2a2a", borderRadius: 12,
                        padding: "12px 14px", cursor: "pointer", minHeight: 66 }}>
            <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>→ Base Speed</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: baseSpeed !== 1.0 ? GOLD : "#666" }}>
                {baseSpeed.toFixed(1)}×
              </span>
              <span style={{ color: "#444", fontSize: 16 }}>›</span>
            </div>
          </div>
        </div>

        {/* Row 2: Mode chips — Record · Voice · Speech · AI */}
        <div style={{ display: "flex", gap: 6 }}>
          {/* Record */}
          <div role="button" tabIndex={0}
               onClick={() => setRecordingEnabled(v => !v)}
               onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setRecordingEnabled(v => !v); }}
               style={chipStyle(recordingEnabled, "232,64,64")}>
            <span style={{ fontSize: 16 }}>⏺</span>
            <span style={chipLabel}>Record</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: recordingEnabled ? RED : "#444" }}>
              {recordingEnabled ? "ON" : "OFF"}
            </span>
          </div>

          {/* Voice */}
          <div role="button" tabIndex={0}
               onClick={() => voiceApiKey ? setShowVoiceSheet(true) : null}
               onKeyDown={e => { if ((e.key === "Enter" || e.key === " ") && voiceApiKey) setShowVoiceSheet(true); }}
               style={{ ...chipStyle(!!voicePersona, "245,166,35"), opacity: voiceApiKey ? 1 : 0.4,
                        cursor: voiceApiKey ? "pointer" : "default" }}>
            <span style={{ fontSize: 16 }}>🔊</span>
            <span style={chipLabel}>Voice</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: voicePersona ? GOLD : "#444" }}>
              {voicePersona ? (() => { const v = VOICES.find(x => x.id === voicePersona); return v ? v.name : "ON"; })() : "OFF"}
            </span>
          </div>

          {/* Speech */}
          <div role="button" tabIndex={0}
               onClick={() => speechSupported && setSpeechTrackingEnabled(v => !v)}
               onKeyDown={e => { if ((e.key === "Enter" || e.key === " ") && speechSupported) setSpeechTrackingEnabled(v => !v); }}
               style={{ ...chipStyle(speechTrackingEnabled && speechSupported, "62,207,110"),
                        opacity: speechSupported ? 1 : 0.4, cursor: speechSupported ? "pointer" : "default" }}>
            <span style={{ fontSize: 16 }}>🎙</span>
            <span style={chipLabel}>Speech</span>
            <span style={{ fontSize: 11, fontWeight: 700,
                           color: speechTrackingEnabled && speechSupported ? "#3ecf6e" : "#444" }}>
              {!speechSupported ? "N/A" : speechTrackingEnabled ? "ON" : "OFF"}
            </span>
          </div>

          {/* AI — display only */}
          <div style={{ ...chipStyle(hasAiScript, "245,166,35"), cursor: "default" }}>
            <span style={{ fontSize: 16, color: hasAiScript ? GOLD : "#555" }}>✦</span>
            <span style={chipLabel}>AI</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: hasAiScript ? GOLD : "#444" }}>
              {hasAiScript ? "ON" : "NONE"}
            </span>
          </div>
        </div>

        {/* ── Visual divider ────────────────────────── */}
        <div style={{ height: 1, background: "linear-gradient(to right, transparent, #2a2a2a 20%, #2a2a2a 80%, transparent)", margin: "4px 0" }} />

        {/* ── Scripts ─────────────────────────────────── */}
        {scripts.length > 0 && <>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#555" }}>Scripts</div>
          {scripts.map((s, i) => (
            <div key={i} style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: 14,
                                  padding: "14px 16px", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}
                   onClick={() => doRun(s.text, s.title, s.segments, s.aiFormatted)}>
                <div style={{ fontSize: 22, flexShrink: 0 }}>{s.aiFormatted ? "✦" : "📜"}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#f0ede8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 2, display: "flex", alignItems: "center", gap: 6 }}>
                    {s.text.trim().split(/\s+/).filter(Boolean).length} words
                    {s.aiFormatted && (
                      <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.5, padding: "1px 5px",
                                     background: "rgba(245,166,35,.12)", color: GOLD,
                                     border: "1px solid rgba(245,166,35,.3)", borderRadius: 4 }}>✦ AI</span>
                    )}
                  </div>
                </div>
              </div>
              <button onClick={() => doRun(s.text, s.title, s.segments, s.aiFormatted)}
                style={{ background: "rgba(245,166,35,.15)", border: "1px solid rgba(245,166,35,.3)", borderRadius: 8,
                         width: 34, height: 34, color: GOLD, fontSize: 16, cursor: "pointer",
                         display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>▶</button>
              <button onClick={e => { e.stopPropagation(); setTitle(s.title); setScriptText(s.text); setEditIdx(i); setScreen("edit"); }}
                style={{ background: "rgba(255,255,255,.07)", border: "1px solid #333", borderRadius: 8,
                         width: 34, height: 34, color: "#aaa", fontSize: 15, cursor: "pointer",
                         display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>✏️</button>
              <button onClick={() => setScripts(ss => ss.filter((_, j) => j !== i))}
                style={{ background: "rgba(232,64,64,.1)", border: "none", borderRadius: 8,
                         width: 34, height: 34, color: RED, fontSize: 15, cursor: "pointer",
                         display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>🗑</button>
            </div>
          ))}
        </>}

        {/* ── Add Script ──────────────────────────────── */}
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

        <label style={{ background: "#161616", border: `1px solid ${aiUploading ? "rgba(245,166,35,.4)" : "rgba(245,166,35,.2)"}`,
                        borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "center", gap: 14,
                        cursor: aiUploading ? "not-allowed" : "pointer", opacity: aiUploading ? 0.85 : 1 }}>
          <div style={{ fontSize: 20, flexShrink: 0, color: GOLD, fontWeight: 700 }}>✦</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#f0ede8" }}>AI Upload</div>
            <div style={{ fontSize: 12, color: aiUploading ? GOLD : aiUploadMsg ? GOLD : "#888", marginTop: 2 }}>
              {aiUploading
                ? `Analysing${aiProgressMsg ? ` — ${aiProgressMsg}` : " your script"}${dotStr}`
                : aiUploadMsg || "Formatted for delivery by Claude"}
            </div>
          </div>
          <div style={{ fontSize: 18, color: aiUploading ? "#333" : "#666" }}>›</div>
          <input type="file" accept=".txt,.text,.md,.rtf,.doc,.docx,.pdf"
                 onChange={handleAiFile} disabled={aiUploading} style={{ display: "none" }} />
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

        {/* ── Recordings ──────────────────────────────── */}
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#555", marginTop: 4 }}>Session Recordings</div>

        {recordings.length === 0 ? (
          <div style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: 14,
                        padding: "18px 16px", textAlign: "center", color: "#444", fontSize: 13 }}>
            No recordings yet — enable recording or voiceover before running a script
          </div>
        ) : recordings.map(rec => {
          const isActive = activePlaybackId === rec.id;
          if (isActive && rec.blob && !videoUrlRef.current[rec.id]) {
            videoUrlRef.current[rec.id] = URL.createObjectURL(rec.blob);
          }
          return (
            <div key={rec.id}>
              <div style={{ background: "#161616", border: "1px solid #2a2a2a",
                            borderRadius: isActive ? "14px 14px 0 0" : 14,
                            padding: "14px 16px", display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 22, flexShrink: 0 }}>{rec.isAudio ? "🎙" : "🎬"}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#f0ede8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rec.scriptTitle}</div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 2, display: "flex", alignItems: "center", gap: 6 }}>
                    {fmtDuration(rec.duration)} · {fmtTimestamp(rec.timestamp)}
                    {rec.isAudio && <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.5, padding: "1px 5px",
                                                   background: "rgba(245,166,35,.1)", color: GOLD,
                                                   border: "1px solid rgba(245,166,35,.25)", borderRadius: 4 }}>VOICE</span>}
                  </div>
                </div>
                <button onClick={() => setActivePlaybackId(isActive ? null : rec.id)}
                  style={{ background: isActive ? "rgba(245,166,35,.15)" : "transparent",
                           border: `1px solid ${isActive ? GOLD : "rgba(245,166,35,.4)"}`,
                           borderRadius: 8, padding: "5px 10px", color: GOLD,
                           fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
                  {isActive ? "■ Stop" : "▶ Play"}
                </button>
                <button onClick={() => redownload(rec)}
                  style={{ background: "rgba(255,255,255,.06)", border: "1px solid #333",
                           borderRadius: 8, width: 32, height: 32, color: "#aaa",
                           fontSize: 15, cursor: "pointer", flexShrink: 0,
                           display: "flex", alignItems: "center", justifyContent: "center" }}>↓</button>
                <button onClick={() => deleteRecording(rec.id)}
                  style={{ background: "rgba(232,64,64,.1)", border: "none", borderRadius: 8,
                           width: 32, height: 32, color: RED, fontSize: 15, cursor: "pointer",
                           flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>🗑</button>
              </div>
              {isActive && videoUrlRef.current[rec.id] && (
                <div style={{ background: "#0a0a0a", borderRadius: "0 0 14px 14px",
                              border: "1px solid #2a2a2a", borderTop: "none",
                              padding: rec.isAudio ? "12px 16px" : "0 0 8px 0", overflow: "hidden" }}>
                  {rec.isAudio ? (
                    <audio controls autoPlay style={{ width: "100%", display: "block" }}
                           src={videoUrlRef.current[rec.id]} />
                  ) : (
                    <video controls autoPlay
                           style={{ width: "100%", display: "block", borderRadius: "0 0 6px 6px", maxHeight: "40vh", background: "#000" }}
                           src={videoUrlRef.current[rec.id]} />
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* ── Modals ──────────────────────────────────── */}
        {showTimer && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 50, display: "flex", alignItems: "flex-end" }}
               onClick={() => setShowTimer(false)}>
            <TimerSheet tMin={tMin} setTMin={setTMin} tSec={tSec} setTSec={setTSec}
              noLimit={noLimit} setNoLimit={setNoLimit} onConfirm={applyTimer} onCancel={() => setShowTimer(false)} />
          </div>
        )}

        {showVoiceSheet && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 50, display: "flex", alignItems: "flex-end" }}
               onClick={() => setShowVoiceSheet(false)}>
            <div style={{ background: "#161616", borderRadius: "20px 20px 0 0", width: "100%", borderTop: "1px solid #2a2a2a",
                          display: "flex", flexDirection: "column", maxHeight: "80vh" }}
                 onClick={e => e.stopPropagation()}>
              <div style={{ padding: "18px 20px 12px", flexShrink: 0 }}>
                <div style={{ width: 38, height: 4, background: "#333", borderRadius: 2, margin: "0 auto 18px" }} />
                <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 2, marginBottom: 4 }}>AI VOICEOVER</div>
                <div style={{ fontSize: 13, color: "#666" }}>Select a voice for your session</div>
              </div>
              <div style={{ overflowY: "auto", padding: "0 20px 36px", flex: 1 }}>
                <div style={{ background: voicePersona === null ? "rgba(255,255,255,0.06)" : "transparent",
                              border: `1px solid ${voicePersona === null ? "rgba(255,255,255,0.2)" : "#2a2a2a"}`,
                              borderRadius: 12, padding: "12px 16px", marginBottom: 8, cursor: "pointer",
                              display: "flex", alignItems: "center", gap: 12 }}
                     onClick={() => { setVoicePersona(null); setShowVoiceSheet(false); }}>
                  <div style={{ width: 32, height: 32, borderRadius: "50%", background: "rgba(255,255,255,0.06)",
                                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>🔇</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: "#f0ede8" }}>Off</div>
                    <div style={{ fontSize: 12, color: "#666", marginTop: 1 }}>No voiceover</div>
                  </div>
                  {voicePersona === null && <div style={{ color: GOLD, fontSize: 16 }}>✓</div>}
                </div>
                {VOICES.map(v => (
                  <div key={v.id}
                       style={{ background: voicePersona === v.id ? "rgba(245,166,35,0.08)" : "transparent",
                                 border: `1px solid ${voicePersona === v.id ? "rgba(245,166,35,0.3)" : "#2a2a2a"}`,
                                 borderRadius: 12, padding: "12px 16px", marginBottom: 8, cursor: "pointer",
                                 display: "flex", alignItems: "center", gap: 12 }}
                       onClick={() => { setVoicePersona(v.id); setShowVoiceSheet(false); }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%",
                                  background: v.gender === "F" ? "rgba(180,100,220,0.15)" : "rgba(100,160,255,0.12)",
                                  border: `1px solid ${v.gender === "F" ? "rgba(180,100,220,0.3)" : "rgba(100,160,255,0.25)"}`,
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  fontSize: 11, fontWeight: 700, flexShrink: 0,
                                  color: v.gender === "F" ? "rgba(180,100,220,0.9)" : "rgba(100,160,255,0.9)",
                                  letterSpacing: 0.5 }}>{v.gender}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 15, fontWeight: 600, color: "#f0ede8" }}>{v.name}</div>
                      <div style={{ fontSize: 12, color: "#666", marginTop: 1 }}>{v.desc}</div>
                    </div>
                    {voicePersona === v.id && <div style={{ color: GOLD, fontSize: 16 }}>✓</div>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {showSpeedSheet && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 50, display: "flex", alignItems: "flex-end" }}
               onClick={() => setShowSpeedSheet(false)}>
            <div style={{ background: "#161616", borderRadius: "20px 20px 0 0", padding: "18px 20px 36px",
                          width: "100%", borderTop: "1px solid #2a2a2a" }}
                 onClick={e => e.stopPropagation()}>
              <div style={{ width: 38, height: 4, background: "#333", borderRadius: 2, margin: "0 auto 18px" }} />
              <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 2, marginBottom: 4 }}>BASE SCROLL SPEED</div>
              <div style={{ fontSize: 13, color: "#666", marginBottom: 24 }}>Starting speed when the prompter launches</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <span style={{ fontSize: 12, color: "#555" }}>Slow</span>
                <span style={{ fontSize: 26, fontWeight: 900, color: GOLD }}>{baseSpeed.toFixed(1)}×</span>
                <span style={{ fontSize: 12, color: "#555" }}>Fast</span>
              </div>
              <input
                type="range" className="px-slider"
                min="0.3" max="3.0" step="0.1"
                value={baseSpeed}
                onChange={e => { const v = parseFloat(e.target.value); setBaseSpeed(v); baseSpeedRef.current = v; }}
                style={{
                  WebkitAppearance: "none", width: "100%", height: 4,
                  background: `linear-gradient(to right, ${GOLD} ${speedPct}%, #2a2a2a ${speedPct}%)`,
                  borderRadius: 2, outline: "none", cursor: "pointer", marginBottom: 28, display: "block"
                }}
              />
              <button onClick={() => setShowSpeedSheet(false)}
                style={{ width: "100%", background: GOLD, color: "#000", fontSize: 16, fontWeight: 700,
                         border: "none", borderRadius: 12, padding: 15, cursor: "pointer", marginBottom: 10 }}>
                Set Speed
              </button>
              <button onClick={() => { setBaseSpeed(1.0); baseSpeedRef.current = 1.0; setShowSpeedSheet(false); }}
                style={{ width: "100%", background: "transparent", border: "1px solid #2a2a2a",
                         borderRadius: 12, padding: 13, color: "#666", fontSize: 15, cursor: "pointer" }}>
                Reset to 1.0×
              </button>
            </div>
          </div>
        )}

        {aiToast && (
          <div style={{ position: "fixed", bottom: 20, left: 16, right: 16, background: "#1e1e1e",
                        border: "1px solid #333", borderRadius: 12, padding: "12px 16px", zIndex: 100,
                        display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 13, color: "#f0ede8", flex: 1 }}>{aiToast}</span>
            <button onClick={() => setAiToast("")}
              style={{ background: "none", border: "none", color: "#555", fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1, flexShrink: 0 }}>✕</button>
          </div>
        )}
      </div>
    );
  }

  // ── EDIT ─────────────────────────────────────────────────────
  if (screen === "edit") {
    const wc = scriptText.trim().split(/\s+/).filter(Boolean).length;
    const saveAndRun = () => {
      if (!scriptText.trim()) return;
      const orig     = editIdx !== null ? scripts[editIdx] : null;
      const textSame = orig && orig.text === scriptText;
      const keepAi   = textSame && orig.aiFormatted === true && Array.isArray(orig.segments) && orig.segments.length > 0;
      const entry    = keepAi
        ? { title: title || "Untitled", text: scriptText, aiFormatted: true, segments: orig.segments }
        : { title: title || "Untitled", text: scriptText };
      setScripts(ss => {
        if (editIdx !== null) { const n = [...ss]; n[editIdx] = entry; return n; }
        return [entry, ...ss];
      });
      doRun(scriptText, title || "Untitled", keepAi ? orig.segments : undefined, keepAi || undefined);
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

      <style>{`@keyframes recpulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>

      <div ref={scrollRef}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                 overflowY: "scroll", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
        <div style={{ paddingTop: "33vh", paddingBottom: "67vh", paddingLeft: "8vw", paddingRight: "8vw",
                      fontSize, lineHeight: 1.8, color: "rgba(255,255,255,.92)",
                      whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "'Courier New',monospace" }}>
          {speechTrackingEnabled && runSegments.length > 0 ? (
            // AI mode + speech tracking: keep full AI segment container styles,
            // but wrap every word in a data-word-index span for highlighting
            (() => {
              let globalIdx = 0;
              return runSegments.map((seg, i) => {
                const isUrgent    = seg.tone === "urgent";
                const isEnergetic = seg.tone === "energetic";
                const isSerious   = seg.tone === "serious";
                const isWarm      = seg.tone === "warm";
                // Split segment text into word/whitespace tokens and wrap words in spans
                const tokens = seg.text.split(/(\s+)/);
                const spans = tokens.map((token, ti) => {
                  if (/\S/.test(token)) {
                    const idx = globalIdx++;
                    return (
                      <span key={ti} data-word-index={idx}
                        style={{ transition: "background 0.2s ease, opacity 0.3s ease" }}>
                        {token}
                      </span>
                    );
                  }
                  return <span key={ti}>{token}</span>;
                });
                return (
                  <div key={i}>
                    {seg.pauseBefore && <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", marginBottom: "0.5em" }} />}
                    <p data-seg={i} style={{
                      margin: 0,
                      marginTop:    seg.pauseBefore ? "2em"  : "0.5em",
                      marginBottom: seg.pauseAfter  ? "2em"  : "0.5em",
                      fontWeight:   seg.emphasis === "strong" ? 900 : seg.emphasis === "moderate" ? 700 : 400,
                      color:        seg.emphasis === "strong" ? GOLD : seg.emphasis === "moderate" ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.72)",
                      fontSize:     seg.speed === "slow" ? "1.08em" : seg.speed === "fast" ? "0.94em" : "1em",
                      ...(isUrgent    ? { borderLeft: "3px solid #e84040", paddingLeft: "12px" } :
                          isEnergetic ? { borderLeft: "3px solid #f5a623", paddingLeft: "12px" } :
                          isSerious   ? { borderLeft: "3px solid #666",    paddingLeft: "12px" } :
                          isWarm      ? { borderLeft: "3px solid #f0a060", paddingLeft: "12px" } : {}),
                      lineHeight: 1.8,
                    }}>{spans}</p>
                  </div>
                );
              });
            })()
          ) : speechTrackingEnabled ? (
            // Plain script + speech tracking: every word in a data-word-index span
            renderScriptContent(scriptText, true)
          ) : runSegments.length > 0 ? (
            // AI mode only — rich per-segment styling, plain text (no word spans needed)
            runSegments.map((seg, i) => {
              const isUrgent    = seg.tone === "urgent";
              const isEnergetic = seg.tone === "energetic";
              const isSerious   = seg.tone === "serious";
              const isWarm      = seg.tone === "warm";
              return (
                <div key={i}>
                  {seg.pauseBefore && <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", marginBottom: "0.5em" }} />}
                  <p data-seg={i} style={{
                    margin: 0,
                    marginTop:    seg.pauseBefore ? "2em"  : "0.5em",
                    marginBottom: seg.pauseAfter  ? "2em"  : "0.5em",
                    fontWeight:   seg.emphasis === "strong" ? 900 : seg.emphasis === "moderate" ? 700 : 400,
                    color:        seg.emphasis === "strong" ? GOLD : seg.emphasis === "moderate" ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.72)",
                    fontSize:     seg.speed === "slow" ? "1.08em" : seg.speed === "fast" ? "0.94em" : "1em",
                    ...(isUrgent    ? { borderLeft: "3px solid #e84040", paddingLeft: "12px" } :
                        isEnergetic ? { borderLeft: "3px solid #f5a623", paddingLeft: "12px" } :
                        isSerious   ? { borderLeft: "3px solid #666",    paddingLeft: "12px" } :
                        isWarm      ? { borderLeft: "3px solid #f0a060", paddingLeft: "12px" } : {}),
                    lineHeight: 1.8,
                  }}>{seg.text}</p>
                </div>
              );
            })
          ) : (
            // Plain script mode
            scriptText.split(/\n\n+/).filter(p => p.trim()).map((p, i) => (
              <p key={i} style={{ marginBottom: "1.3em" }}>{p.replace(/\n/g, " ")}</p>
            ))
          )}
        </div>
      </div>

      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "20%", background: "linear-gradient(to bottom,#000,transparent)", pointerEvents: "none", zIndex: 5 }} />
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "30%", background: "linear-gradient(to top,#000,transparent)", pointerEvents: "none", zIndex: 5 }} />
      <div style={{ position: "absolute", top: "33%", left: 0, right: 0, height: 2, background: `linear-gradient(90deg,transparent,${GOLD} 20%,${GOLD} 80%,transparent)`, boxShadow: `0 0 10px ${GOLD}`, opacity: .55, pointerEvents: "none", zIndex: 6 }} />

      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 10,
                    paddingTop: "max(16px, calc(env(safe-area-inset-top) + 8px))",
                    background: "linear-gradient(to bottom,rgba(0,0,0,.9),transparent)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px 8px", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 2, opacity: .8, maxWidth: "30%",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>
            {title.toUpperCase()}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, pointerEvents: "none" }}>
            {isRecording ? (
              <div style={{ display: "flex", alignItems: "center", gap: 5,
                            background: "rgba(232,64,64,0.18)", border: "1px solid rgba(232,64,64,0.55)",
                            borderRadius: 7, padding: "4px 9px", animation: "recpulse 1.2s infinite" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: RED, display: "inline-block", flexShrink: 0 }} />
                <span style={{ fontSize: 11, fontWeight: 800, color: RED, letterSpacing: 1.5 }}>REC</span>
              </div>
            ) : recordingEnabled ? (
              <span style={{ fontSize: 13, color: "rgba(232,64,64,0.35)" }}>⏺</span>
            ) : null}
            {voicePersona && (voiceoverSpeaking || voiceoverLoading) && (
              <>
                <span style={{ fontSize: 14, color: voiceoverSpeaking ? GOLD : "rgba(245,166,35,0.4)",
                               animation: voiceoverSpeaking ? "recpulse 1.2s infinite" : "none" }}>🔊</span>
                {voiceoverLoading && <span style={{ fontSize: 10, color: "rgba(245,166,35,0.5)", letterSpacing: 0.5 }}>Loading…</span>}
              </>
            )}
            {speechTrackingEnabled && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                  background: speechStatus === "listening" ? "#3ecf6e"
                            : speechStatus === "paused"    ? GOLD
                            : speechStatus === "error"     ? RED : "#444",
                  animation: speechStatus === "listening" ? "recpulse 1.2s infinite" : "none",
                }} />
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase",
                               color: speechStatus === "listening" ? "#3ecf6e"
                                    : speechStatus === "paused"    ? GOLD
                                    : "#666" }}>
                  {speechStatus === "listening" ? "TRACKING"
                 : speechStatus === "paused"    ? "PAUSED"
                 : speechStatus === "error"     ? "MIC ERR"
                 : "STANDBY"}
                </span>
              </div>
            )}
          </div>
          <button onClick={() => setShowRunTimer(true)}
            style={{ fontSize: 20, fontWeight: 900, letterSpacing: 2, background: "none", border: "none",
                     cursor: "pointer", padding: 0, fontFamily: "sans-serif",
                     color: timerWarn ? "#f44" : remaining !== null ? GOLD : "rgba(255,255,255,.4)" }}>
            {timerStr}
          </button>
          <div style={{ fontSize: 11, fontWeight: 700, padding: "5px 9px", borderRadius: 6, letterSpacing: 1,
                        background: playing ? RED : GOLD, color: playing ? "#fff" : "#000", flexShrink: 0 }}>
            {playing ? "LIVE" : "READY"}
          </div>
        </div>
      </div>

      {recToast && (
        <div style={{ position: "absolute", top: 70, left: 16, right: 16, background: "rgba(232,64,64,.9)",
                      borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#fff", zIndex: 20,
                      display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {recToast}
          <button onClick={() => setRecToast("")} style={{ background: "none", border: "none", color: "#fff", fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1 }}>✕</button>
        </div>
      )}

      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "8px 16px 28px",
                    paddingBottom: "max(28px, calc(env(safe-area-inset-bottom) + 12px))",
                    background: "linear-gradient(to top,rgba(0,0,0,.95) 70%,transparent)", zIndex: 10 }}>
        {curSegObj && runSegments.length > 0 && (() => {
          const speed = curSegObj.speed;
          const tone  = curSegObj.tone;
          const speedCfg = {
            slow:   { icon: "⬇", label: "SLOW",   bg: "rgba(245,166,35,0.15)",   border: "rgba(245,166,35,0.4)",   color: "#f5a623" },
            normal: { icon: "→", label: "NORMAL", bg: "rgba(255,255,255,0.08)",  border: "rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.6)" },
            fast:   { icon: "⬆", label: "FAST",   bg: "rgba(62,207,110,0.12)",   border: "rgba(62,207,110,0.35)",  color: "#3ecf6e" },
          };
          const toneCfg = {
            calm:      { icon: "◯", label: "CALM",      color: "rgba(255,255,255,0.5)" },
            energetic: { icon: "⚡", label: "ENERGETIC", color: "#f5a623" },
            serious:   { icon: "▪", label: "SERIOUS",   color: "#aaa" },
            warm:      { icon: "❤", label: "WARM",      color: "#f0a060" },
            urgent:    { icon: "⚠", label: "URGENT",    color: "#e84040" },
          };
          const sc = speedCfg[speed] || speedCfg.normal;
          const tc = toneCfg[tone]   || toneCfg.calm;
          const chipBase = { display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 20, border: "1px solid", fontSize: 13, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "sans-serif" };
          return (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "6px 0 10px", pointerEvents: "none", opacity: chipVisible ? 1 : 0, transition: "opacity 0.3s ease" }}>
              <div style={{ ...chipBase, background: sc.bg, borderColor: sc.border, color: sc.color }}>
                <span>{sc.icon}</span><span>{sc.label}</span>
              </div>
              <div style={{ ...chipBase, background: "rgba(0,0,0,0.3)", borderColor: tc.color + "66", color: tc.color }}>
                <span>{tc.icon}</span><span>{tc.label}</span>
              </div>
            </div>
          );
        })()}

        <div style={{ height: 3, background: "rgba(255,255,255,.12)", borderRadius: 2, marginBottom: 12, overflow: "hidden" }}>
          <div style={{ height: "100%", background: GOLD, width: progress.toFixed(1) + "%", borderRadius: 2 }} />
        </div>
        <div style={{ opacity: speechTrackingEnabled ? 0.35 : 1,
                      pointerEvents: speechTrackingEnabled ? "none" : "auto",
                      position: "relative", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
            <button onClick={() => { const v = Math.max(0.1, Math.round((speed - .1) * 10) / 10); setSpeed(v); speedRef.current = v; }}
              style={{ width: 44, height: 38, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.12)", borderRight: "none", borderRadius: "9px 0 0 9px", color: "#fff", fontSize: 22, cursor: "pointer" }}>−</button>
            <div style={{ minWidth: 100, height: 38, background: "rgba(245,166,35,.1)", border: "1px solid rgba(245,166,35,.3)", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "0 14px" }}>
              <span style={{ fontSize: 20, fontWeight: 900, color: GOLD }}>{speed.toFixed(1)}</span>
              <span style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>speed</span>
            </div>
            <button onClick={() => { const v = Math.min(10, Math.round((speed + .1) * 10) / 10); setSpeed(v); speedRef.current = v; }}
              style={{ width: 44, height: 38, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.12)", borderLeft: "none", borderRadius: "0 9px 9px 0", color: "#fff", fontSize: 22, cursor: "pointer" }}>+</button>
          </div>
          {speechTrackingEnabled && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
                          justifyContent: "center", fontSize: 10, color: GOLD,
                          fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>
              SPEECH TRACKING ACTIVE
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button onClick={doRestart} style={{ width: 48, height: 48, borderRadius: "50%", border: "none", background: "rgba(255,255,255,.09)", color: "#fff", fontSize: 20, cursor: "pointer" }}>↺</button>
            {isRecording && (
              <button onClick={switchCamera}
                title={facingMode === "user" ? "Switch to rear camera" : "Switch to front camera"}
                style={{ width: 44, height: 44, borderRadius: "50%", border: `1px solid ${RED}`, background: "rgba(232,64,64,.12)",
                         color: RED, fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                🔄
              </button>
            )}
          </div>
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
