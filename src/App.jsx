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

YES — data points: Percentages, Counts, Monetary, Environmental metrics, Ratios, Targets

NO — not data points: Years/dates, Page/section numbers, ISO/standard numbers, Classification labels (Scope 1, Class 3, SDG 13), Product models, Footnote markers, GRI/SASB codes, Addresses, Datasheet raw tables, Structural numbers

Return ONLY a JSON array of objects for items that ARE data points:
[{"id": 5, "cat": "E"}, {"id": 8, "cat": "S"}, ...]
Only include data points. Omit non-data-points. No markdown. No explanation.`;

// ─── EXTRACTION ──────────────────────────────────────────────
const NUM_RE = /(\d+(?:,\d{3})*(?:\.\d+)?)/g;
const ALL_YEARS = new Set();
for (let y = 1900; y < 2060; y++) ALL_YEARS.add(y);

function isObviousExclusion(numVal, numText, text, pos) {
  if (numVal === 0) return true;
  if (pos > 0 && text[pos - 1] === "*") return true;
  if (!numText.includes(",") && /^\d{4}$/.test(numText) && ALL_YEARS.has(parseInt(numText))) return true;
  const b3 = text.substring(Math.max(0, pos - 3), pos).toUpperCase();
  if (b3.includes("FY")) return true;
  if (pos > 0 && /[A-Za-z]/.test(text[pos - 1]) && /^\d{4,}$/.test(numText)) return true;
  const b40 = text.substring(Math.max(0, pos - 40), pos);
  if (/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+$/i.test(b40) && numVal <= 31) return true;
  return false;
}

function getSentence(text, pos) {
  let s = pos, e = pos;
  while (s > 0 && !/[.!?\n]/.test(text[s - 1])) s--;
  while (e < text.length && !/[.!?\n]/.test(text[e])) e++;
  if (e < text.length) e++;
  return text.substring(s, e).replace(/\s+/g, " ").trim();
}

async function extractCandidates(file, onProgress) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const cands = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const content = await pg.getTextContent();
    const text = content.items.map((it) => it.str).join(" ");
    let m; NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(text)) !== null) {
      const nt = m[1], nc = nt.replace(/,/g, ""), pos = m.index, nv = parseFloat(nc);
      if (isNaN(nv) || isObviousExclusion(nv, nt, text, pos)) continue;
      cands.push({ id: cands.length, page: i, number: nt, numberClean: nc, sentence: getSentence(text, pos) });
    }
    if (onProgress) onProgress({ page: i, total: pdf.numPages, candidates: cands.length });
  }
  return { candidates: cands, numPages: pdf.numPages };
}

// ─── AI CLASSIFICATION ───────────────────────────────────────
async function classifyBatch(batch, apiKey) {
  const lines = batch.map((c) => `ID:${c.id} | ${c.number} | "${c.sentence.substring(0, 250)}"`);
  const userMsg = "Classify these. Return JSON array of {id, cat} for data points only.\n\n" + lines.join("\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000, system: SYSTEM_PROMPT, messages: [{ role: "user", content: userMsg }] }),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`API ${res.status}: ${err.substring(0, 200)}`); }
  const data = await res.json();
  let text = data.content?.[0]?.text || "[]";
  text = text.trim().replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
  const match = text.match(/\[[\s\S]*?\]/);
  if (match) {
    try {
      return JSON.parse(match[0]).map((item) => ({
        id: typeof item === "number" ? item : item.id,
        cat: (typeof item === "object" && item.cat) ? item.cat.toUpperCase() : "O",
      }));
    } catch { return []; }
  }
  return [];
}

// ─── CATEGORY CONFIG ─────────────────────────────────────────
const CAT = {
  E: { label: "Environment", full: "Environment", color: "#34d399", bg: "#052e16", border: "#064e3b", ring: "#10b981" },
  S: { label: "Social", full: "Social", color: "#60a5fa", bg: "#172554", border: "#1e3a5f", ring: "#3b82f6" },
  G: { label: "Governance", full: "Governance", color: "#c084fc", bg: "#2e1065", border: "#4c1d95", ring: "#a855f7" },
  O: { label: "Other", full: "Other", color: "#a1a1aa", bg: "#1c1c1e", border: "#3f3f46", ring: "#71717a" },
};

function CatBadge({ cat }) {
  const m = CAT[cat] || CAT.O;
  return <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: m.bg, color: m.color, border: `1px solid ${m.border}`, letterSpacing: "0.04em" }}>{m.label}</span>;
}

// ─── PIE CHART COMPONENT ─────────────────────────────────────
function PieChart({ counts, total }) {
  const cats = ["E", "S", "G", "O"];
  const size = 200, cx = 100, cy = 100, r = 80, ir = 48;

  let cumAngle = -Math.PI / 2;
  const slices = cats.map((c) => {
    const pct = total > 0 ? counts[c] / total : 0;
    const angle = pct * 2 * Math.PI;
    const startAngle = cumAngle;
    cumAngle += angle;
    const endAngle = cumAngle;
    const largeArc = angle > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle);
    const ix1 = cx + ir * Math.cos(startAngle), iy1 = cy + ir * Math.sin(startAngle);
    const ix2 = cx + ir * Math.cos(endAngle), iy2 = cy + ir * Math.sin(endAngle);
    const d = pct > 0.001 ? `M${x1},${y1} A${r},${r} 0 ${largeArc} 1 ${x2},${y2} L${ix2},${iy2} A${ir},${ir} 0 ${largeArc} 0 ${ix1},${iy1} Z` : "";
    const midAngle = startAngle + angle / 2;
    const labelR = (r + ir) / 2;
    const lx = cx + labelR * Math.cos(midAngle), ly = cy + labelR * Math.sin(midAngle);
    return { c, pct, d, lx, ly, color: CAT[c].ring };
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 32, padding: "16px 0" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {slices.map((s) => s.d && (
          <path key={s.c} d={s.d} fill={s.color} opacity={0.85} stroke="#09090b" strokeWidth={2} />
        ))}
        <text x={cx} y={cy - 6} textAnchor="middle" fill="#e4e4e7" fontSize="22" fontWeight="700" fontFamily="DM Sans,sans-serif">{total}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" fill="#52525b" fontSize="10" fontFamily="DM Sans,sans-serif">DATA POINTS</text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {cats.map((c) => {
          const pct = total > 0 ? ((counts[c] / total) * 100).toFixed(1) : "0.0";
          return (
            <div key={c} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 14, height: 14, borderRadius: 3, background: CAT[c].ring, flexShrink: 0 }} />
              <div style={{ minWidth: 90 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: CAT[c].color }}>{CAT[c].full}</div>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#e4e4e7", minWidth: 50, textAlign: "right" }}>{counts[c]}</div>
              <div style={{ fontSize: 13, color: "#52525b", minWidth: 50 }}>{pct}%</div>
              {/* Mini bar */}
              <div style={{ width: 120, height: 8, background: "#1f1f23", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ height: "100%", background: CAT[c].ring, width: `${pct}%`, borderRadius: 4, transition: "width 0.5s" }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── EXCEL EXPORT ────────────────────────────────────────────
function generateExcelXML(dataPoints, catCounts, total, fileName) {
  // Generate a proper Excel XML Spreadsheet with formatting, filters, and multiple sheets
  const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const catLabel = { E: "Environment", S: "Social", G: "Governance", O: "Other" };

  // Sort by page then by category
  const sorted = [...dataPoints].sort((a, b) => a.page - b.page || a.cat.localeCompare(b.cat));

  let xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
 <Style ss:ID="header"><Font ss:Bold="1" ss:Size="11" ss:Color="#FFFFFF" ss:FontName="Arial"/><Interior ss:Color="#003366" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
 <Style ss:ID="num"><NumberFormat ss:Format="#,##0"/><Font ss:FontName="Arial" ss:Size="10"/></Style>
 <Style ss:ID="text"><Font ss:FontName="Arial" ss:Size="10"/><Alignment ss:WrapText="1" ss:Vertical="Top"/></Style>
 <Style ss:ID="cat_E"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#059669"/><Interior ss:Color="#D1FAE5" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center"/></Style>
 <Style ss:ID="cat_S"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#2563EB"/><Interior ss:Color="#DBEAFE" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center"/></Style>
 <Style ss:ID="cat_G"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#7C3AED"/><Interior ss:Color="#EDE9FE" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center"/></Style>
 <Style ss:ID="cat_O"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#6B7280"/><Interior ss:Color="#F3F4F6" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center"/></Style>
 <Style ss:ID="title"><Font ss:Bold="1" ss:Size="16" ss:FontName="Arial" ss:Color="#1E3A5F"/></Style>
 <Style ss:ID="subtitle"><Font ss:Size="11" ss:FontName="Arial" ss:Color="#6B7280" ss:Italic="1"/></Style>
 <Style ss:ID="sum_label"><Font ss:Bold="1" ss:Size="11" ss:FontName="Arial"/></Style>
 <Style ss:ID="sum_val"><Font ss:Bold="1" ss:Size="14" ss:FontName="Arial" ss:Color="#4F46E5"/><Alignment ss:Horizontal="Center"/></Style>
 <Style ss:ID="pct"><Font ss:Size="11" ss:FontName="Arial"/><NumberFormat ss:Format="0.0%"/><Alignment ss:Horizontal="Center"/></Style>
 <Style ss:ID="center"><Font ss:FontName="Arial" ss:Size="10"/><Alignment ss:Horizontal="Center"/></Style>
</Styles>

<Worksheet ss:Name="Data Points">
 <Table ss:DefaultRowHeight="18">
  <Column ss:Width="35"/><Column ss:Width="50"/><Column ss:Width="110"/><Column ss:Width="90"/><Column ss:Width="650"/>
  <Row ss:AutoFitHeight="0" ss:Height="28">
   <Cell ss:StyleID="header"><Data ss:Type="String">#</Data></Cell>
   <Cell ss:StyleID="header"><Data ss:Type="String">Page</Data></Cell>
   <Cell ss:StyleID="header"><Data ss:Type="String">Data Point</Data></Cell>
   <Cell ss:StyleID="header"><Data ss:Type="String">Category</Data></Cell>
   <Cell ss:StyleID="header"><Data ss:Type="String">Sentence</Data></Cell>
  </Row>`;

  sorted.forEach((dp, i) => {
    const catStyle = `cat_${dp.cat}`;
    xml += `
  <Row ss:AutoFitHeight="1">
   <Cell ss:StyleID="center"><Data ss:Type="Number">${i + 1}</Data></Cell>
   <Cell ss:StyleID="center"><Data ss:Type="Number">${dp.page}</Data></Cell>
   <Cell ss:StyleID="num"><Data ss:Type="String">${escXml(dp.number)}</Data></Cell>
   <Cell ss:StyleID="${catStyle}"><Data ss:Type="String">${catLabel[dp.cat] || "Other"}</Data></Cell>
   <Cell ss:StyleID="text"><Data ss:Type="String">${escXml(dp.sentence.substring(0, 500))}</Data></Cell>
  </Row>`;
  });

  xml += `
 </Table>
 <AutoFilter x:Range="R1C1:R${sorted.length + 1}C5" xmlns="urn:schemas-microsoft-com:office:excel"/>
</Worksheet>

<Worksheet ss:Name="Summary">
 <Table>
  <Column ss:Width="200"/><Column ss:Width="100"/><Column ss:Width="100"/>
  <Row ss:Height="30"><Cell ss:StyleID="title"><Data ss:Type="String">Data Point Extraction — Summary</Data></Cell></Row>
  <Row ss:Height="20"><Cell ss:StyleID="subtitle"><Data ss:Type="String">${escXml(fileName)}</Data></Cell></Row>
  <Row/>
  <Row><Cell ss:StyleID="sum_label"><Data ss:Type="String">Category</Data></Cell><Cell ss:StyleID="sum_label"><Data ss:Type="String">Count</Data></Cell><Cell ss:StyleID="sum_label"><Data ss:Type="String">Percentage</Data></Cell></Row>`;

  ["E", "S", "G", "O"].forEach((c) => {
    xml += `
  <Row>
   <Cell ss:StyleID="cat_${c}"><Data ss:Type="String">${catLabel[c]}</Data></Cell>
   <Cell ss:StyleID="sum_val"><Data ss:Type="Number">${catCounts[c]}</Data></Cell>
   <Cell ss:StyleID="pct"><Data ss:Type="Number">${total > 0 ? catCounts[c] / total : 0}</Data></Cell>
  </Row>`;
  });

  xml += `
  <Row/>
  <Row><Cell ss:StyleID="sum_label"><Data ss:Type="String">Total Data Points</Data></Cell><Cell ss:StyleID="sum_val"><Data ss:Type="Number">${total}</Data></Cell></Row>
 </Table>
</Worksheet>

<Worksheet ss:Name="By Category — Environment">
 <Table ss:DefaultRowHeight="18">
  <Column ss:Width="35"/><Column ss:Width="50"/><Column ss:Width="110"/><Column ss:Width="650"/>
  <Row ss:Height="28"><Cell ss:StyleID="header"><Data ss:Type="String">#</Data></Cell><Cell ss:StyleID="header"><Data ss:Type="String">Page</Data></Cell><Cell ss:StyleID="header"><Data ss:Type="String">Data Point</Data></Cell><Cell ss:StyleID="header"><Data ss:Type="String">Sentence</Data></Cell></Row>`;
  sorted.filter(d => d.cat === "E").forEach((dp, i) => {
    xml += `<Row><Cell ss:StyleID="center"><Data ss:Type="Number">${i+1}</Data></Cell><Cell ss:StyleID="center"><Data ss:Type="Number">${dp.page}</Data></Cell><Cell ss:StyleID="num"><Data ss:Type="String">${escXml(dp.number)}</Data></Cell><Cell ss:StyleID="text"><Data ss:Type="String">${escXml(dp.sentence.substring(0,500))}</Data></Cell></Row>`;
  });
  xml += `</Table><AutoFilter x:Range="R1C1:R${sorted.filter(d=>d.cat==="E").length+1}C4" xmlns="urn:schemas-microsoft-com:office:excel"/></Worksheet>`;

  xml += `
<Worksheet ss:Name="By Category — Social">
 <Table ss:DefaultRowHeight="18">
  <Column ss:Width="35"/><Column ss:Width="50"/><Column ss:Width="110"/><Column ss:Width="650"/>
  <Row ss:Height="28"><Cell ss:StyleID="header"><Data ss:Type="String">#</Data></Cell><Cell ss:StyleID="header"><Data ss:Type="String">Page</Data></Cell><Cell ss:StyleID="header"><Data ss:Type="String">Data Point</Data></Cell><Cell ss:StyleID="header"><Data ss:Type="String">Sentence</Data></Cell></Row>`;
  sorted.filter(d => d.cat === "S").forEach((dp, i) => {
    xml += `<Row><Cell ss:StyleID="center"><Data ss:Type="Number">${i+1}</Data></Cell><Cell ss:StyleID="center"><Data ss:Type="Number">${dp.page}</Data></Cell><Cell ss:StyleID="num"><Data ss:Type="String">${escXml(dp.number)}</Data></Cell><Cell ss:StyleID="text"><Data ss:Type="String">${escXml(dp.sentence.substring(0,500))}</Data></Cell></Row>`;
  });
  xml += `</Table><AutoFilter x:Range="R1C1:R${sorted.filter(d=>d.cat==="S").length+1}C4" xmlns="urn:schemas-microsoft-com:office:excel"/></Worksheet>`;

  xml += `
<Worksheet ss:Name="By Category — Governance">
 <Table ss:DefaultRowHeight="18">
  <Column ss:Width="35"/><Column ss:Width="50"/><Column ss:Width="110"/><Column ss:Width="650"/>
  <Row ss:Height="28"><Cell ss:StyleID="header"><Data ss:Type="String">#</Data></Cell><Cell ss:StyleID="header"><Data ss:Type="String">Page</Data></Cell><Cell ss:StyleID="header"><Data ss:Type="String">Data Point</Data></Cell><Cell ss:StyleID="header"><Data ss:Type="String">Sentence</Data></Cell></Row>`;
  sorted.filter(d => d.cat === "G").forEach((dp, i) => {
    xml += `<Row><Cell ss:StyleID="center"><Data ss:Type="Number">${i+1}</Data></Cell><Cell ss:StyleID="center"><Data ss:Type="Number">${dp.page}</Data></Cell><Cell ss:StyleID="num"><Data ss:Type="String">${escXml(dp.number)}</Data></Cell><Cell ss:StyleID="text"><Data ss:Type="String">${escXml(dp.sentence.substring(0,500))}</Data></Cell></Row>`;
  });
  xml += `</Table><AutoFilter x:Range="R1C1:R${sorted.filter(d=>d.cat==="G").length+1}C4" xmlns="urn:schemas-microsoft-com:office:excel"/></Worksheet>`;

  xml += `
<Worksheet ss:Name="By Category — Other">
 <Table ss:DefaultRowHeight="18">
  <Column ss:Width="35"/><Column ss:Width="50"/><Column ss:Width="110"/><Column ss:Width="650"/>
  <Row ss:Height="28"><Cell ss:StyleID="header"><Data ss:Type="String">#</Data></Cell><Cell ss:StyleID="header"><Data ss:Type="String">Page</Data></Cell><Cell ss:StyleID="header"><Data ss:Type="String">Data Point</Data></Cell><Cell ss:StyleID="header"><Data ss:Type="String">Sentence</Data></Cell></Row>`;
  sorted.filter(d => d.cat === "O").forEach((dp, i) => {
    xml += `<Row><Cell ss:StyleID="center"><Data ss:Type="Number">${i+1}</Data></Cell><Cell ss:StyleID="center"><Data ss:Type="Number">${dp.page}</Data></Cell><Cell ss:StyleID="num"><Data ss:Type="String">${escXml(dp.number)}</Data></Cell><Cell ss:StyleID="text"><Data ss:Type="String">${escXml(dp.sentence.substring(0,500))}</Data></Cell></Row>`;
  });
  xml += `</Table><AutoFilter x:Range="R1C1:R${sorted.filter(d=>d.cat==="O").length+1}C4" xmlns="urn:schemas-microsoft-com:office:excel"/></Worksheet>`;

  xml += `</Workbook>`;
  return xml;
}

// ─── MAIN APP ────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("dp_key") || "");
  const [showKey, setShowKey] = useState(!localStorage.getItem("dp_key"));
  const [status, setStatus] = useState("idle");
  const [log, setLog] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [dpMap, setDpMap] = useState(new Map());
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
    setStatus("stage1");
    addLog("STAGE 1: Extracting text and finding candidates...");
    try {
      const { candidates: cands, numPages } = await extractCandidates(fileObj, ({ page, total, candidates: cnt }) => {
        setProgress({ stage: "Extracting", pct: Math.round((page / total) * 100), detail: `Page ${page}/${total} — ${cnt} candidates` });
      });
      setCandidates(cands); setTotalPages(numPages);
      addLog(`Stage 1 done: ${cands.length} candidates from ${numPages} pages`);
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
          const cc = {}; results.forEach(({ cat }) => { cc[cat] = (cc[cat] || 0) + 1; });
          const bd = Object.entries(cc).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(" ");
          addLog(`    → ${results.length} data points (${bd})`);
        } catch (err) {
          addLog(`    ✗ ${err.message}`);
          if (err.message.includes("429") || err.message.toLowerCase().includes("rate")) {
            addLog("    Waiting 60s...");
            await new Promise((r) => setTimeout(r, 60000));
            try { const res = await classifyBatch(batch, apiKey); res.forEach(({ id, cat }) => newMap.set(id, cat)); addLog(`    → Retry: ${res.length}`); } catch (e2) { addLog(`    ✗ ${e2.message}`); }
          }
        }
        setDpMap(new Map(newMap));
        await new Promise((r) => setTimeout(r, 5000));
      }
      setDpMap(newMap); setStatus("done");
      const fc = { E: 0, S: 0, G: 0, O: 0 }; newMap.forEach((c) => { fc[c] = (fc[c] || 0) + 1; });
      addLog(`\nDone: ${newMap.size} data points — E:${fc.E} S:${fc.S} G:${fc.G} O:${fc.O}`);
    } catch (err) { setStatus("error"); addLog(`Error: ${err.message}`); }
  };

  // Derived
  const dataPoints = candidates.filter((c) => dpMap.has(c.id) && !removed.has(c.id)).map((c) => ({ ...c, cat: dpMap.get(c.id) })).sort((a, b) => a.page - b.page);
  const filtered = dataPoints.filter((d) => {
    if (catFilter !== "ALL" && d.cat !== catFilter) return false;
    if (search) { const q = search.toLowerCase(); return d.number.includes(search) || d.sentence.toLowerCase().includes(q) || String(d.page).includes(search); }
    return true;
  });
  const toggle = (id) => setRemoved((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const cc = { E: 0, S: 0, G: 0, O: 0 }; dataPoints.forEach((d) => { cc[d.cat] = (cc[d.cat] || 0) + 1; });
  const total = dataPoints.length;

  const exportCSV = () => {
    const rows = ["#,Page,Data Point,Category,Sentence", ...dataPoints.map((d, i) => `${i + 1},${d.page},"${d.number}",${CAT[d.cat]?.full || "Other"},"${d.sentence.replace(/"/g, '""')}"`)];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${fileName.replace(/\.[^.]+$/, "")}_DataPoints.csv`; a.click();
  };
  const exportExcel = () => {
    const xml = generateExcelXML(dataPoints, cc, total, fileName);
    const blob = new Blob([xml], { type: "application/vnd.ms-excel" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${fileName.replace(/\.[^.]+$/, "")}_DataPoints.xls`; a.click();
  };
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(dataPoints, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${fileName.replace(/\.[^.]+$/, "")}_DataPoints.json`; a.click();
  };

  const sMap = { idle: ["Ready", "#27272a", "#a1a1aa"], stage1: ["Extracting...", "#422006", "#fbbf24"], stage2: ["AI Classifying...", "#1e1b4b", "#818cf8"], done: ["Complete", "#052e16", "#34d399"], error: ["Error", "#2a1515", "#f87171"] };
  const [sL, sB, sF] = sMap[status] || sMap.idle;

  return (
    <div style={{ minHeight: "100vh", background: "#09090b", fontFamily: "'DM Sans','Segoe UI',sans-serif", color: "#e4e4e7" }}>
      <header style={{ background: "linear-gradient(135deg,#0c0a1d,#1a103a,#0c0a1d)", borderBottom: "1px solid #1e1b3a", padding: "20px 0" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700 }}><span style={{ color: "#818cf8" }}>◆</span> Data Point Extractor</h1>
            <p style={{ fontSize: 12, color: "#52525b", marginTop: 2 }}>Extract → Classify → Categorise (ESG) → Export</p>
          </div>
          <span style={{ background: sB, color: sF, padding: "5px 14px", borderRadius: 99, fontSize: 12, fontWeight: 600 }}>{sL}</span>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 24px" }}>
        {/* API Key */}
        {showKey && (
          <div style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#52525b", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Anthropic API Key</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-..." style={{ flex: 1, background: "#0f0f14", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", color: "#e4e4e7", fontSize: 13, outline: "none", fontFamily: "monospace" }} />
              <button onClick={saveKey} style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: "#4f46e5", color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Save</button>
            </div>
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
            <button onClick={run} disabled={!fileObj || !apiKey || status === "stage1" || status === "stage2"} style={{ width: "100%", padding: "10px", borderRadius: 8, border: "none", fontWeight: 600, fontSize: 13, background: fileObj && apiKey ? "linear-gradient(135deg,#4f46e5,#7c3aed)" : "#27272a", color: fileObj && apiKey ? "#fff" : "#52525b", cursor: fileObj && apiKey ? "pointer" : "not-allowed", marginBottom: 8 }}>
              {status === "stage1" || status === "stage2" ? `${progress.stage}… ${progress.pct}%` : "Run Extraction"}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#52525b" }}>
              <span>Batch:</span>
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

        {/* Infographic: Pie Chart + Stats */}
        {dpMap.size > 0 && (
          <div style={{ background: "#18181b", border: "1px solid #1f1f23", borderRadius: 12, padding: "20px 28px", marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#a1a1aa", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>ESG Distribution</div>
            <PieChart counts={cc} total={total} />
          </div>
        )}

        {/* Log */}
        <div ref={logRef} style={{ background: "#0c0c10", border: "1px solid #1f1f23", borderRadius: 8, padding: 12, marginBottom: 16, maxHeight: 140, overflowY: "auto", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, lineHeight: 1.7, color: "#52525b" }}>
          {log.length === 0 ? <span style={{ color: "#27272a" }}>Upload a PDF and click Run…</span>
            : log.map((l, i) => <div key={i} style={{ color: l.includes("Done") || l.includes("done") ? "#34d399" : l.includes("✗") || l.includes("Error") ? "#f87171" : l.includes("→") ? "#818cf8" : l.includes("Waiting") ? "#fbbf24" : "#52525b" }}>{l}</div>)}
        </div>

        {/* Results Table */}
        {dpMap.size > 0 && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600 }}>Data Points ({filtered.length})</h2>
              <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                {["ALL", "E", "S", "G", "O"].map((c) => {
                  const m = c === "ALL" ? { color: "#818cf8", bg: "#1e1b4b", border: "#4f46e5" } : CAT[c];
                  const act = catFilter === c;
                  return <button key={c} onClick={() => setCatFilter(c)} style={{ padding: "3px 9px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer", background: act ? m.bg : "transparent", border: `1px solid ${act ? (m.border || m.color) : "#27272a"}`, color: act ? m.color : "#52525b" }}>
                    {c === "ALL" ? "All" : CAT[c].label}{c !== "ALL" ? ` ${cc[c]}` : ""}
                  </button>;
                })}
                <span style={{ width: 1, height: 18, background: "#27272a" }} />
                <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ background: "#0f0f14", border: "1px solid #27272a", borderRadius: 6, padding: "4px 10px", color: "#a1a1aa", fontSize: 12, width: 140, outline: "none" }} />
                <button onClick={exportExcel} style={{ padding: "4px 10px", borderRadius: 5, border: "1px solid #27272a", background: "transparent", color: "#71717a", fontSize: 11, cursor: "pointer" }}>Excel ↓</button>
                <button onClick={exportCSV} style={{ padding: "4px 10px", borderRadius: 5, border: "1px solid #27272a", background: "transparent", color: "#71717a", fontSize: 11, cursor: "pointer" }}>CSV ↓</button>
                <button onClick={exportJSON} style={{ padding: "4px 10px", borderRadius: 5, border: "1px solid #27272a", background: "transparent", color: "#71717a", fontSize: 11, cursor: "pointer" }}>JSON ↓</button>
              </div>
            </div>
            <div style={{ background: "#18181b", border: "1px solid #1f1f23", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "40px 48px 100px 85px 1fr 44px", padding: "8px 14px", background: "#111114", borderBottom: "1px solid #1f1f23", fontSize: 10, fontWeight: 600, color: "#52525b", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                <div>#</div><div>Page</div><div>Number</div><div>Category</div><div>Sentence</div><div style={{ textAlign: "center" }}>✓</div>
              </div>
              <div style={{ maxHeight: 520, overflowY: "auto" }}>
                {filtered.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "#3f3f46", fontSize: 13 }}>No results</div>}
                {filtered.map((dp, idx) => (
                  <div key={dp.id} style={{ display: "grid", gridTemplateColumns: "40px 48px 100px 85px 1fr 44px", padding: "6px 14px", borderBottom: "1px solid #141418", fontSize: 12, background: idx % 2 ? "#0f0f14" : "transparent", alignItems: "center" }}>
                    <div style={{ color: "#3f3f46" }}>{idx + 1}</div>
                    <div style={{ color: "#818cf8", fontWeight: 600 }}>{dp.page}</div>
                    <div style={{ color: "#e4e4e7", fontWeight: 500 }}>{dp.number}</div>
                    <div><CatBadge cat={dp.cat} /></div>
                    <div style={{ color: "#71717a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 11 }}>{dp.sentence}</div>
                    <div style={{ textAlign: "center" }}>
                      <button onClick={() => toggle(dp.id)} style={{ width: 22, height: 22, borderRadius: 5, border: `1px solid ${removed.has(dp.id) ? "#3f2020" : "#1a3a1a"}`, background: removed.has(dp.id) ? "#1a1010" : "#101a10", color: removed.has(dp.id) ? "#f87171" : "#34d399", cursor: "pointer", fontSize: 11, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
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
