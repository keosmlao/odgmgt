// Joins GPS distance to logged refills so a car (and the fleet) gets a km/L.
//
// The join is fuzzy on purpose: `odg_tms_fuel_log.car` holds the car code when
// the refill came from the web dialog, but the mobile app posts whatever the
// job carried — sometimes the plate (`name_1`). `getFuelByCar` already resolves
// what it can to a code; anything it couldn't resolve stays as the raw string,
// so we index by both code and name and add them when they're separate rows.

export interface FuelByCar {
  car_code: string;
  liters: number;
  amount: number;
  refills: number;
  /** Refills whose litres figure is really a kip amount — see lib/fuel-sanity.js. */
  ignored_refills?: number;
}

export interface CarDistance {
  car_code?: string | null;
  car_name?: string | null;
  distance_km?: number | null;
}

export interface CarFuelStats {
  liters: number;
  fuel_amount: number;
  refills: number;
  /** null when the car has no refills logged — not 0, which would read as "uses no fuel". */
  km_per_liter: number | null;
  cost_per_km: number | null;
}

export interface FleetFuelStats {
  cars: number;
  liters: number;
  amount: number;
  distance: number;
  kmPerLiter: number | null;
  costPerKm: number | null;
}

function key(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

export function indexFuelByCar(fuel: FuelByCar[]): Map<string, FuelByCar> {
  const map = new Map<string, FuelByCar>();
  for (const f of fuel) {
    const k = key(f?.car_code);
    if (!k) continue;
    const prev = map.get(k);
    if (prev) {
      prev.liters += Number(f.liters || 0);
      prev.amount += Number(f.amount || 0);
      prev.refills += Number(f.refills || 0);
    } else {
      map.set(k, {
        car_code: k,
        liters: Number(f.liters || 0),
        amount: Number(f.amount || 0),
        refills: Number(f.refills || 0),
      });
    }
  }
  return map;
}

export function fuelStatsForCar(
  car: CarDistance,
  index: Map<string, FuelByCar>
): CarFuelStats {
  const codeKey = key(car.car_code);
  const nameKey = key(car.car_name);
  const byCode = codeKey ? index.get(codeKey) : undefined;
  const byName = nameKey && nameKey !== codeKey ? index.get(nameKey) : undefined;
  const matches = [byCode, byName].filter(
    (m, i, arr): m is FuelByCar => Boolean(m) && arr.indexOf(m) === i
  );

  const liters = matches.reduce((sum, m) => sum + m.liters, 0);
  const amount = matches.reduce((sum, m) => sum + m.amount, 0);
  const refills = matches.reduce((sum, m) => sum + m.refills, 0);
  const distance = Number(car.distance_km || 0);

  return {
    liters,
    fuel_amount: amount,
    refills,
    km_per_liter: liters > 0 ? distance / liters : null,
    cost_per_km: amount > 0 && distance > 0 ? amount / distance : null,
  };
}

/**
 * Fleet km/L divides only by the distance of cars that actually have refills
 * logged in the period — folding in the distance of cars with zero liters
 * would inflate the ratio.
 */
export function fleetFuelStats(
  rows: Array<CarDistance & CarFuelStats>
): FleetFuelStats {
  const withFuel = rows.filter((r) => r.liters > 0);
  const liters = withFuel.reduce((sum, r) => sum + r.liters, 0);
  const amount = withFuel.reduce((sum, r) => sum + r.fuel_amount, 0);
  const distance = withFuel.reduce((sum, r) => sum + Number(r.distance_km || 0), 0);
  return {
    cars: withFuel.length,
    liters,
    amount,
    distance,
    kmPerLiter: liters > 0 ? distance / liters : null,
    costPerKm: amount > 0 && distance > 0 ? amount / distance : null,
  };
}
