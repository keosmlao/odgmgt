/** Compares the copied TMS code against TMS's own REST answer, function by function. */
import crypto from "crypto";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const SEC = process.env.TMS_API_SECRET || "";
const H = SEC ? { Authorization: `Bearer ${SEC}` } : {};
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

const dash = require("../lib/tms/queries/dashboard.js");
const bills = require("../lib/tms/queries/bills.js");
const reports = require("../lib/tms/queries/reports.js");
const master = require("../lib/tms/queries/master-data.js");

const CASES = [
  ["dashboard summary",   "/api/reports/dashboard?slice=summary",  p=>p.data, () => dash.getDashboardSummary({}, false)],
  ["dashboard kpi",       "/api/reports/dashboard?slice=kpi",      p=>p.data, () => dash.getDashboardKpi({}, false)],
  ["dashboard delivery",  "/api/reports/dashboard?slice=delivery", p=>p.data, () => dash.getDashboardDeliveryPerformance({}, false)],
  ["dashboard pending",   "/api/reports/dashboard?slice=pending",  p=>p.data, () => dash.getDashboardPending({}, false)],
  ["delivery-perf 2026-08","/api/reports/delivery-performance?month=2026-08", p=>p.report, () => reports.getDeliveryPerformance({}, "2026-08")],
  ["bills waiting-sent",  "/api/reports/bills?list=waiting-sent",  p=>p.data, () => bills.getBillsWaitingSent({})],
  ["bills in-progress",   "/api/reports/bills?list=in-progress",   p=>p.data, () => bills.getBillsInProgress({})],
  ["bills branches",      "/api/reports/bills?list=branches",      p=>p.data, () => master.getTransportBranches()],
  ["logistics daily-dept","/api/reports/logistics?report=daily-department&from=2026-08-01&to=2026-08-12", p=>p.data,
     () => reports.getReportDailyDepartment({}, "2026-08-01", "2026-08-12", true, "")],
  ["logistics pending-daily","/api/reports/logistics?report=pending-daily&from=2026-08-01&to=2026-08-12", p=>p.data,
     () => reports.getReportPendingDaily({}, "2026-08-01", "2026-08-12")],
];

let pass = 0, fail = 0;
for (const [label, path, pick, run] of CASES) {
  try {
    const [tmsRaw, mine] = await Promise.all([
      fetch(`http://localhost:3100${path}`, { headers: H }).then(r => r.json()),
      run(),
    ]);
    const a = hash(pick(tmsRaw)), b = hash(JSON.parse(JSON.stringify(mine)));
    const same = a === b;
    same ? pass++ : fail++;
    console.log(`${same ? "ok  " : "DIFF"} ${label.padEnd(24)} tms=${a} copy=${b}`);
  } catch (e) { fail++; console.log(`ERR  ${label.padEnd(24)} ${e.message.slice(0,80)}`); }
}
console.log(`\n${pass} ຄືກັນ / ${fail} ຕ່າງ`);
process.exit(0);
