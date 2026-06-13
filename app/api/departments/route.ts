import { rows } from "@/lib/db";
import { ok, fail, errorMessage } from "@/lib/api-response";

export async function GET() {
  try {
    const data = await rows(`
      SELECT code, name_1
      FROM public.odg_department_list
      ORDER BY code
    `);
    return ok(data);
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
