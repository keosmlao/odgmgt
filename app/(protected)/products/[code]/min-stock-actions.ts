"use server";

import { revalidatePath } from "next/cache";
import { pool } from "@/lib/pm/db";
import { getIsAdmin } from "@/lib/pm/products";
import { getCurrentUser } from "@/lib/pm/session";

export type MinStockState = { error: string | null; success: string | null };

// Upsert without relying on a unique constraint (DDL is restricted on the
// shared ERP DB): update first, insert if nothing was updated.
export async function setMinStock(
  _previous: MinStockState,
  formData: FormData,
): Promise<MinStockState> {
  const user = await getCurrentUser();
  if (!user || !(await getIsAdmin(user.employeeCode))) {
    return { error: "ບໍ່ມີສິດ (ສະເພາະ admin)", success: null };
  }

  const itemCode = String(formData.get("item_code") ?? "").trim();
  const minRaw = String(formData.get("min_qty") ?? "").trim();
  const maxRaw = String(formData.get("max_qty") ?? "").trim();
  if (!itemCode) return { error: "ຂໍ້ມູນບໍ່ຄົບ", success: null };

  // Both empty → remove the setting.
  if (minRaw === "" && maxRaw === "") {
    await pool.query(`DELETE FROM odg_min_stock_setting WHERE item_code = $1`, [itemCode]);
    revalidatePath(`/products/${encodeURIComponent(itemCode)}`);
    return { error: null, success: "ລຶບ min/max stock ແລ້ວ" };
  }

  let minQty: number | null = null;
  if (minRaw !== "") {
    minQty = Number(minRaw);
    if (Number.isNaN(minQty) || minQty < 0) return { error: "ຈຳນວນ min ບໍ່ຖືກຕ້ອງ", success: null };
  }
  let maxQty: number | null = null;
  if (maxRaw !== "") {
    maxQty = Number(maxRaw);
    if (Number.isNaN(maxQty) || maxQty < 0) return { error: "ຈຳນວນ max ບໍ່ຖືກຕ້ອງ", success: null };
  }
  if (minQty != null && maxQty != null && maxQty < minQty) {
    return { error: "max ຕ້ອງ ≥ min", success: null };
  }

  const upd = await pool.query(
    `UPDATE odg_min_stock_setting
        SET min_qty = $2, max_qty = $3, updated_by = $4, updated_at = now()
      WHERE item_code = $1`,
    [itemCode, minQty, maxQty, user.employeeCode],
  );
  if (!upd.rowCount) {
    await pool.query(
      `INSERT INTO odg_min_stock_setting (item_code, min_qty, max_qty, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [itemCode, minQty, maxQty, user.employeeCode],
    );
  }
  revalidatePath(`/products/${encodeURIComponent(itemCode)}`);
  const parts = [
    minQty != null ? `min = ${minQty.toLocaleString("en-US")}` : null,
    maxQty != null ? `max = ${maxQty.toLocaleString("en-US")}` : null,
  ].filter(Boolean);
  return { error: null, success: `ຕັ້ງ ${parts.join(" · ")}` };
}
