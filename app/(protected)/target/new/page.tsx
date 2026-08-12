"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, ClipboardList, Plus, Sparkles, Trash2 } from "lucide-react";
import api from "@/service/api";

const FALLBACK_CHANNELS = [{ code: "101", name: "Retail" }, { code: "102", name: "Wholesale" }, { code: "103", name: "Technician" }, { code: "106", name: "Project" }];
const MONTHS = [{ value: 1, label: "Jan" }, { value: 2, label: "Feb" }, { value: 3, label: "Mar" }, { value: 4, label: "Apr" }, { value: 5, label: "May" }, { value: 6, label: "Jun" }, { value: 7, label: "Jul" }, { value: 8, label: "Aug" }, { value: 9, label: "Sep" }, { value: 10, label: "Oct" }, { value: 11, label: "Nov" }, { value: 12, label: "Dec" }];

export default function TargetCreate() {
  const router = useRouter();
  const [buOptions, setBuOptions] = useState<any[]>([]);
  const [provinceOptions, setProvinceOptions] = useState([{ code: "ALL", name: "Nationwide" }]);
  const [districtOptions, setDistrictOptions] = useState([{ code: "ALL", name: "All" }]);
  const [channelOptions, setChannelOptions] = useState(FALLBACK_CHANNELS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<any[]>([]);
  const [existingTargets, setExistingTargets] = useState<any[]>([]);
  const buSelectRef = useRef<HTMLSelectElement>(null);
  const [form, setForm] = useState<any>({ year: new Date().getFullYear(), bu: "", channel: FALLBACK_CHANNELS[0].code, province: "ALL", district: "ALL", month: 1, target: "", note: "" });

  const isVientianeCapital = (code: string) => { if (!code || code === "ALL") return false; const lower = code.toLowerCase(); return lower === "01" || lower.includes("capital") || lower.includes("vientiane"); };
  const handleChange = (field: string, value: any) => { setForm((prev: any) => { const newState = { ...prev, [field]: value }; if (field === "province") newState.district = isVientianeCapital(value) ? "" : "ALL"; return newState; }); };

  useEffect(() => { const fetchData = async () => { try { const [buRes, provRes, targetRes, chanRes] = await Promise.allSettled([api.get("/bu"), api.get("/provinces"), api.get("/targets"), api.get("/sale-channel")]); if (buRes.status === "fulfilled" && buRes.value.data.success) setBuOptions(buRes.value.data.data.map((b: any) => ({ code: b.code, name: b.name_1 || b.name || b.code }))); if (provRes.status === "fulfilled" && provRes.value.data.success) setProvinceOptions([{ code: "ALL", name: "Nationwide" }, ...provRes.value.data.data.map((p: any) => ({ code: p.code, name: p.name_1 || p.name || p.code }))]); if (targetRes.status === "fulfilled" && targetRes.value.data.success) setExistingTargets(targetRes.value.data.data); if (chanRes.status === "fulfilled" && chanRes.value.data.success && chanRes.value.data.data.length) { const mapped = chanRes.value.data.data.map((c: any) => ({ code: c.code, name: c.name_1 || c.name || c.code })); setChannelOptions(mapped); setForm((prev: any) => ({ ...prev, channel: mapped[0].code })); } } catch {} }; fetchData(); }, []);
  useEffect(() => { if (buSelectRef.current) buSelectRef.current.focus(); }, []);
  useEffect(() => { const loadDistricts = async () => { if (!isVientianeCapital(form.province)) { setDistrictOptions([{ code: "ALL", name: "All" }]); return; } try { const { data } = await api.get("/amphur", { params: { province_code: form.province } }); if (data.success && Array.isArray(data.data)) setDistrictOptions(data.data.map((d: any) => ({ code: d.code, name: d.name_1 || d.name || d.code }))); } catch { setDistrictOptions([{ code: "ALL", name: "All" }]); } }; loadDistricts(); }, [form.province]);

  const availableMonthsForSelection = useMemo(() => { if (!form.bu || !form.channel) return MONTHS; const used = new Set([...drafts, ...existingTargets.map((t: any) => ({ bu: t.bu_code || t.bu, province: t.province_code || t.province, district: t.district_code || t.district, year: t.year || t.target_year, month: t.month || t.target_month, channel: t.sale_channel || t.channel }))].filter((d: any) => d.bu === form.bu && d.channel === form.channel && (d.province || "ALL") === form.province && (d.district || "ALL") === (form.district || "ALL") && d.year === form.year).map((d: any) => d.month)); return MONTHS.filter(m => !used.has(m.value)); }, [drafts, existingTargets, form.bu, form.channel, form.province, form.district, form.year]);
  useEffect(() => { if (!availableMonthsForSelection.some(m => m.value === form.month)) setForm((prev: any) => ({ ...prev, month: availableMonthsForSelection[0]?.value ?? prev.month })); }, [availableMonthsForSelection, form.month]);

  const handleAddDraft = (e: React.FormEvent) => { e.preventDefault(); setError(""); if (!form.bu) return buSelectRef.current?.focus(); if (form.bu && form.channel && availableMonthsForSelection.length === 0) return setError("Month already used"); if (!form.target || Number(form.target) <= 0) return setError("Invalid Target Amount"); if (isVientianeCapital(form.province) && !form.district) return setError("Please select district"); const channelObj = channelOptions.find(c => c.code === form.channel); const entry = { id: Date.now(), ...form, target: Number(form.target), buName: buOptions.find(b => b.code === form.bu)?.name || form.bu, provinceName: provinceOptions.find(p => p.code === form.province)?.name || form.province, districtName: districtOptions.find(d => d.code === form.district)?.name || form.district, channelName: channelObj?.name || form.channel, channel: channelObj?.code || form.channel }; setDrafts(prev => [entry, ...prev]); setForm((prev: any) => ({ ...prev, target: "", note: "" })); };
  const handleSaveAll = async () => { setError(""); if (!drafts.length) return setError("Draft is empty"); setSaving(true); try { for (const d of drafts) { await api.post("/targets", { bu_code: d.bu, province: d.province || "ALL", district: d.district || "ALL", channel: d.channel, target: d.target, year: d.year, month: d.month, note: d.note }); } router.replace("/target"); } catch (err: any) { setError(err.response?.data?.message || "Save failed"); } finally { setSaving(false); } };
  const totalDraftAmount = drafts.reduce((sum, item) => sum + item.target, 0);

  return (
    <div className="flex min-h-screen flex-col text-[var(--ink)]">
      {/* Header */}
      <div className="shrink-0 border-b border-[var(--line)]/70 bg-[var(--surface)]/75 px-5 py-4 backdrop-blur-xl /75 md:px-8">
        <div className="mx-auto flex max-w-[1480px] items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-[var(--r-lg)] bg-[var(--brand-deep)] text-white"><Sparkles size={20} /></div>
          <div><p className="eyebrow">Sales planning</p><h1 className="text-xl font-bold tracking-tight text-[var(--ink)]">Create Targets</h1></div>
        </div>
        <button onClick={() => router.back()} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold text-[var(--ink-soft)] shadow-sm transition hover:border-[var(--line)] hover:text-[var(--pos)]"><ArrowLeft size={16} /> Back to List</button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-5 md:p-8">
        <div className="mx-auto grid max-w-[1480px] grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Left: Form */}
          <div className="lg:col-span-4 flex flex-col gap-4 overflow-y-auto">
            <div className="rounded-[var(--r-lg)] border border-[var(--line)]/80 bg-[var(--surface)] p-5 shadow-sm">
              <div className="mb-5 flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-[var(--r-md)] bg-[var(--pos-bg)] text-[var(--pos)] dark:bg-[var(--pos-bg)]0/10"><ClipboardList size={18} /></span><div><h2 className="font-bold text-[var(--ink)]">Target Details</h2><p className="page-sub">Add one or more monthly goals</p></div></div>
              <form onSubmit={handleAddDraft} className="space-y-4">
                {/* Period */}
                <div>
                  <label className="block text-xs font-medium text-[var(--muted)] uppercase mb-1.5">Period</label>
                  <div className="grid grid-cols-3 gap-2">
                    <input type="number" value={form.year} onChange={(e) => handleChange("year", Number(e.target.value))} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm text-center focus:border-[var(--brand)] focus:ring-1 focus:ring-blue-500 outline-none" />
                    <div className="col-span-2">
                      <select value={form.month} onChange={(e) => handleChange("month", Number(e.target.value))} disabled={!form.bu || !form.channel} className="w-full rounded-md border border-[var(--line)] px-3 py-2 text-sm focus:border-[var(--brand)] focus:ring-1 focus:ring-blue-500 outline-none disabled:bg-[var(--surface-2)] disabled:text-[var(--muted)] bg-[var(--surface)]">
                        {availableMonthsForSelection.length === 0 ? <option value="">Full / No Slots</option> : availableMonthsForSelection.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </div>
                  </div>
                </div>

                {/* Business & Channel */}
                <div>
                  <label className="block text-xs font-medium text-[var(--muted)] uppercase mb-1.5">Business & Channel</label>
                  <div className="space-y-2">
                    <select value={form.bu} onChange={(e) => handleChange("bu", e.target.value)} ref={buSelectRef} className={`w-full rounded-md border px-3 py-2 text-sm focus:border-[var(--brand)] focus:ring-1 focus:ring-blue-500 outline-none bg-[var(--surface)] ${error && !form.bu ? "border-[var(--neg)]" : "border-[var(--line)]"}`}>
                      <option value="">Select Business Unit...</option>
                      {buOptions.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
                    </select>
                    <select value={form.channel} onChange={(e) => handleChange("channel", e.target.value)} disabled={!form.bu} className="w-full rounded-md border border-[var(--line)] px-3 py-2 text-sm focus:border-[var(--brand)] focus:ring-1 focus:ring-blue-500 outline-none disabled:bg-[var(--surface-2)] disabled:text-[var(--muted)] bg-[var(--surface)]">
                      {channelOptions.map((ch) => <option key={ch.code} value={ch.code}>{ch.name}</option>)}
                    </select>
                  </div>
                </div>

                {/* Location */}
                <div>
                  <label className="block text-xs font-medium text-[var(--muted)] uppercase mb-1.5">Location</label>
                  <div className="space-y-2">
                    <select value={form.province} onChange={(e) => handleChange("province", e.target.value)} className="w-full rounded-md border border-[var(--line)] px-3 py-2 text-sm focus:border-[var(--brand)] focus:ring-1 focus:ring-blue-500 outline-none bg-[var(--surface)]">
                      {provinceOptions.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                    </select>
                    {isVientianeCapital(form.province) && (
                      <select value={form.district} onChange={(e) => handleChange("district", e.target.value)} className="w-full rounded-md border border-[var(--line)] px-3 py-2 text-sm focus:border-[var(--brand)] focus:ring-1 focus:ring-blue-500 outline-none bg-[var(--surface)]">
                        {districtOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                      </select>
                    )}
                  </div>
                </div>

                <hr className="border-[var(--line)]" />

                {/* Target Value */}
                <div>
                  <label className="block text-xs font-medium text-[var(--muted)] uppercase mb-1.5">Target Amount (LAK)</label>
                  <input type="number" value={form.target} onChange={(e) => handleChange("target", e.target.value)} placeholder="0" min="0" className="w-full rounded-md border border-[var(--line)] px-3 py-2 text-base font-semibold focus:border-[var(--brand)] focus:ring-1 focus:ring-blue-500 outline-none" />
                </div>

                {/* Note */}
                <div>
                  <label className="block text-xs font-medium text-[var(--muted)] uppercase mb-1.5">Note (Optional)</label>
                  <textarea value={form.note} onChange={(e) => handleChange("note", e.target.value)} rows={2} className="w-full rounded-md border border-[var(--line)] px-3 py-2 text-sm focus:border-[var(--brand)] focus:ring-1 focus:ring-blue-500 outline-none resize-none" />
                </div>

                {error && (
                  <div className="p-3 bg-[var(--neg-bg)] text-[var(--neg)] text-sm rounded-lg border border-[var(--neg)]">{error}</div>
                )}

                <button type="submit" className="flex w-full items-center justify-center gap-2 rounded-[var(--r-md)] bg-[var(--brand-deep)] px-4 py-3 text-sm font-bold text-white transition hover:brightness-110"><Plus size={16} /> Add to List</button>
              </form>
            </div>
          </div>

          {/* Right: Draft table */}
          <div className="lg:col-span-8 flex flex-col h-full gap-4 overflow-hidden">
            {/* Stats */}
            <div className="grid grid-cols-2 gap-4 shrink-0">
              <div className="rounded-[var(--r-lg)] border border-[var(--line)]/80 bg-[var(--surface)] p-5 shadow-sm">
                <p className="text-xs font-medium text-[var(--muted)]">Pending Items</p>
                <p className="text-xl font-semibold text-[var(--ink)] mt-1">{drafts.length}</p>
              </div>
              <div className="rounded-[var(--r-lg)] border border-[var(--line)]/80 bg-[var(--surface)] p-5 shadow-sm">
                <p className="text-xs font-medium text-[var(--pos)]">Total Value (LAK)</p>
                <p className="text-xl font-semibold text-[var(--ink)] mt-1">{totalDraftAmount.toLocaleString()}</p>
              </div>
            </div>

            {/* Draft table */}
            <div className="flex flex-1 flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)]/80 bg-[var(--surface)] shadow-sm">
              <div className="px-4 py-3 border-b border-[var(--line)] flex justify-between items-center">
                <h2 className="font-semibold text-base text-[var(--ink)]">Review Drafts</h2>
                {drafts.length > 0 && (
                  <button onClick={() => setDrafts([])} className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-[var(--neg)] transition-colors hover:bg-[var(--neg-bg)] hover:text-[var(--neg)]"><Trash2 size={13} /> Clear All</button>
                )}
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[var(--surface-2)] sticky top-0 text-xs font-medium text-[var(--muted)] uppercase">
                    <tr>
                      <th className="px-4 py-2 border-b border-[var(--line)]">Business & Channel</th>
                      <th className="px-4 py-2 border-b border-[var(--line)]">Location</th>
                      <th className="px-4 py-2 border-b border-[var(--line)]">Month</th>
                      <th className="px-4 py-2 border-b border-[var(--line)] text-right">Target</th>
                      <th className="px-4 py-2 border-b border-[var(--line)] w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line-soft)]">
                    {drafts.length === 0 ? (
                      <tr>
                        <td colSpan={5}>
                          <div className="flex flex-col items-center justify-center py-16 text-[var(--muted)]">
                            <p className="font-medium">No targets added yet</p>
                            <p className="text-xs mt-1">Fill the form on the left to start</p>
                          </div>
                        </td>
                      </tr>
                    ) : drafts.map((d) => (
                      <tr key={d.id} className="group hover:bg-[var(--surface-2)] transition-colors duration-150">
                        <td className="px-4 py-2">
                          <div className="font-semibold text-[var(--ink)]">{d.buName}</div>
                          <div className="page-sub">{d.channelName}</div>
                        </td>
                        <td className="px-4 py-2">
                          <div className="text-[var(--ink-soft)]">{d.provinceName}</div>
                          {d.districtName !== "ALL" && d.districtName !== "All" && <div className="text-xs text-[var(--brand)] font-medium">- {d.districtName}</div>}
                        </td>
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-[var(--info-bg)] text-[var(--brand)] border border-blue-100">{MONTHS.find(m => m.value === d.month)?.label} {d.year}</span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono font-semibold text-[var(--ink-soft)]">{d.target.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right">
                          <button onClick={() => setDrafts(prev => prev.filter(x => x.id !== d.id))} className="p-1 text-[var(--muted)] hover:text-[var(--neg)] hover:bg-[var(--neg-bg)] rounded-md transition-colors duration-150 opacity-0 group-hover:opacity-100">&#10005;</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="p-3 border-t border-[var(--line)] bg-[var(--surface)]">
                <button
                  disabled={saving || drafts.length === 0}
                  onClick={handleSaveAll}
                  className={`w-full rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150 ${saving || drafts.length === 0 ? "bg-[var(--surface-2)] text-[var(--muted)] cursor-not-allowed" : "bg-[var(--brand-deep)] text-white hover:brightness-110"}`}
                >
                    <span className="inline-flex items-center justify-center gap-2"><Check size={16} />{saving ? "Saving..." : `Confirm & Save ${drafts.length} Targets`}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
