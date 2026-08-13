/** Compares every transport endpoint end-to-end: odgmgt HTTP vs TMS HTTP. */
import crypto from "crypto";
import jwt from "jsonwebtoken";
const H = process.env.TMS_API_SECRET ? { Authorization: `Bearer ${process.env.TMS_API_SECRET}` } : {};
const tok = jwt.sign({ user: { id: 1, username: "it", role: "admin", full_name: "IT" } },
  process.env.ODG_SECRET_KEY || "odg-secret-change", { expiresIn: "2h" });
const MINE = { Authorization: `Bearer ${tok}` };
// time_use counts from "now", so it moves between two calls — compare the rest.
const strip = (v) => JSON.parse(JSON.stringify(v, (k, val) =>
  (k === "time_use" || k === "time_use_send") ? undefined : val));
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(strip(v))).digest("hex").slice(0, 16);
const F = "2026-08-01", T = "2026-08-12";

const CASES = [
  ["dashboard summary",  `/api/reports/dashboard?slice=summary`,  p=>p.data,   `/api/transport/overview?slice=summary`],
  ["dashboard kpi",      `/api/reports/dashboard?slice=kpi`,      p=>p.data,   `/api/transport/overview?slice=kpi`],
  ["dashboard delivery", `/api/reports/dashboard?slice=delivery`, p=>p.data,   `/api/transport/overview?slice=delivery`],
  ["dashboard pending",  `/api/reports/dashboard?slice=pending`,  p=>p.data,   `/api/transport/overview?slice=pending`],
  ["dashboard activity", `/api/reports/dashboard?slice=activity`, p=>p.data,   `/api/transport/overview?slice=activity`],
  ["delivery-perf",      `/api/reports/delivery-performance?month=2026-08`, p=>p.report, `/api/transport/delivery-performance?month=2026-08`],
  ["bills waiting-sent", `/api/reports/bills?list=waiting-sent`,  p=>p.data,   `/api/transport/bills?list=waiting-sent`],
  ["bills in-progress",  `/api/reports/bills?list=in-progress`,   p=>p.data,   `/api/transport/bills?list=in-progress`],
  ["bills complete",     `/api/reports/bills?list=complete&from=${F}&to=${T}`, p=>p.data, `/api/transport/bills?list=complete&from=${F}&to=${T}`],
  ["bills branches",     `/api/reports/bills?list=branches`,      p=>p.data,   `/api/transport/bills?list=branches`],
  ["fleet-live",         `/api/reports/fleet-live`,               p=>({cars:p.cars,phones:p.phones}), `/api/transport/fleet-live`],
  ["gps-monthly",        `/api/reports/gps-monthly?from=${F}&to=${T}&window=30`, p=>({rows:p.rows,fuel:p.fuel,efficiency:p.efficiency}), `/api/transport/gps-monthly?from=${F}&to=${T}&window=30`],
  ["truck-utilization",  `/api/reports/truck-utilization?from=${F}&to=${T}`, p=>p.data, `/api/transport/truck-utilization?from=${F}&to=${T}`],
  ["logistics pod",      `/api/reports/logistics?report=pod&from=${F}&to=${T}`, p=>p.data, `/api/transport/logistics?report=pod&from=${F}&to=${T}`],
  ["logistics daily-dept",`/api/reports/logistics?report=daily-department&from=${F}&to=${T}`, p=>p.data, `/api/transport/logistics?report=daily-department&from=${F}&to=${T}`],
  ["logistics daily-bills",`/api/reports/logistics?report=daily-bills&from=${F}&to=${T}`, p=>p.data, `/api/transport/logistics?report=daily-bills&from=${F}&to=${T}`],
  ["logistics pending-daily",`/api/reports/logistics?report=pending-daily&from=${F}&to=${T}`, p=>p.data, `/api/transport/logistics?report=pending-daily&from=${F}&to=${T}`],
];

let pass = 0, fail = 0;
for (const [label, tmsPath, pick, ownPath] of CASES) {
  try {
    const [a, b] = await Promise.all([
      fetch(`http://localhost:3100${tmsPath}`, { headers: H }).then(r => r.json()),
      fetch(`http://localhost:3000${ownPath}`, { headers: MINE }).then(r => r.json()),
    ]);
    if (!b?.success) { fail++; console.log(`FAIL ${label.padEnd(23)} ${b?.message || b?.error}`); continue; }
    const ha = hash(pick(a)), hb = hash(b.data);
    ha === hb ? pass++ : fail++;
    console.log(`${ha === hb ? "ok  " : "DIFF"} ${label.padEnd(23)} tms=${ha} odgmgt=${hb}`);
  } catch (e) { fail++; console.log(`ERR  ${label.padEnd(23)} ${e.message.slice(0, 70)}`); }
}
console.log(`\n${pass} ຄືກັນ / ${fail} ຕ່າງ`);
process.exit(0);
