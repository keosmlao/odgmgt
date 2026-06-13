import { query } from "./db";

let targetUniqueConstraintReady = false;
let salesAssignmentReady = false;
let authTableReady = false;

export async function ensureTargetUniqueConstraint(): Promise<void> {
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

export async function ensureSalesAssignmentTable(): Promise<void> {
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

export async function ensureAuthTable(): Promise<void> {
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

/**
 * Run all schema migrations once. Called from `instrumentation.ts` at server
 * boot so individual request handlers never pay the migration cost.
 */
export async function runMigrations(): Promise<void> {
  await Promise.all([
    ensureAuthTable(),
    ensureSalesAssignmentTable(),
    ensureTargetUniqueConstraint(),
  ]);
}
