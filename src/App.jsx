import { useState, useRef, useCallback, useEffect } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs`;

// ─── SYSTEM PROMPT ───────────────────────────────────────────
const SYSTEM_PROMPT = `You classify candidate numbers extracted from a corporate report.

For each candidate you see the number and the FULL sentence it appears in. You must:
1. Decide if it is a DATA POINT or not
2. If it IS a data point, categorise it as: E (Environment), S (Social), G (Governance), or O (Other)

A DATA POINT is a specific numerical figure representing a measurable metric — KPIs, targets, achievements, counts, percentages, monetary amounts, environmental metrics, ratios. Figures that would need verification year-over-year.

CATEGORY DEFINITIONS:
- E (Environment): emissions, energy, water, waste, recycling, renewable energy, carbon, climate targets, biodiversity, pollution, metric tons, MW, TJ, m³, environmental compliance
- S (Social): employees, diversity, safety, training, community investment, human rights, health & safety incidents, wages, working hours, volunteer hours, donations, accessibility, customer satisfaction, supply chain labor
- G (Governance): board composition, director counts, committee meetings, executive compensation, audit, compliance, shareholder data, shares, voting, ethics hotline, anti-corruption, stock-based compensation
- O (Other): financial metrics (revenue, profit, stock price, market cap), general corporate data (subsidiaries count, offices), anything that doesn't clearly fit E/S/G

YES — data points:
- Percentages: "35%", "58.5%", "30.7%"
- Counts: "1,667 subsidiaries", "113,000 employees", "54 sites"
- Monetary: "881.4 billion yen", "319 million JPY"
- Environmental: "457,000 metric tons", "1.7MW"
- Ratios: "1:53", "1:210"
- Targets: "100% renewable", "75% reduction"

NO — not data points:
- Years / dates: 2024, 2023, FY2023
- Page / section numbers, TOC references
- ISO / standard numbers: 14001, 45001
- Classification labels: Scope 1, Class 3, SDG 13
- Product models: PlayStation 5
- Footnote markers, GRI/SASB codes
- Address / postal code numbers
- Datasheet raw table numbers without narrative
- Structural numbers (bullets, list ordering, section IDs)

Return ONLY a JSON array of objects for items that ARE data points:
[{"id": 5, "cat": "E"}, {"id": 8, "cat": "S"}, {"id": 12, "cat": "G"}, ...]

Only include items that are data points. Omit non-data-points entirely.
No markdown. No explanation. Just the JSON array.`;

// ─── STAGE 1: Extraction ─────────────────────────────────────
const NUM_RE = /(\d+(?:,\d{3})*(?:\.\d+)?)/g;
const ALL_YEARS = new Set();
for (let y = 1900; y < 2060; y++) ALL_YEARS.add(y);

function isObviousExclusion(numVal, numText, text, pos) {
  if (numVal === 0) return true;
  if (pos > 0 && text[pos - 1] === "*") return true;
  if (!numText.includes(",") && /^\d{4}$/.test(numText) && ALL_YEARS.has(parseInt(numText))) return true;
  const before3 = text.substring(Math.max(0, pos - 3), pos).toUpperCase();
  if (before3.includes("FY")) return true;
  if (pos > 0 && /[A-Za-z]/.test(text[pos - 1]) && /^\d{4,}$/.test(numText)) return true;
  const before40 = text.substring(Math.max(0, pos - 40), pos);
  if (/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+$/i.test(before40) && numVal <= 31) return true;
  return false;
}

function getSentence(text, pos) {
  let start = pos;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;
  let end = pos;
  while (end < text.length && !/[.!?\n]/.test(text[end])) end++;
  if (end < text.length) end++;
  return text.substring(start, end).replace(/\s+/g, " ").trim();
}

async function extractCandidates(file, onProgress) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const candidates = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(" ");
    let m;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(text)) !== null) {
      const numText = m[1];
      const numClean = numText.replace(/,/g, "");
      const pos = m.index;
      const numVal = parseFloat(numClean);
      if (isNaN(numVal)) continue;
      if (isObviousExclusion(numVal, numText, text, pos)) continue;
      const sentence = getSentence(text, pos);
      candidates.push({ id: candidates.length, page: i, number: numText, numberClean: numClean, sentence });
    }
    if (onProgress) onProgress({ page: i, total: pdf.numPages, candidates: candidates.length });
  }
  return { candidates, numPages: pdf.numPages };
}

// ─── STAGE 2: AI Classification + ESG Category ──────────────
async function classifyBatch(batch, apiKey) {
  // Send full sentence but cap at 250 chars to manage tokens
  const lines = batch.map((c) => `ID:${c.id} | ${c.number} | "${c.sentence.substring(0, 250)}"`);
  const userMsg = "Classify these. Return JSON array of objects with id and cat (E/S/G/O) for data points only.\n\n" + lines.join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err.substring(0, 200)}`);
  }

  const data = await res.json();
  let text = data.content?.[0]?.text || "[]";
  text = text.trim().replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
  const match = text.match(/\[[\s\S]*?\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      // Returns [{id, cat}, ...]
      return arr.map((item) => ({
        id: typeof item === "number" ? item : item.id,
        cat: (typeof item === "object" && item.cat) ? item.cat.toUpperCase() : "O",
      }));
    } catch {
      return [];
    }
  }
  return [];
}

// ─── CATEGORY HELPERS ────────────────────────────────────────
const CAT_META = {
  E: { label: "Environment", color: "#34d399", bg: "#052e16", border: "#064e3b" },
  S: { label: "Social", color: "#60a5fa", bg: "#172554", border: "#1e3a5f" },
  G: { label: "Governance", color: "#c084fc", bg: "#2e1065", border: "#4c1d95" },
  O: { label: "Other", color: "#a1a1aa", bg: "#1c1c1e", border: "#3f3f46" },
};

function CatBadge({ cat }) {
  const m = CAT_META[cat] || CAT_META.O;
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
      background: m.bg, color: m.color, border: `1px solid ${m.border}`, letterSpacing: "0.05em",
    }}>
      {m.label}
    </span>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("dp_key") || "");
  const [showKey, setShowKey] = useState(!localStorage.getItem("dp_key"));
  const [status, setStatus] = useState("idle");
  const [log, setLog] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [dpMap, setDpMap] = useState(new Map()); // id -> category
  const [removed, setRemoved] = useState(new Set());
  const [progress, setProgress] = useState({ stage: "", pct: 0, detail: "" });
  const [totalPages, setTotalPages] = useState(0);
  const [fileName, setFileName] = useState("");
  const [fileObj, setFileObj] = useState(null);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("ALL");
  const [batchSize, setBatchSize] = useState(25);
  const logRef = useRef(null);

  const addLog = useCallback((msg) => setLog((p) => [...p, `[${new Date().toLocaleTimeString()}] ${msg}`]), []);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  const saveKey = () => { localStorage.setItem("dp_key", apiKey); setShowKey(false); addLog("API key saved"); };
  const handleFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    setFileName(f.name); setFileObj(f); setCandidates([]); setDpMap(new Map()); setRemoved(new Set());
    setProgress({ stage: "", pct: 0, detail: "" }); setLog([]); addLog(`Loaded: ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
  };

  const run = async () => {
    if (!fileObj || !apiKey) { addLog("Need file + API key"); return; }

    // STAGE 1
    setStatus("stage1");
    addLog("STAGE 1: Extracting text and finding candidate numbers...");
    try {
      const { candidates: cands, numPages } = await extractCandidates(fileObj, ({ page, total, candidates: cnt }) => {
        setProgress({ stage: "Extracting", pct: Math.round((page / total) * 100), detail: `Page ${page}/${total} — ${cnt} candidates` });
      });
      setCandidates(cands);
      setTotalPages(numPages);
      addLog(`Stage 1 complete: ${cands.length} candidates from ${numPages} pages`);

      // STAGE 2
      setStatus("stage2");
      addLog(`STAGE 2: AI classifying + ESG categorising (batches of ${batchSize})...`);
      const newMap = new Map();
      const totalBatches = Math.ceil(cands.length / batchSize);

      for (let i = 0; i < cands.length; i += batchSize) {
        const batch = cands.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        setProgress({ stage: "Classifying", pct: Math.round((batchNum / totalBatches) * 100), detail: `Batch ${batchNum}/${totalBatches}` });
        addLog(`  Batch ${batchNum}/${totalBatches}...`);

        try {
          const results = await classifyBatch(batch, apiKey);
          results.forEach(({ id, cat }) => newMap.set(id, cat));
          const counts = { E: 0, S: 0, G: 0, O: 0 };
          results.forEach(({ cat }) => { counts[cat] = (counts[cat] || 0) + 1; });
          const breakdown = Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(" ");
          addLog(`    → ${results.length} data points (${breakdown})`);
        } catch (err) {
          addLog(`    ✗ ${err.message}`);
          if (err.message.includes("429") || err.message.toLowerCase().includes("rate")) {
            addLog("    Waiting 60s for rate limit...");
            await new Promise((r) => setTimeout(r, 60000));
            try {
              const results = await classifyBatch(batch, apiKey);
              results.forEach(({ id, cat }) => newMap.set(id, cat));
              addLog(`    → Retry: ${results.length} data points`);
            } catch (e2) {
              addLog(`    ✗ Retry failed: ${e2.message}`);
            }
          }
        }

        // Update state progressively so user sees results building
        setDpMap(new Map(newMap));
        await new Promise((r) => setTimeout(r, 5000));
      }

      setDpMap(newMap);
      setStatus("done");
      const catCounts = { E: 0, S: 0, G: 0, O: 0 };
      newMap.forEach((cat) => { catCounts[cat] = (catCounts[cat] || 0) + 1; });
      addLog(`\nDone: ${newMap.size} data points — E:${catCounts.E} S:${catCounts.S} G:${catCounts.G} O:${catCounts.O}`);
      addLog(`Rejected: ${cands.length - newMap.size} (${((1 - newMap.size / cands.length) * 100).toFixed(0)}%)`);
    } catch (err) {
      setStatus("error");
      addLog(`Error: ${err.message}`);
    }
  };

  // ── Derived ──
  const dataPoints = candidates
    .filter((c) => dpMap.has(c.id) && !removed.has(c.id))
    .map((c) => ({ ...c, cat: dpMap.get(c.id) }));

  const filtered = dataPoints.filter((d) => {
    if (catFilter !== "ALL" && d.cat !== catFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return d.number.includes(search) || d.sentence.toLowerCase().includes(q) || String(d.page).includes(search);
    }
    return true;
  });

  const toggle = (id) => setRemoved((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Category counts
  const catCounts = { E: 0, S: 0, G: 0, O: 0 };
  dataPoints.forEach((d) => { catCounts[d.cat] = (catCounts[d.cat] || 0) + 1; });

  // ── Exports ──
  const exportCSV = () => {
    const rows = [
      "#,Page,Number,Category,Sentence",
      ...dataPoints.map((d, i) => `${i + 1},${d.page},"${d.number}",${d.cat},"${d.sentence.replace(/"/g, '""')}"`)
    ];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `${fileName.replace(/\.[^.]+$/, "")}_DataPoints.csv`; a.click();
  };
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(dataPoints, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `${fileName.replace(/\.[^.]+$/, "")}_DataPoints.json`; a.click();
  };

  // ── Status pill ──
  const statusMap = {
    idle: ["Ready", "#27272a", "#a1a1aa"],
    stage1: ["Extracting...", "#422006", "#fbbf24"],
    stage2: ["AI Classifying...", "#1e1b4b", "#818cf8"],
    done: ["Complete", "#052e16", "#34d399"],
    error: ["Error", "#2a1515", "#f87171"],
  };
  const [sLabel, sBg, sFg] = statusMap[status] || statusMap.idle;

  // ─── RENDER ──────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#09090b", fontFamily: "'DM Sans','Segoe UI',sans-serif", color: "#e4e4e7" }}>
      {/* Header */}
      <header style={{ background: "linear-gradient(135deg,#0c0a1d,#1a103a,#0c0a1d)", borderBottom: "1px solid #1e1b3a", padding: "20px 0" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700 }}><span style={{ color: "#818cf8" }}>◆</span> Data Point Extractor</h1>
            <p style={{ fontSize: 12, color: "#52525b", marginTop: 2 }}>Extract → Classify → Categorise (ESG)</p>
          </div>
          <span style={{ background: sBg, color: sFg, padding: "5px 14px", borderRadius: 99, fontSize: 12, fontWeight: 600 }}>{sLabel}</span>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 24px" }}>
        {/* API Key */}
        {showKey && (
          <div style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#52525b", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Anthropic API Key</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-..."
                style={{ flex: 1, background: "#0f0f14", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", color: "#e4e4e7", fontSize: 13, outline: "none", fontFamily: "monospace" }} />
              <button onClick={saveKey} style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: "#4f46e5", color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Save</button>
            </div>
            <p style={{ fontSize: 11, color: "#3f3f46", marginTop: 6 }}>Stored in your browser only.</p>
          </div>
        )}
        {!showKey && <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}><button onClick={() => setShowKey(true)} style={{ background: "none", border: "none", color: "#52525b", fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>Change API key</button></div>}

        {/* Controls */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#52525b", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Document</div>
            <label style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 14, borderRadius: 8, cursor: "pointer", background: fileName ? "#1e1b4b" : "#111114", border: `1px dashed ${fileName ? "#4f46e5" : "#27272a"}`, fontSize: 13, color: fileName ? "#c7d2fe" : "#52525b" }}>
              <input type="file" accept=".pdf" onChange={handleFile} style={{ display: "none" }} />
              {fileName ? `📄 ${fileName}` : "Click to select PDF"}
            </label>
            {totalPages > 0 && <div style={{ fontSize: 11, color: "#52525b", marginTop: 6 }}>{totalPages} pages • {candidates.length} candidates</div>}
          </div>
          <div style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#52525b", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Pipeline</div>
            <button onClick={run} disabled={!fileObj || !apiKey || status === "stage1" || status === "stage2"}
              style={{ width: "100%", padding: "10px", borderRadius: 8, border: "none", fontWeight: 600, fontSize: 13, background: fileObj && apiKey ? "linear-gradient(135deg,#4f46e5,#7c3aed)" : "#27272a", color: fileObj && apiKey ? "#fff" : "#52525b", cursor: fileObj && apiKey ? "pointer" : "not-allowed", marginBottom: 8 }}>
              {status === "stage1" || status === "stage2" ? `${progress.stage}… ${progress.pct}%` : "Run Extraction"}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#52525b" }}>
              <span>Batch size:</span>
              <select value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} style={{ background: "#0f0f14", border: "1px solid #27272a", borderRadius: 6, padding: "3px 8px", color: "#a1a1aa", fontSize: 12 }}>
                {[15, 20, 25, 30, 40].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            {(status === "stage1" || status === "stage2") && (
              <div style={{ marginTop: 8 }}>
                <div style={{ background: "#27272a", borderRadius: 4, height: 5, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: status === "stage1" ? "#f59e0b" : "linear-gradient(90deg,#4f46e5,#7c3aed)", width: `${progress.pct}%`, transition: "width 0.3s" }} />
                </div>
                <div style={{ fontSize: 11, color: "#52525b", marginTop: 4 }}>{progress.detail}</div>
              </div>
            )}
          </div>
        </div>

        {/* ESG Stats */}
        {dpMap.size > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 8, marginBottom: 16 }}>
            {[
              { l: "Total", v: dataPoints.length, c: "#818cf8" },
              { l: "Environment", v: catCounts.E, c: CAT_META.E.color },
              { l: "Social", v: catCounts.S, c: CAT_META.S.color },
              { l: "Governance", v: catCounts.G, c: CAT_META.G.color },
              { l: "Other", v: catCounts.O, c: CAT_META.O.color },
              { l: "Candidates", v: candidates.length, c: "#52525b" },
              { l: "AI Rejected", v: candidates.length - dpMap.size, c: "#f87171" },
              { l: "You Removed", v: removed.size, c: "#fbbf24" },
            ].map(({ l, v, c }) => (
              <div key={l} style={{ background: "#18181b", border: "1px solid #1f1f23", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 9, color: "#52525b", textTransform: "uppercase", letterSpacing: "0.06em" }}>{l}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: c, marginTop: 2 }}>{v}</div>
              </div>
            ))}
          </div>
        )}

        {/* Log */}
        <div ref={logRef} style={{ background: "#0c0c10", border: "1px solid #1f1f23", borderRadius: 8, padding: 12, marginBottom: 16, maxHeight: 150, overflowY: "auto", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, lineHeight: 1.7, color: "#52525b" }}>
          {log.length === 0 ? <span style={{ color: "#27272a" }}>Upload a PDF and click Run…</span>
            : log.map((l, i) => <div key={i} style={{ color: l.includes("Done") || l.includes("complete") ? "#34d399" : l.includes("✗") || l.includes("Error") ? "#f87171" : l.includes("→") ? "#818cf8" : l.includes("Waiting") ? "#fbbf24" : "#52525b" }}>{l}</div>)}
        </div>

        {/* Results */}
        {dpMap.size > 0 && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600 }}>Data Points ({filtered.length})</h2>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                {/* Category filter */}
                {["ALL", "E", "S", "G", "O"].map((c) => {
                  const meta = c === "ALL" ? { color: "#818cf8", bg: "#1e1b4b", border: "#4f46e5" } : CAT_META[c];
                  const active = catFilter === c;
                  return (
                    <button key={c} onClick={() => setCatFilter(c)} style={{
                      padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
                      background: active ? meta.bg : "transparent",
                      border: `1px solid ${active ? meta.border || meta.color : "#27272a"}`,
                      color: active ? meta.color : "#52525b",
                    }}>
                      {c === "ALL" ? "All" : CAT_META[c].label}
                      {c !== "ALL" && ` (${catCounts[c]})`}
                    </button>
                  );
                })}
                <span style={{ width: 1, height: 20, background: "#27272a" }} />
                <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ background: "#0f0f14", border: "1px solid #27272a", borderRadius: 6, padding: "5px 10px", color: "#a1a1aa", fontSize: 12, width: 150, outline: "none" }} />
                <button onClick={exportCSV} style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid #27272a", background: "transparent", color: "#71717a", fontSize: 11, cursor: "pointer" }}>CSV ↓</button>
                <button onClick={exportJSON} style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid #27272a", background: "transparent", color: "#71717a", fontSize: 11, cursor: "pointer" }}>JSON ↓</button>
              </div>
            </div>

            <div style={{ background: "#18181b", border: "1px solid #1f1f23", borderRadius: 10, overflow: "hidden" }}>
              {/* Table header */}
              <div style={{ display: "grid", gridTemplateColumns: "40px 48px 100px 80px 1fr 48px", padding: "8px 14px", background: "#111114", borderBottom: "1px solid #1f1f23", fontSize: 10, fontWeight: 600, color: "#52525b", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                <div>#</div><div>Page</div><div>Number</div><div>Category</div><div>Sentence</div><div style={{ textAlign: "center" }}>Keep</div>
              </div>
              {/* Rows */}
              <div style={{ maxHeight: 520, overflowY: "auto" }}>
                {filtered.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "#3f3f46", fontSize: 13 }}>{search || catFilter !== "ALL" ? "No results matching filter" : "No data points"}</div>}
                {filtered.map((dp, idx) => (
                  <div key={dp.id} style={{ display: "grid", gridTemplateColumns: "40px 48px 100px 80px 1fr 48px", padding: "6px 14px", borderBottom: "1px solid #141418", fontSize: 12, background: idx % 2 ? "#0f0f14" : "transparent", alignItems: "center" }}>
                    <div style={{ color: "#3f3f46" }}>{idx + 1}</div>
                    <div style={{ color: "#818cf8", fontWeight: 600 }}>{dp.page}</div>
                    <div style={{ color: "#e4e4e7", fontWeight: 500 }}>{dp.number}</div>
                    <div><CatBadge cat={dp.cat} /></div>
                    <div style={{ color: "#71717a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 11 }}>{dp.sentence}</div>
                    <div style={{ textAlign: "center" }}>
                      <button onClick={() => toggle(dp.id)} style={{
                        width: 24, height: 24, borderRadius: 5,
                        border: `1px solid ${removed.has(dp.id) ? "#3f2020" : "#1a3a1a"}`,
                        background: removed.has(dp.id) ? "#1a1010" : "#101a10",
                        color: removed.has(dp.id) ? "#f87171" : "#34d399",
                        cursor: "pointer", fontSize: 12,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                      }}>
                        {removed.has(dp.id) ? "✗" : "✓"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
