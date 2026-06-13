import { NextResponse, type NextRequest } from "next/server";
import { rows, one, query } from "@/lib/db";
import { ok, fail, errorMessage } from "@/lib/api-response";

const SELECT_COLUMNS = "department_code, weight_balanced_scorecard, weight_matrix";

export async function GET(request: NextRequest) {
  try {
    const department = request.nextUrl.searchParams.get("department");

    // With ?department=CODE → return that single row (or null).
    if (department) {
      const row = await one(
        `SELECT ${SELECT_COLUMNS}
         FROM public.odg_evaluation_weight
         WHERE department_code = %s`,
        [department],
      );
      return ok(row);
    }

    // No params → return the full list.
    const data = await rows(
      `SELECT ${SELECT_COLUMNS}
       FROM public.odg_evaluation_weight
       ORDER BY department_code`,
    );
    return ok(data);
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const departmentCode = payload.department_code;
    if (!departmentCode) {
      return NextResponse.json(
        { success: false, message: "department_code is required" },
        { status: 400 },
      );
    }
    const balancedScorecard = Number(payload.weight_balanced_scorecard || 0);
    const matrix = Number(payload.weight_matrix || 0);

    // Upsert by department_code without depending on a unique constraint.
    const updated = await query(
      `UPDATE public.odg_evaluation_weight
       SET weight_balanced_scorecard = %s, weight_matrix = %s, updated_at = NOW()
       WHERE department_code = %s`,
      [balancedScorecard, matrix, departmentCode],
    );
    if (!updated.rowCount) {
      await query(
        `INSERT INTO public.odg_evaluation_weight
         (department_code, weight_balanced_scorecard, weight_matrix)
         VALUES (%s, %s, %s)`,
        [departmentCode, balancedScorecard, matrix],
      );
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
