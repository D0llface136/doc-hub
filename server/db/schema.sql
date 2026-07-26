-- ===========================================================================
--  MOAP Clinic HUD - PostgreSQL schema
--  Target: PostgreSQL 15+ (Supabase)
--
--  Conventions used throughout:
--    * UUID primary keys (gen_random_uuid, from pgcrypto).
--    * created_at / updated_at on every mutable table; updated_at is
--      maintained by the touch_updated_at() trigger.
--    * Soft deletes via `deleted_at timestamptz` on long-lived records
--      (patients, staff, catalogs). Transactional/event rows are never
--      soft-deleted - they are the audit trail.
--    * Status/type columns are TEXT + CHECK rather than native ENUMs, so new
--      values can be added with a single ALTER TABLE ... DROP/ADD CONSTRAINT
--      instead of a type migration that locks dependent objects.
--    * Money is NUMERIC(12,2). Never floating point.
--
--  This file is idempotent: it can be re-run over an existing database.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy search on names / catalogs

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Human-readable identifiers. These are display/roleplay identifiers; the UUID
-- remains the real key. Sequences guarantee uniqueness without a table scan.
CREATE SEQUENCE IF NOT EXISTS seq_patient_mrn   START 1000;
CREATE SEQUENCE IF NOT EXISTS seq_visit_number  START 1000;
CREATE SEQUENCE IF NOT EXISTS seq_invoice_number START 1000;
CREATE SEQUENCE IF NOT EXISTS seq_staff_number  START 100;


-- ===========================================================================
-- 1. STAFF & AUTHENTICATION
-- ===========================================================================

CREATE TABLE IF NOT EXISTS staff_roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,          -- 'doctor', 'nurse', ...
  name          text NOT NULL,
  description   text,
  -- Permission strings, e.g. ["patients:read","prescriptions:write"].
  -- "*" grants everything (administrator).
  permissions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Lower rank = more authority. Used to stop a nurse editing a doctor.
  rank          integer NOT NULL DEFAULT 100,
  is_system     boolean NOT NULL DEFAULT false, -- system roles cannot be deleted
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_number    text NOT NULL UNIQUE,
  username        text NOT NULL UNIQUE,
  password_hash   text NOT NULL,
  full_name       text NOT NULL,
  display_title   text,                        -- "Dr.", "RN", "PharmD"
  role_id         uuid NOT NULL REFERENCES staff_roles(id) ON DELETE RESTRICT,
  department      text,
  email           text,
  -- Second Life identity. Lets an in-world HUD authenticate its wearer.
  sl_avatar_key   uuid UNIQUE,
  sl_avatar_name  text,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','inactive','suspended','on_break','off_duty')),
  is_on_duty      boolean NOT NULL DEFAULT false,
  last_login_at   timestamptz,
  last_seen_at    timestamptz,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_staff_role        ON staff(role_id);
CREATE INDEX IF NOT EXISTS idx_staff_status      ON staff(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_staff_on_duty     ON staff(is_on_duty) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_staff_name_trgm   ON staff USING gin (full_name gin_trgm_ops);

-- Issued JWTs. Storing them lets an administrator force-logout a session and
-- lets the API reject tokens issued before a password change.
CREATE TABLE IF NOT EXISTS staff_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  token_id      text NOT NULL UNIQUE,          -- the JWT "jti" claim
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip_address    text,
  user_agent    text,
  source        text NOT NULL DEFAULT 'web' CHECK (source IN ('web','lsl','api'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_staff  ON staff_sessions(staff_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON staff_sessions(expires_at) WHERE revoked_at IS NULL;


-- ===========================================================================
-- 2. PATIENTS
-- ===========================================================================

CREATE TABLE IF NOT EXISTS patients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn                text NOT NULL UNIQUE,     -- medical record number, "MRN-001042"
  first_name         text NOT NULL,
  last_name          text NOT NULL,
  date_of_birth      date,
  gender             text CHECK (gender IN ('male','female','non_binary','other','undisclosed')),
  blood_type         text CHECK (blood_type IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')),
  height_cm          numeric(5,1),
  weight_kg          numeric(5,1),
  phone_number       text,
  email              text,
  address            text,
  -- Second Life identity, so a HUD can look up "the avatar I'm touching".
  sl_avatar_key      uuid UNIQUE,
  sl_avatar_name     text,
  photo_url          text,
  notes              text,
  is_deceased        boolean NOT NULL DEFAULT false,
  registered_by      uuid REFERENCES staff(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_patients_last_name  ON patients(lower(last_name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_patients_name_trgm  ON patients USING gin ((first_name || ' ' || last_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_patients_sl_key     ON patients(sl_avatar_key) WHERE sl_avatar_key IS NOT NULL;

-- Allergies and chronic conditions are one-to-many, not comma-joined strings,
-- so they can be queried, flagged during prescribing, and audited.
CREATE TABLE IF NOT EXISTS patient_allergies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  substance    text NOT NULL,
  reaction     text,
  severity     text NOT NULL DEFAULT 'moderate'
               CHECK (severity IN ('mild','moderate','severe','life_threatening')),
  noted_by     uuid REFERENCES staff(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_allergies_patient ON patient_allergies(patient_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS patient_conditions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  condition     text NOT NULL,
  diagnosed_on  date,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','resolved','in_remission','chronic')),
  notes         text,
  noted_by      uuid REFERENCES staff(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_conditions_patient ON patient_conditions(patient_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id     uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  full_name      text NOT NULL,
  relationship   text,
  phone_number   text,
  email          text,
  is_primary     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_emergency_contacts_patient ON emergency_contacts(patient_id) WHERE deleted_at IS NULL;


-- ===========================================================================
-- 3. INSURANCE
-- ===========================================================================

CREATE TABLE IF NOT EXISTS insurance_providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL UNIQUE,
  contact_phone     text,
  contact_email     text,
  -- Fraction of billed charges covered by default, 0.00 - 1.00.
  default_coverage  numeric(4,3) NOT NULL DEFAULT 0.800
                    CHECK (default_coverage >= 0 AND default_coverage <= 1),
  default_copay     numeric(12,2) NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE TABLE IF NOT EXISTS patient_insurance (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  provider_id         uuid REFERENCES insurance_providers(id) ON DELETE SET NULL,
  provider_name       text,                    -- free text if provider not in catalog
  policy_number       text NOT NULL,
  group_number        text,
  policy_holder_name  text,
  coverage_percent    numeric(4,3) CHECK (coverage_percent >= 0 AND coverage_percent <= 1),
  copay_amount        numeric(12,2) NOT NULL DEFAULT 0,
  effective_date      date,
  expiration_date     date,
  verification_status text NOT NULL DEFAULT 'unverified'
                      CHECK (verification_status IN ('unverified','verified','denied','expired','pending')),
  verified_by         uuid REFERENCES staff(id) ON DELETE SET NULL,
  verified_at         timestamptz,
  verification_notes  text,
  is_primary          boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE INDEX IF NOT EXISTS idx_patient_insurance_patient ON patient_insurance(patient_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_patient_insurance_status  ON patient_insurance(verification_status);


-- ===========================================================================
-- 4. APPOINTMENTS
-- ===========================================================================

CREATE TABLE IF NOT EXISTS appointments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id        uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id         uuid REFERENCES staff(id) ON DELETE SET NULL,
  scheduled_start   timestamptz NOT NULL,
  scheduled_end     timestamptz NOT NULL,
  appointment_type  text NOT NULL DEFAULT 'consultation'
                    CHECK (appointment_type IN ('consultation','follow_up','procedure','lab','imaging','vaccination','physical','other')),
  reason            text,
  notes             text,
  status            text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','confirmed','checked_in','in_progress','completed','cancelled','no_show','rescheduled')),
  -- Recurrence. A recurring series is a parent row plus generated children
  -- that point back at it via recurrence_parent_id.
  recurrence_rule       text,                  -- 'daily' | 'weekly' | 'biweekly' | 'monthly'
  recurrence_until      date,
  recurrence_parent_id  uuid REFERENCES appointments(id) ON DELETE CASCADE,
  rescheduled_from_id   uuid REFERENCES appointments(id) ON DELETE SET NULL,
  cancelled_reason  text,
  created_by        uuid REFERENCES staff(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT appointments_time_order CHECK (scheduled_end > scheduled_start)
);
CREATE INDEX IF NOT EXISTS idx_appointments_start   ON appointments(scheduled_start) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_doctor  ON appointments(doctor_id, scheduled_start) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id, scheduled_start) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_status  ON appointments(status) WHERE deleted_at IS NULL;

-- Weekly availability template per doctor, used by the scheduler to offer slots.
CREATE TABLE IF NOT EXISTS doctor_availability (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id     uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  day_of_week   smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0 = Sunday
  start_time    time NOT NULL,
  end_time      time NOT NULL,
  slot_minutes  integer NOT NULL DEFAULT 30 CHECK (slot_minutes > 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_time_order CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS idx_availability_doctor ON doctor_availability(doctor_id, day_of_week);


-- ===========================================================================
-- 5. VISITS (the spine of the record)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS patient_visits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_number      text NOT NULL UNIQUE,      -- "V-2026-001042"
  patient_id        uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id    uuid REFERENCES appointments(id) ON DELETE SET NULL,
  visit_type        text NOT NULL DEFAULT 'walk_in'
                    CHECK (visit_type IN ('walk_in','scheduled','emergency','follow_up','telehealth')),
  status            text NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting','being_seen','completed','admitted','discharged','no_show','cancelled')),
  priority          text NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('normal','urgent','emergency')),

  -- Waiting-room queue
  queue_number      integer,
  queue_date        date NOT NULL DEFAULT CURRENT_DATE,
  estimated_wait_minutes integer,
  called_at         timestamptz,

  -- Clinical summary (details live in the child tables below)
  chief_complaint   text,
  pain_scale        smallint CHECK (pain_scale BETWEEN 0 AND 10),
  disposition       text CHECK (disposition IN ('discharged','admitted','transferred','ama','deceased','referred')),

  assigned_doctor_id uuid REFERENCES staff(id) ON DELETE SET NULL,
  assigned_nurse_id  uuid REFERENCES staff(id) ON DELETE SET NULL,
  checked_in_by      uuid REFERENCES staff(id) ON DELETE SET NULL,

  checked_in_at     timestamptz NOT NULL DEFAULT now(),
  seen_at           timestamptz,
  completed_at      timestamptz,
  discharged_at     timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,

  -- Queue numbers restart each day and are never reused within that day, so a
  -- completed visit still owns its number in the day's history.
  CONSTRAINT visits_queue_unique_per_day UNIQUE (queue_date, queue_number)
);
CREATE INDEX IF NOT EXISTS idx_visits_patient   ON patient_visits(patient_id, checked_in_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_visits_status    ON patient_visits(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_visits_queue     ON patient_visits(queue_date, priority, queue_number) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_visits_doctor    ON patient_visits(assigned_doctor_id, checked_in_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_visits_checkedin ON patient_visits(checked_in_at DESC);

CREATE TABLE IF NOT EXISTS visit_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id     uuid NOT NULL REFERENCES patient_visits(id) ON DELETE CASCADE,
  author_id    uuid REFERENCES staff(id) ON DELETE SET NULL,
  note_type    text NOT NULL DEFAULT 'progress'
               CHECK (note_type IN ('progress','physician','nursing','triage','procedure','discharge','addendum','general')),
  body         text NOT NULL,
  is_pinned    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_visit_notes_visit ON visit_notes(visit_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS vitals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id           uuid REFERENCES patient_visits(id) ON DELETE CASCADE,
  patient_id         uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  recorded_by        uuid REFERENCES staff(id) ON DELETE SET NULL,
  temperature_c      numeric(4,1),
  bp_systolic        integer,
  bp_diastolic       integer,
  heart_rate         integer,
  respiratory_rate   integer,
  oxygen_saturation  integer CHECK (oxygen_saturation BETWEEN 0 AND 100),
  blood_sugar_mgdl   integer,
  weight_kg          numeric(5,1),
  height_cm          numeric(5,1),
  -- Stored (not computed on read) so historical BMI reflects the height and
  -- weight recorded at the time, even if the patient record changes later.
  bmi                numeric(5,2),
  pain_scale         smallint CHECK (pain_scale BETWEEN 0 AND 10),
  notes              text,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_vitals_visit   ON vitals(visit_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_vitals_patient ON vitals(patient_id, recorded_at DESC) WHERE deleted_at IS NULL;

-- Catalog of selectable symptoms (the checkbox list), extensible at runtime.
CREATE TABLE IF NOT EXISTS symptoms (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  category     text,
  description  text,
  is_common    boolean NOT NULL DEFAULT false,  -- shown as a default checkbox
  sort_order   integer NOT NULL DEFAULT 100,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_symptoms_name_trgm ON symptoms USING gin (name gin_trgm_ops);

-- Symptoms actually recorded on a visit. custom_name carries free-text entries
-- that are not (yet) in the catalog.
CREATE TABLE IF NOT EXISTS visit_symptoms (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id     uuid NOT NULL REFERENCES patient_visits(id) ON DELETE CASCADE,
  symptom_id   uuid REFERENCES symptoms(id) ON DELETE SET NULL,
  custom_name  text,
  severity     text CHECK (severity IN ('mild','moderate','severe')),
  duration     text,                            -- "3 days", "since this morning"
  notes        text,
  recorded_by  uuid REFERENCES staff(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visit_symptoms_has_name CHECK (symptom_id IS NOT NULL OR custom_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_visit_symptoms_visit ON visit_symptoms(visit_id);

CREATE TABLE IF NOT EXISTS physical_exams (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id            uuid NOT NULL REFERENCES patient_visits(id) ON DELETE CASCADE,
  examiner_id         uuid REFERENCES staff(id) ON DELETE SET NULL,
  general_appearance  text,
  heent               text,
  cardiovascular      text,
  respiratory         text,
  abdomen             text,
  neurological        text,
  skin                text,
  musculoskeletal     text,
  additional_notes    text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE INDEX IF NOT EXISTS idx_physical_exams_visit ON physical_exams(visit_id);

-- Searchable diagnosis library.
CREATE TABLE IF NOT EXISTS diagnoses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text UNIQUE,                     -- ICD-10 style, optional
  name         text NOT NULL,
  category     text,
  description  text,
  severity     text CHECK (severity IN ('mild','moderate','severe','critical')),
  is_common    boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES staff(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_diagnoses_name_trgm ON diagnoses USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_diagnoses_common    ON diagnoses(is_common) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS visit_diagnoses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id      uuid NOT NULL REFERENCES patient_visits(id) ON DELETE CASCADE,
  diagnosis_id  uuid REFERENCES diagnoses(id) ON DELETE SET NULL,
  custom_name   text,
  is_primary    boolean NOT NULL DEFAULT false,
  certainty     text NOT NULL DEFAULT 'confirmed'
                CHECK (certainty IN ('suspected','probable','confirmed','ruled_out')),
  notes         text,
  diagnosed_by  uuid REFERENCES staff(id) ON DELETE SET NULL,
  diagnosed_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visit_diagnoses_has_name CHECK (diagnosis_id IS NOT NULL OR custom_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_visit_diagnoses_visit ON visit_diagnoses(visit_id);
CREATE INDEX IF NOT EXISTS idx_visit_diagnoses_dx    ON visit_diagnoses(diagnosis_id);

CREATE TABLE IF NOT EXISTS treatments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id       uuid NOT NULL REFERENCES patient_visits(id) ON DELETE CASCADE,
  treatment_type text NOT NULL
                 CHECK (treatment_type IN ('observation','medication','referral','physical_therapy','laboratory','imaging','admission','procedure','counseling','other')),
  description    text,
  physician_notes text,
  status         text NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','in_progress','completed','cancelled')),
  ordered_by     uuid REFERENCES staff(id) ON DELETE SET NULL,
  ordered_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_treatments_visit ON treatments(visit_id) WHERE deleted_at IS NULL;


-- ===========================================================================
-- 6. MEDICATIONS, PRESCRIPTIONS, PHARMACY
-- ===========================================================================

CREATE TABLE IF NOT EXISTS medications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  generic_name        text,
  form                text CHECK (form IN ('tablet','capsule','liquid','injection','topical','inhaler','patch','suppository','drops','other')),
  strength            text,                     -- "200 mg"
  category            text,                     -- "analgesic", "antibiotic"
  is_controlled       boolean NOT NULL DEFAULT false,
  requires_approval   boolean NOT NULL DEFAULT false,
  default_dosage      text,
  default_frequency   text,
  default_instructions text,
  unit_cost           numeric(12,2) NOT NULL DEFAULT 0,
  stock_quantity      integer NOT NULL DEFAULT 0,
  reorder_level       integer NOT NULL DEFAULT 10,
  contraindications   text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT medications_name_strength_unique UNIQUE (name, strength)
);
CREATE INDEX IF NOT EXISTS idx_medications_name_trgm ON medications USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_medications_active    ON medications(is_active) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS prescriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id        uuid REFERENCES patient_visits(id) ON DELETE SET NULL,
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  medication_id   uuid REFERENCES medications(id) ON DELETE SET NULL,
  medication_name text NOT NULL,                -- denormalized: the label must
                                                -- survive a catalog edit
  dosage          text NOT NULL,
  frequency       text NOT NULL,
  duration        text,
  quantity        integer NOT NULL DEFAULT 1,
  refills         integer NOT NULL DEFAULT 0,
  instructions    text,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','sent_to_pharmacy','filled','dispensed','completed','cancelled','expired')),
  prescribed_by   uuid REFERENCES staff(id) ON DELETE SET NULL,
  prescribed_at   timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient ON prescriptions(patient_id, prescribed_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_prescriptions_visit   ON prescriptions(visit_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_status  ON prescriptions(status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS pharmacy_queue (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id  uuid NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  patient_id       uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','in_progress','ready','picked_up','rejected','cancelled')),
  priority         text NOT NULL DEFAULT 'normal'
                   CHECK (priority IN ('normal','urgent','emergency')),
  filled_by        uuid REFERENCES staff(id) ON DELETE SET NULL,
  filled_at        timestamptz,
  dispensed_by     uuid REFERENCES staff(id) ON DELETE SET NULL,
  dispensed_at     timestamptz,
  rejected_reason  text,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pharmacy_queue_status ON pharmacy_queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pharmacy_queue_rx     ON pharmacy_queue(prescription_id);


-- ===========================================================================
-- 7. LABORATORY & RADIOLOGY
-- ===========================================================================

-- Catalog of orderable tests, covering both lab and imaging.
CREATE TABLE IF NOT EXISTS lab_test_catalog (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text UNIQUE,
  name           text NOT NULL,
  category       text NOT NULL DEFAULT 'laboratory'
                 CHECK (category IN ('laboratory','imaging','pathology','other')),
  modality       text,                          -- 'xray','mri','ct','ultrasound'
  specimen_type  text,                          -- 'blood','urine','swab'
  turnaround_minutes integer NOT NULL DEFAULT 30,
  reference_range text,
  unit           text,
  cost           numeric(12,2) NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lab_catalog_name_trgm ON lab_test_catalog USING gin (name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS laboratory_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id      uuid REFERENCES patient_visits(id) ON DELETE SET NULL,
  patient_id    uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  test_id       uuid REFERENCES lab_test_catalog(id) ON DELETE SET NULL,
  test_name     text NOT NULL,
  priority      text NOT NULL DEFAULT 'routine'
                CHECK (priority IN ('routine','urgent','stat')),
  status        text NOT NULL DEFAULT 'ordered'
                CHECK (status IN ('ordered','collected','in_progress','completed','cancelled','rejected')),
  clinical_notes text,
  ordered_by    uuid REFERENCES staff(id) ON DELETE SET NULL,
  ordered_at    timestamptz NOT NULL DEFAULT now(),
  collected_by  uuid REFERENCES staff(id) ON DELETE SET NULL,
  collected_at  timestamptz,
  completed_by  uuid REFERENCES staff(id) ON DELETE SET NULL,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_lab_orders_status  ON laboratory_orders(status, ordered_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lab_orders_patient ON laboratory_orders(patient_id, ordered_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lab_orders_visit   ON laboratory_orders(visit_id);

CREATE TABLE IF NOT EXISTS laboratory_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES laboratory_orders(id) ON DELETE CASCADE,
  test_name       text NOT NULL,
  result_value    text,
  unit            text,
  reference_range text,
  flag            text NOT NULL DEFAULT 'normal'
                  CHECK (flag IN ('normal','high','low','critical','abnormal','inconclusive')),
  interpretation  text,
  notes           text,
  resulted_by     uuid REFERENCES staff(id) ON DELETE SET NULL,
  resulted_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lab_results_order ON laboratory_results(order_id);
CREATE INDEX IF NOT EXISTS idx_lab_results_flag  ON laboratory_results(flag) WHERE flag IN ('critical','high','low');

CREATE TABLE IF NOT EXISTS radiology_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id          uuid REFERENCES patient_visits(id) ON DELETE SET NULL,
  patient_id        uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  test_id           uuid REFERENCES lab_test_catalog(id) ON DELETE SET NULL,
  study_name        text NOT NULL,
  modality          text NOT NULL DEFAULT 'xray'
                    CHECK (modality IN ('xray','ct','mri','ultrasound','mammogram','fluoroscopy','other')),
  body_part         text,
  priority          text NOT NULL DEFAULT 'routine'
                    CHECK (priority IN ('routine','urgent','stat')),
  status            text NOT NULL DEFAULT 'ordered'
                    CHECK (status IN ('ordered','scheduled','in_progress','awaiting_read','completed','cancelled')),
  clinical_history  text,
  findings          text,
  impression        text,                       -- the radiologist's read
  interpreted_by    uuid REFERENCES staff(id) ON DELETE SET NULL,
  interpreted_at    timestamptz,
  ordered_by        uuid REFERENCES staff(id) ON DELETE SET NULL,
  ordered_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_radiology_status  ON radiology_orders(status, ordered_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_radiology_patient ON radiology_orders(patient_id, ordered_at DESC) WHERE deleted_at IS NULL;

-- Generic attachment table. Images in Second Life are almost always remote
-- URLs (a texture service or image host), so we store the URL rather than
-- bytes. entity_type/entity_id lets any module attach files without a new
-- table per module.
CREATE TABLE IF NOT EXISTS attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL
               CHECK (entity_type IN ('laboratory_result','radiology_order','patient','visit','surgery','certificate','message')),
  entity_id    uuid NOT NULL,
  file_name    text NOT NULL,
  file_url     text NOT NULL,
  mime_type    text,
  file_size    bigint,
  caption      text,
  uploaded_by  uuid REFERENCES staff(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id) WHERE deleted_at IS NULL;


-- ===========================================================================
-- 8. SURGERY
-- ===========================================================================

CREATE TABLE IF NOT EXISTS surgeries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id          uuid REFERENCES patient_visits(id) ON DELETE SET NULL,
  patient_id        uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  procedure_name    text NOT NULL,
  procedure_code    text,
  surgeon_id        uuid REFERENCES staff(id) ON DELETE SET NULL,
  anesthesia_type   text CHECK (anesthesia_type IN ('none','local','regional','spinal','general','sedation')),
  anesthesiologist_id uuid REFERENCES staff(id) ON DELETE SET NULL,
  operating_room    text,
  status            text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','in_progress','completed','cancelled','postponed')),
  scheduled_at      timestamptz,
  start_time        timestamptz,
  end_time          timestamptz,
  outcome           text CHECK (outcome IN ('successful','partial','unsuccessful','aborted')),
  complications     text,
  operative_notes   text,
  post_op_instructions text,
  cost              numeric(12,2) NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT surgeries_time_order CHECK (end_time IS NULL OR start_time IS NULL OR end_time >= start_time)
);
CREATE INDEX IF NOT EXISTS idx_surgeries_patient ON surgeries(patient_id, scheduled_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_surgeries_status  ON surgeries(status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS surgery_assistants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surgery_id  uuid NOT NULL REFERENCES surgeries(id) ON DELETE CASCADE,
  staff_id    uuid REFERENCES staff(id) ON DELETE SET NULL,
  staff_name  text,                             -- for non-registered assistants
  role        text,                             -- 'first assist', 'scrub nurse'
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT surgery_assistants_unique UNIQUE (surgery_id, staff_id)
);
CREATE INDEX IF NOT EXISTS idx_surgery_assistants ON surgery_assistants(surgery_id);


-- ===========================================================================
-- 9. BILLING
-- ===========================================================================

CREATE TABLE IF NOT EXISTS invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number    text NOT NULL UNIQUE,       -- "INV-2026-001042"
  patient_id        uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  visit_id          uuid REFERENCES patient_visits(id) ON DELETE SET NULL,
  billing_type      text NOT NULL DEFAULT 'self_pay'
                    CHECK (billing_type IN ('self_pay','insurance','mixed','waived')),
  patient_insurance_id uuid REFERENCES patient_insurance(id) ON DELETE SET NULL,
  subtotal          numeric(12,2) NOT NULL DEFAULT 0,
  discount_amount   numeric(12,2) NOT NULL DEFAULT 0,
  tax_amount        numeric(12,2) NOT NULL DEFAULT 0,
  insurance_covered numeric(12,2) NOT NULL DEFAULT 0,
  patient_responsibility numeric(12,2) NOT NULL DEFAULT 0,
  total             numeric(12,2) NOT NULL DEFAULT 0,
  amount_paid       numeric(12,2) NOT NULL DEFAULT 0,
  balance_due       numeric(12,2) NOT NULL DEFAULT 0,
  currency          text NOT NULL DEFAULT 'L$', -- Linden Dollars by default
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','issued','partially_paid','paid','overdue','void','written_off')),
  claim_status      text CHECK (claim_status IN ('not_submitted','submitted','approved','denied','partially_approved')),
  claim_submitted_at timestamptz,
  claim_reference   text,
  claim_notes       text,
  issued_at         timestamptz,
  due_date          date,
  paid_at           timestamptz,
  created_by        uuid REFERENCES staff(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_invoices_patient ON invoices(patient_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_status  ON invoices(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_visit   ON invoices(visit_id);

CREATE TABLE IF NOT EXISTS invoice_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_type    text NOT NULL
               CHECK (item_type IN ('visit','medication','laboratory','radiology','surgery','procedure','supply','other')),
  -- Optional pointer at the row that generated the charge, for drill-down.
  source_id    uuid,
  description  text NOT NULL,
  quantity     numeric(10,2) NOT NULL DEFAULT 1,
  unit_price   numeric(12,2) NOT NULL DEFAULT 0,
  line_total   numeric(12,2) NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  method          text NOT NULL DEFAULT 'cash'
                  CHECK (method IN ('cash','card','linden','insurance','bank_transfer','waived','other')),
  reference       text,                          -- SL transaction ID, etc.
  notes           text,
  received_by     uuid REFERENCES staff(id) ON DELETE SET NULL,
  paid_at         timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_date    ON payments(paid_at DESC);


-- ===========================================================================
-- 10. DOCUMENTS & DISCHARGE
-- ===========================================================================

CREATE TABLE IF NOT EXISTS medical_certificates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_number text NOT NULL UNIQUE,
  patient_id        uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  visit_id          uuid REFERENCES patient_visits(id) ON DELETE SET NULL,
  template          text NOT NULL
                    CHECK (template IN ('work_excuse','school_note','fitness_clearance','admission_letter','discharge_summary','custom')),
  title             text NOT NULL,
  body              text NOT NULL,
  valid_from        date,
  valid_until       date,
  issued_by         uuid REFERENCES staff(id) ON DELETE SET NULL,
  issued_at         timestamptz NOT NULL DEFAULT now(),
  -- Public token so a printable copy can be opened in-world without a login.
  public_token      text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_certificates_patient ON medical_certificates(patient_id, issued_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS discharge_records (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id              uuid NOT NULL REFERENCES patient_visits(id) ON DELETE CASCADE,
  patient_id            uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  discharge_status      text NOT NULL
                        CHECK (discharge_status IN ('recovered','improved','transferred','admitted','ama','deceased','referred')),
  condition_on_discharge text,
  instructions          text,
  medication_summary    text,
  follow_up_required    boolean NOT NULL DEFAULT false,
  follow_up_date        date,
  follow_up_appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  transferred_to        text,
  discharged_by         uuid REFERENCES staff(id) ON DELETE SET NULL,
  discharged_at         timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_discharge_visit   ON discharge_records(visit_id);
CREATE INDEX IF NOT EXISTS idx_discharge_patient ON discharge_records(patient_id, discharged_at DESC);


-- ===========================================================================
-- 11. COMMUNICATION
-- ===========================================================================

CREATE TABLE IF NOT EXISTS internal_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id       uuid REFERENCES staff(id) ON DELETE SET NULL,
  -- A message goes either to a department (broadcast) or to specific staff
  -- (rows in message_recipients), or both.
  department      text CHECK (department IN ('reception','nursing','doctors','laboratory','pharmacy','radiology','administration','all')),
  subject         text,
  body            text NOT NULL,
  priority        text NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low','normal','high','urgent')),
  related_patient_id uuid REFERENCES patients(id) ON DELETE SET NULL,
  related_visit_id   uuid REFERENCES patient_visits(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_messages_dept ON internal_messages(department, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_sender ON internal_messages(sender_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_recipients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid NOT NULL REFERENCES internal_messages(id) ON DELETE CASCADE,
  staff_id     uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  read_at      timestamptz,                     -- read receipt
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_recipients_unique UNIQUE (message_id, staff_id)
);
CREATE INDEX IF NOT EXISTS idx_message_recipients_unread ON message_recipients(staff_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL staff_id = broadcast to everyone.
  staff_id      uuid REFERENCES staff(id) ON DELETE CASCADE,
  role_code     text,                           -- or target a whole role
  type          text NOT NULL DEFAULT 'info'
                CHECK (type IN ('info','success','warning','error','emergency','lab_result','prescription','appointment','message','queue')),
  title         text NOT NULL,
  body          text,
  -- Deep link into the SPA, e.g. "#/patients/<uuid>".
  link          text,
  entity_type   text,
  entity_id     uuid,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_notifications_staff  ON notifications(staff_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(staff_id) WHERE read_at IS NULL;


-- ===========================================================================
-- 12. EMERGENCY, AUDIT, SETTINGS
-- ===========================================================================

CREATE TABLE IF NOT EXISTS emergency_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_type       text NOT NULL
                  CHECK (code_type IN ('code_blue','code_red','code_black','trauma','mass_casualty','lockdown','all_clear')),
  location        text,
  description     text,
  patient_id      uuid REFERENCES patients(id) ON DELETE SET NULL,
  visit_id        uuid REFERENCES patient_visits(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','acknowledged','resolved','cancelled')),
  activated_by    uuid REFERENCES staff(id) ON DELETE SET NULL,
  activated_at    timestamptz NOT NULL DEFAULT now(),
  resolved_by     uuid REFERENCES staff(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  resolution_notes text,
  responders      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- staff ids who acknowledged
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emergency_active ON emergency_events(status, activated_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid REFERENCES staff(id) ON DELETE SET NULL,
  staff_name    text,                           -- kept even if staff is deleted
  action        text NOT NULL,                  -- 'create','update','delete','view','login','dispense'
  entity_type   text NOT NULL,
  entity_id     uuid,
  -- Changed fields only, as {field: {from, to}}. Never store password hashes.
  changes       jsonb,
  description   text,
  ip_address    text,
  user_agent    text,
  source        text NOT NULL DEFAULT 'web' CHECK (source IN ('web','lsl','api','system')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_staff  ON audit_logs(staff_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_date   ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS clinic_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  category    text NOT NULL DEFAULT 'general',
  label       text,
  description text,
  -- Readable by unauthenticated clients (clinic name, logo) vs. staff-only.
  is_public   boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES staff(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);


-- ===========================================================================
-- 13. TRIGGERS
-- ===========================================================================

-- updated_at maintenance for every table that has the column.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'updated_at'
      AND EXISTS (
        SELECT 1 FROM information_schema.tables x
        WHERE x.table_schema = 'public' AND x.table_name = c.table_name
          AND x.table_type = 'BASE TABLE'
      )
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_%1$s ON %1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_touch_%1$s BEFORE UPDATE ON %1$I
       FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t);
  END LOOP;
END $$;

-- Auto-assign human-readable identifiers.
CREATE OR REPLACE FUNCTION assign_patient_mrn() RETURNS trigger AS $$
BEGIN
  IF NEW.mrn IS NULL OR NEW.mrn = '' THEN
    NEW.mrn := 'MRN-' || lpad(nextval('seq_patient_mrn')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_mrn ON patients;
CREATE TRIGGER trg_patient_mrn BEFORE INSERT ON patients
  FOR EACH ROW EXECUTE FUNCTION assign_patient_mrn();

CREATE OR REPLACE FUNCTION assign_staff_number() RETURNS trigger AS $$
BEGIN
  IF NEW.staff_number IS NULL OR NEW.staff_number = '' THEN
    NEW.staff_number := 'STF-' || lpad(nextval('seq_staff_number')::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_staff_number ON staff;
CREATE TRIGGER trg_staff_number BEFORE INSERT ON staff
  FOR EACH ROW EXECUTE FUNCTION assign_staff_number();

-- Visit number + daily queue number.
--
-- The advisory lock serializes concurrent check-ins for the same day so two
-- receptionists cannot be handed the same queue number. It is a transaction
-- lock, so it releases automatically on COMMIT or ROLLBACK.
CREATE OR REPLACE FUNCTION assign_visit_identifiers() RETURNS trigger AS $$
DECLARE
  next_queue integer;
BEGIN
  IF NEW.visit_number IS NULL OR NEW.visit_number = '' THEN
    NEW.visit_number := 'V-' || to_char(now(), 'YYYY') || '-' ||
                        lpad(nextval('seq_visit_number')::text, 6, '0');
  END IF;

  IF NEW.queue_number IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('clinic_queue_' || NEW.queue_date::text));
    SELECT COALESCE(MAX(queue_number), 0) + 1 INTO next_queue
      FROM patient_visits
     WHERE queue_date = NEW.queue_date;
    NEW.queue_number := next_queue;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_visit_identifiers ON patient_visits;
CREATE TRIGGER trg_visit_identifiers BEFORE INSERT ON patient_visits
  FOR EACH ROW EXECUTE FUNCTION assign_visit_identifiers();

CREATE OR REPLACE FUNCTION assign_invoice_number() RETURNS trigger AS $$
BEGIN
  IF NEW.invoice_number IS NULL OR NEW.invoice_number = '' THEN
    NEW.invoice_number := 'INV-' || to_char(now(), 'YYYY') || '-' ||
                          lpad(nextval('seq_invoice_number')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoice_number ON invoices;
CREATE TRIGGER trg_invoice_number BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION assign_invoice_number();

-- Keep invoice balances consistent whenever a payment lands. Doing this in the
-- database means a payment recorded by any client (web, LSL, manual SQL) keeps
-- the invoice correct.
CREATE OR REPLACE FUNCTION recalc_invoice_balance() RETURNS trigger AS $$
DECLARE
  inv_id uuid;
  paid   numeric(12,2);
  inv    invoices%ROWTYPE;
BEGIN
  inv_id := COALESCE(NEW.invoice_id, OLD.invoice_id);

  SELECT COALESCE(SUM(amount), 0) INTO paid FROM payments WHERE invoice_id = inv_id;
  SELECT * INTO inv FROM invoices WHERE id = inv_id;

  UPDATE invoices
     SET amount_paid = paid,
         balance_due = GREATEST(inv.total - paid, 0),
         status = CASE
                    WHEN inv.status IN ('void','written_off','draft') THEN inv.status
                    WHEN paid >= inv.total AND inv.total > 0 THEN 'paid'
                    WHEN paid > 0 THEN 'partially_paid'
                    ELSE inv.status
                  END,
         paid_at = CASE WHEN paid >= inv.total AND inv.total > 0
                        THEN COALESCE(inv.paid_at, now()) ELSE inv.paid_at END
   WHERE id = inv_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_recalc ON payments;
CREATE TRIGGER trg_payment_recalc AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION recalc_invoice_balance();


-- ===========================================================================
-- 14. VIEWS - read models for the dashboard and queue screens
-- ===========================================================================

CREATE OR REPLACE VIEW v_waiting_queue AS
SELECT
  v.id                AS visit_id,
  v.visit_number,
  v.queue_number,
  v.priority,
  v.status,
  v.visit_type,
  v.chief_complaint,
  v.checked_in_at,
  v.estimated_wait_minutes,
  EXTRACT(EPOCH FROM (now() - v.checked_in_at))::int / 60 AS waiting_minutes,
  p.id                AS patient_id,
  p.mrn,
  p.first_name,
  p.last_name,
  p.first_name || ' ' || p.last_name AS patient_name,
  p.date_of_birth,
  d.id                AS doctor_id,
  d.full_name         AS doctor_name
FROM patient_visits v
JOIN patients p ON p.id = v.patient_id
LEFT JOIN staff d ON d.id = v.assigned_doctor_id
WHERE v.deleted_at IS NULL
  AND v.status IN ('waiting','being_seen');

CREATE OR REPLACE VIEW v_patient_summary AS
SELECT
  p.id,
  p.mrn,
  p.first_name,
  p.last_name,
  p.first_name || ' ' || p.last_name AS full_name,
  p.date_of_birth,
  CASE WHEN p.date_of_birth IS NULL THEN NULL
       ELSE EXTRACT(YEAR FROM age(p.date_of_birth))::int END AS age,
  p.gender,
  p.blood_type,
  p.phone_number,
  p.sl_avatar_name,
  p.created_at,
  (SELECT count(*) FROM patient_visits v
     WHERE v.patient_id = p.id AND v.deleted_at IS NULL) AS visit_count,
  (SELECT max(v.checked_in_at) FROM patient_visits v
     WHERE v.patient_id = p.id AND v.deleted_at IS NULL) AS last_visit_at,
  (SELECT count(*) FROM patient_allergies a
     WHERE a.patient_id = p.id AND a.deleted_at IS NULL) AS allergy_count
FROM patients p
WHERE p.deleted_at IS NULL;
