// Shared domain types used across the API layer and business logic.

export type UserRole =
  | "ceo"
  | "gm"
  | "sale_bu_manager"
  | "sale_supervisor"
  | "sale";

/** Authenticated user payload embedded in the JWT and returned to the client. */
export interface AuthUser {
  id: number | null;
  username: string | null;
  full_name: string | null;
  role: string;
  bu_code: string | null;
  channel_codes: string[];
}

/** Row shape from `odg_user_auth` / legacy `odg_user`. Columns vary by table. */
export interface AuthUserRow {
  id?: number;
  username?: string;
  password?: string;
  password_hash?: string;
  full_name?: string;
  name?: string;
  fullname?: string;
  role?: string;
  role_code?: string;
  bu_code?: string | null;
  channel_codes?: string[] | null;
  is_active?: boolean;
  [key: string]: unknown;
}

export interface LoginResult {
  success: boolean;
  user?: AuthUser;
  token?: string;
  message?: string;
  error?: string;
}

/** Standard API response envelope used by data endpoints. */
export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/** A single channel alias mapping (names + codes). */
export interface ChannelMapEntry {
  names: string[];
  codes: string[];
}

/** Filter values accepted by the dashboard / data endpoints. */
export type FilterValue = string | string[] | null | undefined;

export interface BuiltFilters {
  detailWhere: string;
  detailParams: unknown[];
  targetWhere: string;
  targetParams: unknown[];
}

export interface SaleDetailSchema {
  columnSet: Set<string>;
  dateCol: string | null;
  custNameCol: string | null;
  costCol: string | null;
}
