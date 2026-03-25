import { useState, useRef, useCallback, useEffect } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs`;

// ─── AI PROMPT ───────────────────────────────────────────────
const SYSTEM_PROMPT = `You extract data points from corporate reports (sustainability reports, 20-F filings, annual reports).

A DATA POINT is a specific numerical figure representing a measurable metric about the company's operations, performance, targets, achievements, or impact — the kind of figure that would need to be verified or updated year-over-year.

EXAMPLES OF DATA POINTS:
- Percentages: "35%", "58.5%", "90%", "30.7%"
- Counts: "1,667 subsidiaries", "113,000 employees", "54 sites", "22 pairs"
- Monetary: "881.4 billion yen", "319 million JPY", "200,000 USD"
- Environmental: "457,000 metric tons", "1.7MW", "22.63 million m³"
- Ratios: "1:53", "1:210"
- Targets: "100% renewable", "75% reduction"
- Standalone metrics: "1,261,231,889" (shares issued), "373,144" (shareholders)

NOT DATA POINTS — always exclude:
- Years / dates: 2024, 2023, FY2023, "March 31, 2024", fiscal year 2021
- Page / section numbers
- Standard or law numbers: ISO 14001, ISO 45001, Ordinance No. 162
- Classification labels: Scope 1, Scope 2, Class 3, SDG 13, Category 2
- Product model numbers: PlayStation®5
- Footnote / superscript markers: *1, *2
- GRI / SASB index codes
- Table-of-contents page references
- Datasheet appendix tables (dense raw-data tables with no narrative)

Return ONLY a JSON array of objects. Each object: {"page":<int>,"value":"<the data point with minimal context>","context":"<surrounding sentence fragment>"}
Return [] if no data points found. No markdown fences. Just raw JSON.`;

// ─── PDF TEXT EXTRACTION ─────────────────────────────────────
async function extractPdfText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join(" ");
    pages.push({ page: i, text });
  }
  return { pages, numPages: pdf.numPages };
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─── API CALL ────────────────────────────────────────────────
async function classifyPages(base64, startPage, endPage, apiKey) {
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
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64,
              },
            },
            {
              type: "text",
              text: `Extract ALL data points from pages ${startPage} to ${endPage} only. Years (2023, 2024, FY2023 etc.) are NOT data points. Page numbers are NOT data points. Return JSON array.`,
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  let text = data.content?.[0]?.text || "[]";
  text = text.trim().replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
  const match = text.match(/\[[\s\S]*\]/);
  return match ? JSON.parse(match[0]) : [];
}

// ─── COMPONENTS ──────────────────────────────────────────────
function StatusPill({ status }) {
  const map = {
    idle: ["Ready", "#27272a", "#a1a1aa"],
    loading: ["Loading PDF…", "#422006", "#fbbf24"],
    extracting: ["AI Extracting…", "#1e1b4b", "#818cf8"],
    done: ["Complete", "#052e16", "#34d399"],
    error: ["Error", "#2a1515", "#f87171"],
  };
  const [label, bg, fg] = map[status] || map.idle;
  return (
    <span style={{ background: bg, color: fg, padding: "5px 14px", borderRadius: 99, fontSize: 12, fontWeight: 600 }}>
      {label}
    </span>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("dp_api_key") || "");
  const [showKey, setShowKey] = useState(!localStorage.getItem("dp_api_key"));
  const [status, setStatus] = useState("idle");
  const [log, setLog] = useState([]);
  const [dataPoints, setDataPoints] = useState([]);
  const [removed, setRemoved] = useState(new Set());
  const [progress, setProgress] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [fileName, setFileName] = useState("");
  const [fileObj, setFileObj] = useState(null);
  const [search, setSearch] = useState("");
  const [batchSize, setBatchSize] = useState(10);
  const logRef = useRef(null);

  const addLog = useCallback((msg) => {
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const saveKey = () => {
    localStorage.setItem("dp_api_key", apiKey);
    setShowKey(false);
    addLog("API key saved");
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setFileObj(file);
    setDataPoints([]);
    setRemoved(new Set());
    setProgress(0);
    setLog([]);
    addLog(`Loaded: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
  };

  const run = async () => {
    if (!fileObj || !apiKey) {
      addLog("⚠ Need a file and API key");
      return;
    }

    setStatus("loading");
    setDataPoints([]);
    setRemoved(new Set());
    addLog("Reading PDF…");

    try {
      // Extract text + get page count
      const { numPages } = await extractPdfText(fileObj);
      setTotalPages(numPages);
      addLog(`PDF has ${numPages} pages`);

      // Convert to base64
      addLog("Preparing document for AI…");
      const base64 = await fileToBase64(fileObj);

      setStatus("extracting");
      const allPoints = [];
      const bs = batchSize;

      for (let start = 1; start <= numPages; start += bs) {
        const end = Math.min(start + bs - 1, numPages);
        const pct = Math.round((start / numPages) * 100);
        setProgress(pct);
        addLog(`Processing pages ${start}–${end}…`);

        try {
          const points = await classifyPages(base64, start, end, apiKey);
          const tagged = points.map((p, i) => ({
            ...p,
            id: `${start}_${i}`,
          }));
          allPoints.push(...tagged);
          addLog(`  → ${points.length} data points found`);
        } catch (err) {
          addLog(`  ✗ Error on pages ${start}–${end}: ${err.message}`);
          // If rate limited, wait and retry once
          if (err.message.includes("429") || err.message.includes("rate")) {
            addLog("  ⏳ Rate limited — waiting 30s…");
            await new Promise((r) => setTimeout(r, 30000));
            try {
              const points = await classifyPages(base64, start, end, apiKey);
              const tagged = points.map((p, i) => ({ ...p, id: `retry_${start}_${i}` }));
              allPoints.push(...tagged);
              addLog(`  → Retry: ${points.length} data points`);
            } catch (retryErr) {
              addLog(`  ✗ Retry failed: ${retryErr.message}`);
            }
          }
        }

        // Small delay to avoid rate limits
        await new Promise((r) => setTimeout(r, 1500));
      }

      setDataPoints(allPoints);
      setProgress(100);
      setStatus("done");
      addLog(`\n✓ Complete: ${allPoints.length} data points extracted`);
    } catch (err) {
      setStatus("error");
      addLog(`✗ ${err.message}`);
    }
  };

  const toggle = (id) => {
    setRemoved((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const activePoints = dataPoints.filter(
    (dp) =>
      !removed.has(dp.id) &&
      (!search ||
        dp.value?.toLowerCase().includes(search.toLowerCase()) ||
        dp.context?.toLowerCase().includes(search.toLowerCase()) ||
        String(dp.page).includes(search))
  );

  const exportCSV = () => {
    const points = dataPoints.filter((dp) => !removed.has(dp.id));
    const rows = [
      ["#", "Page", "Data Point", "Context"].join(","),
      ...points.map((dp, i) => {
        const v = `"${(dp.value || "").replace(/"/g, '""')}"`;
        const c = `"${(dp.context || "").replace(/"/g, '""')}"`;
        return [i + 1, dp.page, v, c].join(",");
      }),
    ];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${fileName.replace(/\.[^.]+$/, "")}_DataPoints.csv`;
    a.click();
  };

  const exportJSON = () => {
    const points = dataPoints.filter((dp) => !removed.has(dp.id));
    const blob = new Blob([JSON.stringify(points, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${fileName.replace(/\.[^.]+$/, "")}_DataPoints.json`;
    a.click();
  };

  // ─── RENDER ──────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#09090b" }}>
      {/* ── HEADER ── */}
      <header
        style={{
          background: "linear-gradient(135deg,#0c0a1d 0%,#1a103a 40%,#0c0a1d 100%)",
          borderBottom: "1px solid #1e1b3a",
          padding: "20px 0",
        }}
      >
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.03em", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: "#818cf8", fontSize: 22 }}>◆</span>
              Data Point Extractor
            </h1>
            <p style={{ fontSize: 12, color: "#52525b", marginTop: 2 }}>Python + AI extraction for sustainability &amp; annual reports</p>
          </div>
          <StatusPill status={status} />
        </div>
      </header>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "20px 24px" }}>
        {/* ── API KEY ── */}
        {showKey && (
          <div style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#71717a", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Anthropic API Key
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                style={{
                  flex: 1, background: "#0f0f14", border: "1px solid #27272a", borderRadius: 8,
                  padding: "8px 12px", color: "#e4e4e7", fontSize: 13, outline: "none",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              />
              <button onClick={saveKey} style={{
                padding: "8px 20px", borderRadius: 8, border: "none",
                background: "#4f46e5", color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer",
              }}>
                Save
              </button>
            </div>
            <p style={{ fontSize: 11, color: "#3f3f46", marginTop: 6 }}>Stored in browser localStorage only. Never sent anywhere except Anthropic's API.</p>
          </div>
        )}

        {!showKey && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
            <button onClick={() => setShowKey(true)} style={{
              background: "none", border: "none", color: "#52525b", fontSize: 11, cursor: "pointer", textDecoration: "underline",
            }}>
              Change API key
            </button>
          </div>
        )}

        {/* ── CONTROLS ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          {/* File */}
          <div style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#52525b", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Document
            </div>
            <label style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: "14px", borderRadius: 8, cursor: "pointer",
              background: fileName ? "#1e1b4b" : "#111114",
              border: `1px dashed ${fileName ? "#4f46e5" : "#27272a"}`,
              transition: "all 0.2s", fontSize: 13,
              color: fileName ? "#c7d2fe" : "#52525b",
            }}>
              <input type="file" accept=".pdf" onChange={handleFile} style={{ display: "none" }} />
              {fileName ? `📄 ${fileName}` : "Click or drop a PDF here"}
            </label>
            {totalPages > 0 && <div style={{ fontSize: 11, color: "#52525b", marginTop: 6 }}>{totalPages} pages</div>}
          </div>

          {/* Actions */}
          <div style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#52525b", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Extract
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button
                onClick={run}
                disabled={!fileObj || !apiKey || status === "extracting" || status === "loading"}
                style={{
                  flex: 1, padding: "10px 16px", borderRadius: 8, border: "none", fontWeight: 600, fontSize: 13,
                  background: fileObj && apiKey ? "linear-gradient(135deg,#4f46e5,#7c3aed)" : "#27272a",
                  color: fileObj && apiKey ? "#fff" : "#52525b",
                  cursor: fileObj && apiKey ? "pointer" : "not-allowed",
                }}
              >
                {status === "extracting" ? `Processing… ${progress}%` : status === "loading" ? "Loading…" : "Extract Data Points"}
              </button>
            </div>
            {/* Batch size control */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#52525b" }}>
              <span>Pages per batch:</span>
              <select
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
                style={{ background: "#0f0f14", border: "1px solid #27272a", borderRadius: 6, padding: "3px 8px", color: "#a1a1aa", fontSize: 12 }}
              >
                {[5, 10, 15, 20].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <span style={{ color: "#3f3f46" }}>Smaller = more accurate, slower</span>
            </div>
            {/* Progress */}
            {(status === "extracting" || status === "loading") && (
              <div style={{ marginTop: 8, background: "#27272a", borderRadius: 4, height: 5, overflow: "hidden" }}>
                <div style={{ height: "100%", background: "linear-gradient(90deg,#4f46e5,#7c3aed)", width: `${progress}%`, transition: "width 0.4s" }} />
              </div>
            )}
          </div>
        </div>

        {/* ── STATS ── */}
        {dataPoints.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
            {[
              { l: "Data Points", v: dataPoints.length - removed.size, c: "#818cf8" },
              { l: "Pages Covered", v: new Set(dataPoints.filter((d) => !removed.has(d.id)).map((d) => d.page)).size, c: "#34d399" },
              { l: "Removed", v: removed.size, c: "#f87171" },
              { l: "Showing", v: activePoints.length, c: "#fbbf24" },
            ].map(({ l, v, c }) => (
              <div key={l} style={{ background: "#18181b", border: "1px solid #1f1f23", borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ fontSize: 10, color: "#52525b", textTransform: "uppercase", letterSpacing: "0.06em" }}>{l}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: c, marginTop: 2 }}>{v}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── LOG ── */}
        <div
          ref={logRef}
          style={{
            background: "#0c0c10", border: "1px solid #1f1f23", borderRadius: 8,
            padding: 12, marginBottom: 16, maxHeight: 150, overflowY: "auto",
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11, lineHeight: 1.7, color: "#52525b",
          }}
        >
          {log.length === 0 ? (
            <span style={{ color: "#27272a" }}>Upload a PDF and click Extract…</span>
          ) : (
            log.map((l, i) => (
              <div key={i} style={{ color: l.includes("✓") ? "#34d399" : l.includes("⚠") ? "#fbbf24" : l.includes("✗") ? "#f87171" : l.includes("→") ? "#818cf8" : "#52525b" }}>
                {l}
              </div>
            ))
          )}
        </div>

        {/* ── RESULTS ── */}
        {dataPoints.length > 0 && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600 }}>Results</h2>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  placeholder="Search…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{
                    background: "#0f0f14", border: "1px solid #27272a", borderRadius: 6,
                    padding: "5px 10px", color: "#a1a1aa", fontSize: 12, width: 180, outline: "none",
                  }}
                />
                <button onClick={exportCSV} style={{
                  padding: "5px 12px", borderRadius: 6, border: "1px solid #27272a",
                  background: "transparent", color: "#71717a", fontSize: 12, cursor: "pointer",
                }}>
                  CSV ↓
                </button>
                <button onClick={exportJSON} style={{
                  padding: "5px 12px", borderRadius: 6, border: "1px solid #27272a",
                  background: "transparent", color: "#71717a", fontSize: 12, cursor: "pointer",
                }}>
                  JSON ↓
                </button>
              </div>
            </div>

            <div style={{ background: "#18181b", border: "1px solid #1f1f23", borderRadius: 10, overflow: "hidden" }}>
              {/* Header */}
              <div style={{
                display: "grid", gridTemplateColumns: "44px 52px 1fr 2fr 56px",
                padding: "8px 14px", background: "#111114", borderBottom: "1px solid #1f1f23",
                fontSize: 10, fontWeight: 600, color: "#52525b", textTransform: "uppercase", letterSpacing: "0.06em",
              }}>
                <div>#</div><div>Page</div><div>Data Point</div><div>Context</div><div style={{ textAlign: "center" }}>Keep</div>
              </div>

              {/* Rows */}
              <div style={{ maxHeight: 480, overflowY: "auto" }}>
                {activePoints.length === 0 && (
                  <div style={{ padding: 24, textAlign: "center", color: "#3f3f46", fontSize: 13 }}>
                    {search ? "No results match your search" : "No data points"}
                  </div>
                )}
                {activePoints.map((dp, idx) => {
                  const isRemoved = removed.has(dp.id);
                  return (
                    <div
                      key={dp.id}
                      style={{
                        display: "grid", gridTemplateColumns: "44px 52px 1fr 2fr 56px",
                        padding: "7px 14px", borderBottom: "1px solid #141418",
                        fontSize: 12, background: idx % 2 === 0 ? "transparent" : "#0f0f14",
                        opacity: isRemoved ? 0.25 : 1, transition: "opacity 0.2s",
                      }}
                    >
                      <div style={{ color: "#3f3f46" }}>{idx + 1}</div>
                      <div style={{ color: "#818cf8", fontWeight: 600 }}>{dp.page}</div>
                      <div style={{ color: "#e4e4e7", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{dp.value}</div>
                      <div style={{ color: "#71717a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{dp.context}</div>
                      <div style={{ textAlign: "center" }}>
                        <button
                          onClick={() => toggle(dp.id)}
                          style={{
                            width: 26, height: 26, borderRadius: 6,
                            border: `1px solid ${isRemoved ? "#3f2020" : "#1a3a1a"}`,
                            background: isRemoved ? "#1a1010" : "#101a10",
                            color: isRemoved ? "#f87171" : "#34d399",
                            cursor: "pointer", fontSize: 13,
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                          }}
                        >
                          {isRemoved ? "✗" : "✓"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
