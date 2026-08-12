import { query } from "./db";

let targetUniqueConstraintReady = false;
let salesAssignmentReady = false;
let authTableReady = false;

export async function ensureTargetUniqueConstraint() {
  if (targetUniqueConstraintReady) return;
  try {
    await query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'odg_sales_target_target_year_target_month_bu_code_province__key'
            AND conrelid = 'public.odg_sales_target'::regclass
        ) THEN
          ALTER TABLE public.odg_sales_target
          DROP CONSTRAINT odg_sales_target_target_year_target_month_bu_code_province__key;
        END IF;
      END$$;
    `);
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'odg_sales_target_unique_full'
            AND conrelid = 'public.odg_sales_target'::regclass
        ) THEN
          ALTER TABLE public.odg_sales_target
          ADD CONSTRAINT odg_sales_target_unique_full
          UNIQUE (target_year, target_month, bu_code, province_code, district_code, sale_channel);
        END IF;
      END$$;
    `);
    targetUniqueConstraintReady = true;
  } catch (error) {
    console.error("ensureTargetUniqueConstraint error:", error);
  }
}

export async function ensureSalesAssignmentTable() {
  if (salesAssignmentReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS public.odg_sales_assignment (
        id SERIAL PRIMARY KEY,
        sale_id TEXT NOT NULL,
        sale_name TEXT,
        bu_code TEXT NOT NULL,
        province_code TEXT NOT NULL,
        district_code TEXT NOT NULL DEFAULT 'ALL',
        channel_codes TEXT[],
        month INT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'odg_sales_assignment'
            AND column_name = 'district_code'
        ) THEN
          ALTER TABLE public.odg_sales_assignment
          ADD COLUMN district_code TEXT NOT NULL DEFAULT 'ALL';
        END IF;
      END$$;
    `);
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'odg_sales_assignment'
            AND column_name = 'channel_codes'
        ) THEN
          ALTER TABLE public.odg_sales_assignment
          ADD COLUMN channel_codes TEXT[];
        END IF;
      END$$;
    `);
    await query(`ALTER TABLE public.odg_sales_assignment DROP CONSTRAINT IF EXISTS odg_sales_assignment_unique;`);
    await query(`DROP INDEX IF EXISTS odg_sales_assignment_unique;`);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS odg_sales_assignment_unique_idx
      ON public.odg_sales_assignment (sale_id, bu_code, province_code, district_code, month);
    `);
    salesAssignmentReady = true;
  } catch (error) {
    console.error("ensureSalesAssignmentTable error:", error);
  }
}

export async function ensureAuthTable() {
  if (authTableReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS public.odg_user_auth (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        role TEXT NOT NULL,
        bu_code TEXT,
        channel_codes TEXT[],
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'odg_user_auth'
            AND column_name = 'bu_code'
        ) THEN
          ALTER TABLE public.odg_user_auth ADD COLUMN bu_code TEXT;
        END IF;
      END$$;
    `);
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'odg_user_auth'
            AND column_name = 'channel_codes'
        ) THEN
          ALTER TABLE public.odg_user_auth ADD COLUMN channel_codes TEXT[];
        END IF;
      END$$;
    `);
    authTableReady = true;
  } catch (error) {
    console.error("ensureAuthTable error:", error);
  }
}

let mgmtUserReady = false;

/**
 * Access list for this management app only — deliberately separate from
 * app_employee_access, which belongs to the sales/POS app.
 * Roles use this app's own vocabulary (see ALLOWED_ROLES in lib/auth.js).
 */
export async function ensureMgmtUserTable() {
  if (mgmtUserReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS public.odg_mgmt_user (
        employee_code text PRIMARY KEY,
        app_role      text NOT NULL DEFAULT 'sale',
        is_active     boolean NOT NULL DEFAULT true,
        bu_code       text,
        channel_codes text[],
        note          text,
        created_by    text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_by    text,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT odg_mgmt_user_role_chk
          CHECK (app_role IN ('ceo', 'gm', 'sale_bu_manager', 'sale_supervisor', 'sale'))
      );
    `);
    await query(`ALTER TABLE public.odg_mgmt_user ADD COLUMN IF NOT EXISTS channel_codes text[]`);
    await query(`CREATE INDEX IF NOT EXISTS idx_odg_mgmt_user_active ON public.odg_mgmt_user (is_active)`);

    // The owner must always be able to get in, even on a brand-new table.
    const owners = (process.env.ODG_OWNER_CODES || "22020")
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean);
    for (const code of owners) {
      await query(
        `INSERT INTO public.odg_mgmt_user (employee_code, app_role, is_active, note, created_by, updated_by)
         VALUES (%s, 'ceo', true, 'owner', 'system', 'system')
         ON CONFLICT (employee_code) DO NOTHING`,
        [code],
      );
    }
    mgmtUserReady = true;
  } catch (error) {
    console.error("ensureMgmtUserTable error:", error);
  }
}

let payoutReady = false;

/**
 * Records that a month's retail incentive has been paid, together with a frozen
 * copy of what each person was paid. Owned by this app — the sales app's
 * app_commission_round / _line tables are left untouched.
 */
export async function ensurePayoutTables() {
  if (payoutReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS public.odg_incentive_payout (
        id            SERIAL PRIMARY KEY,
        target_year   int  NOT NULL,
        target_month  int  NOT NULL,
        branch_code   text NOT NULL DEFAULT '01',
        status        text NOT NULL DEFAULT 'paid',
        people        int  NOT NULL DEFAULT 0,
        point_reward  numeric NOT NULL DEFAULT 0,
        unit_reward   numeric NOT NULL DEFAULT 0,
        commission    numeric NOT NULL DEFAULT 0,
        total_amount  numeric NOT NULL DEFAULT 0,
        currency      text NOT NULL DEFAULT 'THB',
        note          text,
        paid_by       text,
        paid_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT odg_incentive_payout_unique UNIQUE (target_year, target_month, branch_code)
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS public.odg_incentive_payout_line (
        payout_id     int  NOT NULL REFERENCES public.odg_incentive_payout(id) ON DELETE CASCADE,
        employee_code text NOT NULL,
        employee_name text,
        sales         numeric NOT NULL DEFAULT 0,
        target        numeric NOT NULL DEFAULT 0,
        ach_pct       numeric NOT NULL DEFAULT 0,
        points        numeric NOT NULL DEFAULT 0,
        multiplier    numeric NOT NULL DEFAULT 0,
        point_reward  numeric NOT NULL DEFAULT 0,
        unit_reward   numeric NOT NULL DEFAULT 0,
        commission    numeric NOT NULL DEFAULT 0,
        total         numeric NOT NULL DEFAULT 0,
        PRIMARY KEY (payout_id, employee_code)
      );
    `);
    payoutReady = true;
  } catch (error) {
    console.error("ensurePayoutTables error:", error);
  }
}
