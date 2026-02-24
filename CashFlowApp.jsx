import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import * as Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts";
import { useAuth } from "./useAuth.js";
import { loadUserData, saveBudgets, saveCategoryOverrides, saveDataset, deleteDataset } from "./useFirestore.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const CATEGORY_RULES = {
  "Groceries": ["grocery", "supermarket", "whole foods", "trader joe", "safeway", "kroger", "walmart", "costco", "aldi", "publix", "wegmans", "heb", "food lion", "save-a-lot"],
  "Dining Out": ["restaurant", "mcdonald", "starbucks", "chipotle", "subway", "pizza", "doordash", "uber eats", "grubhub", "cafe", "coffee", "burger", "taco", "sushi", "diner", "bar & grill"],
  "Transportation": ["gas", "fuel", "shell", "chevron", "bp", "exxon", "uber", "lyft", "parking", "transit", "metro", "toll", "auto"],
  "Housing": ["rent", "mortgage", "hoa", "property tax", "home depot", "lowe", "ikea", "furniture"],
  "Utilities": ["electric", "water", "gas bill", "internet", "comcast", "verizon", "at&t", "t-mobile", "phone", "utility", "power", "energy"],
  "Entertainment": ["netflix", "spotify", "hulu", "disney", "amazon prime", "movie", "theater", "concert", "game", "steam", "playstation", "xbox", "apple music", "youtube"],
  "Shopping": ["amazon", "target", "mall", "clothing", "shoes", "nike", "adidas", "zara", "h&m", "nordstrom", "macy", "best buy", "apple store"],
  "Health": ["pharmacy", "cvs", "walgreens", "doctor", "hospital", "medical", "dental", "vision", "gym", "fitness", "health"],
  "Insurance": ["insurance", "geico", "state farm", "allstate", "progressive"],
  "Subscriptions": ["subscription", "membership", "annual fee", "monthly fee", "patreon"],
  "Travel": ["airline", "hotel", "airbnb", "booking", "flight", "travel", "vacation", "resort"],
  "Education": ["tuition", "school", "university", "course", "udemy", "textbook", "student"],
  "Income": ["payroll", "salary", "direct deposit", "deposit", "payment received", "refund", "interest earned", "dividend", "transfer in", "income", "paycheck"],
};

const CATEGORY_COLORS = {
  "Groceries": "#34d399",
  "Dining Out": "#fb923c",
  "Transportation": "#60a5fa",
  "Housing": "#a78bfa",
  "Utilities": "#fbbf24",
  "Entertainment": "#f472b6",
  "Shopping": "#c084fc",
  "Health": "#2dd4bf",
  "Insurance": "#94a3b8",
  "Subscriptions": "#e879f9",
  "Travel": "#38bdf8",
  "Education": "#a3e635",
  "Income": "#4ade80",
  "Other": "#6b7280",
};

const ACCENT = "#34d399";
const ACCENT2 = "#60a5fa";
const BG = "#0a0f1a";
const CARD = "#111827";
const CARD2 = "#1a2236";
const BORDER = "#1e293b";
const TEXT = "#e2e8f0";
const MUTED = "#64748b";

// ─── Build flat keyword → category lookup (O(1) for exact prefix matches) ───

const KEYWORD_INDEX = (() => {
  const index = [];
  for (const [cat, keywords] of Object.entries(CATEGORY_RULES)) {
    for (const kw of keywords) {
      index.push({ keyword: kw.toLowerCase(), category: cat });
    }
  }
  // Sort longest-first so more specific matches win
  index.sort((a, b) => b.keyword.length - a.keyword.length);
  return index;
})();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function categorize(description) {
  const lower = (description || "").toLowerCase();
  for (const { keyword, category } of KEYWORD_INDEX) {
    if (lower.includes(keyword)) return category;
  }
  return "Other";
}

function parseAmount(val) {
  if (typeof val === "number") return val;
  if (!val) return 0;
  const cleaned = String(val).replace(/[$,\s]/g, "").replace(/\((.+)\)/, "-$1");
  return parseFloat(cleaned) || 0;
}

function parseDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function fmt(n) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function fmtFull(n) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [y, m] = key.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m) - 1]} ${y}`;
}

// ─── Header row detection (skip bank preamble rows) ─────────────────────────

const HEADER_KEYWORDS = ["date", "posted", "trans", "desc", "memo", "merchant", "payee", "amount", "debit", "credit", "withdrawal", "deposit", "detail", "narr"];

function looksLikeHeaderRow(columns) {
  // A real header row has multiple recognizable column names and no __EMPTY junk
  const lower = columns.map(c => String(c).toLowerCase().trim());
  const hits = lower.filter(h => HEADER_KEYWORDS.some(kw => h.includes(kw)));
  const empties = lower.filter(h => h.includes("__empty") || h === "" || h.startsWith("_"));
  return hits.length >= 2 && empties.length <= 1;
}

// For Excel: parse without headers and scan rows to find the real header row
function findHeaderRowInSheet(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i].map(c => String(c).trim()).filter(c => c !== "");
    if (row.length >= 3 && looksLikeHeaderRow(row)) {
      // Return the header row index and the clean headers
      const headers = rows[i].map(c => String(c).trim());
      const data = rows.slice(i + 1)
        .filter(r => r.some(c => String(c).trim() !== ""))
        .map(r => {
          const obj = {};
          headers.forEach((h, j) => { if (h) obj[h] = r[j] !== undefined ? r[j] : ""; });
          return obj;
        });
      return { headers: headers.filter(h => h !== ""), data };
    }
  }
  return null; // fallback: couldn't detect
}

// For CSV: re-parse without headers to scan for the real header row
function findHeaderRowInCSV(text) {
  const result = Papa.parse(text, { header: false, skipEmptyLines: true });
  const rows = result.data;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i].map(c => String(c).trim()).filter(c => c !== "");
    if (row.length >= 3 && looksLikeHeaderRow(row)) {
      const headers = rows[i].map(c => String(c).trim());
      const data = rows.slice(i + 1)
        .filter(r => r.some(c => String(c).trim() !== ""))
        .map(r => {
          const obj = {};
          headers.forEach((h, j) => { if (h) obj[h] = r[j] !== undefined ? r[j] : ""; });
          return obj;
        });
      return { headers: headers.filter(h => h !== ""), data };
    }
  }
  return null;
}

// ─── CSV Column Mapper ───────────────────────────────────────────────────────

function guessMapping(headers) {
  const lower = headers.map(h => h.toLowerCase().trim());
  const mapping = { date: "", description: "", amount: "", debit: "", credit: "" };

  for (let i = 0; i < lower.length; i++) {
    const h = lower[i];
    if (!mapping.date && (h.includes("date") || h.includes("posted") || h.includes("trans"))) mapping.date = headers[i];
    if (!mapping.description && (h.includes("desc") || h.includes("memo") || h.includes("narr") || h.includes("merchant") || h.includes("payee") || h.includes("name") || h.includes("detail"))) mapping.description = headers[i];
    if (!mapping.amount && (h === "amount" || h.includes("amount"))) mapping.amount = headers[i];
    if (!mapping.debit && (h.includes("debit") || h.includes("withdrawal") || h.includes("out"))) mapping.debit = headers[i];
    if (!mapping.credit && (h.includes("credit") || h.includes("deposit") || h.includes("in"))) mapping.credit = headers[i];
  }

  return mapping;
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function CashFlowApp() {
  const { user, loading: authLoading, signInWithGoogle, logOut } = useAuth();

  const [transactions, setTransactions] = useState([]);
  const [view, setView] = useState("upload");
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [dateRange, setDateRange] = useState({ start: "", end: "" });
  const [budgets, setBudgets] = useState({});
  const [categoryOverrides, setCategoryOverrides] = useState({});
  const [editingCategory, setEditingCategory] = useState(null);
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [csvData, setCsvData] = useState([]);
  const [columnMapping, setColumnMapping] = useState({ date: "", description: "", amount: "", debit: "", credit: "" });
  const [showMapper, setShowMapper] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [savedDatasets, setSavedDatasets] = useState([]);
  const [activeDatasetName, setActiveDatasetName] = useState(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadFileName, setUploadFileName] = useState("");
  const fileRef = useRef(null);

  // ─── Inject Google Fonts once ────────────────────────────────────────────
  useEffect(() => {
    const id = "cashflow-fonts";
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Outfit:wght@400;600;700;800&display=swap";
      document.head.appendChild(link);
    }
  }, []);

  // ─── Load user data from Firestore on auth ──────────────────────────────
  useEffect(() => {
    if (!user) {
      // Reset state when signed out
      setTransactions([]);
      setBudgets({});
      setCategoryOverrides({});
      setSavedDatasets([]);
      setActiveDatasetName(null);
      setView("upload");
      return;
    }
    setDataLoading(true);
    loadUserData(user.uid).then(data => {
      setBudgets(data.budgets);
      setCategoryOverrides(data.categoryOverrides);
      setSavedDatasets(data.datasets);
      setDataLoading(false);
    });
  }, [user]);

  // ─── Persist budgets & category overrides to Firestore (debounced) ──────
  const budgetTimer = useRef(null);
  const overrideTimer = useRef(null);

  useEffect(() => {
    if (!user) return;
    clearTimeout(budgetTimer.current);
    budgetTimer.current = setTimeout(() => { saveBudgets(user.uid, budgets); }, 1000);
    return () => clearTimeout(budgetTimer.current);
  }, [budgets, user]);

  useEffect(() => {
    if (!user) return;
    clearTimeout(overrideTimer.current);
    overrideTimer.current = setTimeout(() => { saveCategoryOverrides(user.uid, categoryOverrides); }, 1000);
    return () => clearTimeout(overrideTimer.current);
  }, [categoryOverrides, user]);

  // ─── CSV Processing ──────────────────────────────────────────────────────

  const handleFile = useCallback((file) => {
    if (!file) return;
    setUploadFileName(file.name.replace(/\.[^/.]+$/, "")); // strip extension for dataset name
    const name = file.name.toLowerCase();
    const isExcel = name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".xlsm");

    if (isExcel) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: "array", cellDates: true });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];

          // Try smart header detection first (handles bank preamble rows)
          const detected = findHeaderRowInSheet(sheet);
          let headers, json;
          if (detected) {
            headers = detected.headers;
            json = detected.data;
          } else {
            // Fallback: standard first-row-as-header parsing
            json = XLSX.utils.sheet_to_json(sheet, { defval: "" });
            headers = json.length > 0 ? Object.keys(json[0]) : [];
          }

          if (json.length > 0) {
            setCsvHeaders(headers);
            setCsvData(json);
            const guessed = guessMapping(headers);
            setColumnMapping(guessed);
            setShowMapper(true);
          }
        } catch (err) {
          console.error("Excel parse error:", err);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      // Read file as text first so we can scan for the real header row
      const textReader = new FileReader();
      textReader.onload = (e) => {
        const text = e.target.result;

        // Try smart header detection first
        const detected = findHeaderRowInCSV(text);
        let headers, json;
        if (detected) {
          headers = detected.headers;
          json = detected.data;
        } else {
          // Fallback: standard PapaParse with first-row headers
          const result = Papa.parse(text, { header: true, skipEmptyLines: true });
          json = result.data;
          headers = json.length > 0 ? Object.keys(json[0]) : [];
        }

        if (json.length > 0) {
          setCsvHeaders(headers);
          setCsvData(json);
          const guessed = guessMapping(headers);
          setColumnMapping(guessed);
          setShowMapper(true);
        }
      };
      textReader.readAsText(file);
    }
  }, []);

  const applyMapping = useCallback(() => {
    const { date, description, amount, debit, credit } = columnMapping;
    const parsed = csvData.map((row, i) => {
      const d = parseDate(row[date]);
      if (!d) return null;

      let amt;
      if (amount) {
        amt = parseAmount(row[amount]);
      } else if (debit || credit) {
        const db = parseAmount(row[debit] || 0);
        const cr = parseAmount(row[credit] || 0);
        amt = cr > 0 ? cr : -Math.abs(db);
      } else {
        return null;
      }

      const desc = row[description] || "Unknown";
      // Use persisted category override if the user previously re-categorized this merchant
      const cat = categoryOverrides[desc.toLowerCase()] || categorize(desc);

      return { id: i, date: d, description: desc, amount: amt, category: cat };
    }).filter(Boolean);

    setTransactions(parsed);
    setShowMapper(false);
    setView("dashboard");

    if (parsed.length > 0) {
      const sorted = [...parsed].sort((a, b) => b.date - a.date);
      setSelectedMonth(monthKey(sorted[0].date));
    }

    // Save to Firestore
    const dsName = uploadFileName || `Upload ${new Date().toLocaleDateString()}`;
    setActiveDatasetName(dsName);
    if (user) {
      setSaving(true);
      saveDataset(user.uid, dsName, parsed).then(() => {
        // Refresh local datasets list
        setSavedDatasets(prev => {
          const idx = prev.findIndex(d => d.name === dsName);
          const ds = { name: dsName, uploadedAt: new Date().toISOString(), transactions: parsed };
          if (idx >= 0) { const next = [...prev]; next[idx] = ds; return next; }
          return [...prev, ds];
        });
        setSaving(false);
      });
    }
  }, [columnMapping, csvData, categoryOverrides, user, uploadFileName]);

  // ─── Filtered Transactions ───────────────────────────────────────────────

  const filtered = useMemo(() => {
    if (dateRange.start || dateRange.end) {
      const s = dateRange.start ? new Date(dateRange.start) : new Date(0);
      const e = dateRange.end ? new Date(dateRange.end + "T23:59:59") : new Date();
      return transactions.filter(t => t.date >= s && t.date <= e);
    }
    if (selectedMonth) {
      return transactions.filter(t => monthKey(t.date) === selectedMonth);
    }
    return transactions;
  }, [transactions, selectedMonth, dateRange]);

  // ─── Derived Data ────────────────────────────────────────────────────────

  const income = useMemo(() => filtered.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0), [filtered]);
  const expenses = useMemo(() => filtered.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0), [filtered]);
  const netFlow = income - expenses;

  const categoryBreakdown = useMemo(() => {
    const map = {};
    filtered.filter(t => t.amount < 0).forEach(t => {
      const c = t.category;
      map[c] = (map[c] || 0) + Math.abs(t.amount);
    });
    return Object.entries(map)
      .map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
      .sort((a, b) => b.value - a.value);
  }, [filtered]);

  const monthlyData = useMemo(() => {
    const map = {};
    transactions.forEach(t => {
      const k = monthKey(t.date);
      if (!map[k]) map[k] = { month: k, income: 0, expenses: 0 };
      if (t.amount > 0) map[k].income += t.amount;
      else map[k].expenses += Math.abs(t.amount);
    });
    return Object.values(map)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map(d => ({
        ...d,
        label: monthLabel(d.month),
        net: Math.round((d.income - d.expenses) * 100) / 100,
        income: Math.round(d.income * 100) / 100,
        expenses: Math.round(d.expenses * 100) / 100
      }));
  }, [transactions]);

  const months = useMemo(() => monthlyData.map(d => d.month), [monthlyData]);

  // ─── Forecast ────────────────────────────────────────────────────────────

  const forecast = useMemo(() => {
    if (monthlyData.length < 2) return [];
    const recent = monthlyData.slice(-3);
    const avgIncome = recent.reduce((s, d) => s + d.income, 0) / recent.length;
    const avgExpenses = recent.reduce((s, d) => s + d.expenses, 0) / recent.length;

    const last = monthlyData[monthlyData.length - 1];
    const [y, m] = last.month.split("-").map(Number);

    const result = [];
    for (let i = 1; i <= 3; i++) {
      const nm = ((m - 1 + i) % 12) + 1;
      const ny = y + Math.floor((m - 1 + i) / 12);
      const key = `${ny}-${String(nm).padStart(2, "0")}`;
      result.push({
        month: key,
        label: monthLabel(key),
        income: Math.round(avgIncome),
        expenses: Math.round(avgExpenses),
        net: Math.round(avgIncome - avgExpenses),
        forecast: true
      });
    }
    return result;
  }, [monthlyData]);

  // Combined data with separate actual/forecast keys so chart can style them differently
  const combinedMonthly = useMemo(() => {
    const actual = monthlyData.map(d => ({
      ...d,
      incomeActual: d.income, expensesActual: d.expenses, netActual: d.net,
      incomeForecast: null, expensesForecast: null, netForecast: null,
    }));
    // Bridge: duplicate the last actual point into forecast so lines connect
    const bridge = monthlyData.length > 0 ? {
      incomeActual: null, expensesActual: null, netActual: null,
      incomeForecast: monthlyData[monthlyData.length - 1].income,
      expensesForecast: monthlyData[monthlyData.length - 1].expenses,
      netForecast: monthlyData[monthlyData.length - 1].net,
    } : {};
    const lastActualIdx = actual.length - 1;
    if (lastActualIdx >= 0) Object.assign(actual[lastActualIdx], bridge);

    const fc = forecast.map(d => ({
      ...d,
      incomeActual: null, expensesActual: null, netActual: null,
      incomeForecast: d.income, expensesForecast: d.expenses, netForecast: d.net,
    }));
    return [...actual, ...fc];
  }, [monthlyData, forecast]);

  // ─── Re-categorize ──────────────────────────────────────────────────────

  const updateCategory = useCallback((id, newCat) => {
    setTransactions(prev => {
      const target = prev.find(t => t.id === id);
      if (target) {
        // Persist override keyed by lowercase description so future imports remember it
        setCategoryOverrides(o => ({ ...o, [target.description.toLowerCase()]: newCat }));
      }
      return prev.map(t => t.id === id ? { ...t, category: newCat } : t);
    });
  }, []);

  // ─── Styles ──────────────────────────────────────────────────────────────

  const styles = {
    app: { minHeight: "100vh", background: BG, color: TEXT, fontFamily: "'DM Sans', 'Outfit', sans-serif" },
    header: { background: CARD, borderBottom: `1px solid ${BORDER}`, padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 50 },
    logo: { fontSize: 22, fontWeight: 700, letterSpacing: "-0.5px", color: ACCENT },
    nav: { display: "flex", gap: 4, background: CARD2, borderRadius: 12, padding: 4 },
    navBtn: (active) => ({
      padding: "8px 18px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
      background: active ? ACCENT : "transparent", color: active ? BG : MUTED,
      transition: "all 0.2s"
    }),
    card: { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 16, padding: 24 },
    statCard: (accent) => ({
      background: `linear-gradient(135deg, ${CARD} 0%, ${CARD2} 100%)`,
      border: `1px solid ${BORDER}`, borderRadius: 16, padding: 24, flex: 1,
      borderTop: `3px solid ${accent}`
    }),
    btn: (variant) => ({
      padding: "10px 20px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600,
      background: variant === "primary" ? ACCENT : CARD2,
      color: variant === "primary" ? BG : TEXT,
      transition: "all 0.2s"
    }),
    select: {
      background: CARD2, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 8,
      padding: "8px 12px", fontSize: 13, outline: "none"
    },
    input: {
      background: CARD2, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 8,
      padding: "8px 12px", fontSize: 13, outline: "none", width: "100%"
    },
    badge: (color) => ({
      display: "inline-block", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: `${color}22`, color: color, border: `1px solid ${color}44`
    }),
  };

  const customTooltip = { contentStyle: { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "10px 14px", fontSize: 13, color: TEXT }, cursor: { stroke: ACCENT, strokeDasharray: "4 4" } };

  // ─── Helper: load a saved dataset ──────────────────────────────────────

  const loadSavedDataset = useCallback((ds) => {
    setTransactions(ds.transactions);
    setActiveDatasetName(ds.name);
    setView("dashboard");
    if (ds.transactions.length > 0) {
      const sorted = [...ds.transactions].sort((a, b) => b.date - a.date);
      setSelectedMonth(monthKey(sorted[0].date));
    }
  }, []);

  const handleDeleteDataset = useCallback((dsName) => {
    if (!user) return;
    setSavedDatasets(prev => prev.filter(d => d.name !== dsName));
    deleteDataset(user.uid, dsName);
    if (activeDatasetName === dsName) {
      setTransactions([]);
      setActiveDatasetName(null);
      setView("upload");
    }
  }, [user, activeDatasetName]);

  // ─── Auth loading ──────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div style={{ ...styles.app, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>💸</div>
          <div style={{ color: MUTED, fontSize: 14 }}>Loading...</div>
        </div>
      </div>
    );
  }

  // ─── Sign-in screen ────────────────────────────────────────────────────

  if (!user) {
    return (
      <div style={styles.app}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 24 }}>
          <div style={{ textAlign: "center", maxWidth: 440 }}>
            <div style={{ fontSize: 56, marginBottom: 8 }}>💸</div>
            <h1 style={{ fontSize: 40, fontWeight: 800, fontFamily: "'Outfit', sans-serif", marginBottom: 8, background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT2})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              CashFlow
            </h1>
            <p style={{ color: MUTED, fontSize: 16, marginBottom: 40, lineHeight: 1.6 }}>
              Track your spending, visualize cash flow, and forecast your finances. Sign in to save your data across sessions.
            </p>
            <button
              onClick={signInWithGoogle}
              style={{
                ...styles.btn("primary"), fontSize: 16, padding: "14px 32px",
                display: "flex", alignItems: "center", gap: 10, margin: "0 auto"
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Data loading ──────────────────────────────────────────────────────

  if (dataLoading) {
    return (
      <div style={{ ...styles.app, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>💸</div>
          <div style={{ color: MUTED, fontSize: 14 }}>Loading your data...</div>
        </div>
      </div>
    );
  }

  // ─── Upload View ─────────────────────────────────────────────────────────

  if (view === "upload" && !showMapper) {
    return (
      <div style={styles.app}>
        {/* Signed-in header bar */}
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, padding: "12px 24px" }}>
          {saving && <span style={{ fontSize: 11, color: ACCENT }}>Saving...</span>}
          <img src={user.photoURL} alt="" style={{ width: 28, height: 28, borderRadius: "50%", border: `2px solid ${BORDER}` }} />
          <span style={{ fontSize: 13, color: MUTED }}>{user.displayName?.split(" ")[0]}</span>
          <button onClick={logOut} style={{ ...styles.btn(), fontSize: 11, padding: "5px 12px" }}>Sign out</button>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "calc(100vh - 60px)", padding: 24 }}>
          <div style={{ textAlign: "center", maxWidth: 560 }}>
            <div style={{ fontSize: 56, marginBottom: 8 }}>💸</div>
            <h1 style={{ fontSize: 40, fontWeight: 800, fontFamily: "'Outfit', sans-serif", marginBottom: 8, background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT2})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              CashFlow
            </h1>

            {/* Saved datasets */}
            {savedDatasets.length > 0 && (
              <div style={{ marginBottom: 32 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: MUTED, marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.5px" }}>Your Saved Data</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {savedDatasets.map(ds => (
                    <div key={ds.name} style={{
                      ...styles.card, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between",
                      cursor: "pointer", transition: "all 0.2s", textAlign: "left"
                    }}
                      onClick={() => loadSavedDataset(ds)}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{ds.name}</div>
                        <div style={{ fontSize: 11, color: MUTED }}>
                          {ds.transactions.length} transactions · uploaded {new Date(ds.uploadedAt).toLocaleDateString()}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <button onClick={(e) => { e.stopPropagation(); loadSavedDataset(ds); }} style={{ ...styles.btn("primary"), fontSize: 12, padding: "6px 14px" }}>Open</button>
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteDataset(ds.name); }} style={{ ...styles.btn(), fontSize: 12, padding: "6px 12px", color: "#f87171" }}>×</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ margin: "24px 0 8px", color: MUTED, fontSize: 13 }}>— or upload a new file —</div>
              </div>
            )}

            {savedDatasets.length === 0 && (
              <p style={{ color: MUTED, fontSize: 16, marginBottom: 40, lineHeight: 1.6 }}>
                Drop your bank statement CSV or Excel file to instantly visualize your spending, track income vs. expenses, and forecast your financial future.
              </p>
            )}

            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
              onClick={() => fileRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? ACCENT : BORDER}`,
                borderRadius: 20, padding: "56px 40px", cursor: "pointer",
                background: dragOver ? `${ACCENT}08` : CARD,
                transition: "all 0.3s"
              }}
            >
              <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.7 }}>📄</div>
              <p style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>
                {dragOver ? "Drop it here!" : "Drag & drop your CSV or Excel file"}
              </p>
              <p style={{ color: MUTED, fontSize: 13 }}>or click to browse — supports .csv, .xlsx, .xls and most bank export formats</p>
              <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm" style={{ display: "none" }}
                onChange={e => handleFile(e.target.files[0])} />
            </div>

            <div style={{ marginTop: 32, display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              {["Chase", "Bank of America", "Wells Fargo", "Citi", "Capital One", "Mint", "Most banks"].map(b => (
                <span key={b} style={{ ...styles.badge(MUTED), fontSize: 11 }}>{b}</span>
              ))}
            </div>

            <button
              onClick={() => {
                const demo = generateDemoData();
                setTransactions(demo);
                setView("dashboard");
                setSelectedMonth(monthKey(demo[0].date));
              }}
              style={{ ...styles.btn(), marginTop: 32, fontSize: 13, opacity: 0.7 }}
            >
              or try with demo data →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Column Mapper ───────────────────────────────────────────────────────

  if (showMapper) {
    return (
      <div style={styles.app}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 24 }}>
          <div style={{ ...styles.card, maxWidth: 520, width: "100%" }}>
            <h2 style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Outfit', sans-serif", marginBottom: 4 }}>Map Your Columns</h2>
            <p style={{ color: MUTED, fontSize: 13, marginBottom: 24 }}>Tell us which columns contain your transaction data. We've made our best guesses below.</p>

            {[
              { key: "date", label: "📅 Date Column", required: true },
              { key: "description", label: "📝 Description / Merchant", required: true },
              { key: "amount", label: "💰 Amount (single column)", required: false },
              { key: "debit", label: "🔻 Debit / Withdrawal", required: false },
              { key: "credit", label: "🔺 Credit / Deposit", required: false },
            ].map(({ key, label, required }) => (
              <div key={key} style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: "block", color: MUTED }}>
                  {label} {required && <span style={{ color: ACCENT }}>*</span>}
                </label>
                <select
                  value={columnMapping[key]}
                  onChange={e => setColumnMapping(p => ({ ...p, [key]: e.target.value }))}
                  style={{ ...styles.select, width: "100%" }}
                >
                  <option value="">— Select —</option>
                  {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}

            <p style={{ fontSize: 12, color: MUTED, marginBottom: 20, lineHeight: 1.5 }}>
              Use either a single Amount column (positives=income, negatives=expenses) or separate Debit/Credit columns.
            </p>

            <div style={{ display: "flex", gap: 12 }}>
              <button onClick={() => { setShowMapper(false); setCsvHeaders([]); setCsvData([]); setColumnMapping({ date: "", description: "", amount: "", debit: "", credit: "" }); }} style={styles.btn()}>← Back</button>
              <button
                onClick={applyMapping}
                disabled={!columnMapping.date || !columnMapping.description || (!columnMapping.amount && !columnMapping.debit && !columnMapping.credit)}
                style={{
                  ...styles.btn("primary"), flex: 1,
                  opacity: (!columnMapping.date || !columnMapping.description || (!columnMapping.amount && !columnMapping.debit && !columnMapping.credit)) ? 0.4 : 1
                }}
              >
                Analyze {csvData.length} Transactions →
              </button>
            </div>

            {csvData.length > 0 && (
              <div style={{ marginTop: 20, maxHeight: 150, overflow: "auto", borderRadius: 8, border: `1px solid ${BORDER}` }}>
                <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{csvHeaders.slice(0, 5).map(h => <th key={h} style={{ padding: "6px 8px", background: CARD2, textAlign: "left", color: MUTED, fontWeight: 600, position: "sticky", top: 0 }}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {csvData.slice(0, 5).map((row, i) => (
                      <tr key={i}>{csvHeaders.slice(0, 5).map(h => <td key={h} style={{ padding: "5px 8px", borderTop: `1px solid ${BORDER}`, color: TEXT }}>{row[h]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── Dashboard ───────────────────────────────────────────────────────────

  return (
    <div style={styles.app}>
      {/* Header */}
      <header style={styles.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={styles.logo}>💸 CashFlow</span>
          {activeDatasetName && <span style={{ fontSize: 12, color: ACCENT2, fontWeight: 600 }}>{activeDatasetName}</span>}
          <span style={{ fontSize: 12, color: MUTED }}>{transactions.length} transactions</span>
          {saving && <span style={{ fontSize: 11, color: ACCENT }}>Saving...</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <nav style={styles.nav}>
            {[["dashboard", "Overview"], ["transactions", "Transactions"], ["budget", "Budget"], ["forecast", "Forecast"]].map(([key, label]) => (
              <button key={key} style={styles.navBtn(view === key)} onClick={() => setView(key)}>{label}</button>
            ))}
          </nav>
          <button onClick={() => { setView("upload"); setTransactions([]); setCsvData([]); setActiveDatasetName(null); }} style={{ ...styles.btn(), fontSize: 12, padding: "8px 14px" }}>New CSV</button>
          {user && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 8 }}>
              <img src={user.photoURL} alt="" style={{ width: 26, height: 26, borderRadius: "50%", border: `2px solid ${BORDER}` }} />
              <button onClick={logOut} style={{ ...styles.btn(), fontSize: 11, padding: "5px 10px" }}>Sign out</button>
            </div>
          )}
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 24px 60px" }}>

        {/* Filters */}
        <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={dateRange.start ? "" : selectedMonth || ""}
            onChange={e => { setSelectedMonth(e.target.value); setDateRange({ start: "", end: "" }); }}
            style={styles.select}
          >
            {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <span style={{ color: MUTED, fontSize: 13 }}>or</span>
          <input type="date" value={dateRange.start} onChange={e => setDateRange(p => ({ ...p, start: e.target.value }))} style={{ ...styles.select, width: "auto" }} />
          <span style={{ color: MUTED, fontSize: 13 }}>to</span>
          <input type="date" value={dateRange.end} onChange={e => setDateRange(p => ({ ...p, end: e.target.value }))} style={{ ...styles.select, width: "auto" }} />
          {(dateRange.start || dateRange.end) && (
            <button onClick={() => setDateRange({ start: "", end: "" })} style={{ ...styles.btn(), fontSize: 12, padding: "6px 12px" }}>Clear</button>
          )}
        </div>

        {/* ─── OVERVIEW TAB ────────────────────────────────────────────── */}
        {view === "dashboard" && (
          <>
            {/* Stat Cards */}
            <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
              <div style={styles.statCard(ACCENT)}>
                <div style={{ color: MUTED, fontSize: 12, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>Income</div>
                <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "'Outfit', sans-serif", color: ACCENT }}>{fmt(income)}</div>
              </div>
              <div style={styles.statCard("#f87171")}>
                <div style={{ color: MUTED, fontSize: 12, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>Expenses</div>
                <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "'Outfit', sans-serif", color: "#f87171" }}>{fmt(expenses)}</div>
              </div>
              <div style={styles.statCard(netFlow >= 0 ? ACCENT : "#f87171")}>
                <div style={{ color: MUTED, fontSize: 12, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>Net Cash Flow</div>
                <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "'Outfit', sans-serif", color: netFlow >= 0 ? ACCENT : "#f87171" }}>{netFlow >= 0 ? "+" : ""}{fmt(netFlow)}</div>
              </div>
              <div style={styles.statCard(ACCENT2)}>
                <div style={{ color: MUTED, fontSize: 12, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>Transactions</div>
                <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "'Outfit', sans-serif", color: ACCENT2 }}>{filtered.length}</div>
              </div>
            </div>

            {/* Charts Row */}
            <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16, marginBottom: 24 }}>
              {/* Income vs Expenses Over Time */}
              <div style={styles.card}>
                <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 20, fontFamily: "'Outfit', sans-serif" }}>Income vs. Expenses</h3>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={monthlyData} barGap={4}>
                    <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                    <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 11 }} axisLine={{ stroke: BORDER }} />
                    <YAxis tick={{ fill: MUTED, fontSize: 11 }} axisLine={{ stroke: BORDER }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                    <Tooltip {...customTooltip} formatter={(v) => fmtFull(v)} />
                    <Bar dataKey="income" fill={ACCENT} radius={[6, 6, 0, 0]} name="Income" />
                    <Bar dataKey="expenses" fill="#f87171" radius={[6, 6, 0, 0]} name="Expenses" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Spending by Category */}
              <div style={styles.card}>
                <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 20, fontFamily: "'Outfit', sans-serif" }}>Where Your Money Goes</h3>
                {categoryBreakdown.length > 0 ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <ResponsiveContainer width="50%" height={240}>
                      <PieChart>
                        <Pie data={categoryBreakdown} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} innerRadius={50} paddingAngle={2} strokeWidth={0}>
                          {categoryBreakdown.map((entry) => (
                            <Cell key={entry.name} fill={CATEGORY_COLORS[entry.name] || CATEGORY_COLORS["Other"]} />
                          ))}
                        </Pie>
                        <Tooltip {...customTooltip} formatter={(v) => fmtFull(v)} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ flex: 1, maxHeight: 240, overflow: "auto" }}>
                      {categoryBreakdown.slice(0, 7).map(c => (
                        <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 12 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 3, background: CATEGORY_COLORS[c.name] || CATEGORY_COLORS["Other"], flexShrink: 0 }} />
                          <span style={{ flex: 1, color: MUTED }}>{c.name}</span>
                          <span style={{ fontWeight: 600 }}>{fmt(c.value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p style={{ color: MUTED, fontSize: 13, textAlign: "center", paddingTop: 60 }}>No expense data for this period</p>
                )}
              </div>
            </div>

            {/* Net Cash Flow Trend */}
            <div style={styles.card}>
              <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 20, fontFamily: "'Outfit', sans-serif" }}>Net Cash Flow Trend</h3>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={monthlyData}>
                  <defs>
                    <linearGradient id="netGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={ACCENT} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                  <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 11 }} axisLine={{ stroke: BORDER }} />
                  <YAxis tick={{ fill: MUTED, fontSize: 11 }} axisLine={{ stroke: BORDER }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip {...customTooltip} formatter={(v) => fmtFull(v)} />
                  <Area type="monotone" dataKey="net" stroke={ACCENT} fill="url(#netGrad)" strokeWidth={2.5} name="Net Flow" />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Top Expenses */}
            <div style={{ ...styles.card, marginTop: 16 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, fontFamily: "'Outfit', sans-serif" }}>Largest Expenses</h3>
              <div>
                {filtered.filter(t => t.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, 8).map(t => (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${BORDER}`, gap: 12 }}>
                    <span style={styles.badge(CATEGORY_COLORS[t.category] || CATEGORY_COLORS["Other"])}>{t.category}</span>
                    <span style={{ flex: 1, fontSize: 13 }}>{t.description}</span>
                    <span style={{ fontSize: 12, color: MUTED }}>{t.date.toLocaleDateString()}</span>
                    <span style={{ fontWeight: 700, color: "#f87171", fontSize: 14, fontFamily: "'Outfit', sans-serif" }}>{fmtFull(t.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ─── TRANSACTIONS TAB ────────────────────────────────────────── */}
        {view === "transactions" && (
          <div style={styles.card}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16, fontFamily: "'Outfit', sans-serif" }}>All Transactions</h3>
            <div style={{ maxHeight: 600, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>
                    {["Date", "Description", "Category", "Amount"].map(h => (
                      <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, color: MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px", borderBottom: `2px solid ${BORDER}`, position: "sticky", top: 0, background: CARD }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.sort((a, b) => b.date - a.date).map(t => (
                    <tr key={t.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                      <td style={{ padding: "10px 12px", color: MUTED }}>{t.date.toLocaleDateString()}</td>
                      <td style={{ padding: "10px 12px", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.description}</td>
                      <td style={{ padding: "10px 12px" }}>
                        <select
                          value={t.category}
                          onChange={e => updateCategory(t.id, e.target.value)}
                          style={{ ...styles.select, background: `${CATEGORY_COLORS[t.category] || CATEGORY_COLORS["Other"]}18`, color: CATEGORY_COLORS[t.category] || CATEGORY_COLORS["Other"], border: `1px solid ${CATEGORY_COLORS[t.category] || CATEGORY_COLORS["Other"]}44`, fontSize: 12, padding: "4px 8px", fontWeight: 600 }}
                        >
                          {Object.keys(CATEGORY_COLORS).map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: "10px 12px", fontWeight: 700, color: t.amount >= 0 ? ACCENT : "#f87171", fontFamily: "'Outfit', sans-serif" }}>{fmtFull(t.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ─── BUDGET TAB ──────────────────────────────────────────────── */}
        {view === "budget" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Outfit', sans-serif" }}>Budget vs. Actual</h3>
              <p style={{ color: MUTED, fontSize: 13 }}>Click any category to set a budget</p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16 }}>
              {categoryBreakdown.map(cat => {
                const budget = budgets[cat.name] || 0;
                const pct = budget > 0 ? Math.min((cat.value / budget) * 100, 100) : 0;
                const over = budget > 0 && cat.value > budget;
                const color = CATEGORY_COLORS[cat.name] || CATEGORY_COLORS["Other"];

                return (
                  <div key={cat.name} style={{ ...styles.card, cursor: "pointer", transition: "all 0.2s" }}
                    onClick={() => setEditingCategory(editingCategory === cat.name ? null : cat.name)}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 14, height: 14, borderRadius: 4, background: color }} />
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{cat.name}</span>
                      </div>
                      <span style={{ fontWeight: 700, fontSize: 16, fontFamily: "'Outfit', sans-serif", color: over ? "#f87171" : TEXT }}>{fmt(cat.value)}</span>
                    </div>

                    {budget > 0 && (
                      <>
                        <div style={{ background: CARD2, borderRadius: 8, height: 10, overflow: "hidden", marginBottom: 8 }}>
                          <div style={{
                            height: "100%", borderRadius: 8,
                            width: `${pct}%`,
                            background: over ? `linear-gradient(90deg, ${color}, #f87171)` : color,
                            transition: "width 0.5s ease"
                          }} />
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: MUTED }}>
                          <span>{Math.round(pct)}% used</span>
                          <span>{over ? `Over by ${fmt(cat.value - budget)}` : `${fmt(budget - cat.value)} left`}</span>
                        </div>
                      </>
                    )}

                    {!budget && (
                      <p style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>No budget set — click to add one</p>
                    )}

                    {editingCategory === cat.name && (
                      <div style={{ marginTop: 12, display: "flex", gap: 8 }} onClick={e => e.stopPropagation()}>
                        <input
                          type="number"
                          placeholder="Monthly budget..."
                          defaultValue={budget || ""}
                          style={styles.input}
                          onKeyDown={e => {
                            if (e.key === "Enter") {
                              setBudgets(p => ({ ...p, [cat.name]: parseFloat(e.target.value) || 0 }));
                              setEditingCategory(null);
                            }
                          }}
                          autoFocus
                        />
                        <button
                          onClick={(e) => {
                            const input = e.target.previousSibling;
                            setBudgets(p => ({ ...p, [cat.name]: parseFloat(input.value) || 0 }));
                            setEditingCategory(null);
                          }}
                          style={styles.btn("primary")}
                        >Set</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── FORECAST TAB ────────────────────────────────────────────── */}
        {view === "forecast" && (
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, fontFamily: "'Outfit', sans-serif" }}>Cash Flow Forecast</h3>
            <p style={{ color: MUTED, fontSize: 13, marginBottom: 24 }}>
              Based on your last 3 months of activity, here's what the next 3 months could look like.
            </p>

            {forecast.length > 0 && (
              <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
                {forecast.map(f => (
                  <div key={f.month} style={{ ...styles.statCard(f.net >= 0 ? ACCENT : "#f87171"), minWidth: 200 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: ACCENT2, fontFamily: "'Outfit', sans-serif" }}>
                      {f.label} <span style={{ fontSize: 10, color: MUTED, fontWeight: 400 }}>projected</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                      <span style={{ color: MUTED }}>Income</span><span style={{ color: ACCENT, fontWeight: 600 }}>{fmt(f.income)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                      <span style={{ color: MUTED }}>Expenses</span><span style={{ color: "#f87171", fontWeight: 600 }}>{fmt(f.expenses)}</span>
                    </div>
                    <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 8, marginTop: 8, display: "flex", justifyContent: "space-between", fontSize: 14, fontWeight: 700 }}>
                      <span>Net</span><span style={{ color: f.net >= 0 ? ACCENT : "#f87171", fontFamily: "'Outfit', sans-serif" }}>{f.net >= 0 ? "+" : ""}{fmt(f.net)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={styles.card}>
              <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 20, fontFamily: "'Outfit', sans-serif" }}>Historical + Forecast</h3>
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={combinedMonthly}>
                  <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                  <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 11 }} axisLine={{ stroke: BORDER }} />
                  <YAxis tick={{ fill: MUTED, fontSize: 11 }} axisLine={{ stroke: BORDER }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip {...customTooltip} formatter={(v, name) => [fmtFull(v), name.replace("Actual", "").replace("Forecast", " (projected)")]} />
                  <Legend formatter={(value) => value.replace("Actual", "").replace("Forecast", " (proj.)")} />
                  {/* Actual lines — solid */}
                  <Line type="monotone" dataKey="incomeActual" stroke={ACCENT} strokeWidth={2.5} dot={{ fill: ACCENT, r: 4 }}
                    name="Income" connectNulls={false} />
                  <Line type="monotone" dataKey="expensesActual" stroke="#f87171" strokeWidth={2.5} dot={{ fill: "#f87171", r: 4 }}
                    name="Expenses" connectNulls={false} />
                  <Line type="monotone" dataKey="netActual" stroke={ACCENT2} strokeWidth={2} dot={{ fill: ACCENT2, r: 3 }}
                    name="Net Flow" connectNulls={false} />
                  {/* Forecast lines — dashed */}
                  <Line type="monotone" dataKey="incomeForecast" stroke={ACCENT} strokeWidth={2.5} strokeDasharray="8 4"
                    dot={{ fill: ACCENT, r: 4, strokeDasharray: "" }} name="Income Forecast" connectNulls={false} />
                  <Line type="monotone" dataKey="expensesForecast" stroke="#f87171" strokeWidth={2.5} strokeDasharray="8 4"
                    dot={{ fill: "#f87171", r: 4, strokeDasharray: "" }} name="Expenses Forecast" connectNulls={false} />
                  <Line type="monotone" dataKey="netForecast" stroke={ACCENT2} strokeWidth={2} strokeDasharray="8 4"
                    dot={{ fill: ACCENT2, r: 3, strokeDasharray: "" }} name="Net Flow Forecast" connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
              <div style={{ display: "flex", gap: 16, marginTop: 12, justifyContent: "center" }}>
                <span style={{ fontSize: 11, color: MUTED }}>━━ Solid = actual</span>
                <span style={{ fontSize: 11, color: MUTED }}>╌╌ Dashed = projected</span>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Demo Data Generator ─────────────────────────────────────────────────────

function generateDemoData() {
  const merchants = [
    { desc: "Direct Deposit - Payroll", min: 3500, max: 4200, cat: "Income" },
    { desc: "Whole Foods Market", min: 40, max: 180, cat: "Groceries" },
    { desc: "Trader Joe's", min: 25, max: 90, cat: "Groceries" },
    { desc: "Starbucks", min: 4, max: 12, cat: "Dining Out" },
    { desc: "Chipotle Mexican Grill", min: 10, max: 18, cat: "Dining Out" },
    { desc: "Shell Gas Station", min: 35, max: 65, cat: "Transportation" },
    { desc: "Uber", min: 8, max: 35, cat: "Transportation" },
    { desc: "Netflix", min: 15, max: 15, cat: "Entertainment" },
    { desc: "Spotify", min: 10, max: 10, cat: "Entertainment" },
    { desc: "Amazon.com", min: 12, max: 120, cat: "Shopping" },
    { desc: "Target", min: 20, max: 80, cat: "Shopping" },
    { desc: "Rent Payment", min: 1800, max: 1800, cat: "Housing" },
    { desc: "Electric Company", min: 60, max: 140, cat: "Utilities" },
    { desc: "Comcast Internet", min: 70, max: 70, cat: "Utilities" },
    { desc: "CVS Pharmacy", min: 8, max: 45, cat: "Health" },
    { desc: "Planet Fitness", min: 25, max: 25, cat: "Health" },
    { desc: "State Farm Insurance", min: 120, max: 120, cat: "Insurance" },
  ];

  const txns = [];
  let id = 0;

  for (let m = 0; m < 6; m++) {
    const baseDate = new Date(2025, 7 - m, 1);

    // Payroll (2x/month)
    txns.push({ id: id++, date: new Date(baseDate.getFullYear(), baseDate.getMonth(), 1), description: "Direct Deposit - Payroll", amount: 3500 + Math.random() * 700, category: "Income" });
    txns.push({ id: id++, date: new Date(baseDate.getFullYear(), baseDate.getMonth(), 15), description: "Direct Deposit - Payroll", amount: 3500 + Math.random() * 700, category: "Income" });

    // Monthly bills
    txns.push({ id: id++, date: new Date(baseDate.getFullYear(), baseDate.getMonth(), 1), description: "Rent Payment", amount: -1800, category: "Housing" });
    txns.push({ id: id++, date: new Date(baseDate.getFullYear(), baseDate.getMonth(), 5), description: "Electric Company", amount: -(60 + Math.random() * 80), category: "Utilities" });
    txns.push({ id: id++, date: new Date(baseDate.getFullYear(), baseDate.getMonth(), 8), description: "Comcast Internet", amount: -70, category: "Utilities" });
    txns.push({ id: id++, date: new Date(baseDate.getFullYear(), baseDate.getMonth(), 12), description: "State Farm Insurance", amount: -120, category: "Insurance" });
    txns.push({ id: id++, date: new Date(baseDate.getFullYear(), baseDate.getMonth(), 1), description: "Netflix", amount: -15.49, category: "Entertainment" });
    txns.push({ id: id++, date: new Date(baseDate.getFullYear(), baseDate.getMonth(), 1), description: "Spotify", amount: -10.99, category: "Entertainment" });
    txns.push({ id: id++, date: new Date(baseDate.getFullYear(), baseDate.getMonth(), 3), description: "Planet Fitness", amount: -25, category: "Health" });

    // Variable spending
    for (let d = 0; d < 20; d++) {
      const pick = merchants[Math.floor(Math.random() * merchants.length)];
      if (pick.cat === "Income" || pick.cat === "Housing" || pick.cat === "Insurance") continue;
      const day = Math.floor(Math.random() * 28) + 1;
      const amt = pick.min + Math.random() * (pick.max - pick.min);
      txns.push({
        id: id++,
        date: new Date(baseDate.getFullYear(), baseDate.getMonth(), day),
        description: pick.desc,
        amount: -Math.round(amt * 100) / 100,
        category: pick.cat
      });
    }
  }

  return txns.sort((a, b) => b.date - a.date);
}
