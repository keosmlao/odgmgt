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

let meetingScheduleReady = false;

/**
 * Weekly meeting board — the spreadsheet the office used to keep by hand
 * (one block per weekday, one row per meeting). Owned by this app alone.
 *
 * The name is odg_meeting_board, not odg_meeting_schedule: that name is
 * already taken by the ERP's own meeting documents (doc_no MT25…), and
 * odg_meeting / odg_meeting_participant belong to a separate module again.
 * Rooms are the only thing shared — they are read from odg_meeting_room.
 */
export async function ensureMeetingScheduleTable() {
  if (meetingScheduleReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS public.odg_meeting_board (
        id            SERIAL PRIMARY KEY,
        meeting_date  date NOT NULL,
        start_time    time,
        end_time      time,
        title         text NOT NULL,
        attendees     text,
        room          text,
        organizer     text,
        status        text NOT NULL DEFAULT 'confirmed',
        note          text,
        created_by    text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_by    text,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT odg_meeting_board_status_chk
          CHECK (status IN ('confirmed', 'postponed', 'cancelled'))
      );
    `);
    // Attendees are picked from the org chart: whole departments
    // (odg_department) and/or named people (odg_employee). The free-text
    // `attendees` column stays for guests who are in neither, e.g. suppliers.
    await query(`ALTER TABLE public.odg_meeting_board ADD COLUMN IF NOT EXISTS department_codes text[]`);
    await query(`ALTER TABLE public.odg_meeting_board ADD COLUMN IF NOT EXISTS employee_codes text[]`);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_odg_meeting_board_date
      ON public.odg_meeting_board (meeting_date, start_time)
    `);
    meetingScheduleReady = true;
  } catch (error) {
    console.error("ensureMeetingScheduleTable error:", error);
  }
}

let payoutReady = false;
let ruleBoundsReady = false;

/**
 * Records that a month's retail incentive has been paid, together with a frozen
 * copy of what each person was paid. Owned by this app — the sales app's
 * app_commission_round / _line tables are left untouched.
 */
let priceBandReady = false;

/**
 * The price brackets a point rule is looked up by, moved out of the scoring
 * query and into a table.
 *
 * They used to be a CASE inside the SQL, which meant a bracket could only be
 * changed by editing code and shipping it — while the inch and kilogram bands
 * beside them had been editable on screen for as long as anyone could remember.
 * Same kind of decision, two very different costs to make it.
 *
 * `max_price NULL` is the open top of the ladder, and it is what makes the
 * lookup total: every price lands in exactly one bracket, so no sale can fall
 * out of the scheme because a threshold was left short. Seeding runs only when
 * the table is empty, and seeds precisely what the CASE used to say — so the
 * change ships paying every seller exactly what they were already paid.
 */
export async function ensurePriceBands() {
  if (priceBandReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS public.app_incentive_price_band (
        category_code text    NOT NULL,
        size_token    text    NOT NULL,
        max_price     numeric,
        sort_order    int     NOT NULL DEFAULT 0,
        PRIMARY KEY (category_code, size_token)
      );
    `);
    await query(`
      INSERT INTO public.app_incentive_price_band (category_code, size_token, max_price, sort_order)
      SELECT * FROM (VALUES
        ('AV',  '<=10000',      10000::numeric, 1),
        ('AV',  '10001-20000',  20000::numeric, 2),
        ('AV',  '>20000',       NULL::numeric,  3),
        ('Air', '<=10000',      10000::numeric, 1),
        ('Air', '10001-20000',  20000::numeric, 2),
        ('Air', '>20000',       NULL::numeric,  3),
        ('SDA', '<=500',          500::numeric, 1),
        ('SDA', '<=1000',        1000::numeric, 2),
        ('SDA', '<=2000',        2000::numeric, 3),
        ('SDA', '<=5000',        5000::numeric, 4),
        ('SDA', '>5000',        NULL::numeric,  5)
      ) AS seed(category_code, size_token, max_price, sort_order)
      WHERE NOT EXISTS (SELECT 1 FROM public.app_incentive_price_band);
    `);
    // A size ladder is the same shape as a price ladder — a list of ceilings —
    // so it is kept in the same table. `kind` is what keeps them apart: the
    // scoring query reads the price rows to bracket a sale, and would otherwise
    // measure a speaker's price against a television's inches.
    //
    // The size rows exist for the configuration screen, which needs a category
    // to have columns even when every rule in it has just been deleted. Before
    // this they were only implied by the rules, so clearing a category left a
    // grid with nothing to type into.
    await query(`
      ALTER TABLE public.app_incentive_price_band
        ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'price';
    `);
    await query(`
      INSERT INTO public.app_incentive_price_band (category_code, size_token, max_price, sort_order, kind)
      SELECT * FROM (VALUES
        ('Washer', '<5',             5.9::numeric, 1, 'size'),
        ('Washer', '6-11',           11::numeric,  2, 'size'),
        ('Washer', '12-14',          14::numeric,  3, 'size'),
        ('Washer', '15-19',          19::numeric,  4, 'size'),
        ('Washer', '>20',          NULL::numeric,  5, 'size'),
        ('REF',    '<5',            4.9::numeric,  1, 'size'),
        ('REF',    '5.0-9.9',       9.9::numeric,  2, 'size'),
        ('REF',    '10.0-14.9',    14.9::numeric,  3, 'size'),
        ('REF',    '15.0-19.9',    19.9::numeric,  4, 'size'),
        ('REF',    '>=20',        NULL::numeric,   5, 'size'),
        ('AV',     '<=34',          34::numeric,   1, 'size'),
        ('AV',     '40-44',         44::numeric,   2, 'size'),
        ('AV',     '55-64',         64::numeric,   3, 'size'),
        ('AV',     '65-74',         74::numeric,   4, 'size'),
        ('AV',     '>=75',        NULL::numeric,   5, 'size')
      ) AS seed(category_code, size_token, max_price, sort_order, kind)
      ON CONFLICT (category_code, size_token) DO NOTHING;
    `);
    priceBandReady = true;
  } catch (error) {
    console.error("ensurePriceBands error:", error);
  }
}

/**
 * The numeric bounds a point rule is matched by, beside the band name it was
 * written as.
 *
 * A band name only ever meant something to a person: "12-14" is a Washer's
 * kilograms, "<=34" is a television's inches and "<=5000" is a price, and the
 * scoring query could only match a name it had already produced — so a size
 * the mapping table had never seen scored nothing, and two brands could never
 * split a band differently because the name belonged to the whole category.
 *
 * `max_value` is the top of the band, `NULL` its open top, and `band_kind`
 * says which measurement it bounds so a price ceiling and an inch ceiling can
 * never be compared to each other. A line then takes the SMALLEST ceiling that
 * still covers it WITHIN ITS OWN brand and design, which is what lets two rows
 * of the same category carry different ladders — and, because the ladder ends
 * open, leaves no measurement without a home.
 *
 * Additive: the columns are filled by scripts/migrate-rule-bounds.mjs and are
 * ignored until the scoring query is switched over to them.
 */
export async function ensureRuleBounds() {
  if (ruleBoundsReady) return;
  try {
    await query(`
      ALTER TABLE public.app_incentive_point_rule
        ADD COLUMN IF NOT EXISTS max_value numeric,
        ADD COLUMN IF NOT EXISTS band_kind text;
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_incentive_point_rule_bounds
        ON public.app_incentive_point_rule (category_code, brand_code, design_token, band_kind, max_value);
    `);
    ruleBoundsReady = true;
  } catch (error) {
    console.error("ensureRuleBounds error:", error);
  }
}

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
