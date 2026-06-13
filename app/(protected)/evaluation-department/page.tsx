"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import api from "@/service/api";

interface WeightRow {
  id: string;
  label: string;
  percent: number;
}

type DepartmentRow = Record<string, unknown>;
type SavedWeightRow = Record<string, unknown>;

export default function EvaluationDepartment() {
  const [form, setForm] = useState({ weightBalancedScorecard: 30, weightMatrix: 70 });
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [department, setDepartment] = useState("ALL");
  const [loadingWeights, setLoadingWeights] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [allWeights, setAllWeights] = useState<SavedWeightRow[]>([]);
  const [loadingAllWeights, setLoadingAllWeights] = useState(false);
  const [, setIsDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [balancedRows, setBalancedRows] = useState<WeightRow[]>([{ id: "revenue", label: "Revenue", percent: 25 }, { id: "customer", label: "Customer", percent: 25 }, { id: "employee", label: "Employee", percent: 25 }, { id: "top5", label: "Top 5", percent: 25 }]);
  const [matrixRows, setMatrixRows] = useState<WeightRow[]>([{ id: "performance", label: "Performance", percent: 50 }, { id: "potential", label: "Potential", percent: 50 }]);

  const clampPercent = (value: number) => { if (Number.isNaN(value)) return 0; return Math.min(100, Math.max(0, value)); };
  const normalizeNumericInput = (raw: unknown) => { const map: Record<string, string> = { "\u0ED0": "0", "\u0ED1": "1", "\u0ED2": "2", "\u0ED3": "3", "\u0ED4": "4", "\u0ED5": "5", "\u0ED6": "6", "\u0ED7": "7", "\u0ED8": "8", "\u0ED9": "9" }; return String(raw ?? "").replace(/[\u0ED0-\u0ED9]/g, (ch) => map[ch] || ch); };

  const update = (key: string, rawValue: unknown) => { const normalized = normalizeNumericInput(rawValue); const parsed = Number(normalized); if (Number.isNaN(parsed)) return; const value = clampPercent(parsed); setIsDirty(true); dirtyRef.current = true; setForm((prev) => { if (key === "weightBalancedScorecard") return { ...prev, weightBalancedScorecard: value, weightMatrix: 100 - value }; if (key === "weightMatrix") return { ...prev, weightMatrix: value, weightBalancedScorecard: 100 - value }; return { ...prev, [key]: value }; }); };
  const updateRowPercent = (setter: React.Dispatch<React.SetStateAction<WeightRow[]>>, rows: WeightRow[], id: string, rawValue: unknown) => { const normalized = normalizeNumericInput(rawValue); const parsed = Number(normalized); if (Number.isNaN(parsed)) return; const value = clampPercent(parsed); setter(rows.map((row) => (row.id === id ? { ...row, percent: value } : row))); };
  const sumPercent = (rows: WeightRow[]) => rows.reduce((acc, row) => acc + Number(row.percent || 0), 0);

  const loadAllWeights = async () => { setLoadingAllWeights(true); try { const res = await api.get("/evaluation-weights"); if (res.data?.success) setAllWeights(res.data.data || []); } catch (err) { console.error("Failed to load evaluation weights list", err); } finally { setLoadingAllWeights(false); } };

  useEffect(() => { const loadDepartments = async () => { try { const res = await api.get("/departments"); if (res.data?.success) setDepartments(res.data.data || []); } catch (err) { console.error("Failed to load departments", err); } }; loadDepartments(); }, []);
  useEffect(() => { const loadWeights = async () => { setLoadingWeights(true); try { const res = await api.get("/evaluation-weights", { params: { department } }); const row = res.data?.data; if (row && !dirtyRef.current) setForm({ weightBalancedScorecard: Number(row.weight_balanced_scorecard || 0), weightMatrix: Number(row.weight_matrix || 0) }); else if (!row) setForm({ weightBalancedScorecard: 30, weightMatrix: 70 }); } catch { if (!dirtyRef.current) setForm({ weightBalancedScorecard: 30, weightMatrix: 70 }); } finally { setLoadingWeights(false); } }; loadWeights(); }, [department]);
  useEffect(() => { loadAllWeights(); }, []);

  const saveWeights = async () => { setSaving(true); setSaveStatus(""); try { const payload = { department_code: department, weight_balanced_scorecard: form.weightBalancedScorecard, weight_matrix: form.weightMatrix }; const res = await api.post("/evaluation-weights", payload); if (res.data?.success) { setSaveStatus("Saved successfully"); setIsDirty(false); dirtyRef.current = false; await loadAllWeights(); } else { setSaveStatus("Save failed"); } } catch { setSaveStatus("Save failed"); } finally { setSaving(false); } };

  const departmentNameMap = new Map((departments || []).map((d) => [String(d.code), String(d.name_1 || d.code)]));
  const getDepartmentLabel = (code: string) => { if (code === "ALL") return "All Departments"; return departmentNameMap.get(String(code)) || code; };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <div className="mx-auto max-w-[1200px] px-4 py-6">
        <div className="space-y-6">
          {/* Header */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h1 className="text-xl font-semibold text-slate-900">Department Weights</h1>
                <p className="mt-1 text-sm text-slate-500">Configure Balanced Scorecard and 3x3 Matrix weights by department</p>
              </div>
              <Link href="/evaluation" className="rounded-md px-4 py-2 text-sm font-medium border border-slate-300 hover:bg-slate-50 transition-colors duration-150 text-center">Back</Link>
            </div>
          </div>

          {/* Weight Configuration */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-slate-800 mb-4">Weight Configuration</h2>
            <div className="grid gap-4 md:grid-cols-2 text-sm">
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Department</label>
                <select value={department} onChange={(e) => { setIsDirty(false); dirtyRef.current = false; setDepartment(e.target.value); }} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none bg-white">
                  <option value="ALL">All Departments</option>
                  {departments.map((d) => <option key={String(d.code)} value={String(d.code)}>{String(d.name_1 || d.code)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Balanced Scorecard (%)</label>
                <input type="number" readOnly min="0" max="100" value={form.weightBalancedScorecard} onChange={(e) => update("weightBalancedScorecard", e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none bg-white" />
                <p className="mt-1 text-xs text-slate-400">{loadingWeights ? "Loading..." : "Total should equal 100"}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">3x3 Matrix (%)</label>
                <input type="number" readOnly min="0" max="100" value={form.weightMatrix} onChange={(e) => update("weightMatrix", e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none bg-white" />
                <p className="mt-1 text-xs text-slate-400">{loadingWeights ? "Loading..." : "Weights auto-balance"}</p>
              </div>
            </div>
          </div>

          {/* Scorecard + Matrix side by side */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Balanced Scorecard */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between gap-2 mb-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-800">Balanced Scorecard</h2>
                  <p className="text-xs text-slate-400 mt-0.5">Set weights for each category</p>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-md ${sumPercent(balancedRows) === 100 ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"}`}>Total {sumPercent(balancedRows)}%</span>
              </div>
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 font-medium uppercase">
                  <tr>
                    <th className="px-3 py-2 rounded-tl-lg">Item</th>
                    <th className="px-3 py-2 text-right rounded-tr-lg">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {balancedRows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2 font-medium text-slate-700">{row.label}</td>
                      <td className="px-3 py-2 text-right">
                        <input type="number" min="0" max="100" value={row.percent} onChange={(e) => updateRowPercent(setBalancedRows, balancedRows, row.id, e.target.value)} className="w-20 rounded-md border border-slate-300 px-3 py-2 text-sm text-right focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 3x3 Matrix */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between gap-2 mb-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-800">3x3 Matrix</h2>
                  <p className="text-xs text-slate-400 mt-0.5">Set axis weights</p>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-md ${sumPercent(matrixRows) === 100 ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"}`}>Total {sumPercent(matrixRows)}%</span>
              </div>
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 font-medium uppercase">
                  <tr>
                    <th className="px-3 py-2 rounded-tl-lg">Axis</th>
                    <th className="px-3 py-2 text-right rounded-tr-lg">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {matrixRows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2 font-medium text-slate-700">{row.label}</td>
                      <td className="px-3 py-2 text-right">
                        <input type="number" min="0" max="100" value={row.percent} onChange={(e) => updateRowPercent(setMatrixRows, matrixRows, row.id, e.target.value)} className="w-20 rounded-md border border-slate-300 px-3 py-2 text-sm text-right focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Configuration Data table */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-800">Configuration Data</h2>
                <p className="text-xs text-slate-400 mt-0.5">Saved weights by department</p>
              </div>
              {loadingAllWeights && <span className="text-xs font-medium text-slate-400">Loading...</span>}
            </div>
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 font-medium uppercase">
                <tr>
                  <th className="px-3 py-2">Department</th>
                  <th className="px-3 py-2 text-right">Balanced Scorecard (%)</th>
                  <th className="px-3 py-2 text-right">3x3 Matrix (%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {allWeights.length === 0 ? (
                  <tr><td className="px-3 py-3 text-slate-400" colSpan={3}>No data yet</td></tr>
                ) : allWeights.map((row) => (
                  <tr key={String(row.department_code)} className="hover:bg-slate-50 transition-colors duration-150">
                    <td className="px-3 py-2 font-medium text-slate-700">{getDepartmentLabel(String(row.department_code))}</td>
                    <td className="px-3 py-2 text-right">{Number(row.weight_balanced_scorecard || 0)}%</td>
                    <td className="px-3 py-2 text-right">{Number(row.weight_matrix || 0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Save button */}
          <div className="flex items-center justify-end gap-3">
            {saveStatus && <span className="text-xs font-medium text-slate-500">{saveStatus}</span>}
            <button type="button" onClick={saveWeights} disabled={saving} className="rounded-md px-4 py-2 text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors duration-150 disabled:opacity-70 disabled:cursor-not-allowed">
              {saving ? "Saving..." : "Save Configuration"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
