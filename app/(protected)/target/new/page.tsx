"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import api from "@/service/api";

const FALLBACK_CHANNELS = [{ code: "101", name: "Retail" }, { code: "102", name: "Wholesale" }, { code: "103", name: "Technician" }, { code: "106", name: "Project" }];
const MONTHS = [{ value: 1, label: "Jan" }, { value: 2, label: "Feb" }, { value: 3, label: "Mar" }, { value: 4, label: "Apr" }, { value: 5, label: "May" }, { value: 6, label: "Jun" }, { value: 7, label: "Jul" }, { value: 8, label: "Aug" }, { value: 9, label: "Sep" }, { value: 10, label: "Oct" }, { value: 11, label: "Nov" }, { value: 12, label: "Dec" }];

interface Option { code: string; name: string }
interface FormState {
  year: number;
  bu: string;
  channel: string;
  province: string;
  district: string;
  month: number;
  target: string | number;
  note: string;
}
interface Draft extends FormState {
  id: number;
  target: number;
  buName: string;
  provinceName: string;
  districtName: string;
  channelName: string;
}

export default function TargetCreate() {
  const router = useRouter();
  const [buOptions, setBuOptions] = useState<Option[]>([]);
  const [provinceOptions, setProvinceOptions] = useState([{ code: "ALL", name: "Nationwide" }]);
  const [districtOptions, setDistrictOptions] = useState([{ code: "ALL", name: "All" }]);
  const [channelOptions, setChannelOptions] = useState(FALLBACK_CHANNELS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [existingTargets, setExistingTargets] = useState<Record<string, unknown>[]>([]);
  const buSelectRef = useRef<HTMLSelectElement>(null);
  const [form, setForm] = useState<FormState>({ year: new Date().getFullYear(), bu: "", channel: FALLBACK_CHANNELS[0].code, province: "ALL", district: "ALL", month: 1, target: "", note: "" });

  const isVientianeCapital = (code: string) => { if (!code || code === "ALL") return false; const lower = code.toLowerCase(); return lower === "01" || lower.includes("capital") || lower.includes("vientiane"); };
  const handleChange = (field: keyof FormState, value: string | number) => { setForm((prev) => { const newState = { ...prev, [field]: value }; if (field === "province") newState.district = isVientianeCapital(String(value)) ? "" : "ALL"; return newState; }); };

  useEffect(() => { const fetchData = async () => { try { const [buRes, provRes, targetRes, chanRes] = await Promise.allSettled([api.get("/bu"), api.get("/provinces"), api.get("/targets"), api.get("/sale-channel")]); if (buRes.status === "fulfilled" && buRes.value.data.success) setBuOptions(buRes.value.data.data.map((b: Record<string, unknown>) => ({ code: String(b.code), name: String(b.name_1 || b.name || b.code) }))); if (provRes.status === "fulfilled" && provRes.value.data.success) setProvinceOptions([{ code: "ALL", name: "Nationwide" }, ...provRes.value.data.data.map((p: Record<string, unknown>) => ({ code: String(p.code), name: String(p.name_1 || p.name || p.code) }))]); if (targetRes.status === "fulfilled" && targetRes.value.data.success) setExistingTargets(targetRes.value.data.data); if (chanRes.status === "fulfilled" && chanRes.value.data.success && chanRes.value.data.data.length) { const mapped = chanRes.value.data.data.map((c: Record<string, unknown>) => ({ code: String(c.code), name: String(c.name_1 || c.name || c.code) })); setChannelOptions(mapped); setForm((prev) => ({ ...prev, channel: mapped[0].code })); } } catch {} }; fetchData(); }, []);
  useEffect(() => { if (buSelectRef.current) buSelectRef.current.focus(); }, []);
  useEffect(() => { const loadDistricts = async () => { if (!isVientianeCapital(form.province)) { setDistrictOptions([{ code: "ALL", name: "All" }]); return; } try { const { data } = await api.get("/amphur", { params: { province_code: form.province } }); if (data.success && Array.isArray(data.data)) setDistrictOptions(data.data.map((d: Record<string, unknown>) => ({ code: String(d.code), name: String(d.name_1 || d.name || d.code) }))); } catch { setDistrictOptions([{ code: "ALL", name: "All" }]); } }; loadDistricts(); }, [form.province]);

  const availableMonthsForSelection = useMemo(() => { if (!form.bu || !form.channel) return MONTHS; const used = new Set([...drafts, ...existingTargets.map((t: Record<string, unknown>) => ({ bu: t.bu_code || t.bu, province: t.province_code || t.province, district: t.district_code || t.district, year: t.year || t.target_year, month: t.month || t.target_month, channel: t.sale_channel || t.channel }))].filter((d: Record<string, unknown>) => d.bu === form.bu && d.channel === form.channel && (d.province || "ALL") === form.province && (d.district || "ALL") === (form.district || "ALL") && d.year === form.year).map((d: Record<string, unknown>) => d.month)); return MONTHS.filter(m => !used.has(m.value)); }, [drafts, existingTargets, form.bu, form.channel, form.province, form.district, form.year]);
  useEffect(() => { if (!availableMonthsForSelection.some(m => m.value === form.month)) setForm((prev) => ({ ...prev, month: availableMonthsForSelection[0]?.value ?? prev.month })); }, [availableMonthsForSelection, form.month]);

  const handleAddDraft = (e: React.FormEvent) => { e.preventDefault(); setError(""); if (!form.bu) return buSelectRef.current?.focus(); if (form.bu && form.channel && availableMonthsForSelection.length === 0) return setError("Month already used"); if (!form.target || Number(form.target) <= 0) return setError("Invalid Target Amount"); if (isVientianeCapital(form.province) && !form.district) return setError("Please select district"); const channelObj = channelOptions.find(c => c.code === form.channel); const entry = { id: Date.now(), ...form, target: Number(form.target), buName: buOptions.find(b => b.code === form.bu)?.name || form.bu, provinceName: provinceOptions.find(p => p.code === form.province)?.name || form.province, districtName: districtOptions.find(d => d.code === form.district)?.name || form.district, channelName: channelObj?.name || form.channel, channel: channelObj?.code || form.channel }; setDrafts(prev => [entry, ...prev]); setForm((prev) => ({ ...prev, target: "", note: "" })); };
  const handleSaveAll = async () => { setError(""); if (!drafts.length) return setError("Draft is empty"); setSaving(true); try { for (const d of drafts) { await api.post("/targets", { bu_code: d.bu, province: d.province || "ALL", district: d.district || "ALL", channel: d.channel, target: d.target, year: d.year, month: d.month, note: d.note }); } router.replace("/target"); } catch (err) { setError((err as { response?: { data?: { message?: string } } }).response?.data?.message || "Save failed"); } finally { setSaving(false); } };
  const totalDraftAmount = drafts.reduce((sum, item) => sum + item.target, 0);

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-800">
      {/* Header */}
      <div className="border-b border-slate-200 dark:border-slate-800 bg-white px-4 py-3 flex justify-between items-center shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Create Targets</h1>
          <p className="text-xs text-slate-500">Sales Management - New Entry</p>
        </div>
        <button onClick={() => router.back()} className="rounded-md px-4 py-2 text-sm font-medium border border-slate-300 hover:bg-slate-50 transition-colors duration-150">Back to List</button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden p-4">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 h-full">
          {/* Left: Form */}
          <div className="lg:col-span-4 flex flex-col gap-4 overflow-y-auto">
            <div className="bg-white rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm p-4">
              <h2 className="font-semibold text-base text-slate-800 mb-4">Target Details</h2>
              <form onSubmit={handleAddDraft} className="space-y-4">
                {/* Period */}
                <div>
                  <label className="block text-xs font-medium text-slate-500 uppercase mb-1.5">Period</label>
                  <div className="grid grid-cols-3 gap-2">
                    <input type="number" value={form.year} onChange={(e) => handleChange("year", Number(e.target.value))} className="rounded-md border border-slate-300 px-3 py-2 text-sm text-center focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none" />
                    <div className="col-span-2">
                      <select value={form.month} onChange={(e) => handleChange("month", Number(e.target.value))} disabled={!form.bu || !form.channel} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none disabled:bg-slate-100 disabled:text-slate-400 bg-white">
                        {availableMonthsForSelection.length === 0 ? <option value="">Full / No Slots</option> : availableMonthsForSelection.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </div>
                  </div>
                </div>

                {/* Business & Channel */}
                <div>
                  <label className="block text-xs font-medium text-slate-500 uppercase mb-1.5">Business & Channel</label>
                  <div className="space-y-2">
                    <select value={form.bu} onChange={(e) => handleChange("bu", e.target.value)} ref={buSelectRef} className={`w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none bg-white ${error && !form.bu ? "border-rose-500" : "border-slate-300"}`}>
                      <option value="">Select Business Unit...</option>
                      {buOptions.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
                    </select>
                    <select value={form.channel} onChange={(e) => handleChange("channel", e.target.value)} disabled={!form.bu} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none disabled:bg-slate-100 disabled:text-slate-400 bg-white">
                      {channelOptions.map((ch) => <option key={ch.code} value={ch.code}>{ch.name}</option>)}
                    </select>
                  </div>
                </div>

                {/* Location */}
                <div>
                  <label className="block text-xs font-medium text-slate-500 uppercase mb-1.5">Location</label>
                  <div className="space-y-2">
                    <select value={form.province} onChange={(e) => handleChange("province", e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none bg-white">
                      {provinceOptions.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                    </select>
                    {isVientianeCapital(form.province) && (
                      <select value={form.district} onChange={(e) => handleChange("district", e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none bg-white">
                        {districtOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                      </select>
                    )}
                  </div>
                </div>

                <hr className="border-slate-200 dark:border-slate-800" />

                {/* Target Value */}
                <div>
                  <label className="block text-xs font-medium text-slate-500 uppercase mb-1.5">Target Amount (LAK)</label>
                  <input type="number" value={form.target} onChange={(e) => handleChange("target", e.target.value)} placeholder="0" min="0" className="w-full rounded-md border border-slate-300 px-3 py-2 text-base font-semibold focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none" />
                </div>

                {/* Note */}
                <div>
                  <label className="block text-xs font-medium text-slate-500 uppercase mb-1.5">Note (Optional)</label>
                  <textarea value={form.note} onChange={(e) => handleChange("note", e.target.value)} rows={2} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none resize-none" />
                </div>

                {error && (
                  <div className="p-3 bg-rose-50 text-rose-700 text-sm rounded-lg border border-rose-200">{error}</div>
                )}

                <button type="submit" className="w-full rounded-md px-4 py-2 text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors duration-150">+ Add to List</button>
              </form>
            </div>
          </div>

          {/* Right: Draft table */}
          <div className="lg:col-span-8 flex flex-col h-full gap-4 overflow-hidden">
            {/* Stats */}
            <div className="grid grid-cols-2 gap-4 shrink-0">
              <div className="bg-white p-4 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm">
                <p className="text-xs font-medium text-slate-500">Pending Items</p>
                <p className="text-xl font-semibold text-slate-800 mt-1">{drafts.length}</p>
              </div>
              <div className="bg-white p-4 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm">
                <p className="text-xs font-medium text-emerald-600">Total Value (LAK)</p>
                <p className="text-xl font-semibold text-slate-800 mt-1">{totalDraftAmount.toLocaleString()}</p>
              </div>
            </div>

            {/* Draft table */}
            <div className="flex-1 bg-white rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center">
                <h2 className="font-semibold text-base text-slate-800">Review Drafts</h2>
                {drafts.length > 0 && (
                  <button onClick={() => setDrafts([])} className="text-xs font-medium text-rose-500 hover:text-rose-700 px-2 py-1 hover:bg-rose-50 rounded-md transition-colors duration-150">Clear All</button>
                )}
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 sticky top-0 text-xs font-medium text-slate-500 uppercase">
                    <tr>
                      <th className="px-4 py-2 border-b border-slate-200 dark:border-slate-800">Business & Channel</th>
                      <th className="px-4 py-2 border-b border-slate-200 dark:border-slate-800">Location</th>
                      <th className="px-4 py-2 border-b border-slate-200 dark:border-slate-800">Month</th>
                      <th className="px-4 py-2 border-b border-slate-200 dark:border-slate-800 text-right">Target</th>
                      <th className="px-4 py-2 border-b border-slate-200 dark:border-slate-800 w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {drafts.length === 0 ? (
                      <tr>
                        <td colSpan={5}>
                          <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                            <p className="font-medium">No targets added yet</p>
                            <p className="text-xs mt-1">Fill the form on the left to start</p>
                          </div>
                        </td>
                      </tr>
                    ) : drafts.map((d) => (
                      <tr key={d.id} className="group hover:bg-slate-50 transition-colors duration-150">
                        <td className="px-4 py-2">
                          <div className="font-semibold text-slate-800">{d.buName}</div>
                          <div className="text-xs text-slate-500">{d.channelName}</div>
                        </td>
                        <td className="px-4 py-2">
                          <div className="text-slate-700">{d.provinceName}</div>
                          {d.districtName !== "ALL" && d.districtName !== "All" && <div className="text-xs text-blue-600 font-medium">- {d.districtName}</div>}
                        </td>
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100">{MONTHS.find(m => m.value === d.month)?.label} {d.year}</span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono font-semibold text-slate-700">{d.target.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right">
                          <button onClick={() => setDrafts(prev => prev.filter(x => x.id !== d.id))} className="p-1 text-slate-300 hover:text-rose-500 hover:bg-rose-50 rounded-md transition-colors duration-150 opacity-0 group-hover:opacity-100">&#10005;</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-white">
                <button
                  disabled={saving || drafts.length === 0}
                  onClick={handleSaveAll}
                  className={`w-full rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150 ${saving || drafts.length === 0 ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"}`}
                >
                  {saving ? "Saving..." : `Confirm & Save ${drafts.length} Targets`}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
