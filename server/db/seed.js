/**
 * Database seed.
 *
 *   npm run db:seed
 *
 * Idempotent: every insert is an upsert keyed on a natural key, so running it
 * twice does not create duplicates and does not overwrite data staff have
 * edited (existing rows are left alone unless the value is clearly derived).
 *
 * Seeds:
 *   - the seven default roles
 *   - one account per role, all using SEED_ADMIN_PASSWORD
 *   - clinic settings
 *   - the symptom checklist, diagnosis library, formulary and test catalogue
 *   - a few insurance providers
 */
import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';
import { pool, closePool } from './pool.js';
import { DEFAULT_ROLES } from '../lib/permissions.js';

// --- Reference data --------------------------------------------------------

const SETTINGS = [
  ['clinic.name', 'Meridian General Clinic', 'general', 'Clinic name', true],
  ['clinic.tagline', 'Compassionate care, around the clock', 'general', 'Tagline', true],
  ['clinic.logo_url', '', 'general', 'Logo image URL', true],
  ['clinic.address', 'Meridian Sim (128, 128, 24)', 'general', 'In-world address', true],
  ['clinic.phone', '(555) 0100', 'general', 'Contact number', true],
  ['clinic.currency', 'L$', 'billing', 'Currency symbol', true],
  ['billing.visit_fee', 150, 'billing', 'Standard consultation fee', false],
  ['billing.emergency_fee', 500, 'billing', 'Emergency visit fee', false],
  ['billing.tax_rate', 0, 'billing', 'Tax rate applied to invoices', false],
  ['queue.average_consult_minutes', 15, 'queue', 'Fallback consultation length for wait estimates', false],
  ['queue.show_full_names', false, 'queue', 'Show full patient names on public queue boards', false],
  ['alerts.emergency_sound', true, 'alerts', 'Play a sound when an emergency code is raised', true],
  ['alerts.toast_duration_ms', 5000, 'alerts', 'How long toast notifications stay on screen', true],
  ['ui.theme', 'dark', 'appearance', 'Interface theme', true],
  ['ui.compact_mode', false, 'appearance', 'Denser layout for small MOAP surfaces', true],
];

const SYMPTOMS = [
  ['Headache', 'neurological', true, 10],
  ['Fever', 'general', true, 20],
  ['Nausea', 'gastrointestinal', true, 30],
  ['Vomiting', 'gastrointestinal', true, 40],
  ['Cough', 'respiratory', true, 50],
  ['Fatigue', 'general', true, 60],
  ['Chest Pain', 'cardiovascular', true, 70],
  ['Dizziness', 'neurological', true, 80],
  ['Pregnancy', 'obstetric', true, 90],
  ['Shortness of Breath', 'respiratory', false, 100],
  ['Abdominal Pain', 'gastrointestinal', false, 110],
  ['Sore Throat', 'respiratory', false, 120],
  ['Rash', 'dermatological', false, 130],
  ['Joint Pain', 'musculoskeletal', false, 140],
  ['Back Pain', 'musculoskeletal', false, 150],
  ['Diarrhoea', 'gastrointestinal', false, 160],
  ['Loss of Appetite', 'general', false, 170],
  ['Blurred Vision', 'neurological', false, 180],
  ['Palpitations', 'cardiovascular', false, 190],
  ['Anxiety', 'psychiatric', false, 200],
];

const DIAGNOSES = [
  ['J00', 'Common Cold', 'respiratory', 'mild', true],
  ['J11', 'Influenza', 'respiratory', 'moderate', true],
  ['U07.1', 'COVID-19', 'infectious', 'moderate', true],
  ['G43', 'Migraine', 'neurological', 'moderate', true],
  ['I10', 'Hypertension', 'cardiovascular', 'moderate', true],
  ['J45', 'Asthma', 'respiratory', 'moderate', true],
  ['E11', 'Type 2 Diabetes Mellitus', 'endocrine', 'moderate', true],
  ['S52', 'Fracture', 'musculoskeletal', 'severe', true],
  ['S93', 'Sprain', 'musculoskeletal', 'mild', true],
  ['A05', 'Food Poisoning', 'gastrointestinal', 'moderate', true],
  ['J02', 'Pharyngitis', 'respiratory', 'mild', false],
  ['N39.0', 'Urinary Tract Infection', 'genitourinary', 'moderate', false],
  ['K21', 'Gastro-oesophageal Reflux', 'gastrointestinal', 'mild', false],
  ['L20', 'Atopic Dermatitis', 'dermatological', 'mild', false],
  ['F41', 'Anxiety Disorder', 'psychiatric', 'moderate', false],
  ['F32', 'Depressive Episode', 'psychiatric', 'moderate', false],
  ['I21', 'Acute Myocardial Infarction', 'cardiovascular', 'critical', false],
  ['J18', 'Pneumonia', 'respiratory', 'severe', false],
  ['K35', 'Acute Appendicitis', 'gastrointestinal', 'severe', false],
  ['T78.2', 'Anaphylaxis', 'immunological', 'critical', false],
  ['R51', 'Headache, unspecified', 'neurological', 'mild', false],
  ['E86', 'Dehydration', 'metabolic', 'moderate', false],
  ['S06', 'Concussion', 'neurological', 'severe', false],
  ['T30', 'Burn, unspecified', 'trauma', 'severe', false],
  ['D50', 'Iron Deficiency Anaemia', 'haematological', 'mild', false],
];

//  name, generic, form, strength, category, controlled, cost, stock, instructions
const MEDICATIONS = [
  ['Ibuprofen', 'ibuprofen', 'tablet', '200 mg', 'analgesic', false, 5, 500, 'Take one tablet every 8 hours with food.'],
  ['Ibuprofen', 'ibuprofen', 'tablet', '400 mg', 'analgesic', false, 8, 300, 'Take one tablet every 8 hours with food.'],
  ['Tylenol', 'paracetamol', 'tablet', '500 mg', 'analgesic', false, 4, 600, 'Take one to two tablets every 6 hours. Do not exceed 8 in 24 hours.'],
  ['Amoxicillin', 'amoxicillin', 'capsule', '500 mg', 'antibiotic', false, 15, 200, 'Take one capsule three times a day for the full course.'],
  ['Azithromycin', 'azithromycin', 'tablet', '250 mg', 'antibiotic', false, 25, 120, 'Two tablets on day one, then one daily for four days.'],
  ['Insulin Glargine', 'insulin glargine', 'injection', '100 units/mL', 'endocrine', false, 120, 40, 'Inject subcutaneously once daily at the same time each evening.'],
  ['Morphine', 'morphine sulfate', 'injection', '10 mg/mL', 'opioid analgesic', true, 200, 25, 'Administered by clinical staff only.'],
  ['Vitamin D', 'cholecalciferol', 'capsule', '1000 IU', 'supplement', false, 3, 800, 'Take one capsule daily with a meal.'],
  ['Salbutamol Inhaler', 'salbutamol', 'inhaler', '100 mcg/dose', 'bronchodilator', false, 45, 60, 'Two puffs as needed for breathlessness, up to four times daily.'],
  ['Lisinopril', 'lisinopril', 'tablet', '10 mg', 'antihypertensive', false, 12, 180, 'Take one tablet each morning.'],
  ['Metformin', 'metformin', 'tablet', '500 mg', 'antidiabetic', false, 10, 250, 'Take one tablet twice daily with meals.'],
  ['Omeprazole', 'omeprazole', 'capsule', '20 mg', 'gastric', false, 9, 200, 'Take one capsule before breakfast.'],
  ['Cetirizine', 'cetirizine', 'tablet', '10 mg', 'antihistamine', false, 6, 300, 'Take one tablet daily.'],
  ['Epinephrine Auto-Injector', 'epinephrine', 'injection', '0.3 mg', 'emergency', false, 250, 20, 'Inject into the outer thigh in an emergency, then seek immediate care.'],
  ['Ondansetron', 'ondansetron', 'tablet', '4 mg', 'antiemetic', false, 18, 100, 'Take one tablet every 8 hours as needed for nausea.'],
  ['Diazepam', 'diazepam', 'tablet', '5 mg', 'benzodiazepine', true, 40, 50, 'Take as directed. Do not drive or operate machinery.'],
  ['Prednisone', 'prednisone', 'tablet', '20 mg', 'corticosteroid', false, 14, 150, 'Take with food each morning as directed.'],
  ['Naloxone', 'naloxone', 'injection', '0.4 mg/mL', 'emergency', false, 90, 30, 'Administered by clinical staff for opioid reversal.'],
];

//  code, name, category, modality, specimen, turnaround, unit, range, cost
const LAB_TESTS = [
  ['CBC', 'Complete Blood Count', 'laboratory', null, 'blood', 30, '10^9/L', '4.0 - 11.0', 60],
  ['UA', 'Urinalysis', 'laboratory', null, 'urine', 20, null, 'Negative', 40],
  ['BG', 'Blood Sugar', 'laboratory', null, 'blood', 10, 'mg/dL', '70 - 140', 25],
  ['COVID', 'COVID-19 Antigen Test', 'laboratory', null, 'swab', 20, null, 'Negative', 75],
  ['PREG', 'Pregnancy Test', 'laboratory', null, 'urine', 15, null, 'Negative', 35],
  ['BMP', 'Basic Metabolic Panel', 'laboratory', null, 'blood', 45, null, 'See report', 90],
  ['LFT', 'Liver Function Test', 'laboratory', null, 'blood', 45, 'U/L', 'See report', 85],
  ['LIPID', 'Lipid Panel', 'laboratory', null, 'blood', 45, 'mg/dL', 'See report', 80],
  ['TROP', 'Troponin', 'laboratory', null, 'blood', 30, 'ng/mL', '< 0.04', 150],
  ['CULT', 'Wound Culture', 'laboratory', null, 'swab', 2880, null, 'No growth', 110],
  ['XR', 'X-Ray', 'imaging', 'xray', null, 30, null, null, 200],
  ['MRI', 'MRI Scan', 'imaging', 'mri', null, 90, null, null, 900],
  ['CT', 'CT Scan', 'imaging', 'ct', null, 45, null, null, 650],
  ['US', 'Ultrasound', 'imaging', 'ultrasound', null, 30, null, null, 250],
];

const INSURANCE_PROVIDERS = [
  ['Linden Mutual Health', '(555) 0110', 0.8, 25],
  ['Second Life Care Cooperative', '(555) 0120', 0.7, 40],
  ['Meridian Employee Plan', '(555) 0130', 0.9, 10],
  ['Grid Standard Insurance', '(555) 0140', 0.6, 60],
];

const STAFF = [
  ['admin', 'Alex Reyes', 'administrator', 'Administration', null],
  ['dr.chen', 'Mei Chen', 'doctor', 'General Medicine', 'Dr.'],
  ['dr.okafor', 'Daniel Okafor', 'doctor', 'Emergency Medicine', 'Dr.'],
  ['nurse.patel', 'Priya Patel', 'nurse', 'Nursing', 'RN'],
  ['nurse.diallo', 'Awa Diallo', 'nurse', 'Nursing', 'RN'],
  ['pharm.silva', 'Rafael Silva', 'pharmacist', 'Pharmacy', 'PharmD'],
  ['lab.novak', 'Ivan Novak', 'lab_tech', 'Laboratory', null],
  ['rad.tanaka', 'Yuki Tanaka', 'radiology_tech', 'Radiology', null],
  ['front.moreau', 'Claire Moreau', 'receptionist', 'Reception', null],
];

// --- Seeding ---------------------------------------------------------------

async function seedRoles(client) {
  for (const role of DEFAULT_ROLES) {
    await client.query(
      `INSERT INTO staff_roles (code, name, description, rank, permissions, is_system)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             rank = EXCLUDED.rank,
             permissions = EXCLUDED.permissions`,
      [role.code, role.name, role.description, role.rank, JSON.stringify(role.permissions)]
    );
  }
  console.log(`[seed] ${DEFAULT_ROLES.length} roles`);
}

async function seedStaff(client) {
  const hash = await bcrypt.hash(config.seed.adminPassword, config.auth.bcryptRounds);
  let createdCount = 0;

  for (const [username, fullName, roleCode, department, title] of STAFF) {
    const { rows: role } = await client.query('SELECT id FROM staff_roles WHERE code = $1', [roleCode]);
    if (role.length === 0) continue;

    // DO NOTHING, not DO UPDATE: never reset a password an operator has changed.
    const { rowCount } = await client.query(
      `INSERT INTO staff (username, password_hash, full_name, display_title, role_id, department, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,true)
       ON CONFLICT (username) DO NOTHING`,
      [username, hash, fullName, title, role[0].id, department]
    );
    createdCount += rowCount;
  }

  console.log(`[seed] ${createdCount} staff account(s) created (${STAFF.length - createdCount} already existed)`);
  if (createdCount > 0) {
    console.log(`[seed] password for new accounts: ${config.seed.adminPassword}`);
    console.log('[seed] every account is flagged must_change_password.');
  }
}

async function seedSettings(client) {
  for (const [key, value, category, label, isPublic] of SETTINGS) {
    await client.query(
      `INSERT INTO clinic_settings (key, value, category, label, is_public)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (key) DO UPDATE SET category = EXCLUDED.category, label = EXCLUDED.label`,
      [key, JSON.stringify(value), category, label, isPublic]
    );
  }
  console.log(`[seed] ${SETTINGS.length} settings`);
}

async function seedSymptoms(client) {
  for (const [name, category, isCommon, sortOrder] of SYMPTOMS) {
    await client.query(
      `INSERT INTO symptoms (name, category, is_common, sort_order)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE SET category = EXCLUDED.category, is_common = EXCLUDED.is_common`,
      [name, category, isCommon, sortOrder]
    );
  }
  console.log(`[seed] ${SYMPTOMS.length} symptoms`);
}

async function seedDiagnoses(client) {
  for (const [code, name, category, severity, isCommon] of DIAGNOSES) {
    await client.query(
      `INSERT INTO diagnoses (code, name, category, severity, is_common)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, category = EXCLUDED.category,
             severity = EXCLUDED.severity, is_common = EXCLUDED.is_common`,
      [code, name, category, severity, isCommon]
    );
  }
  console.log(`[seed] ${DIAGNOSES.length} diagnoses`);
}

async function seedMedications(client) {
  for (const [name, generic, form, strength, category, controlled, cost, stock, instructions] of MEDICATIONS) {
    // Stock is not overwritten on re-seed - the pharmacy owns that number.
    await client.query(
      `INSERT INTO medications
         (name, generic_name, form, strength, category, is_controlled,
          unit_cost, stock_quantity, default_instructions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (name, strength) DO UPDATE
         SET generic_name = EXCLUDED.generic_name,
             form = EXCLUDED.form,
             category = EXCLUDED.category,
             is_controlled = EXCLUDED.is_controlled,
             default_instructions = EXCLUDED.default_instructions`,
      [name, generic, form, strength, category, controlled, cost, stock, instructions]
    );
  }
  console.log(`[seed] ${MEDICATIONS.length} medications`);
}

async function seedLabTests(client) {
  for (const [code, name, category, modality, specimen, turnaround, unit, range, cost] of LAB_TESTS) {
    await client.query(
      `INSERT INTO lab_test_catalog
         (code, name, category, modality, specimen_type, turnaround_minutes, unit, reference_range, cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, category = EXCLUDED.category,
             modality = EXCLUDED.modality, cost = EXCLUDED.cost`,
      [code, name, category, modality, specimen, turnaround, unit, range, cost]
    );
  }
  console.log(`[seed] ${LAB_TESTS.length} orderable tests`);
}

async function seedInsurance(client) {
  for (const [name, phone, coverage, copay] of INSURANCE_PROVIDERS) {
    await client.query(
      `INSERT INTO insurance_providers (name, contact_phone, default_coverage, default_copay)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE
         SET default_coverage = EXCLUDED.default_coverage, default_copay = EXCLUDED.default_copay`,
      [name, phone, coverage, copay]
    );
  }
  console.log(`[seed] ${INSURANCE_PROVIDERS.length} insurance providers`);
}

async function seedAvailability(client) {
  // Weekday 09:00-17:00 for every doctor that has no schedule yet.
  const { rows: doctors } = await client.query(
    `SELECT s.id FROM staff s JOIN staff_roles r ON r.id = s.role_id
      WHERE r.code = 'doctor' AND s.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM doctor_availability a WHERE a.doctor_id = s.id)`
  );

  for (const doctor of doctors) {
    for (let day = 1; day <= 5; day += 1) {
      await client.query(
        `INSERT INTO doctor_availability (doctor_id, day_of_week, start_time, end_time, slot_minutes)
         VALUES ($1,$2,'09:00','17:00',30)`,
        [doctor.id, day]
      );
    }
  }

  if (doctors.length > 0) console.log(`[seed] working hours for ${doctors.length} doctor(s)`);
}

async function main() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await seedRoles(client);
    await seedStaff(client);
    await seedSettings(client);
    await seedSymptoms(client);
    await seedDiagnoses(client);
    await seedMedications(client);
    await seedLabTests(client);
    await seedInsurance(client);
    await seedAvailability(client);

    await client.query('COMMIT');
    console.log('[seed] done');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] FAILED:', err.message);
    if (err.detail) console.error('[seed] detail:', err.detail);
    process.exitCode = 1;
  } finally {
    client.release();
    await closePool();
  }
}

main();
