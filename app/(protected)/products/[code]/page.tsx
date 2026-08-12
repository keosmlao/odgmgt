import Link from "next/link";
import { notFound } from "next/navigation";
import { getProductDetail, getIsAdmin, getStockThresholds, getPmPrices, getLifecycle, getItemSuppliers, getProductDeptStaff } from "@/lib/pm/products";
import { getEditableSalePrices } from "@/lib/pm/pricing";
import PriceEditor from "./PriceEditor";
import { getComments, getActivities } from "@/lib/pm/chatter";
import { getCurrentUser } from "@/lib/pm/session";
import ChatterActivities from "./ChatterActivities";
import WarehouseFilter from "./WarehouseFilter";
import Tabs, { type Tab } from "./Tabs";
import SerialTree from "./SerialTree";
import RelatedItemForm from "./RelatedItemForm";
import RelatedItemActions from "./RelatedItemActions";
import MinStockForm from "./MinStockForm";
import PmSettings from "./PmSettings";

function fmtNum(value: string | null): string {
  if (value == null) return "-";
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtDate(value: string | null): string {
  if (!value) return "-";
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : value;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const IMAGE_BASE = process.env.NEXT_PUBLIC_PRODUCT_IMAGE_BASE_URL ?? "";

function imageSrc(img: { url_image: string; image_base64: string }): string | null {
  if (img.image_base64) return `data:image/jpeg;base64,${img.image_base64}`;
  if (img.url_image && IMAGE_BASE) return `${IMAGE_BASE.replace(/\/$/, "")}/${img.url_image}`;
  return null;
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl glass p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1.5 text-lg font-bold tracking-tight text-slate-900 dark:text-white">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4 border-b border-slate-100 py-2 last:border-0 dark:border-slate-800">
      <dt className="shrink-0 text-sm text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-right text-sm font-semibold text-slate-900 dark:text-white">{value || "-"}</dd>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl glass p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
      <h2 className="mb-4 border-b border-slate-100 pb-3 text-sm font-bold text-slate-900 dark:border-slate-800 dark:text-white">{title}</h2>
      {children}
    </section>
  );
}

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ wh?: string; tab?: string }>;
}) {
  const { code } = await params;
  const decodedCode = decodeURIComponent(code);
  const { wh = "", tab } = await searchParams;
  const [result, user] = await Promise.all([
    getProductDetail(decodedCode, wh),
    getCurrentUser(),
  ]);
  if (!result) notFound();
  const [isAdmin, thresholds, pmPrices, editablePrices, lifecycle, itemSuppliers, comments, activities, deptStaff] = await Promise.all([
    user ? getIsAdmin(user.employeeCode) : Promise.resolve(false),
    getStockThresholds(decodedCode),
    getPmPrices(decodedCode),
    getEditableSalePrices(decodedCode),
    getLifecycle(decodedCode),
    getItemSuppliers(decodedCode),
    getComments(decodedCode),
    getActivities(decodedCode),
    getProductDeptStaff(),
  ]);
  const { product: p, barcodes, images, movements, warehouseStock, prices, movementWarehouses, serials, soldSerials, serialSummary, serialWarehouses, priceCells, latestPurchase, relatedItems } = result;

  // Warranty is fixed at 12 months and starts on the warehouse issue date.
  const warrantyStatus = (issueDate: string | null): { label: string; expired: boolean } | null => {
    if (!issueDate) return null;
    const issued = new Date(issueDate + "T00:00:00Z");
    if (Number.isNaN(issued.getTime())) return null;
    const expiry = new Date(issued);
    expiry.setUTCMonth(expiry.getUTCMonth() + 12);
    const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const remainingDays = Math.ceil((expiry.getTime() - today) / (24 * 3600 * 1000));
    return remainingDays >= 0
      ? { label: `ເຫຼືອ ${remainingDays.toLocaleString("en-US")} ວັນ`, expired: false }
      : { label: `ໝົດແລ້ວ ${Math.abs(remainingDays).toLocaleString("en-US")} ວັນ`, expired: true };
  };

  // Headline price/cost — same source & logic as the products list (getPmPrices).
  const priceField = (v: string | null, cur: string) => (v == null ? "-" : `${fmtNum(v)}${cur ? ` ${cur}` : ""}`);

  // Pivot price cells into rows = period, columns = customer group.
  // Column order: sales groups first (ຂາຍໜ້າຮ້ານ 101, ຂາຍສົ່ງ 102, ໂຄງການ 103),
  // then cost groups (ຕົ້ນທຶນປາກເຊ 10, ຕົ້ນທຶນວຽງຈັນ 9).
  const GROUP_ORDER = ["101", "102", "103", "10", "9"];
  const groupRank = (code: string) => {
    const i = GROUP_ORDER.indexOf(code);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  const priceGroupCols: { code: string; name: string }[] = [];
  const seenGroup = new Set<string>();
  for (const c of priceCells) {
    if (!seenGroup.has(c.group_code)) {
      seenGroup.add(c.group_code);
      priceGroupCols.push({ code: c.group_code, name: c.group_name });
    }
  }
  priceGroupCols.sort((a, b) => groupRank(a.code) - groupRank(b.code));

  type Cell = { lak: string | null; thb: string | null };
  const pricePeriodRows: {
    key: string;
    from_date: string | null;
    to_date: string | null;
    create_date: string | null;
    byGroup: Record<string, Cell>;
  }[] = [];
  const periodIndex = new Map<string, number>();
  for (const c of priceCells) {
    const key = `${c.from_date}|${c.to_date}`;
    let idx = periodIndex.get(key);
    if (idx === undefined) {
      idx = pricePeriodRows.length;
      periodIndex.set(key, idx);
      pricePeriodRows.push({ key, from_date: c.from_date, to_date: c.to_date, create_date: c.create_date, byGroup: {} });
    }
    pricePeriodRows[idx].byGroup[c.group_code] = { lak: c.price_lak, thb: c.price_thb };
    if (c.create_date && (!pricePeriodRows[idx].create_date || c.create_date > pricePeriodRows[idx].create_date!)) {
      pricePeriodRows[idx].create_date = c.create_date;
    }
  }
  const pricePeriodRows10 = pricePeriodRows.slice(0, 10);
  const totalQty = warehouseStock.reduce((s, w) => s + Number(w.qty), 0);
  const description = p.description ? stripHtml(p.description) : "";
  const shownImages = images
    .map((img) => ({ src: imageSrc(img), name: img.url_image }))
    .filter((x): x is { src: string; name: string } => x.src !== null);
  const pendingImages = images.length - shownImages.length;
  const cover = shownImages[0];

  const infoTab = (
    <div className="space-y-5">
      <div className="grid items-start gap-5 xl:grid-cols-3">
        <Card title="ຂໍ້ມູນທົ່ວໄປ">
          <dl>
            <Field label="ຊື່ (ລາວ)" value={p.name_1} />
            <Field label="ຊື່ (ອັງກິດ)" value={p.name_eng_1} />
            <Field label="ຊື່ຫຍໍ້" value={p.short_name} />
            <Field label="ລະຫັດເກົ່າ" value={p.code_old} />
            <Field label="ລຸ້ນ / ໂມເດວ" value={p.item_model} />
            <Field label="ຂະໜາດ" value={p.item_size} />
            <Field label="ສີ" value={p.item_color} />
          </dl>
        </Card>

        <Card title="ໝວດໝູ່">
          <dl>
            <Field label="ກຸ່ມຫຼັກ" value={p.group_main_name} />
            <Field label="ກຸ່ມຍ່ອຍ" value={p.group_sub_name} />
            <Field label="ກຸ່ມຍ່ອຍ 1" value={p.group_sub2_name} />
            <Field label="ໝວດ" value={p.category_name} />
            <Field label="ຍີ່ຫໍ້" value={p.brand_name} />
            <Field label="ຜູ້ຮັບຜິດຊອບ" value={p.responsible_name || "-"} />
          </dl>
        </Card>

        <Card title="ຕົ້ນທຶນ ແລະ ລາຄາລ້າສຸດ">
          <dl>
            <Field label="ໜ່ວຍ" value={p.unit_standard_name} />
            <Field label="ຕົ້ນທຶນສະເລ່ຍ" value={fmtNum(p.average_cost)} />
            <Field label="ລາຄາຊື້ລ້າສຸດ" value={latestPurchase?.price ? fmtNum(latestPurchase.price) : "-"} />
            <Field label="ຂາຍໜ້າຮ້ານ" value={priceField(pmPrices?.price_retail ?? null, pmPrices?.price_retail_cur ?? "")} />
            <Field label="ຂາຍສົ່ງ" value={priceField(pmPrices?.price_wholesale ?? null, "฿")} />
            <Field label="ຕົ້ນທຶນປາກເຊ" value={priceField(pmPrices?.cost_pks ?? null, "฿")} />
            <Field label="ຕົ້ນທຶນວຽງຈັນ" value={priceField(pmPrices?.cost_vte ?? null, "฿")} />
            <Field label="ໃບຮັບເຂົ້າລ້າສຸດ" value={latestPurchase?.doc_no || "-"} />
            <Field label="ເລກ PO" value={latestPurchase?.po_no || "-"} />
            <Field
              label="ຜູ້ສະໜອງ"
              value={latestPurchase?.supplier_name || latestPurchase?.supplier_code || "-"}
            />
          </dl>
        </Card>
      </div>

      {/* Price by period (rows) × customer group (columns) */}
      {pricePeriodRows10.length > 0 && (
        <Card title="ລາຄາຂາຍຕາມວັນທີ ແລະ ກຸ່ມ">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="py-2 pr-4 text-left font-medium">ໄລຍະ</th>
                  <th className="py-2 pr-4 text-left font-medium">ວັນທີສ້າງ</th>
                  {priceGroupCols.map((g) => (
                    <th key={g.code} className="py-2 pr-4 text-right font-medium">
                      {g.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pricePeriodRows10.map((row) => (
                  <tr key={row.key} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="py-2 pr-4 whitespace-nowrap text-slate-700 dark:text-slate-300">
                      {fmtDate(row.from_date)} — {fmtDate(row.to_date)}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap text-slate-500 dark:text-slate-400">
                      {fmtDate(row.create_date)}
                    </td>
                    {priceGroupCols.map((g) => {
                      const cell = row.byGroup[g.code];
                      return (
                        <td key={g.code} className="py-2 pr-4 text-right">
                          {cell?.lak ? (
                            <span className="font-medium text-slate-900 dark:text-white">{fmtNum(cell.lak)}</span>
                          ) : null}
                          {cell?.thb ? (
                            <span className="block text-xs text-slate-400">฿ {fmtNum(cell.thb)}</span>
                          ) : null}
                          {!cell?.lak && !cell?.thb ? <span className="text-slate-400">-</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-400">ຕົວເລກເທິງ = ກີບ, ຂ້າງລຸ່ມ (฿) = ບາດ</p>
        </Card>
      )}

      {/* Images */}
      {(shownImages.length > 0 || pendingImages > 0) && (
        <Card title={`ຮູບພາບ (${images.length})`}>
          <div className="flex flex-wrap gap-3">
            {shownImages.map((img, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${img.name}-${i}`}
                src={img.src}
                alt={`${p.name_1} ${i + 1}`}
                className="h-28 w-28 rounded-xl border border-slate-200 object-cover dark:border-slate-800"
              />
            ))}
          </div>
          {pendingImages > 0 && (
            <p className="mt-2 text-xs text-slate-400">
              ມີ {pendingImages} ຮູບທີ່ຍັງສະແດງບໍ່ໄດ້ (ຕັ້ງ NEXT_PUBLIC_PRODUCT_IMAGE_BASE_URL)
            </p>
          )}
        </Card>
      )}

      {(description || p.remark) && (
        <Card title="ລາຍລະອຽດ">
          {p.remark && <p className="text-sm text-slate-600 dark:text-slate-400">{p.remark}</p>}
          {description && (
            <p className="mt-1 whitespace-pre-line text-sm text-slate-700 dark:text-slate-300">{description}</p>
          )}
        </Card>
      )}
    </div>
  );

  const stockTab = (
    <div className="space-y-5">
      {isAdmin && (
        <Card title="ຕັ້ງ min / max stock (ຊ່ວງ stock ເພື່ອກັນການສັ່ງຊື້ຜິດ)">
          <MinStockForm itemCode={decodedCode} current={thresholds} balance={totalQty} />
        </Card>
      )}
      {isAdmin && (
        <Card title="ຈັດການລາຄາຂາຍ (ຕໍ່ກຸ່ມລູກຄ້າ)">
          <PriceEditor itemCode={decodedCode} prices={editablePrices} />
        </Card>
      )}
      {isAdmin && (
        <Card title="ຈັດການພະລິດຕະພັນ (ສະຖານະ · ຜູ້ສະໜອງ)">
          <PmSettings itemCode={decodedCode} lifecycle={lifecycle} suppliers={itemSuppliers} />
        </Card>
      )}
      <Card title={`ຄົງເຫຼືອແຍກສາງ (${warehouseStock.length})`}>
        {warehouseStock.length === 0 ? (
          <p className="text-sm text-slate-400">ບໍ່ມີຍອດຄົງເຫຼືອ</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="py-2 pr-4 font-medium">ສາງ</th>
                  <th className="py-2 pr-4 font-medium">ບ່ອນຈັດວາງ</th>
                  <th className="py-2 text-right font-medium">ຄົງເຫຼືອ</th>
                </tr>
              </thead>
              <tbody>
                {warehouseStock.map((w, i) => (
                  <tr key={`${w.warehouse}-${w.location}-${i}`} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">
                      <span className="font-mono text-xs text-slate-400">{w.warehouse}</span> {w.wh_name}
                    </td>
                    <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">
                      {w.location_name || "-"}
                      <span className="ml-1 font-mono text-xs text-slate-400">{w.location}</span>
                    </td>
                    <td className="py-2 text-right font-medium text-slate-900 dark:text-white">{fmtNum(w.qty)}</td>
                  </tr>
                ))}
                <tr className="border-t border-slate-200 font-semibold dark:border-slate-700">
                  <td className="py-2 pr-4 text-slate-900 dark:text-white">ລວມ</td>
                  <td></td>
                  <td className="py-2 text-right text-slate-900 dark:text-white">{fmtNum(String(totalQty))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Movement history */}
      <section id="movements" className="rounded-xl glass p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">ປະຫວັດເຄື່ອນໄຫວ (ລ້າສຸດ {movements.length})</h2>
          <Link href={`/products/${encodeURIComponent(decodedCode)}/movements${wh ? `?wh=${encodeURIComponent(wh)}` : ""}`} className="text-xs font-semibold text-teal-600 hover:underline dark:text-teal-400">ເບິ່ງທັງໝົດ →</Link>
        </div>
        {movementWarehouses.length > 1 && (
          <WarehouseFilter code={decodedCode} current={wh} options={movementWarehouses} />
        )}
        {movements.length === 0 ? (
          <p className="text-sm text-slate-400">ບໍ່ມີປະຫວັດເຄື່ອນໄຫວ</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="py-2 pr-4 font-medium">ວັນທີ</th>
                  <th className="py-2 pr-4 font-medium">ເລກເອກະສານ</th>
                  <th className="py-2 pr-4 font-medium">ປະເພດ</th>
                  <th className="py-2 pr-4 font-medium">ສາງ</th>
                  <th className="py-2 pr-4 text-right font-medium">ຈຳນວນ</th>
                  <th className="py-2 pr-4 font-medium">ຫົວໜ່ວຍ</th>
                  <th className="py-2 text-right font-medium">ມູນຄ່າ</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m, i) => {
                  const inQty = Number(m.inqty);
                  const outQty = Number(m.outqty);
                  const isIn = inQty > 0;
                  const isOut = outQty !== 0;
                  const qty = isIn ? inQty : -Math.abs(outQty);
                  const amount = Number(m.amount);
                  const signedAmount = isOut ? -Math.abs(amount) : amount;
                  const currencySymbol = m.currency_code === "02" ? "₭" : m.currency_code === "01" ? "฿" : m.currency_code;
                  return (
                    <tr key={`${m.doc_no}-${i}`} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                      <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">{fmtDate(m.doc_date)}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-700 dark:text-slate-300">{m.doc_no}</td>
                      <td className="py-2 pr-4">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                            isOut
                              ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                              : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                          }`}
                        >
                          {isOut ? "↓" : "↑"} {m.doc_type || (isOut ? "ຈ່າຍອອກ" : "ຮັບເຂົ້າ")}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">{m.wh_name || "-"}</td>
                      <td
                        className={`py-2 pr-4 text-right font-medium ${
                          isOut ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"
                        }`}
                      >
                        {qty > 0 ? "+" : ""}
                        {fmtNum(String(qty))}
                      </td>
                      <td className="py-2 pr-4 text-slate-500 dark:text-slate-400">{m.unit_code || "-"}</td>
                      <td
                        className={`whitespace-nowrap py-2 text-right font-semibold ${
                          amount === 0
                            ? "text-slate-400"
                            : isOut
                              ? "text-red-600 dark:text-red-400"
                              : "text-green-600 dark:text-green-400"
                        }`}
                      >
                        {amount === 0 ? "-" : `${signedAmount > 0 ? "+" : "−"}${currencySymbol ? `${currencySymbol} ` : ""}${fmtNum(String(Math.abs(signedAmount)))}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Card title={`ບາໂຄດ (${barcodes.length})`}>
        {barcodes.length === 0 ? (
          <p className="text-sm text-slate-400">ບໍ່ມີບາໂຄດ</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                <th className="py-1 font-medium">ບາໂຄດ</th>
                <th className="py-1 font-medium">ໜ່ວຍ</th>
                <th className="py-1 text-right font-medium">ລາຄາ</th>
              </tr>
            </thead>
            <tbody>
              {barcodes.map((b, i) => (
                <tr key={`${b.barcode}-${i}`} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1.5 font-mono text-xs">{b.barcode}</td>
                  <td className="py-1.5 text-slate-600 dark:text-slate-400">{b.unit_code || "-"}</td>
                  <td className="py-1.5 text-right">{Number(b.price) > 0 ? fmtNum(b.price) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );

  const isnTab = (
    <Card title={`ໝາຍເລກເຄື່ອງ / ISN (${serialSummary.total.toLocaleString("en-US")})`}>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-green-100 px-2.5 py-1 text-green-700 dark:bg-green-950 dark:text-green-300">
          ໃນສາງ {serialSummary.in_stock.toLocaleString("en-US")}
        </span>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          ອອກແລ້ວ {serialSummary.out_stock.toLocaleString("en-US")}
        </span>
      </div>
      <SerialTree warehouses={serialWarehouses} serials={serials} />
    </Card>
  );

  const soldTab = (
    <Card title={`ຂາຍອອກແລ້ວ (${serialSummary.out_stock.toLocaleString("en-US")})`}>
      {soldSerials.length === 0 ? (
        <p className="text-sm text-slate-400">ບໍ່ມີລາຍການຂາຍອອກ</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <th className="py-2 pr-4 font-medium">ISN</th>
                <th className="py-2 pr-4 font-medium">SN</th>
                <th className="py-2 pr-4 font-medium">ບິນຂາຍ</th>
                <th className="py-2 pr-4 font-medium">ວັນທີຂາຍ</th>
                <th className="py-2 pr-4 font-medium">ລູກຄ້າ</th>
                <th className="py-2 pr-4 text-right font-medium">ລາຄາຂາຍ</th>
                <th className="py-2 font-medium">ປະກັນເຫຼືອ</th>
              </tr>
            </thead>
            <tbody>
              {soldSerials.map((s, i) => {
                const w = warrantyStatus(s.sale_date);
                return (
                  <tr key={`${s.serial_no}-${i}`} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="py-2 pr-4 font-mono text-xs text-slate-800 dark:text-slate-200">{s.isn || "-"}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-500 dark:text-slate-400">{s.serial_no}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-700 dark:text-slate-300">{s.bill || "-"}</td>
                    <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">{fmtDate(s.sale_date)}</td>
                    <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">{s.customer || "-"}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right font-semibold text-slate-800 dark:text-slate-200">
                      {s.sale_price
                        ? `฿ ${Number(s.sale_price).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                        : "-"}
                    </td>
                    <td className="py-2">
                      {w ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            w.expired
                              ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                              : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                          }`}
                        >
                          {w.label}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );

  const relatedTab = (
    <Card title={p.is_spare ? "ສິນຄ້າທີ່ໃຊ້ກັບອາໄຫຼ່ນີ້" : "ອາໄຫຼ່ທີ່ໃຊ້ກັບສິນຄ້ານີ້"}>
      <RelatedItemForm currentCode={p.code} isSpare={p.is_spare} />
      {relatedItems.length === 0 ? (
        <div className="rounded-xl bg-slate-50 px-5 py-10 text-center dark:bg-slate-950">
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
            {p.is_spare ? "ຍັງບໍ່ພົບສິນຄ້າທີ່ກົງກັບ model ຂອງອາໄຫຼ່ນີ້" : "ຍັງບໍ່ພົບອາໄຫຼ່ທີ່ກົງກັບ model ຂອງສິນຄ້ານີ້"}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[940px] text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <th className="py-2 pr-4 font-medium">ລະຫັດ</th>
                <th className="py-2 pr-4 font-medium">ຊື່ລາຍການ</th>
                <th className="py-2 pr-4 font-medium">Model</th>
                <th className="py-2 pr-4 font-medium">ຍີ່ຫໍ້</th>
                <th className="py-2 pr-4 text-right font-medium">ຄົງເຫຼືອ</th>
                <th className="py-2 pr-4 font-medium">ໜ່ວຍ</th>
                <th className="py-2 font-medium">ຈັດການ</th>
              </tr>
            </thead>
            <tbody>
              {relatedItems.map((item) => (
                <tr key={item.code} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <td className="py-3 pr-4 font-mono text-xs">
                    <Link href={`/products/${encodeURIComponent(item.code)}`} className="font-semibold text-teal-600 hover:underline dark:text-teal-400">
                      {item.code}
                    </Link>
                  </td>
                  <td className="py-3 pr-4 font-medium text-slate-900 dark:text-white">
                    <span>{item.name_1 || "-"}</span>
                    {item.is_manual && (
                      <span className="ml-2 rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-semibold text-teal-700 dark:bg-teal-950 dark:text-teal-300">ເພີ່ມເອງ</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-slate-500 dark:text-slate-400">{item.item_model || "-"}</td>
                  <td className="py-3 pr-4 text-slate-600 dark:text-slate-400">{item.brand_name || "-"}</td>
                  <td className="py-3 pr-4 text-right">
                    <span
                      className={`inline-flex min-w-8 justify-center rounded-md px-2.5 py-0.5 font-bold ${
                        Number(item.balance_qty) > 0
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
                      }`}
                    >
                      {fmtNum(item.balance_qty)}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-slate-500 dark:text-slate-400">{item.unit_standard_name || "-"}</td>
                  <td className="py-3">
                    {item.is_manual ? (
                      <RelatedItemActions currentCode={p.code} relatedCode={item.code} />
                    ) : (
                      <span className="text-xs text-slate-400">ອັດຕະໂນມັດ</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );

  const tabs: Tab[] = [
    { id: "info", label: "ຂໍ້ມູນ", content: infoTab },
    { id: "stock", label: "ສາງ & ເຄື່ອນໄຫວ", content: stockTab },
  ];
  if (serialSummary.in_stock > 0) {
    tabs.push({ id: "isn", label: `ISN ໃນສາງ (${serialSummary.in_stock.toLocaleString("en-US")})`, content: isnTab });
  }
  if (serialSummary.out_stock > 0) {
    tabs.push({ id: "sold", label: `ຂາຍອອກ (${serialSummary.out_stock.toLocaleString("en-US")})`, content: soldTab });
  }
  tabs.push({
    id: "related",
    label: p.is_spare
      ? `ສິນຄ້າທີ່ໃຊ້ (${relatedItems.length.toLocaleString("en-US")})`
      : `ອາໄຫຼ່ (${relatedItems.length.toLocaleString("en-US")})`,
    content: relatedTab,
  });
  tabs.push({
    id: "chatter",
    label: `ສົນທະນາ & ວຽກ (${comments.length + activities.filter((a) => a.status !== "done").length})`,
    content: (
      <ChatterActivities
        itemCode={decodedCode}
        comments={comments}
        activities={activities}
        staff={deptStaff}
        currentUserCode={user?.employeeCode ?? ""}
      />
    ),
  });

  return (
    <div className="w-full">
      <Link href="/products" className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500 transition hover:text-teal-600 dark:text-slate-400">
        <span aria-hidden="true">←</span> ກັບຄືນລາຍການສິນຄ້າ
      </Link>

      {/* Hero */}
      <div className="relative mt-4 flex flex-col gap-5 overflow-hidden rounded-xl glass p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6 lg:flex-row lg:items-center">
        <div className="absolute bottom-0 left-0 top-0 w-1 bg-teal-500" />
        <div className="relative flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-950">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cover.src} alt={p.name_1} className="h-full w-full object-cover" />
          ) : (
            <span className="text-3xl text-slate-300">□</span>
          )}
        </div>
        <div className="relative min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                p.is_spare
                  ? "bg-amber-400/15 text-amber-300"
                  : "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300"
              }`}
            >
              {p.is_spare ? "ອາໄຫຼ່" : "ສິນຄ້າ"}
            </span>
            <span className="font-mono text-xs text-slate-500">{p.code}</span>
          </div>
          <h1 className="mt-2 text-xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-2xl">
            {p.name_1 || p.name_eng_1 || p.code}
          </h1>
          {p.name_eng_1 && p.name_eng_1 !== p.name_1 && (
            <p className="mt-1 text-xs text-slate-400">{p.name_eng_1}</p>
          )}
        </div>
      </div>

      {/* Stat tiles */}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatTile
          label="ຄົງເຫຼືອລວມ"
          value={fmtNum(String(totalQty))}
          sub={`${p.unit_standard_name} · ${warehouseStock.length} ສາງ`}
        />
        <StatTile label="ຕົ້ນທຶນສະເລ່ຍ" value={fmtNum(p.average_cost)} />
        <StatTile
          label="ລາຄາຂາຍ"
          value={prices[0] ? fmtNum(prices[0].sale_price) : "-"}
          sub={prices[0]?.currency_label}
        />
        <StatTile label="ຍີ່ຫໍ້" value={p.brand_name || "-"} />
      </div>

      <div className="mt-5">
        <Tabs tabs={tabs} initialTab={tab ?? (wh ? "stock" : "info")} />
      </div>
    </div>
  );
}
