/**
 * Clinical calculations and reference ranges.
 *
 * These live on the server so the API, the printable documents and the SPA all
 * agree on what "high" means. The SPA renders the colour it is told rather than
 * re-implementing thresholds.
 *
 * Ranges are adult defaults for roleplay use. They are deliberately simple and
 * are not a substitute for clinical judgement.
 */

/**
 * Reference ranges, expressed as the green band and the outer (red) bounds.
 * Anything between the two bands is yellow.
 *
 * `{ green: [low, high], red: [low, high] }` - a null bound means unbounded.
 */
export const VITAL_RANGES = {
  temperature_c: { green: [36.1, 37.5], red: [35.0, 38.5], unit: '°C', label: 'Temperature' },
  bp_systolic: { green: [90, 129], red: [80, 159], unit: 'mmHg', label: 'Systolic BP' },
  bp_diastolic: { green: [60, 84], red: [50, 99], unit: 'mmHg', label: 'Diastolic BP' },
  heart_rate: { green: [60, 100], red: [50, 120], unit: 'bpm', label: 'Heart rate' },
  respiratory_rate: { green: [12, 20], red: [9, 24], unit: '/min', label: 'Respiratory rate' },
  oxygen_saturation: { green: [95, 100], red: [90, 100], unit: '%', label: 'SpO₂' },
  blood_sugar_mgdl: { green: [70, 140], red: [50, 200], unit: 'mg/dL', label: 'Blood sugar' },
  bmi: { green: [18.5, 24.9], red: [17, 29.9], unit: 'kg/m²', label: 'BMI' },
};

/**
 * Body mass index. Returns null when either input is missing or implausible,
 * so a partially filled vitals form does not produce a nonsense number.
 *
 * @param {number|string|null} weightKg
 * @param {number|string|null} heightCm
 * @returns {number|null} BMI rounded to one decimal place
 */
export function calculateBmi(weightKg, heightCm) {
  const weight = Number(weightKg);
  const height = Number(heightCm);

  if (!Number.isFinite(weight) || !Number.isFinite(height)) return null;
  if (weight <= 0 || height <= 0) return null;

  const metres = height / 100;
  const bmi = weight / (metres * metres);

  // Guard against transposed units (e.g. height entered in metres).
  if (bmi < 5 || bmi > 200) return null;

  return Math.round(bmi * 10) / 10;
}

/** Plain-language BMI band. */
export function bmiCategory(bmi) {
  if (bmi === null || bmi === undefined) return null;
  if (bmi < 16) return 'Severely underweight';
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Healthy weight';
  if (bmi < 30) return 'Overweight';
  if (bmi < 35) return 'Obese (class I)';
  if (bmi < 40) return 'Obese (class II)';
  return 'Obese (class III)';
}

/**
 * Classify one measurement as 'green' | 'yellow' | 'red'.
 * @param {string} field key in VITAL_RANGES
 * @param {number|null} value
 * @returns {'green'|'yellow'|'red'|null} null when not measured or unknown field
 */
export function classifyVital(field, value) {
  const range = VITAL_RANGES[field];
  if (!range) return null;

  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return null;

  const [greenLow, greenHigh] = range.green;
  const [redLow, redHigh] = range.red;

  if (n >= greenLow && n <= greenHigh) return 'green';
  if (n < redLow || n > redHigh) return 'red';
  return 'yellow';
}

/**
 * Classify a whole vitals row.
 * @param {Record<string, unknown>} vitals
 * @returns {Record<string, 'green'|'yellow'|'red'>} only the measured fields
 */
export function classifyVitals(vitals = {}) {
  const flags = {};
  for (const field of Object.keys(VITAL_RANGES)) {
    const level = classifyVital(field, vitals[field]);
    if (level) flags[field] = level;
  }
  return flags;
}

/** The worst flag present, for a single at-a-glance indicator on a row. */
export function overallVitalStatus(vitals) {
  const flags = Object.values(classifyVitals(vitals));
  if (flags.includes('red')) return 'red';
  if (flags.includes('yellow')) return 'yellow';
  if (flags.length > 0) return 'green';
  return null;
}

/** Whole years between a date of birth and today. */
export function ageFromDob(dateOfBirth) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;

  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;

  return age >= 0 && age < 200 ? age : null;
}

/** Numeric weight for a priority, so queues sort emergencies first. */
export const PRIORITY_WEIGHT = { emergency: 0, urgent: 1, normal: 2 };

/**
 * Rough wait-time estimate for a queue position.
 *
 * Deliberately simple: position in the priority-sorted queue times the average
 * consultation length, divided by the number of clinicians free to take them.
 *
 * @param {number} position 0-based position in the queue
 * @param {number} activeDoctors clinicians currently on duty
 * @param {number} avgMinutes average consultation length
 */
export function estimateWait(position, activeDoctors, avgMinutes = 15) {
  const doctors = Math.max(1, activeDoctors);
  return Math.max(0, Math.round((position / doctors) * avgMinutes));
}
