import { useState, useRef, useCallback, useEffect } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs`;

// ─── PROMPT ──────────────────────────────────────────────────
const SYS = `You classify candidate numbers from a corporate report.
For each candidate: the number + full sentence. Decide if it's a DATA POINT, and categorise as E (Environment), S (Social), G (Governance), O (Other).

DATA POINT = measurable metric (KPI, target, achievement, count, %, monetary, environmental, ratio).
E = emissions, energy, water, waste, recycling, carbon, climate, biodiversity, MW, TJ, m³
S = employees, diversity, safety, training, community, human rights, wages, hours, donations, accessibility
G = board, directors, committees, compensation, audit, compliance, shareholders, shares, voting, ethics
O = financial (revenue, profit), general corporate, anything not clearly E/S/G

NOT data points: years/dates, page numbers, ISO standards, Scope/Class/SDG labels, product models, footnotes, GRI/SASB codes, addresses, raw table data, structural numbers.

Return ONLY JSON: [{"id":N,"cat":"E"},...]  — data points only. No markdown.`;

// ─── EXTRACTION ──────────────────────────────────────────────
const NR = /(\d+(?:,\d{3})*(?:\.\d+)?)/g;
const YRS = new Set(); for (let y = 1900; y < 2060; y++) YRS.add(y);

function skip(v, t, tx, p) {
  if (v === 0 || (p > 0 && tx[p-1] === "*")) return true;
  if (!t.includes(",") && /^\d{4}$/.test(t) && YRS.has(+t)) return true;
  if (tx.substring(Math.max(0,p-3),p).toUpperCase().includes("FY")) return true;
  if (p > 0 && /[A-Za-z]/.test(tx[p-1]) && /^\d{4,}$/.test(t)) return true;
  if (/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+$/i.test(tx.substring(Math.max(0,p-40),p)) && v <= 31) return true;
  return false;
}

function sent(tx, p) {
  let s = p, e = p;
  while (s > 0 && !/[.!?\n]/.test(tx[s-1])) s--;
  while (e < tx.length && !/[.!?\n]/.test(tx[e])) e++;
  if (e < tx.length) e++;
  return tx.substring(s, e).replace(/\s+/g, " ").trim();
}

async function extract(file, onP) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const cs = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const tx = (await pg.getTextContent()).items.map(x => x.str).join(" ");
    let m; NR.lastIndex = 0;
    while ((m = NR.exec(tx)) !== null) {
      const t = m[1], c = t.replace(/,/g,""), p = m.index, v = parseFloat(c);
      if (!isNaN(v) && !skip(v,t,tx,p)) cs.push({ id: cs.length, page: i, number: t, numberClean: c, sentence: sent(tx, p) });
    }
    if (onP) onP({ page: i, total: pdf.numPages, n: cs.length });
  }
  return { candidates: cs, numPages: pdf.numPages };
}

// ─── AI ──────────────────────────────────────────────────────
async function classify(batch, key) {
  const msg = "Classify. Return JSON [{id,cat}] for data points only.\n\n" + batch.map(c => `ID:${c.id} | ${c.number} | "${c.sentence.substring(0,250)}"`).join("\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000, system: SYS, messages: [{ role: "user", content: msg }] }),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).substring(0,200)}`);
  let tx = (await r.json()).content?.[0]?.text || "[]";
  tx = tx.trim().replace(/^```\w*\n?/,"").replace(/\n?```$/,"");
  const ma = tx.match(/\[[\s\S]*?\]/);
  if (ma) try { return JSON.parse(ma[0]).map(x => ({ id: typeof x==="number"?x:x.id, cat: (x.cat||"O").toUpperCase() })); } catch {}
  return [];
}

// ─── CATEGORY ────────────────────────────────────────────────
const C = {
  E: { l: "Environment", c: "#34d399", bg: "#052e16", bd: "#064e3b", r: "#10b981" },
  S: { l: "Social", c: "#60a5fa", bg: "#172554", bd: "#1e3a5f", r: "#3b82f6" },
  G: { l: "Governance", c: "#c084fc", bg: "#2e1065", bd: "#4c1d95", r: "#a855f7" },
  O: { l: "Other", c: "#a1a1aa", bg: "#1c1c1e", bd: "#3f3f46", r: "#71717a" },
};
const Badge = ({ cat }) => { const m = C[cat]||C.O; return <span style={{ padding:"2px 7px", borderRadius:4, fontSize:10, fontWeight:700, background:m.bg, color:m.c, border:`1px solid ${m.bd}` }}>{m.l}</span>; };

// ─── PIE ─────────────────────────────────────────────────────
function Pie({ cc, tot }) {
  const ks = ["E","S","G","O"], sz = 180, cx = 90, cy = 90, r = 72, ir = 44;
  let a = -Math.PI/2;
  const sl = ks.map(k => {
    const p = tot > 0 ? cc[k]/tot : 0, an = p*2*Math.PI, sa = a; a += an;
    const la = an > Math.PI ? 1 : 0;
    const d = p > 0.001 ? `M${cx+r*Math.cos(sa)},${cy+r*Math.sin(sa)} A${r},${r} 0 ${la} 1 ${cx+r*Math.cos(a)},${cy+r*Math.sin(a)} L${cx+ir*Math.cos(a)},${cy+ir*Math.sin(a)} A${ir},${ir} 0 ${la} 0 ${cx+ir*Math.cos(sa)},${cy+ir*Math.sin(sa)} Z` : "";
    return { k, d, color: C[k].r };
  });
  return (
    <div style={{ display:"flex", alignItems:"center", gap:28, padding:"12px 0" }}>
      <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
        {sl.map(s => s.d && <path key={s.k} d={s.d} fill={s.color} opacity={0.85} stroke="#09090b" strokeWidth={2}/>)}
        <text x={cx} y={cy-5} textAnchor="middle" fill="#e4e4e7" fontSize="20" fontWeight="700" fontFamily="sans-serif">{tot}</text>
        <text x={cx} y={cy+12} textAnchor="middle" fill="#52525b" fontSize="9" fontFamily="sans-serif">DATA POINTS</text>
      </svg>
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {ks.map(k => {
          const pct = tot > 0 ? ((cc[k]/tot)*100).toFixed(1) : "0.0";
          return <div key={k} style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ width:12, height:12, borderRadius:3, background:C[k].r, flexShrink:0 }}/>
            <div style={{ width:85, fontSize:12, fontWeight:600, color:C[k].c }}>{C[k].l}</div>
            <div style={{ fontSize:18, fontWeight:700, color:"#e4e4e7", width:44, textAlign:"right" }}>{cc[k]}</div>
            <div style={{ fontSize:12, color:"#52525b", width:48 }}>{pct}%</div>
            <div style={{ width:100, height:7, background:"#1f1f23", borderRadius:3, overflow:"hidden" }}><div style={{ height:"100%", background:C[k].r, width:`${pct}%`, borderRadius:3 }}/></div>
          </div>;
        })}
      </div>
    </div>
  );
}

// ─── EXCEL EXPORT ────────────────────────────────────────────
function makeExcel(dps, cc, tot, fn) {
  const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const cl = { E:"Environment", S:"Social", G:"Governance", O:"Other" };
  const sorted = [...dps].sort((a,b) => a.page-b.page);
  let x = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
<Style ss:ID="h"><Font ss:Bold="1" ss:Size="11" ss:Color="#FFFFFF" ss:FontName="Arial"/><Interior ss:Color="#003366" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>
<Style ss:ID="t"><Font ss:FontName="Arial" ss:Size="10"/><Alignment ss:WrapText="1" ss:Vertical="Top"/></Style>
<Style ss:ID="c"><Font ss:FontName="Arial" ss:Size="10"/><Alignment ss:Horizontal="Center"/></Style>
<Style ss:ID="cE"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#059669"/><Interior ss:Color="#D1FAE5" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center"/></Style>
<Style ss:ID="cS"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#2563EB"/><Interior ss:Color="#DBEAFE" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center"/></Style>
<Style ss:ID="cG"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#7C3AED"/><Interior ss:Color="#EDE9FE" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center"/></Style>
<Style ss:ID="cO"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#6B7280"/><Interior ss:Color="#F3F4F6" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center"/></Style>
<Style ss:ID="ti"><Font ss:Bold="1" ss:Size="16" ss:FontName="Arial" ss:Color="#1E3A5F"/></Style>
<Style ss:ID="sl"><Font ss:Bold="1" ss:Size="11" ss:FontName="Arial"/></Style>
<Style ss:ID="sv"><Font ss:Bold="1" ss:Size="14" ss:FontName="Arial" ss:Color="#4F46E5"/><Alignment ss:Horizontal="Center"/></Style>
<Style ss:ID="pct"><Font ss:Size="11" ss:FontName="Arial"/><NumberFormat ss:Format="0.0%"/><Alignment ss:Horizontal="Center"/></Style>
</Styles>`;

  // Sheet: All Data Points
  const sheet = (name, data) => {
    let s = `<Worksheet ss:Name="${esc(name)}"><Table ss:DefaultRowHeight="18">
<Column ss:Width="35"/><Column ss:Width="50"/><Column ss:Width="110"/>${name==="Data Points"?'<Column ss:Width="90"/>':"" }<Column ss:Width="650"/>
<Row ss:Height="28"><Cell ss:StyleID="h"><Data ss:Type="String">#</Data></Cell><Cell ss:StyleID="h"><Data ss:Type="String">Page</Data></Cell><Cell ss:StyleID="h"><Data ss:Type="String">Data Point</Data></Cell>${name==="Data Points"?'<Cell ss:StyleID="h"><Data ss:Type="String">Category</Data></Cell>':""}<Cell ss:StyleID="h"><Data ss:Type="String">Sentence</Data></Cell></Row>`;
    data.forEach((d,i) => {
      s += `<Row><Cell ss:StyleID="c"><Data ss:Type="Number">${i+1}</Data></Cell><Cell ss:StyleID="c"><Data ss:Type="Number">${d.page}</Data></Cell><Cell ss:StyleID="t"><Data ss:Type="String">${esc(d.number)}</Data></Cell>`;
      if (name==="Data Points") s += `<Cell ss:StyleID="c${d.cat}"><Data ss:Type="String">${cl[d.cat]||"Other"}</Data></Cell>`;
      s += `<Cell ss:StyleID="t"><Data ss:Type="String">${esc(d.sentence.substring(0,500))}</Data></Cell></Row>`;
    });
    s += `</Table><AutoFilter x:Range="R1C1:R${data.length+1}C${name==="Data Points"?5:4}" xmlns="urn:schemas-microsoft-com:office:excel"/></Worksheet>`;
    return s;
  };

  x += sheet("Data Points", sorted);

  // Summary
  x += `<Worksheet ss:Name="Summary"><Table><Column ss:Width="200"/><Column ss:Width="100"/><Column ss:Width="100"/>
<Row ss:Height="30"><Cell ss:StyleID="ti"><Data ss:Type="String">Data Point Extraction Summary</Data></Cell></Row>
<Row><Cell ss:StyleID="t"><Data ss:Type="String">${esc(fn)}</Data></Cell></Row><Row/>
<Row><Cell ss:StyleID="sl"><Data ss:Type="String">Category</Data></Cell><Cell ss:StyleID="sl"><Data ss:Type="String">Count</Data></Cell><Cell ss:StyleID="sl"><Data ss:Type="String">%</Data></Cell></Row>`;
  ["E","S","G","O"].forEach(k => { x += `<Row><Cell ss:StyleID="c${k}"><Data ss:Type="String">${cl[k]}</Data></Cell><Cell ss:StyleID="sv"><Data ss:Type="Number">${cc[k]}</Data></Cell><Cell ss:StyleID="pct"><Data ss:Type="Number">${tot?cc[k]/tot:0}</Data></Cell></Row>`; });
  x += `<Row/><Row><Cell ss:StyleID="sl"><Data ss:Type="String">Total</Data></Cell><Cell ss:StyleID="sv"><Data ss:Type="Number">${tot}</Data></Cell></Row></Table></Worksheet>`;

  // Per-category sheets
  ["E","S","G","O"].forEach(k => { x += sheet(cl[k], sorted.filter(d => d.cat===k)); });
  x += `</Workbook>`;
  return x;
}

// ─── SESSION STORAGE ─────────────────────────────────────────
function loadSessions() {
  try { return JSON.parse(localStorage.getItem("dp_sessions") || "[]"); } catch { return []; }
}
function saveSessions(s) { localStorage.setItem("dp_sessions", JSON.stringify(s)); }
function loadSession(id) {
  try { return JSON.parse(localStorage.getItem(`dp_sess_${id}`) || "null"); } catch { return null; }
}
function saveSession(id, data) { localStorage.setItem(`dp_sess_${id}`, JSON.stringify(data)); }
function deleteSessionData(id) { localStorage.removeItem(`dp_sess_${id}`); }

// ─── APP ─────────────────────────────────────────────────────
export default function App() {
  const [sessions, setSessions] = useState(loadSessions);
  const [activeId, setActiveId] = useState(null);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("dp_key") || "");
  const [showKey, setShowKey] = useState(!localStorage.getItem("dp_key"));
  const [status, setStatus] = useState("idle");
  const [log, setLog] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [dpMap, setDpMap] = useState(new Map());
  const [removed, setRemoved] = useState(new Set());
  const [progress, setProgress] = useState({ stage:"", pct:0, detail:"" });
  const [totalPages, setTotalPages] = useState(0);
  const [fileName, setFileName] = useState("");
  const [fileObj, setFileObj] = useState(null);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("ALL");
  const [batchSize, setBatchSize] = useState(25);
  const [sideOpen, setSideOpen] = useState(true);
  const logRef = useRef(null);

  const addLog = useCallback((m) => setLog(p => [...p, `[${new Date().toLocaleTimeString()}] ${m}`]), []);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  // Restore session
  useEffect(() => {
    if (!activeId) return;
    const d = loadSession(activeId);
    if (d) {
      setCandidates(d.candidates || []);
      setDpMap(new Map(d.dpEntries || []));
      setRemoved(new Set(d.removed || []));
      setTotalPages(d.totalPages || 0);
      setFileName(d.fileName || "");
      setLog(d.log || []);
      setStatus(d.status || "done");
      setFileObj(null); // Can't restore file object
    }
  }, [activeId]);

  // Auto-save active session
  const saveActive = useCallback(() => {
    if (!activeId || candidates.length === 0) return;
    saveSession(activeId, {
      candidates, dpEntries: [...dpMap.entries()], removed: [...removed],
      totalPages, fileName, log, status: status === "done" ? "done" : "idle",
    });
  }, [activeId, candidates, dpMap, removed, totalPages, fileName, log, status]);

  useEffect(() => { saveActive(); }, [saveActive]);

  const saveKey = () => { localStorage.setItem("dp_key", apiKey); setShowKey(false); addLog("API key saved"); };

  // Create new session
  const newSession = (name) => {
    const id = Date.now().toString(36);
    const sess = { id, name, date: new Date().toISOString() };
    const updated = [sess, ...sessions];
    setSessions(updated); saveSessions(updated);
    setActiveId(id);
    setCandidates([]); setDpMap(new Map()); setRemoved(new Set());
    setLog([]); setStatus("idle"); setFileName(""); setFileObj(null);
    setTotalPages(0); setSearch(""); setCatFilter("ALL");
  };

  const deleteSession = (id) => {
    const updated = sessions.filter(s => s.id !== id);
    setSessions(updated); saveSessions(updated); deleteSessionData(id);
    if (activeId === id) { setActiveId(null); setCandidates([]); setDpMap(new Map()); setLog([]); setStatus("idle"); }
  };

  const handleFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    // Auto-create session
    if (!activeId) newSession(f.name);
    else {
      // Update session name
      const updated = sessions.map(s => s.id === activeId ? { ...s, name: f.name } : s);
      setSessions(updated); saveSessions(updated);
    }
    setFileName(f.name); setFileObj(f); setCandidates([]); setDpMap(new Map()); setRemoved(new Set());
    setProgress({ stage:"", pct:0, detail:"" }); setLog([]); addLog(`Loaded: ${f.name} (${(f.size/1024/1024).toFixed(1)} MB)`);
  };

  const run = async () => {
    if (!fileObj || !apiKey) { addLog("Need file + API key"); return; }
    if (!activeId) newSession(fileName);
    setStatus("stage1"); addLog("STAGE 1: Extracting text...");
    try {
      const { candidates: cs, numPages } = await extract(fileObj, ({ page, total, n }) => {
        setProgress({ stage:"Extracting", pct: Math.round((page/total)*100), detail:`Page ${page}/${total} — ${n} candidates` });
      });
      setCandidates(cs); setTotalPages(numPages);
      addLog(`Stage 1: ${cs.length} candidates from ${numPages} pages`);
      setStatus("stage2"); addLog(`STAGE 2: AI classifying (batches of ${batchSize})...`);
      const nm = new Map();
      const tb = Math.ceil(cs.length / batchSize);
      for (let i = 0; i < cs.length; i += batchSize) {
        const b = cs.slice(i, i+batchSize), bn = Math.floor(i/batchSize)+1;
        setProgress({ stage:"Classifying", pct: Math.round((bn/tb)*100), detail:`Batch ${bn}/${tb}` });
        addLog(`  Batch ${bn}/${tb}...`);
        try {
          const res = await classify(b, apiKey);
          res.forEach(({ id, cat }) => nm.set(id, cat));
          const co = {}; res.forEach(({cat}) => { co[cat]=(co[cat]||0)+1; });
          addLog(`    → ${res.length} (${Object.entries(co).map(([k,v])=>`${k}:${v}`).join(" ")})`);
        } catch (err) {
          addLog(`    ✗ ${err.message}`);
          if (err.message.includes("429")) {
            addLog("    Waiting 60s..."); await new Promise(r=>setTimeout(r,60000));
            try { const res = await classify(b, apiKey); res.forEach(({id,cat})=>nm.set(id,cat)); addLog(`    → Retry: ${res.length}`); } catch(e2) { addLog(`    ✗ ${e2.message}`); }
          }
        }
        setDpMap(new Map(nm));
        await new Promise(r=>setTimeout(r,5000));
      }
      setDpMap(nm); setStatus("done");
      const fc={E:0,S:0,G:0,O:0}; nm.forEach(c=>{fc[c]=(fc[c]||0)+1;});
      addLog(`\nDone: ${nm.size} data points — E:${fc.E} S:${fc.S} G:${fc.G} O:${fc.O}`);
    } catch(err) { setStatus("error"); addLog(`Error: ${err.message}`); }
  };

  // Derived
  const dps = candidates.filter(c => dpMap.has(c.id) && !removed.has(c.id)).map(c => ({...c, cat: dpMap.get(c.id)})).sort((a,b)=>a.page-b.page);
  const cc = {E:0,S:0,G:0,O:0}; dps.forEach(d=>{cc[d.cat]=(cc[d.cat]||0)+1;});
  const tot = dps.length;
  const filt = dps.filter(d => {
    if (catFilter !== "ALL" && d.cat !== catFilter) return false;
    if (search) { const q = search.toLowerCase(); return d.number.includes(search) || d.sentence.toLowerCase().includes(q) || String(d.page).includes(search); }
    return true;
  });
  const toggle = id => setRemoved(p => { const n=new Set(p); n.has(id)?n.delete(id):n.add(id); return n; });

  const exportCSV = () => { const rows = ["#,Page,Data Point,Category,Sentence",...dps.map((d,i)=>`${i+1},${d.page},"${d.number}",${C[d.cat]?.l||"Other"},"${d.sentence.replace(/"/g,'""')}"`)]; const b=new Blob([rows.join("\n")],{type:"text/csv"}); const a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download=`${fileName.replace(/\.[^.]+$/,"")}_DataPoints.csv`; a.click(); };
  const exportExcel = () => { const x=makeExcel(dps,cc,tot,fileName); const b=new Blob([x],{type:"application/vnd.ms-excel"}); const a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download=`${fileName.replace(/\.[^.]+$/,"")}_DataPoints.xls`; a.click(); };
  const exportJSON = () => { const b=new Blob([JSON.stringify(dps,null,2)],{type:"application/json"}); const a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download=`${fileName.replace(/\.[^.]+$/,"")}_DataPoints.json`; a.click(); };

  const sm={idle:["Ready","#27272a","#a1a1aa"],stage1:["Extracting...","#422006","#fbbf24"],stage2:["Classifying...","#1e1b4b","#818cf8"],done:["Complete","#052e16","#34d399"],error:["Error","#2a1515","#f87171"]};
  const [sL,sB,sF]=sm[status]||sm.idle;

  return (
    <div style={{ display:"flex", minHeight:"100vh", background:"#09090b", fontFamily:"'DM Sans','Segoe UI',sans-serif", color:"#e4e4e7" }}>

      {/* ─── SIDEBAR ─── */}
      <div style={{ width: sideOpen ? 260 : 0, minWidth: sideOpen ? 260 : 0, background:"#0c0c10", borderRight:"1px solid #1f1f23", transition:"all 0.2s", overflow:"hidden", display:"flex", flexDirection:"column" }}>
        <div style={{ padding:"16px 14px 10px", borderBottom:"1px solid #1f1f23", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontSize:13, fontWeight:700, color:"#818cf8" }}>◆ Sessions</span>
          <button onClick={() => newSession("New Extraction")} style={{ background:"#4f46e5", border:"none", color:"#fff", borderRadius:6, padding:"4px 10px", fontSize:11, fontWeight:600, cursor:"pointer" }}>+ New</button>
        </div>
        <div style={{ flex:1, overflowY:"auto", padding:"8px 0" }}>
          {sessions.length === 0 && <div style={{ padding:"20px 14px", color:"#3f3f46", fontSize:12, textAlign:"center" }}>No sessions yet. Upload a PDF to start.</div>}
          {sessions.map(s => (
            <div key={s.id} onClick={() => setActiveId(s.id)} style={{
              padding:"10px 14px", cursor:"pointer", borderLeft: activeId===s.id ? "3px solid #4f46e5" : "3px solid transparent",
              background: activeId===s.id ? "#18181b" : "transparent", transition:"all 0.15s",
            }}>
              <div style={{ fontSize:12, fontWeight: activeId===s.id ? 600 : 400, color: activeId===s.id ? "#e4e4e7" : "#71717a", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                📄 {s.name}
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:3 }}>
                <span style={{ fontSize:10, color:"#3f3f46" }}>{new Date(s.date).toLocaleDateString()}</span>
                <button onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }} style={{ background:"none", border:"none", color:"#52525b", fontSize:10, cursor:"pointer", padding:"2px 4px" }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ─── MAIN ─── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", minWidth:0 }}>
        {/* Header */}
        <header style={{ background:"linear-gradient(135deg,#0c0a1d,#1a103a,#0c0a1d)", borderBottom:"1px solid #1e1b3a", padding:"14px 0", flexShrink:0 }}>
          <div style={{ maxWidth:1200, margin:"0 auto", padding:"0 20px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <button onClick={() => setSideOpen(p=>!p)} style={{ background:"none", border:"1px solid #27272a", borderRadius:6, color:"#71717a", padding:"4px 8px", cursor:"pointer", fontSize:14 }}>☰</button>
              <div>
                <h1 style={{ fontSize:18, fontWeight:700 }}><span style={{ color:"#818cf8" }}>◆</span> Data Point Extractor</h1>
                <p style={{ fontSize:11, color:"#52525b", marginTop:1 }}>Extract → Classify → ESG Categorise → Export</p>
              </div>
            </div>
            <span style={{ background:sB, color:sF, padding:"4px 12px", borderRadius:99, fontSize:11, fontWeight:600 }}>{sL}</span>
          </div>
        </header>

        {/* Content */}
        <div style={{ flex:1, overflowY:"auto", padding:"16px 20px" }}>
          <div style={{ maxWidth:1200, margin:"0 auto" }}>
            {/* API Key */}
            {showKey && (
              <div style={{ background:"#18181b", border:"1px solid #27272a", borderRadius:10, padding:14, marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#52525b", marginBottom:6, textTransform:"uppercase" }}>API Key</div>
                <div style={{ display:"flex", gap:8 }}>
                  <input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="sk-ant-..." style={{ flex:1, background:"#0f0f14", border:"1px solid #27272a", borderRadius:8, padding:"7px 10px", color:"#e4e4e7", fontSize:12, outline:"none", fontFamily:"monospace" }}/>
                  <button onClick={saveKey} style={{ padding:"7px 16px", borderRadius:8, border:"none", background:"#4f46e5", color:"#fff", fontWeight:600, fontSize:12, cursor:"pointer" }}>Save</button>
                </div>
              </div>
            )}
            {!showKey && <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:6 }}><button onClick={()=>setShowKey(true)} style={{ background:"none", border:"none", color:"#52525b", fontSize:10, cursor:"pointer", textDecoration:"underline" }}>Change API key</button></div>}

            {/* Controls */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
              <div style={{ background:"#18181b", border:"1px solid #27272a", borderRadius:10, padding:14 }}>
                <div style={{ fontSize:10, fontWeight:600, color:"#52525b", marginBottom:6, textTransform:"uppercase" }}>Document</div>
                <label style={{ display:"flex", alignItems:"center", justifyContent:"center", padding:12, borderRadius:8, cursor:"pointer", background:fileName?"#1e1b4b":"#111114", border:`1px dashed ${fileName?"#4f46e5":"#27272a"}`, fontSize:12, color:fileName?"#c7d2fe":"#52525b" }}>
                  <input type="file" accept=".pdf" onChange={handleFile} style={{ display:"none" }}/>
                  {fileName ? `📄 ${fileName}` : "Click to select PDF"}
                </label>
                {totalPages>0 && <div style={{ fontSize:10, color:"#52525b", marginTop:5 }}>{totalPages} pages • {candidates.length} candidates</div>}
              </div>
              <div style={{ background:"#18181b", border:"1px solid #27272a", borderRadius:10, padding:14 }}>
                <div style={{ fontSize:10, fontWeight:600, color:"#52525b", marginBottom:6, textTransform:"uppercase" }}>Pipeline</div>
                <button onClick={run} disabled={!fileObj||!apiKey||status==="stage1"||status==="stage2"} style={{ width:"100%", padding:"9px", borderRadius:8, border:"none", fontWeight:600, fontSize:12, background:fileObj&&apiKey?"linear-gradient(135deg,#4f46e5,#7c3aed)":"#27272a", color:fileObj&&apiKey?"#fff":"#52525b", cursor:fileObj&&apiKey?"pointer":"not-allowed", marginBottom:6 }}>
                  {status==="stage1"||status==="stage2"?`${progress.stage}… ${progress.pct}%`:"Run Extraction"}
                </button>
                <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:11, color:"#52525b" }}>
                  <span>Batch:</span>
                  <select value={batchSize} onChange={e=>setBatchSize(+e.target.value)} style={{ background:"#0f0f14", border:"1px solid #27272a", borderRadius:5, padding:"2px 6px", color:"#a1a1aa", fontSize:11 }}>
                    {[15,20,25,30,40].map(n=><option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                {(status==="stage1"||status==="stage2") && <div style={{ marginTop:6 }}><div style={{ background:"#27272a", borderRadius:3, height:4, overflow:"hidden" }}><div style={{ height:"100%", background:status==="stage1"?"#f59e0b":"linear-gradient(90deg,#4f46e5,#7c3aed)", width:`${progress.pct}%`, transition:"width 0.3s" }}/></div><div style={{ fontSize:10, color:"#52525b", marginTop:3 }}>{progress.detail}</div></div>}
              </div>
            </div>

            {/* Pie Chart */}
            {dpMap.size > 0 && (
              <div style={{ background:"#18181b", border:"1px solid #1f1f23", borderRadius:10, padding:"16px 24px", marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#71717a", marginBottom:2, textTransform:"uppercase", letterSpacing:"0.06em" }}>ESG Distribution</div>
                <Pie cc={cc} tot={tot}/>
              </div>
            )}

            {/* Log */}
            <div ref={logRef} style={{ background:"#0c0c10", border:"1px solid #1f1f23", borderRadius:8, padding:10, marginBottom:14, maxHeight:120, overflowY:"auto", fontFamily:"'JetBrains Mono',monospace", fontSize:10, lineHeight:1.7, color:"#52525b" }}>
              {log.length===0?<span style={{color:"#27272a"}}>Upload a PDF to start…</span>:log.map((l,i)=><div key={i} style={{color:l.includes("Done")||l.includes("done")?"#34d399":l.includes("✗")?"#f87171":l.includes("→")?"#818cf8":l.includes("Wait")?"#fbbf24":"#52525b"}}>{l}</div>)}
            </div>

            {/* Results */}
            {dpMap.size > 0 && (<>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8, flexWrap:"wrap", gap:6 }}>
                <h2 style={{ fontSize:14, fontWeight:600 }}>Data Points ({filt.length})</h2>
                <div style={{ display:"flex", gap:4, alignItems:"center", flexWrap:"wrap" }}>
                  {["ALL","E","S","G","O"].map(c=>{const m=c==="ALL"?{c:"#818cf8",bg:"#1e1b4b",bd:"#4f46e5"}:C[c];const a=catFilter===c;return<button key={c} onClick={()=>setCatFilter(c)} style={{padding:"3px 8px",borderRadius:5,fontSize:10,fontWeight:600,cursor:"pointer",background:a?(m.bg||m.bg):"transparent",border:`1px solid ${a?(m.bd||m.c):"#27272a"}`,color:a?(m.c||m.c):"#52525b"}}>{c==="ALL"?"All":C[c].l}{c!=="ALL"?` ${cc[c]}`:""}</button>;})}
                  <span style={{width:1,height:16,background:"#27272a"}}/>
                  <input type="text" placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)} style={{background:"#0f0f14",border:"1px solid #27272a",borderRadius:5,padding:"3px 8px",color:"#a1a1aa",fontSize:11,width:120,outline:"none"}}/>
                  <button onClick={exportExcel} style={{padding:"3px 8px",borderRadius:5,border:"1px solid #27272a",background:"transparent",color:"#71717a",fontSize:10,cursor:"pointer"}}>Excel ↓</button>
                  <button onClick={exportCSV} style={{padding:"3px 8px",borderRadius:5,border:"1px solid #27272a",background:"transparent",color:"#71717a",fontSize:10,cursor:"pointer"}}>CSV ↓</button>
                  <button onClick={exportJSON} style={{padding:"3px 8px",borderRadius:5,border:"1px solid #27272a",background:"transparent",color:"#71717a",fontSize:10,cursor:"pointer"}}>JSON ↓</button>
                </div>
              </div>
              <div style={{ background:"#18181b", border:"1px solid #1f1f23", borderRadius:10, overflow:"hidden" }}>
                <div style={{ display:"grid", gridTemplateColumns:"36px 44px 95px 78px 1fr 40px", padding:"7px 12px", background:"#111114", borderBottom:"1px solid #1f1f23", fontSize:9, fontWeight:600, color:"#52525b", textTransform:"uppercase", letterSpacing:"0.06em" }}>
                  <div>#</div><div>Page</div><div>Number</div><div>Category</div><div>Sentence</div><div style={{textAlign:"center"}}>✓</div>
                </div>
                <div style={{ maxHeight:480, overflowY:"auto" }}>
                  {filt.length===0&&<div style={{padding:20,textAlign:"center",color:"#3f3f46",fontSize:12}}>No results</div>}
                  {filt.map((d,i)=>(<div key={d.id} style={{display:"grid",gridTemplateColumns:"36px 44px 95px 78px 1fr 40px",padding:"5px 12px",borderBottom:"1px solid #141418",fontSize:11,background:i%2?"#0f0f14":"transparent",alignItems:"center"}}>
                    <div style={{color:"#3f3f46"}}>{i+1}</div>
                    <div style={{color:"#818cf8",fontWeight:600}}>{d.page}</div>
                    <div style={{color:"#e4e4e7",fontWeight:500}}>{d.number}</div>
                    <div><Badge cat={d.cat}/></div>
                    <div style={{color:"#71717a",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",fontSize:10}}>{d.sentence}</div>
                    <div style={{textAlign:"center"}}><button onClick={()=>toggle(d.id)} style={{width:20,height:20,borderRadius:4,border:`1px solid ${removed.has(d.id)?"#3f2020":"#1a3a1a"}`,background:removed.has(d.id)?"#1a1010":"#101a10",color:removed.has(d.id)?"#f87171":"#34d399",cursor:"pointer",fontSize:10,display:"inline-flex",alignItems:"center",justifyContent:"center"}}>{removed.has(d.id)?"✗":"✓"}</button></div>
                  </div>))}
                </div>
              </div>
            </>)}
          </div>
        </div>
      </div>
    </div>
  );
}
