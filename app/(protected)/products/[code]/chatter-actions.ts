"use server";

import { revalidatePath } from "next/cache";
import { pool } from "@/lib/pm/db";
import { getCurrentUser } from "@/lib/pm/session";

export type ChatterState = { error: string | null; success: string | null };

export async function addComment(_prev: ChatterState, formData: FormData): Promise<ChatterState> {
  const user = await getCurrentUser();
  if (!user) return { error: "ກະລຸນາເຂົ້າລະບົບໃໝ່", success: null };
  const itemCode = String(formData.get("item_code") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!itemCode || !body) return { error: "ກະລຸນາພິມຂໍ້ຄວາມ", success: null };

  await pool.query(
    `INSERT INTO odg_product_comment (item_code, body, created_by) VALUES ($1, $2, $3)`,
    [itemCode, body.slice(0, 2000), user.employeeCode],
  );
  revalidatePath(`/products/${encodeURIComponent(itemCode)}`);
  return { error: null, success: null };
}

export async function deleteComment(_prev: ChatterState, formData: FormData): Promise<ChatterState> {
  const user = await getCurrentUser();
  if (!user) return { error: "ກະລຸນາເຂົ້າລະບົບໃໝ່", success: null };
  const id = Number(formData.get("id") ?? "");
  const itemCode = String(formData.get("item_code") ?? "").trim();
  if (!id) return { error: "ຂໍ້ມູນບໍ່ຄົບ", success: null };
  // Only the author may delete their own comment.
  await pool.query(`DELETE FROM odg_product_comment WHERE id = $1 AND created_by = $2`, [id, user.employeeCode]);
  revalidatePath(`/products/${encodeURIComponent(itemCode)}`);
  return { error: null, success: null };
}

export async function addActivity(_prev: ChatterState, formData: FormData): Promise<ChatterState> {
  const user = await getCurrentUser();
  if (!user) return { error: "ກະລຸນາເຂົ້າລະບົບໃໝ່", success: null };
  const itemCode = String(formData.get("item_code") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const assignee = String(formData.get("assignee") ?? "").trim();
  const dueDate = String(formData.get("due_date") ?? "").trim();
  if (!itemCode || !title) return { error: "ກະລຸນາພິມຫົວຂໍ້ວຽກ", success: null };

  await pool.query(
    `INSERT INTO odg_product_activity (item_code, title, assignee, due_date, created_by)
     VALUES ($1, $2, NULLIF($3,''), NULLIF($4,'')::date, $5)`,
    [itemCode, title.slice(0, 255), assignee, dueDate, user.employeeCode],
  );
  revalidatePath(`/products/${encodeURIComponent(itemCode)}`);
  return { error: null, success: "ເພີ່ມວຽກແລ້ວ" };
}

export async function toggleActivity(_prev: ChatterState, formData: FormData): Promise<ChatterState> {
  const user = await getCurrentUser();
  if (!user) return { error: "ກະລຸນາເຂົ້າລະບົບໃໝ່", success: null };
  const id = Number(formData.get("id") ?? "");
  const itemCode = String(formData.get("item_code") ?? "").trim();
  if (!id) return { error: "ຂໍ້ມູນບໍ່ຄົບ", success: null };
  await pool.query(
    `UPDATE odg_product_activity
        SET status = CASE WHEN status = 'done' THEN 'open' ELSE 'done' END,
            done_at = CASE WHEN status = 'done' THEN NULL ELSE now() END
      WHERE id = $1`,
    [id],
  );
  revalidatePath(`/products/${encodeURIComponent(itemCode)}`);
  return { error: null, success: null };
}
