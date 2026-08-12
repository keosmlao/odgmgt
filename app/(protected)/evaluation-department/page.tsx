"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import api from "@/service/api";

export default function EvaluationDepartment() {
  const [form, setForm] = useState({ weightBalancedScorecard: 30, weightMatrix: 70 });
  const [departments, setDepartments] = useState<any[]>([]);
  const [department, setDepartment] = useState("ALL");
  const [loadingWeights, setLoadingWeights] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [allWeights, setAllWeights] = useState<any[]>([]);
  const [loadingAllWeights, setLoadingAllWeights] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [balancedRows, setBalancedRows] = useState([{ id: "revenue", label: "Revenue", percent: 25 }, { id: "customer", label: "Customer", percent: 25 }, { id: "employee", label: "Employee", percent: 25 }, { id: "top5", label: "Top 5", percent: 25 }]);
  const [matrixRows, setMatrixRows] = useState([{ id: "performance", label: "Performance", percent: 50 }, { id: "potential", label: "Potential", percent: 50 }]);

  const clampPercent = (value: number) => { if (Number.isNaN(value)) return 0; return Math.min(100, Math.max(0, value)); };
  const normalizeNumericInput = (raw: any) => { const map: Record<string, string> = { "\u0ED0": "0", "\u0ED1": "1", "\u0ED2": "2", "\u0ED3": "3", "\u0ED4": "4", "\u0ED5": "5", "\u0ED6": "6", "\u0ED7": "7", "\u0ED8": "8", "\u0ED9": "9" }; return String(raw ?? "").replace(/[\u0ED0-\u0ED9]/g, (ch) => map[ch] || ch); };

  const update = (key: string, rawValue: any) => { const normalized = normalizeNumericInput(rawValue); const parsed = Number(normalized); if (Number.isNaN(parsed)) return; const value = clampPercent(parsed); setIsDirty(true); dirtyRef.current = true; setForm((prev) => { if (key === "weightBalancedScorecard") return { ...prev, weightBalancedScorecard: value, weightMatrix: 100 - value }; if (key === "weightMatrix") return { ...prev, weightMatrix: value, weightBalancedScorecard: 100 - value }; return { ...prev, [key]: value }; }); };
  const updateRowPercent = (setter: any, rows: any[], id: string, rawValue: any) => { const normalized = normalizeNumericInput(rawValue); const parsed = Number(normalized); if (Number.isNaN(parsed)) return; const value = clampPercent(parsed); setter(rows.map((row: any) => (row.id === id ? { ...row, percent: value } : row))); };
  const sumPercent = (rows: any[]) => rows.reduce((acc, row) => acc + Number(row.percent || 0), 0);

  const loadAllWeights = async () => { setLoadingAllWeights(true); try { const res = await api.get("/evaluation-weights"); if (res.data?.success) setAllWeights(res.data.data || []); } catch (err) { console.error("Failed to load evaluation weights list", err); } finally { setLoadingAllWeights(false); } };

  useEffect(() => { const loadDepartments = async () => { try { const res = await api.get("/departments"); if (res.data?.success) setDepartments(res.data.data || []); } catch (err) { console.error("Failed to load departments", err); } }; loadDepartments(); }, []);
  useEffect(() => { const loadWeights = async () => { setLoadingWeights(true); try { const res = await api.get("/evaluation-weights", { params: { department } }); const row = res.data?.data; if (row && !dirtyRef.current) setForm({ weightBalancedScorecard: Number(row.weight_balanced_scorecard || 0), weightMatrix: Number(row.weight_matrix || 0) }); else if (!row) setForm({ weightBalancedScorecard: 30, weightMatrix: 70 }); } catch { if (!dirtyRef.current) setForm({ weightBalancedScorecard: 30, weightMatrix: 70 }); } finally { setLoadingWeights(false); } }; loadWeights(); }, [department]);
  useEffect(() => { loadAllWeights(); }, []);

  const saveWeights = async () => { setSaving(true); setSaveStatus(""); try { const payload = { department_code: department, weight_balanced_scorecard: form.weightBalancedScorecard, weight_matrix: form.weightMatrix }; const res = await api.post("/evaluation-weights", payload); if (res.data?.success) { setSaveStatus("Saved successfully"); setIsDirty(false); dirtyRef.current = false; await loadAllWeights(); } else { setSaveStatus("Save failed"); } } catch { setSaveStatus("Save failed"); } finally { setSaving(false); } };

  const departmentNameMap = new Map((departments || []).map((d: any) => [String(d.code), d.name_1 || d.code]));
  const getDepartmentLabel = (code: string) => { if (code === "ALL") return "All Departments"; return departmentNameMap.get(String(code)) || code; };

  return (
    <div className="min-h-screen bg-transparent text-[var(--ink)]">
      <div className="page mx-auto max-w-[1100px]">
        <div className="space-y-3">
          {/* Header */}
          <div className="card p-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="eyebrow">Performance framework</p>
                <h1 className="page-title">Department Weights</h1>
                <p className="page-sub">Configure Balanced Scorecard and 3x3 Matrix weights by department</p>
              </div>
              <Link href="/evaluation" className="btn">Back</Link>
            </div>
          </div>

          {/* Weight Configuration */}
          <div className="card p-4">
            <h2 className="card-title mb-3">Weight Configuration</h2>
            <div className="grid gap-4 md:grid-cols-2 text-sm">
              <div className="md:col-span-2">
                <label className="field-label">Department</label>
                <select value={department} onChange={(e) => { setIsDirty(false); dirtyRef.current = false; setDepartment(e.target.value); }} className="select">
                  <option value="ALL">All Departments</option>
                  {departments.map((d: any) => <option key={d.code} value={d.code}>{d.name_1 || d.code}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label">Balanced Scorecard (%)</label>
                <input type="number" readOnly min="0" max="100" value={form.weightBalancedScorecard} onChange={(e) => update("weightBalancedScorecard", e.target.value)} className="select" />
                <p className="mt-1 text-xs text-[var(--muted)]">{loadingWeights ? "Loading..." : "Total should equal 100"}</p>
              </div>
              <div>
                <label className="field-label">3x3 Matrix (%)</label>
                <input type="number" readOnly min="0" max="100" value={form.weightMatrix} onChange={(e) => update("weightMatrix", e.target.value)} className="select" />
                <p className="mt-1 text-xs text-[var(--muted)]">{loadingWeights ? "Loading..." : "Weights auto-balance"}</p>
              </div>
            </div>
          </div>

          {/* Scorecard + Matrix side by side */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Balanced Scorecard */}
            <div className="card p-4">
              <div className="flex items-center justify-between gap-2 mb-4">
                <div>
                  <h2 className="card-title">Balanced Scorecard</h2>
                  <p className="text-xs text-[var(--muted)] mt-0.5">Set weights for each category</p>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-md ${sumPercent(balancedRows) === 100 ? "bg-[var(--pos-bg)] text-[var(--pos)]" : "bg-[var(--warn-bg)] text-[var(--warn)]"}`}>Total {sumPercent(balancedRows)}%</span>
              </div>
              <table className="w-full text-left text-sm">
                <thead className="bg-[var(--surface-2)] text-xs text-[var(--muted)] font-medium uppercase">
                  <tr>
                    <th className="px-3 py-2 rounded-tl-lg">Item</th>
                    <th className="px-3 py-2 text-right rounded-tr-lg">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line-soft)]">
                  {balancedRows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2 font-medium text-[var(--ink-soft)]">{row.label}</td>
                      <td className="px-3 py-2 text-right">
                        <input type="number" min="0" max="100" value={row.percent} onChange={(e) => updateRowPercent(setBalancedRows, balancedRows, row.id, e.target.value)} className="input w-16 text-right" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 3x3 Matrix */}
            <div className="card p-4">
              <div className="flex items-center justify-between gap-2 mb-4">
                <div>
                  <h2 className="card-title">3x3 Matrix</h2>
                  <p className="text-xs text-[var(--muted)] mt-0.5">Set axis weights</p>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-md ${sumPercent(matrixRows) === 100 ? "bg-[var(--pos-bg)] text-[var(--pos)]" : "bg-[var(--warn-bg)] text-[var(--warn)]"}`}>Total {sumPercent(matrixRows)}%</span>
              </div>
              <table className="w-full text-left text-sm">
                <thead className="bg-[var(--surface-2)] text-xs text-[var(--muted)] font-medium uppercase">
                  <tr>
                    <th className="px-3 py-2 rounded-tl-lg">Axis</th>
                    <th className="px-3 py-2 text-right rounded-tr-lg">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line-soft)]">
                  {matrixRows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2 font-medium text-[var(--ink-soft)]">{row.label}</td>
                      <td className="px-3 py-2 text-right">
                        <input type="number" min="0" max="100" value={row.percent} onChange={(e) => updateRowPercent(setMatrixRows, matrixRows, row.id, e.target.value)} className="input w-16 text-right" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Configuration Data table */}
          <div className="card p-4">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="card-title">Configuration Data</h2>
                <p className="text-xs text-[var(--muted)] mt-0.5">Saved weights by department</p>
              </div>
              {loadingAllWeights && <span className="text-xs font-medium text-[var(--muted)]">Loading...</span>}
            </div>
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--surface-2)] text-xs text-[var(--muted)] font-medium uppercase">
                <tr>
                  <th className="px-3 py-2">Department</th>
                  <th className="px-3 py-2 text-right">Balanced Scorecard (%)</th>
                  <th className="px-3 py-2 text-right">3x3 Matrix (%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line-soft)]">
                {allWeights.length === 0 ? (
                  <tr><td className="px-3 py-3 text-[var(--muted)]" colSpan={3}>No data yet</td></tr>
                ) : allWeights.map((row: any) => (
                  <tr key={row.department_code} className="hover:bg-[var(--surface-2)] transition-colors duration-150">
                    <td className="px-3 py-2 font-medium text-[var(--ink-soft)]">{getDepartmentLabel(row.department_code)}</td>
                    <td className="px-3 py-2 text-right">{Number(row.weight_balanced_scorecard || 0)}%</td>
                    <td className="px-3 py-2 text-right">{Number(row.weight_matrix || 0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Save button */}
          <div className="flex items-center justify-end gap-3">
            {saveStatus && <span className="text-xs font-medium text-[var(--muted)]">{saveStatus}</span>}
            <button type="button" onClick={saveWeights} disabled={saving} className="rounded-md px-4 py-2 text-sm font-medium bg-[var(--brand-deep)] text-white hover:brightness-110 transition-colors duration-150 disabled:opacity-70 disabled:cursor-not-allowed">
              {saving ? "Saving..." : "Save Configuration"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
