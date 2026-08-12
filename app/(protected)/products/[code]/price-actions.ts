"use server";

import { revalidatePath } from "next/cache";
import { updateSalePrice } from "@/lib/pm/pricing";
import { getIsAdmin } from "@/lib/pm/products";
import { getCurrentUser } from "@/lib/pm/session";

export type PriceState = { error: string | null; success: string | null; roworder: number | null };

// Edit one active sale-price row (targeted by roworder). Admin only.
export async function setSalePrice(_prev: PriceState, formData: FormData): Promise<PriceState> {
  const user = await getCurrentUser();
  if (!user || !(await getIsAdmin(user.employeeCode))) {
    return { error: "ບໍ່ມີສິດ (ສະເພາະ admin)", success: null, roworder: null };
  }
  const roworder = Number(formData.get("roworder"));
  const itemCode = String(formData.get("item_code") ?? "").trim();
  const raw = String(formData.get("price") ?? "").trim();
  if (!Number.isFinite(roworder) || !itemCode) return { error: "ຂໍ້ມູນບໍ່ຄົບ", success: null, roworder: null };

  const price = Number(raw);
  if (raw === "" || Number.isNaN(price) || price < 0) {
    return { error: "ລາຄາບໍ່ຖືກຕ້ອງ", success: null, roworder };
  }

  const ok = await updateSalePrice(roworder, itemCode, price);
  if (!ok) return { error: "ບໍ່ພົບແຖວລາຄາ ຫຼື ອັບເດດບໍ່ໄດ້", success: null, roworder };

  revalidatePath(`/products/${encodeURIComponent(itemCode)}`);
  revalidatePath("/products");
  return { error: null, success: `ບັນທຶກ ${price.toLocaleString("en-US")} ແລ້ວ`, roworder };
}
