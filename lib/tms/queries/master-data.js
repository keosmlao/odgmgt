const { pool, query, queryOne } = require("../lib/db");
const { ensureCarTypeSchema, capacityM3Sql, numOrNull } = require("./car-type.js");
const { ensureSettingsSchema } = require("./settings");

// ==================== Cars ====================

async function ensureTmsCarAssignmentTables() {
  await query(`ALTER TABLE public.odg_tms_car ADD COLUMN IF NOT EXISTS imei character varying`);
  await query(`ALTER TABLE public.odg_tms_car ADD COLUMN IF NOT EXISTS plate_no character varying`);
  await query(`ALTER TABLE public.odg_tms_car ADD COLUMN IF NOT EXISTS tank_no character varying`);
  await query(`ALTER TABLE public.odg_tms_car ADD COLUMN IF NOT EXISTS car_type character varying`);
  // ລົດສັງກັດສາຂາໃດ — ບໍ່ເຄີຍມີບ່ອນເກັບ ຈຶ່ງບອກບໍ່ໄດ້ວ່າຄັນນີ້ຢູ່ສາຂາໃດ
  await query(`ALTER TABLE public.odg_tms_car ADD COLUMN IF NOT EXISTS transport_code character varying`);
  // ຄວາມຈຸບັນທຸກ — ເກັບຢູ່ "ຄັນ" ເພາະລົດປະເພດດຽວກັນຕູ້ບໍ່ເທົ່າກັນ (ຕໍ່ຄອກ,
  // ຕັດຕູ້, ຕິດຫຼັງຄາ). ປະເພດລົດເປັນພຽງຄ່າຕັ້ງຕົ້ນຕອນເພີ່ມລົດໃໝ່ ບໍ່ແມ່ນ
  // ຕົວຕັດສິນ — ເບິ່ງ migrateCarTypeCapacityToCars().
  for (const col of [
    "cargo_length_cm numeric",
    "cargo_width_cm numeric",
    "cargo_height_cm numeric",
    "payload_kg numeric",
    "pallet_slots int",
    "stowage_pct numeric",
    // false = ຄ່າທີ່ລະບົບຄາດຄະເນໃຫ້, true = ຄົນວັດລົດຄັນນີ້ແລ້ວຢືນຢັນ
    "capacity_verified boolean DEFAULT false",
  ]) {
    await query(`ALTER TABLE public.odg_tms_car ADD COLUMN IF NOT EXISTS ${col}`);
  }
  await ensureCarTypeSchema();
  await migrateCarTypeCapacityToCars();
  await query(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_car_driver (
      roworder BIGSERIAL PRIMARY KEY,
      car_code character varying NOT NULL,
      driver_code character varying NOT NULL,
      driver_name character varying NOT NULL,
      user_create character varying,
      create_date_time_now timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      CONSTRAINT odg_tms_car_driver_unique UNIQUE (car_code, driver_code)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_car_worker (
      roworder BIGSERIAL PRIMARY KEY,
      car_code character varying NOT NULL,
      worker_code character varying NOT NULL,
      worker_name character varying NOT NULL,
      user_create character varying,
      create_date_time_now timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      CONSTRAINT odg_tms_car_worker_unique UNIQUE (car_code, worker_code)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_odg_tms_car_driver_car_code ON public.odg_tms_car_driver (car_code)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_odg_tms_car_worker_car_code ON public.odg_tms_car_worker (car_code)`);
}

// ensureTmsCarAssignmentTables() ຍິງ ALTER/CREATE ຫຼາຍສິບຄຳສັ່ງ + migration.
// ໜ້າ admin ເອີ້ນເປັນຄັ້ງຄາວຈຶ່ງບໍ່ເປັນຫຍັງ ແຕ່ getCars() ຖືກເອີ້ນທຸກຄັ້ງທີ່ໂຫຼດ
// ໜ້າສ້າງຖ້ຽວ — ຈຶ່ງແຄສໄວ້ໃຫ້ແລ່ນເທື່ອດຽວຕໍ່ process ຄືກັບ ensure ອື່ນໆ.
const carSchemaCache = globalThis;
async function ensureCarColumnsOnce() {
  if (carSchemaCache.__tmsCarColumnsReady) return;
  if (!carSchemaCache.__tmsCarColumnsPromise) {
    carSchemaCache.__tmsCarColumnsPromise = ensureTmsCarAssignmentTables()
      .then(() => {
        carSchemaCache.__tmsCarColumnsReady = true;
      })
      .catch((err) => {
        carSchemaCache.__tmsCarColumnsPromise = null;
        throw err;
      });
  }
  await carSchemaCache.__tmsCarColumnsPromise;
}

/**
 * ຍ້າຍຄວາມຈຸຈາກ "ປະເພດລົດ" ໄປໃສ່ "ແຕ່ລະຄັນ" ເທື່ອດຽວ.
 *
 * ເປັນຫຍັງ: ລົດ 6 ລໍ້ 23 ຄັນຕູ້ບໍ່ເທົ່າກັນ ແຕ່ຄ່າຢູ່ປະເພດເຮັດໃຫ້ທຸກຄັນໄດ້
 * 17.64 m³ ຄືກັນ ແລະ ເບິ່ງຄືເຊື່ອຖືໄດ້ ທັ້ງທີ່ບໍ່ມີໃຜວັດ. ຫຼັງຍ້າຍແລ້ວ
 * ແຕ່ລະຄັນມີເລກຂອງຕົນ ແລະ capacity_verified=false ບອກວ່າຍັງບໍ່ໄດ້ຢືນຢັນ.
 *
 * ແລ່ນເທື່ອດຽວ (ຈື່ດ້ວຍ setting key) ເພື່ອບໍ່ໃຫ້ທັບຄ່າທີ່ຄົນລຶບອອກເອງ.
 */
async function migrateCarTypeCapacityToCars() {
  const MIGRATION_KEY = "car_capacity_moved_to_car_v1";
  // ຕ້ອງແນ່ໃຈວ່າຕາຕະລາງ setting ມີກ່ອນ ບໍ່ດັ່ງນັ້ນ flag ບັນທຶກບໍ່ໄດ້ ແລ້ວ
  // migration ຈະແລ່ນຄືນທຸກຄັ້ງ ໄປທັບຄ່າທີ່ຄົນລຶບອອກເອງ
  await ensureSettingsSchema();
  const done = await queryOne(
    `SELECT value FROM public.odg_tms_setting WHERE key = $1`,
    [MIGRATION_KEY]
  );
  if (done?.value === "1") return;

  await query(
    `UPDATE public.odg_tms_car c
        SET cargo_length_cm = COALESCE(c.cargo_length_cm, ct.cargo_length_cm),
            cargo_width_cm  = COALESCE(c.cargo_width_cm,  ct.cargo_width_cm),
            cargo_height_cm = COALESCE(c.cargo_height_cm, ct.cargo_height_cm),
            payload_kg      = COALESCE(c.payload_kg,      ct.payload_kg),
            pallet_slots    = COALESCE(c.pallet_slots,    ct.pallet_slots),
            stowage_pct     = COALESCE(c.stowage_pct,     ct.stowage_pct),
            capacity_verified = COALESCE(c.capacity_verified, false)
       FROM public.odg_tms_car_type ct
      WHERE ct.name = NULLIF(TRIM(c.car_type), '')
        AND c.cargo_length_cm IS NULL
        AND ct.cargo_length_cm IS NOT NULL`
  );
  await query(
    `INSERT INTO public.odg_tms_setting (key, value) VALUES ($1, '1')
     ON CONFLICT (key) DO UPDATE SET value = '1'`,
    [MIGRATION_KEY]
  );
}

// Per-car capacity values, in the column order both the INSERT and the
// UPDATE use. Empty stays NULL = "ຍັງບໍ່ໄດ້ກຳນົດ" (ບໍ່ແມ່ນ 0).
function readCapacityInput(data) {
  return [
    numOrNull(data?.cargo_length_cm),
    numOrNull(data?.cargo_width_cm),
    numOrNull(data?.cargo_height_cm),
    numOrNull(data?.payload_kg),
    numOrNull(data?.pallet_slots),
    numOrNull(data?.stowage_pct),
  ];
}

// ຄວາມຈຸຂອງລົດຄັນໜຶ່ງ — ອ່ານຈາກ "ຄັນ" ດຽວ ບໍ່ຕົກໄປປະເພດອີກ.
//
// ຕັ້ງໃຈບໍ່ໃຫ້ຕົກໄປປະເພດ: ຖ້າຕົກ ລົດທີ່ຍັງບໍ່ໄດ້ວັດຈະສະແດງເລກຂອງປະເພດ
// ເຊິ່ງເບິ່ງຄືເຊື່ອຖືໄດ້ ແລະ ຄົນຈະບັນທຸກຕາມ. ວ່າງ = ບອກວ່າຍັງບໍ່ໄດ້ວັດ.
async function getCarCapacity(carCode) {
  await ensureTmsCarAssignmentTables();
  return queryOne(
    `SELECT c.code,
            c.cargo_length_cm AS length_cm,
            c.cargo_width_cm  AS width_cm,
            c.cargo_height_cm AS height_cm,
            c.payload_kg,
            c.pallet_slots,
            COALESCE(c.stowage_pct, 80) AS stowage_pct,
            ${capacityM3Sql("c.cargo_length_cm", "c.cargo_width_cm", "c.cargo_height_cm")}
              AS capacity_m3,
            ROUND(${capacityM3Sql(
              "c.cargo_length_cm",
              "c.cargo_width_cm",
              "c.cargo_height_cm"
            )} * COALESCE(c.stowage_pct, 80) / 100, 3) AS usable_m3,
            CASE
              WHEN c.cargo_length_cm IS NULL THEN 'none'
              WHEN c.capacity_verified THEN 'measured'
              ELSE 'estimated'
            END AS capacity_source
       FROM public.odg_tms_car c
      WHERE c.code = $1`,
    [carCode]
  );
}

async function getTransportEmployeesByCodes(codes) {
  if (codes.length === 0) return [];
  return query(
    `SELECT e.employee_code AS code,
      COALESCE(NULLIF(TRIM(e.fullname_lo), ''), NULLIF(TRIM(e.nickname), ''), e.employee_code) AS name_1
    FROM public.odg_employee e
    LEFT JOIN public.odg_department d ON d.department_code = e.department_code
    WHERE e.employee_code = ANY($1::varchar[])
      AND e.employment_status = 'ACTIVE'
      AND d.department_name_lo ILIKE '%ຂົນສົ່ງ%'
    ORDER BY name_1 ASC, e.employee_code ASC`,
    [codes]
  );
}

// Runs on the supplied transaction client so the DELETE + re-INSERTs are atomic
// (the caller wraps them in BEGIN/COMMIT). Without this, a failed INSERT
// mid-loop left the car with its old assignments deleted and the new ones only
// partially written. getTransportEmployeesByCodes is a read (shared pool is ok).
async function replaceCarDriverAssignments(client, carCode, driverCodes, userCreate) {
  await client.query("DELETE FROM public.odg_tms_car_driver WHERE car_code=$1", [carCode]);
  const drivers = await getTransportEmployeesByCodes(Array.from(new Set(driverCodes.filter(Boolean))));
  for (const driver of drivers) {
    await client.query(
      `INSERT INTO public.odg_tms_car_driver(car_code, driver_code, driver_name, user_create, create_date_time_now)
       VALUES ($1, $2, $3, $4, LOCALTIMESTAMP(0))`,
      [carCode, driver.code, driver.name_1, userCreate]
    );
  }
}

async function replaceCarWorkerAssignments(client, carCode, workerCodes, excludedDriverCodes, userCreate) {
  await client.query("DELETE FROM public.odg_tms_car_worker WHERE car_code=$1", [carCode]);
  const normalizedWorkers = Array.from(
    new Set(
      workerCodes
        .filter(Boolean)
        .filter((workerCode) => !excludedDriverCodes.includes(workerCode))
    )
  );
  const workers = await getTransportEmployeesByCodes(normalizedWorkers);
  for (const worker of workers) {
    await client.query(
      `INSERT INTO public.odg_tms_car_worker(car_code, worker_code, worker_name, user_create, create_date_time_now)
       VALUES ($1, $2, $3, $4, LOCALTIMESTAMP(0))`,
      [carCode, worker.code, worker.name_1, userCreate]
    );
  }
}

/**
 * ລາຍການລົດ + ຂໍ້ມູນທີ່ໃຊ້ກັ່ນຕອງໃນຈໍເລືອກລົດ.
 *
 * `is_delivery` = ລົດຄັນນີ້ຕັ້ງ car_type ກົງກັບປະເພດລົດໃນ odg_tms_car_type ບໍ.
 * ອຸປະກອນທີ່ບໍ່ແມ່ນລົດຂົນສົ່ງ (ເຊັ່ນ Forklift) ບໍ່ມີປະເພດໃນລາຍການນັ້ນ ຈຶ່ງເປັນ
 * false ແລ້ວຈໍສ້າງຖ້ຽວກັ່ນອອກ. `transport_code` = ສາຂາທີ່ລົດຢູ່ ('' = ຍັງບໍ່
 * ໄດ້ກຳນົດ). ຜູ້ເອີ້ນເກົ່າທີ່ໃຊ້ພຽງ code/name_1 ຍັງໃຊ້ໄດ້ຄືເກົ່າ.
 */
async function getCars() {
  await ensureCarColumnsOnce();
  return query(
    `SELECT c.code,
            c.name_1,
            COALESCE(NULLIF(TRIM(c.car_type), ''), '')       AS car_type,
            COALESCE(NULLIF(TRIM(c.transport_code), ''), '') AS transport_code,
            (ct.name IS NOT NULL)                            AS is_delivery
       FROM public.odg_tms_car c
       LEFT JOIN public.odg_tms_car_type ct
         ON ct.name = NULLIF(TRIM(c.car_type), '')
      ORDER BY c.name_1`
  );
}
async function addCar(code, name_1) { await queryOne("INSERT INTO public.odg_tms_car(code, name_1) VALUES ($1, $2)", [code, name_1]); }
async function updateCar(code, name_1) { await queryOne("UPDATE odg_tms_car SET name_1=$1 WHERE code=$2", [name_1, code]); }
async function deleteCar(code) { await queryOne("DELETE FROM odg_tms_car WHERE code=$1", [code]); }

async function getCarDefaults(carCode) {
  await ensureTmsCarAssignmentTables();
  const drivers = await query(
    `SELECT driver_code AS code, driver_name AS name_1 FROM public.odg_tms_car_driver WHERE car_code=$1 ORDER BY driver_name ASC`,
    [carCode]
  );
  const workers = await query(
    `SELECT worker_code AS code, worker_name AS name_1 FROM public.odg_tms_car_worker WHERE car_code=$1 ORDER BY worker_name ASC`,
    [carCode]
  );
  return { drivers, workers };
}

async function getCarProfiles() {
  await ensureTmsCarAssignmentTables();
  const [cars, carDrivers, carWorkers] = await Promise.all([
    query(`SELECT c.code, c.name_1, COALESCE(c.imei,'') AS imei,
             COALESCE(c.plate_no,'') AS plate_no, COALESCE(c.tank_no,'') AS tank_no,
             COALESCE(c.car_type,'') AS car_type,
             COALESCE(c.transport_code,'') AS transport_code,
             COALESCE(NULLIF(TRIM(tt.name_1), ''), '') AS transport_name,
             -- ຄວາມຈຸເປັນຂອງ "ຄັນ" ດຽວ ບໍ່ຕົກໄປປະເພດ
             c.cargo_length_cm, c.cargo_width_cm, c.cargo_height_cm,
             c.payload_kg, c.pallet_slots, c.stowage_pct,
             COALESCE(c.capacity_verified, false) AS capacity_verified,
             ${capacityM3Sql("c.cargo_length_cm", "c.cargo_width_cm", "c.cargo_height_cm")}
               AS capacity_m3,
             ROUND(${capacityM3Sql(
               "c.cargo_length_cm",
               "c.cargo_width_cm",
               "c.cargo_height_cm"
             )} * COALESCE(c.stowage_pct, 80) / 100, 3) AS usable_m3,
             -- ບອກວ່າວັດແລ້ວ ຫຼື ຍັງເປັນຄ່າຄາດຄະເນ
             CASE
               WHEN c.cargo_length_cm IS NULL THEN 'none'
               WHEN c.capacity_verified THEN 'measured'
               ELSE 'estimated'
             END AS capacity_source,
             -- tracker ບາງເຄື່ອງຕັ້ງຊື່ໄວ້ຄົນລະຢ່າງກັບລະຫັດລົດໃນລະບົບ ເຊິ່ງ
             -- ເຮັດໃຫ້ຕຳແໜ່ງໄປໃສ່ຄັນອື່ນເມື່ອບ່ອນໃດ join ດ້ວຍລະຫັດ. ດຶງມາ
             -- ໃຫ້ເຫັນເພື່ອໃຫ້ຄົນແກ້ໄດ້.
             COALESCE(NULLIF(TRIM(g.car_code), ''), '') AS tracker_code,
             COALESCE(g.recorded_at, '') AS gps_recorded_at
           FROM public.odg_tms_car c
           LEFT JOIN transport_type tt ON tt.code = c.transport_code
           LEFT JOIN public.odg_tms_gps_current g
             ON NULLIF(TRIM(c.imei), '') IS NOT NULL AND g.imei = TRIM(c.imei)
           ORDER BY c.name_1 ASC, c.code ASC`),
    query(`SELECT car_code, driver_code AS code, driver_name AS name_1 FROM public.odg_tms_car_driver ORDER BY car_code ASC, driver_name ASC, driver_code ASC`),
    query(`SELECT car_code, worker_code AS code, worker_name AS name_1 FROM public.odg_tms_car_worker ORDER BY car_code ASC, worker_name ASC, worker_code ASC`),
  ]);

  const driversByCar = new Map();
  const workersByCar = new Map();

  for (const driver of carDrivers) {
    const current = driversByCar.get(driver.car_code) ?? [];
    current.push({ code: driver.code, name_1: driver.name_1 });
    driversByCar.set(driver.car_code, current);
  }
  for (const worker of carWorkers) {
    const current = workersByCar.get(worker.car_code) ?? [];
    current.push({ code: worker.code, name_1: worker.name_1 });
    workersByCar.set(worker.car_code, current);
  }

  return cars.map((car) => ({
    ...car,
    drivers: driversByCar.get(car.code) ?? [],
    workers: workersByCar.get(car.code) ?? [],
  }));
}

async function addCarProfile(session, data) {
  await ensureTmsCarAssignmentTables();
  const existingCar = await queryOne("SELECT code FROM public.odg_tms_car WHERE code=$1", [data.code]);
  if (existingCar) throw new Error("Car code already exists");

  const userCreate = session?.usercode ?? null;
  const driverCodes = Array.from(new Set(data.driverCodes.filter(Boolean)));
  const imei = data.imei?.trim() ?? "";
  const plateNo = data.plate_no?.trim() ?? "";
  const tankNo = data.tank_no?.trim() ?? "";
  const carType = data.car_type?.trim() ?? "";
  const transportCode = data.transport_code?.trim() ?? "";
  const cap = readCapacityInput(data);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.odg_tms_car(code, name_1, imei, plate_no, tank_no, car_type, transport_code,
         cargo_length_cm, cargo_width_cm, cargo_height_cm, payload_kg, pallet_slots, stowage_pct,
         capacity_verified, create_date_time_now)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, LOCALTIMESTAMP(0))`,
      [data.code, data.name_1, imei, plateNo, tankNo, carType, transportCode, ...cap, cap[0] !== null]
    );
    await replaceCarDriverAssignments(client, data.code, driverCodes, userCreate);
    await replaceCarWorkerAssignments(client, data.code, data.workerCodes, driverCodes, userCreate);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function updateCarProfile(session, data) {
  await ensureTmsCarAssignmentTables();
  const userCreate = session?.usercode ?? null;
  const driverCodes = Array.from(new Set(data.driverCodes.filter(Boolean)));
  const imei = data.imei?.trim() ?? "";
  const plateNo = data.plate_no?.trim() ?? "";
  const tankNo = data.tank_no?.trim() ?? "";
  const carType = data.car_type?.trim() ?? "";
  const transportCode = data.transport_code?.trim() ?? "";
  const cap = readCapacityInput(data);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE public.odg_tms_car
          SET name_1=$1, imei=$2, plate_no=$3, tank_no=$4, car_type=$5, transport_code=$6,
              cargo_length_cm=$7, cargo_width_cm=$8, cargo_height_cm=$9,
              payload_kg=$10, pallet_slots=$11, stowage_pct=$12,
              -- ຄົນກົດບັນທຶກພ້ອມຂະໜາດ = ຢືນຢັນວ່າວັດລົດຄັນນີ້ແລ້ວ
              capacity_verified=$13
        WHERE code=$14`,
      [data.name_1, imei, plateNo, tankNo, carType, transportCode, ...cap, cap[0] !== null, data.code]
    );
    await replaceCarDriverAssignments(client, data.code, driverCodes, userCreate);
    await replaceCarWorkerAssignments(client, data.code, data.workerCodes, driverCodes, userCreate);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function deleteCarProfile(code) {
  await ensureTmsCarAssignmentTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM public.odg_tms_car_driver WHERE car_code=$1", [code]);
    await client.query("DELETE FROM public.odg_tms_car_worker WHERE car_code=$1", [code]);
    await client.query("DELETE FROM public.odg_tms_car WHERE code=$1", [code]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ==================== Drivers & Workers ====================

async function getDispatchDriverByCode(code) {
  return queryOne(
    `SELECT e.employee_code AS code,
      COALESCE(NULLIF(TRIM(e.fullname_lo), ''), NULLIF(TRIM(e.nickname), ''), e.employee_code) AS name_1
    FROM public.odg_employee e
    LEFT JOIN public.odg_department d ON d.department_code = e.department_code
    WHERE e.employee_code = $1
      AND e.employment_status = 'ACTIVE'
      AND d.department_name_lo ILIKE '%ຂົນສົ່ງ%'`,
    [code]
  );
}

async function getTransportDepartmentEmployees(session, role = null) {
  await ensureWorkerBranchTable();
  const branch = session?.logistic_code?.trim() ?? "";
  const scoped = !!branch && branch !== "02-0004";
  // ຄົນຂັບຕ້ອງເຫັນສະເພາະຄົນຂັບ, ກຳມະກອນສະເພາະກຳມະກອນ.
  //
  // ບັນຫາ: ພະນັກງານບາງຄົນຍັງບໍ່ໄດ້ກຳນົດ position_code ແຕ່ຂັບຖ້ຽວຈິງມາເປັນຮ້ອຍ
  // ຄັ້ງ — ຖ້າຮັດແບບກົງໆ dispatcher ຈະເລືອກເຂົາບໍ່ໄດ້ ແລະ ຈັດຖ້ຽວບໍ່ໄດ້.
  // ຈຶ່ງອະນຸມານຈາກປະຫວັດແທນ: ເຄີຍຂັບ = ຄົນຂັບ, ຢູ່ທີມລົດ = ກຳມະກອນ.
  // ຄົນທີ່ບໍ່ມີທັງຕຳແໜ່ງ ແລະ ບໍ່ມີປະຫວັດ ຈະບໍ່ຂຶ້ນທັງສອງບ່ອນ — ຕ້ອງໃຫ້ admin
  // ໄປກຳນົດຕຳແໜ່ງທີ່ໜ້າ "ພະນັກງານຂົນສົ່ງ" ກ່ອນ.
  const roleFilter =
    role === "driver"
      ? `AND (
           wb.position_code IN ('driver', 'both')
           OR (COALESCE(NULLIF(TRIM(wb.position_code), ''), '') = ''
               AND EXISTS (SELECT 1 FROM public.odg_tms j WHERE j.driver = e.employee_code))
         )`
      : role === "worker"
        ? `AND (
             wb.position_code IN ('worker', 'both')
             OR (COALESCE(NULLIF(TRIM(wb.position_code), ''), '') = ''
                 AND EXISTS (SELECT 1 FROM public.odg_tms_car_worker cw
                              WHERE cw.worker_code = e.employee_code))
           )`
        : "";

  if (!scoped) {
    return query(
      `SELECT e.employee_code AS code,
        COALESCE(NULLIF(TRIM(e.fullname_lo), ''), NULLIF(TRIM(e.nickname), ''), e.employee_code) AS name_1
      FROM public.odg_employee e
      LEFT JOIN public.odg_department d ON d.department_code = e.department_code
      LEFT JOIN public.odg_tms_worker_branch wb ON wb.worker_code = e.employee_code
      WHERE e.employment_status = 'ACTIVE'
        AND d.department_name_lo ILIKE '%ຂົນສົ່ງ%'
        ${roleFilter}
      ORDER BY name_1 ASC, e.employee_code ASC`
    );
  }

  // Branch admin: only show employees assigned to this branch
  return query(
    `SELECT e.employee_code AS code,
      COALESCE(NULLIF(TRIM(e.fullname_lo), ''), NULLIF(TRIM(e.nickname), ''), e.employee_code) AS name_1
    FROM public.odg_employee e
    LEFT JOIN public.odg_department d ON d.department_code = e.department_code
    INNER JOIN public.odg_tms_worker_branch wb ON wb.worker_code = e.employee_code
    WHERE e.employment_status = 'ACTIVE'
      AND d.department_name_lo ILIKE '%ຂົນສົ່ງ%'
      AND wb.transport_code = $1
      ${roleFilter}
    ORDER BY name_1 ASC, e.employee_code ASC`,
    [branch]
  );
}

async function getDispatchDrivers(session) { return getTransportDepartmentEmployees(session, "driver"); }
async function getDispatchWorkers(session) { return getTransportDepartmentEmployees(session, "worker"); }

async function ensureWorkerBranchTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_worker_branch (
      worker_code character varying PRIMARY KEY,
      transport_code character varying NOT NULL,
      position_code character varying,
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      updated_by character varying
    )
  `);
  await query(`ALTER TABLE public.odg_tms_worker_branch ADD COLUMN IF NOT EXISTS position_code character varying`);
  await query(`ALTER TABLE public.odg_tms_worker_branch ALTER COLUMN transport_code DROP NOT NULL`);
  // Multi-branch dispatch visibility: a transport admin can be assigned MORE than
  // one branch here (one row per branch). This is separate from the single
  // "home" branch in odg_tms_worker_branch (which mobile/todo/notify still read),
  // and only widens the WEB dispatch screens via getBranchScope at login.
  await query(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_worker_dispatch_branch (
      worker_code character varying NOT NULL,
      transport_code character varying NOT NULL,
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      updated_by character varying,
      CONSTRAINT odg_tms_worker_dispatch_branch_pk PRIMARY KEY (worker_code, transport_code)
    )
  `);
}

async function getTransportBranches() {
  return query(`SELECT code, name_1 FROM public.transport_type WHERE code LIKE '02-%' AND code <> '02-0004' ORDER BY code ASC`);
}

async function getDispatchWorkersWithBranch() {
  await ensureWorkerBranchTable();
  return query(
    `SELECT e.employee_code AS code,
      COALESCE(NULLIF(TRIM(e.fullname_lo), ''), NULLIF(TRIM(e.nickname), ''), e.employee_code) AS name_1,
      wb.transport_code AS branch_code,
      tt.name_1 AS branch_name,
      wb.position_code AS position_code,
      CASE wb.position_code
        WHEN 'driver' THEN 'ຄົນຂັບ'
        WHEN 'worker' THEN 'ກຳມະກອນ'
        WHEN 'team_lead' THEN 'ຫົວໜ້າໜ່ວຍງານ'
        WHEN 'manager' THEN 'ຜູ້ຈັດການສາງແລະຂົນສົ່ງ'
        WHEN 'admin' THEN 'ແອັດມິນ (ຈັດຖ້ຽວ/ປິດຖ້ຽວ/ລາຍງານ)'
        ELSE NULL
      END AS position_name,
      COALESCE(db.codes, ARRAY[]::text[]) AS dispatch_branch_codes
    FROM public.odg_employee e
    LEFT JOIN public.odg_department d ON d.department_code = e.department_code
    LEFT JOIN public.odg_tms_worker_branch wb ON wb.worker_code = e.employee_code
    LEFT JOIN public.transport_type tt ON tt.code = wb.transport_code
    LEFT JOIN LATERAL (
      SELECT array_agg(x.transport_code ORDER BY x.transport_code) AS codes
      FROM public.odg_tms_worker_dispatch_branch x
      WHERE x.worker_code = e.employee_code
    ) db ON true
    WHERE e.employment_status = 'ACTIVE'
      AND (d.department_name_lo ILIKE '%ຂົນສົ່ງ%' OR d.department_name_lo ILIKE '%ສາງ%')
    ORDER BY name_1 ASC, e.employee_code ASC`
  );
}

// Lean, hot-path resolver used by the session helpers on EVERY request to keep
// the multi-branch dispatch scope live (no re-login after an admin re-assigns).
// Returns the comma-joined set, "" when none / not yet set. Deliberately skips
// the ensure-table DDL and swallows a missing-table error so it never adds load
// or fails a request.
async function resolveDispatchBranchCodes(workerCode) {
  const code = String(workerCode ?? "").trim();
  if (!code) return "";
  try {
    const rows = await query(
      "SELECT transport_code FROM public.odg_tms_worker_dispatch_branch WHERE worker_code = $1 ORDER BY transport_code",
      [code]
    );
    return rows.map((r) => String(r.transport_code ?? "").trim()).filter(Boolean).join(",");
  } catch {
    return "";
  }
}

// The set of branches a transport worker may see on the WEB dispatch screens.
async function getWorkerDispatchBranches(workerCode) {
  await ensureWorkerBranchTable();
  const code = String(workerCode ?? "").trim();
  if (!code) return [];
  const rows = await query(
    `SELECT transport_code FROM public.odg_tms_worker_dispatch_branch
     WHERE worker_code = $1 ORDER BY transport_code`,
    [code]
  );
  return rows.map((r) => r.transport_code);
}

// Replace a worker's dispatch-branch set with the given list (admin-only). Only
// real internal delivery branches (02-xxxx, not 02-0004 self-pickup) are stored.
async function setWorkerDispatchBranches(session, workerCode, transportCodes) {
  await ensureWorkerBranchTable();
  const code = String(workerCode ?? "").trim();
  if (!code) throw new Error("ຕ້ອງລະບຸ worker");
  const valid = await query(
    `SELECT code FROM public.transport_type WHERE code LIKE '02-%' AND code <> '02-0004'`
  );
  const allowed = new Set(valid.map((r) => r.code));
  const codes = Array.from(
    new Set((Array.isArray(transportCodes) ? transportCodes : []).map((c) => String(c ?? "").trim()))
  ).filter((c) => allowed.has(c));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM public.odg_tms_worker_dispatch_branch WHERE worker_code = $1", [code]);
    for (const tc of codes) {
      await client.query(
        `INSERT INTO public.odg_tms_worker_dispatch_branch(worker_code, transport_code, updated_at, updated_by)
         VALUES ($1, $2, LOCALTIMESTAMP(0), $3)
         ON CONFLICT (worker_code, transport_code) DO UPDATE
           SET updated_at = LOCALTIMESTAMP(0), updated_by = EXCLUDED.updated_by`,
        [code, tc, session?.usercode ?? null]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { success: true, worker_code: code, dispatch_branch_codes: codes };
}

async function setWorkerProfile(session, workerCode, transportCode, positionCode) {
  await ensureWorkerBranchTable();
  const normalizedPosition = ["driver", "worker", "both", "team_lead", "manager", "admin"].includes(positionCode) ? positionCode : null;
  if (!transportCode && !normalizedPosition) {
    await queryOne("DELETE FROM public.odg_tms_worker_branch WHERE worker_code=$1", [workerCode]);
    return;
  }
  await queryOne(
    `INSERT INTO public.odg_tms_worker_branch(worker_code, transport_code, position_code, updated_at, updated_by)
     VALUES ($1, $2, $3, LOCALTIMESTAMP(0), $4)
     ON CONFLICT (worker_code) DO UPDATE
     SET transport_code = EXCLUDED.transport_code,
         position_code = EXCLUDED.position_code,
         updated_at = LOCALTIMESTAMP(0),
         updated_by = EXCLUDED.updated_by`,
    [workerCode, transportCode || null, normalizedPosition, session?.usercode ?? null]
  );
}

async function setWorkerBranch(session, workerCode, transportCode) {
  await ensureWorkerBranchTable();
  const current = await queryOne(
    "SELECT position_code FROM public.odg_tms_worker_branch WHERE worker_code=$1",
    [workerCode]
  );
  return setWorkerProfile(session, workerCode, transportCode, current?.position_code ?? null);
}

async function getDrivers() { return query("SELECT code, name_1 FROM public.odg_tms_driver"); }
async function addDriver(code, name_1) { await queryOne("INSERT INTO public.odg_tms_driver(code, name_1) VALUES ($1, $2)", [code, name_1]); }
async function updateDriver(code, name_1) { await queryOne("UPDATE odg_tms_driver SET name_1=$1 WHERE code=$2", [name_1, code]); }
async function deleteDriver(code) { await queryOne("DELETE FROM odg_tms_driver WHERE code=$1", [code]); }

async function getWarehouseWorkers() { return query("SELECT code, name_1 FROM public.odg_tms_warehouse_worker ORDER BY name_1 ASC, code ASC"); }
async function addWarehouseWorker(code, name_1) { await queryOne("INSERT INTO public.odg_tms_warehouse_worker(code, name_1) VALUES ($1, $2)", [code, name_1]); }
async function updateWarehouseWorker(code, name_1) { await queryOne("UPDATE public.odg_tms_warehouse_worker SET name_1=$1 WHERE code=$2", [name_1, code]); }
async function deleteWarehouseWorker(code) { await queryOne("DELETE FROM public.odg_tms_warehouse_worker WHERE code=$1", [code]); }

module.exports = {
  getCars,
  addCar,
  updateCar,
  deleteCar,
  getCarDefaults,
  getCarProfiles,
  getCarCapacity,
  addCarProfile,
  updateCarProfile,
  deleteCarProfile,
  getDispatchDriverByCode,
  getTransportDepartmentEmployees,
  getDispatchDrivers,
  getDispatchWorkers,
  getDispatchWorkersWithBranch,
  setWorkerBranch,
  setWorkerProfile,
  getWorkerDispatchBranches,
  setWorkerDispatchBranches,
  resolveDispatchBranchCodes,
  getTransportBranches,
  getDrivers,
  addDriver,
  updateDriver,
  deleteDriver,
  getWarehouseWorkers,
  addWarehouseWorker,
  updateWarehouseWorker,
  deleteWarehouseWorker,
};
