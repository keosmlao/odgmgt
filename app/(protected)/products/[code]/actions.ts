"use server";

import { revalidatePath } from "next/cache";
import { pool } from "@/lib/pm/db";
import { getCurrentUser } from "@/lib/pm/session";

export type RelationActionState = {
  error: string | null;
  success: string | null;
};

export type AddRelationState = RelationActionState;

type ItemKind = { code: string; name_1: string; is_spare: boolean };

export async function addProductSpareRelation(
  _previous: AddRelationState,
  formData: FormData,
): Promise<AddRelationState> {
  const user = await getCurrentUser();
  if (!user) return { error: "ກະລຸນາເຂົ້າລະບົບໃໝ່", success: null };

  const currentCode = String(formData.get("current_code") ?? "").trim();
  const relatedCode = String(formData.get("related_code") ?? "").trim();
  if (!currentCode || !relatedCode) {
    return { error: "ກະລຸນາປ້ອນລະຫັດທີ່ຕ້ອງການເພີ່ມ", success: null };
  }
  if (currentCode === relatedCode) {
    return { error: "ບໍ່ສາມາດຈັບຄູ່ລະຫັດດຽວກັນໄດ້", success: null };
  }

  const { rows } = await pool.query<ItemKind>(
    `SELECT code, name_1, (group_main = '14') AS is_spare
       FROM ic_inventory
      WHERE code = ANY($1::varchar[])`,
    [[currentCode, relatedCode]],
  );
  const current = rows.find((item) => item.code === currentCode);
  const related = rows.find((item) => item.code === relatedCode);
  if (!current) return { error: "ບໍ່ພົບລະຫັດລາຍການປັດຈຸບັນ", success: null };
  if (!related) return { error: `ບໍ່ພົບລະຫັດ ${relatedCode}`, success: null };
  if (current.is_spare === related.is_spare) {
    return {
      error: current.is_spare
        ? "ຕ້ອງເພີ່ມລະຫັດສິນຄ້າ ບໍ່ແມ່ນອາໄຫຼ່"
        : "ຕ້ອງເພີ່ມລະຫັດອາໄຫຼ່ (ກຸ່ມຫຼັກ 14)",
      success: null,
    };
  }

  const productCode = current.is_spare ? related.code : current.code;
  const spareCode = current.is_spare ? current.code : related.code;
  const result = await pool.query(
    `INSERT INTO odg_product_spare_mapping (product_code, spare_code, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (product_code, spare_code) DO NOTHING
     RETURNING id`,
    [productCode, spareCode, user.employeeCode],
  );

  revalidatePath(`/products/${encodeURIComponent(currentCode)}`);
  return result.rowCount
    ? { error: null, success: `ເພີ່ມ ${related.code} · ${related.name_1} ສຳເລັດ` }
    : { error: null, success: "ລາຍການນີ້ຖືກເພີ່ມໄວ້ແລ້ວ" };
}

async function getItemKinds(codes: string[]) {
  const { rows } = await pool.query<ItemKind>(
    `SELECT code, name_1, (group_main = '14') AS is_spare
       FROM ic_inventory
      WHERE code = ANY($1::varchar[])`,
    [codes],
  );
  return rows;
}

function relationPair(current: ItemKind, relatedCode: string) {
  return current.is_spare
    ? { productCode: relatedCode, spareCode: current.code }
    : { productCode: current.code, spareCode: relatedCode };
}

export async function updateProductSpareRelation(
  _previous: RelationActionState,
  formData: FormData,
): Promise<RelationActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "ກະລຸນາເຂົ້າລະບົບໃໝ່", success: null };

  const currentCode = String(formData.get("current_code") ?? "").trim();
  const oldRelatedCode = String(formData.get("old_related_code") ?? "").trim();
  const newRelatedCode = String(formData.get("new_related_code") ?? "").trim();
  if (!currentCode || !oldRelatedCode || !newRelatedCode) {
    return { error: "ກະລຸນາປ້ອນລະຫັດໃໝ່", success: null };
  }
  if (currentCode === newRelatedCode) {
    return { error: "ບໍ່ສາມາດຈັບຄູ່ລະຫັດດຽວກັນໄດ້", success: null };
  }
  if (oldRelatedCode === newRelatedCode) {
    return { error: null, success: "ລະຫັດຍັງຄືເກົ່າ" };
  }

  const rows = await getItemKinds([currentCode, newRelatedCode]);
  const current = rows.find((item) => item.code === currentCode);
  const related = rows.find((item) => item.code === newRelatedCode);
  if (!current) return { error: "ບໍ່ພົບລະຫັດລາຍການປັດຈຸບັນ", success: null };
  if (!related) return { error: `ບໍ່ພົບລະຫັດ ${newRelatedCode}`, success: null };
  if (current.is_spare === related.is_spare) {
    return {
      error: current.is_spare
        ? "ຕ້ອງເລືອກລະຫັດສິນຄ້າ ບໍ່ແມ່ນອາໄຫຼ່"
        : "ຕ້ອງເລືອກລະຫັດອາໄຫຼ່ (ກຸ່ມຫຼັກ 14)",
      success: null,
    };
  }

  const oldPair = relationPair(current, oldRelatedCode);
  const newPair = relationPair(current, newRelatedCode);
  try {
    const result = await pool.query(
      `UPDATE odg_product_spare_mapping
          SET product_code = $1, spare_code = $2, created_by = $3
        WHERE product_code = $4 AND spare_code = $5
        RETURNING id`,
      [
        newPair.productCode,
        newPair.spareCode,
        user.employeeCode,
        oldPair.productCode,
        oldPair.spareCode,
      ],
    );
    if (!result.rowCount) {
      return { error: "ບໍ່ພົບລາຍການທີ່ເພີ່ມເອງນີ້", success: null };
    }
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505") {
      return { error: "ລະຫັດນີ້ຖືກຈັບຄູ່ໄວ້ແລ້ວ", success: null };
    }
    throw error;
  }

  revalidatePath(`/products/${encodeURIComponent(currentCode)}`);
  return { error: null, success: `ປ່ຽນເປັນ ${related.code} · ${related.name_1} ສຳເລັດ` };
}

export async function setProductResponsible(
  _previous: RelationActionState,
  formData: FormData,
): Promise<RelationActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "ກະລຸນາເຂົ້າລະບົບໃໝ່", success: null };

  const productCode = String(formData.get("product_code") ?? "").trim();
  const employeeCode = String(formData.get("employee_code") ?? "").trim();
  if (!productCode) return { error: "ຂໍ້ມູນບໍ່ຄົບ", success: null };

  // Empty employee → clear the assignment.
  if (!employeeCode) {
    await pool.query(`DELETE FROM odg_product_responsible WHERE product_code = $1`, [productCode]);
    revalidatePath(`/products/${encodeURIComponent(productCode)}`);
    return { error: null, success: "ລຶບຜູ້ຮັບຜິດຊອບແລ້ວ" };
  }

  const { rows } = await pool.query<{ fullname_lo: string }>(
    `SELECT fullname_lo FROM odg_employee
      WHERE employee_code = $1 AND department_code IN ('101','102','103','104')`,
    [employeeCode],
  );
  if (!rows[0]) {
    return { error: "ຕ້ອງເລືອກພະນັກງານພະແນກພະລິດຕະພັນ", success: null };
  }

  await pool.query(
    `INSERT INTO odg_product_responsible (product_code, employee_code, assigned_by, assigned_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (product_code)
       DO UPDATE SET employee_code = EXCLUDED.employee_code,
                     assigned_by = EXCLUDED.assigned_by,
                     assigned_at = now()`,
    [productCode, employeeCode, user.employeeCode],
  );
  revalidatePath(`/products/${encodeURIComponent(productCode)}`);
  return { error: null, success: `ກຳນົດ ${rows[0].fullname_lo} ຮັບຜິດຊອບແລ້ວ` };
}

export async function deleteProductSpareRelation(
  _previous: RelationActionState,
  formData: FormData,
): Promise<RelationActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "ກະລຸນາເຂົ້າລະບົບໃໝ່", success: null };

  const currentCode = String(formData.get("current_code") ?? "").trim();
  const relatedCode = String(formData.get("related_code") ?? "").trim();
  if (!currentCode || !relatedCode) {
    return { error: "ຂໍ້ມູນບໍ່ຄົບ ບໍ່ສາມາດລຶບໄດ້", success: null };
  }

  const rows = await getItemKinds([currentCode]);
  const current = rows.find((item) => item.code === currentCode);
  if (!current) return { error: "ບໍ່ພົບລະຫັດລາຍການປັດຈຸບັນ", success: null };

  const pair = relationPair(current, relatedCode);
  const result = await pool.query(
    `DELETE FROM odg_product_spare_mapping
      WHERE product_code = $1 AND spare_code = $2
      RETURNING id`,
    [pair.productCode, pair.spareCode],
  );
  if (!result.rowCount) {
    return { error: "ລາຍການນີ້ຖືກລຶບໄປແລ້ວ ຫຼື ບໍ່ແມ່ນລາຍການທີ່ເພີ່ມເອງ", success: null };
  }

  revalidatePath(`/products/${encodeURIComponent(currentCode)}`);
  return { error: null, success: "ລຶບຄວາມສຳພັນສຳເລັດ" };
}
