import { rows } from "@/lib/db";
import { pickFirst } from "@/lib/auth";
import { ok, fail, errorMessage } from "@/lib/api-response";

export async function GET() {
  try {
    const result = await rows("SELECT * FROM public.erp_user");
    const data = result
      .map((row) => {
        const saleId = pickFirst(row, [
          "user_id",
          "id",
          "user_code",
          "code",
          "emp_code",
          "username",
        ]);
        const saleCode = pickFirst(row, [
          "user_code",
          "code",
          "emp_code",
          "username",
          "user_id",
          "id",
        ]);
        const saleName = pickFirst(row, [
          "name",
          "name_1",
          "fullname",
          "full_name",
          "display_name",
          "user_name",
          "username",
        ]);
        if (saleId == null && saleCode == null && saleName == null) {
          return null;
        }
        return {
          id: saleId || saleCode || saleName,
          code: saleCode || saleId || saleName,
          name: saleName || saleCode || saleId,
        };
      })
      .filter(Boolean);

    return ok(data);
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
