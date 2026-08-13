import crypto from "crypto"; import jwt from "jsonwebtoken";
const H = process.env.TMS_API_SECRET ? { Authorization: `Bearer ${process.env.TMS_API_SECRET}` } : {};
const tok = jwt.sign({ user: { id: 1, username: "it", role: "admin" } }, process.env.ODG_SECRET_KEY, { expiresIn: "1h" });
const M = { Authorization: `Bearer ${tok}` };
const strip = v => JSON.parse(JSON.stringify(v, (k,x)=>(k==="time_use"||k==="time_use_send")?undefined:x));
const h = v => crypto.createHash("sha256").update(JSON.stringify(strip(v))).digest("hex").slice(0,16);
const F="2026-07-14", T="2026-08-13";
const C = [
  ["overview summary","/api/reports/dashboard?slice=summary",p=>p.data,"/api/transport/overview?slice=summary"],
  ["overview kpi","/api/reports/dashboard?slice=kpi",p=>p.data,"/api/transport/overview?slice=kpi"],
  ["overview delivery","/api/reports/dashboard?slice=delivery",p=>p.data,"/api/transport/overview?slice=delivery"],
  ["overview pending","/api/reports/dashboard?slice=pending",p=>p.data,"/api/transport/overview?slice=pending"],
  ["delivery-perf","/api/reports/delivery-performance?month=2026-08",p=>p.report,"/api/transport/delivery-performance?month=2026-08"],
  ["bills waiting-sent","/api/reports/bills?list=waiting-sent",p=>p.data,"/api/transport/bills?list=waiting-sent"],
  ["bills in-progress","/api/reports/bills?list=in-progress",p=>p.data,"/api/transport/bills?list=in-progress"],
  ["bills complete",`/api/reports/bills?list=complete&from=${F}&to=${T}`,p=>p.data,`/api/transport/bills?list=complete&from=${F}&to=${T}`],
  ["truck-utilization",`/api/reports/truck-utilization?from=${F}&to=${T}`,p=>p.data,`/api/transport/truck-utilization?from=${F}&to=${T}`],
  ["gps-monthly",`/api/reports/gps-monthly?from=${F}&to=${T}&window=30`,p=>({rows:p.rows,fuel:p.fuel,efficiency:p.efficiency}),`/api/transport/gps-monthly?from=${F}&to=${T}&window=30`],
  ["fleet-live","/api/reports/fleet-live",p=>({cars:p.cars,phones:p.phones}),"/api/transport/fleet-live"],
  ["logistics pod",`/api/reports/logistics?report=pod&from=${F}&to=${T}`,p=>p.data,`/api/transport/logistics?report=pod&from=${F}&to=${T}`],
  ["logistics daily-dept",`/api/reports/logistics?report=daily-department&from=${F}&to=${T}`,p=>p.data,`/api/transport/logistics?report=daily-department&from=${F}&to=${T}`],
  ["logistics pending-daily",`/api/reports/logistics?report=pending-daily&from=${F}&to=${T}`,p=>p.data,`/api/transport/logistics?report=pending-daily&from=${F}&to=${T}`],
];
let ok=0, bad=0;
for (const [l, tp, pick, op] of C) {
  const s = Date.now();
  const a = await fetch(`http://localhost:3100${tp}`,{headers:H}).then(r=>r.json());
  const t1 = Date.now();
  const b = await fetch(`http://localhost:3000${op}${op.includes("?")?"&":"?"}nocache=1`,{headers:M}).then(r=>r.json());
  const t2 = Date.now();
  if (!b?.success) { bad++; console.log(`FAIL ${l.padEnd(23)} ${b?.message||b?.error}`); continue; }
  const same = h(pick(a))===h(b.data); same?ok++:bad++;
  console.log(`${same?"ok  ":"DIFF"} ${l.padEnd(23)} tms ${String(t1-s).padStart(5)}ms · odgmgt ${String(t2-t1).padStart(5)}ms`);
}
console.log(`\n${ok} ຄືກັນ / ${bad} ຕ່າງ`);
process.exit(0);
