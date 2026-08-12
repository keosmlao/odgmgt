"use server";

import { revalidatePath } from "next/cache";
import { pool } from "@/lib/pm/db";
import { getIsAdmin } from "@/lib/pm/products";
import { getCurrentUser } from "@/lib/pm/session";

export type PmState = { error: string | null; success: string | null };

async function admin(): Promise<{ employeeCode: string } | null> {
  const user = await getCurrentUser();
  if (!user || !(await getIsAdmin(user.employeeCode))) return null;
  return user;
}

export async function setLifecycle(_prev: PmState, formData: FormData): Promise<PmState> {
  const user = await admin();
  if (!user) return { error: "ບໍ່ມີສິດ (ສະເພາະ admin)", success: null };
  const itemCode = String(formData.get("item_code") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  if (!itemCode) return { error: "ຂໍ້ມູນບໍ່ຄົບ", success: null };

  if (!status) {
    await pool.query(`DELETE FROM odg_product_lifecycle WHERE item_code = $1`, [itemCode]);
    revalidatePath(`/products/${encodeURIComponent(itemCode)}`);
    return { error: null, success: "ລຶບສະຖານະແລ້ວ" };
  }
  const upd = await pool.query(
    `UPDATE odg_product_lifecycle SET status = $2, updated_by = $3, updated_at = now() WHERE item_code = $1`,
    [itemCode, status, user.employeeCode],
  );
  if (!upd.rowCount) {
    await pool.query(
      `INSERT INTO odg_product_lifecycle (item_code, status, updated_by) VALUES ($1, $2, $3)`,
      [itemCode, status, user.employeeCode],
    );
  }
  revalidatePath(`/products/${encodeURIComponent(itemCode)}`);
  return { error: null, success: "ບັນທຶກສະຖານະແລ້ວ" };
}

export async function addItemSupplier(_prev: PmState, formData: FormData): Promise<PmState> {
  const user = await admin();
  if (!user) return { error: "ບໍ່ມີສິດ (ສະເພາະ admin)", success: null };
  const itemCode = String(formData.get("item_code") ?? "").trim();
  const supplierCode = String(formData.get("supplier_code") ?? "").trim();
  if (!itemCode || !supplierCode) return { error: "ກະລຸນາເລືອກຜູ້ສະໜອງ", success: null };

  const ok = await pool.query(`SELECT 1 FROM ap_supplier WHERE code = $1`, [supplierCode]);
  if (!ok.rowCount) return { error: "ບໍ່ພົບຜູ້ສະໜອງ", success: null };

  const res = await pool.query(
    `INSERT INTO odg_product_supplier (item_code, supplier_code, created_by)
     VALUES ($1, $2, $3) ON CONFLICT (item_code, supplier_code) DO NOTHING`,
    [itemCode, supplierCode, user.employeeCode],
  );
  revalidatePath(`/products/${encodeURIComponent(itemCode)}`);
  return res.rowCount
    ? { error: null, success: "ເພີ່ມຜູ້ສະໜອງແລ້ວ" }
    : { error: null, success: "ຜູ້ສະໜອງນີ້ມີຢູ່ແລ້ວ" };
}

export async function removeItemSupplier(_prev: PmState, formData: FormData): Promise<PmState> {
  const user = await admin();
  if (!user) return { error: "ບໍ່ມີສິດ (ສະເພາະ admin)", success: null };
  const id = Number(formData.get("id") ?? "");
  const itemCode = String(formData.get("item_code") ?? "").trim();
  if (!id) return { error: "ຂໍ້ມູນບໍ່ຄົບ", success: null };
  await pool.query(`DELETE FROM odg_product_supplier WHERE id = $1`, [id]);
  revalidatePath(`/products/${encodeURIComponent(itemCode)}`);
  return { error: null, success: "ລຶບຜູ້ສະໜອງແລ້ວ" };
}
