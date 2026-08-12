import {
  buildEmployeeUser,
  findEmployeeByUsername,
  getMgmtUser,
  OWNER_CODES,
  isActiveValue,
  verifyEmployeePassword,
} from "./employee-auth";
import { issueLoginResponse } from "./route-auth";

/**
 * Shared login logic for /api/login and /api/auth/login.
 * Credentials are checked against public.odg_employee only.
 * Returns a plain object { success, user?, token?, message? }.
 */
export async function authLogin(username, password) {
  try {
    if (!username || !password) {
      return { success: false, message: "username and password required" };
    }

    const { row, schema } = await findEmployeeByUsername(username);
    if (!row) {
      return { success: false, message: "invalid credentials" };
    }

    if (schema.activeColumn && !isActiveValue(row[schema.activeColumn])) {
      return { success: false, message: "account is inactive" };
    }

    const { ok, unsupported } = verifyEmployeePassword(
      row[schema.passwordColumn],
      password,
    );
    if (unsupported) {
      return { success: false, message: "password format not supported" };
    }
    if (!ok) {
      return { success: false, message: "invalid credentials" };
    }

    const user = buildEmployeeUser(row, schema, username);
    const code = String(schema.codeColumn ? row[schema.codeColumn] : user.username);

    // This app keeps its own access list; an employee row alone is not enough.
    const access = await getMgmtUser(code);
    if (!access && !OWNER_CODES.has(code)) {
      return { success: false, message: "ບັນຊີນີ້ຍັງບໍ່ໄດ້ຮັບອະນຸຍາດໃຫ້ເຂົ້າລະບົບ" };
    }

    // The access list is the authority on role and BU scope.
    if (access?.app_role) user.role = String(access.app_role).toLowerCase();
    if (access?.bu_code) {
      user.bu_code = access.bu_code;
      user.bu_codes = [String(access.bu_code)];
    }
    if (Array.isArray(access?.channel_codes) && access.channel_codes.length) {
      user.channel_codes = access.channel_codes.map(String);
    }

    return issueLoginResponse(user);
  } catch (error) {
    return { success: false, error: error.message };
  }
}
