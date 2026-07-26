/**
 * Patient check-in (reception).
 *
 * Two paths through the same form: search for an existing patient, or register
 * a new one inline. Either way it ends with one POST to /api/visits/checkin so
 * the patient, contact, insurance and visit are created in one transaction.
 */
import { api } from '../api.js';
import {
  html, raw, render, on, readForm, toastOk, reportError, emptyState,
  fmtDate, statusBadge, esc, loadingState,
} from '../ui.js';

let selectedPatient = null;
let searchTimer = null;
let context = null;

const BLOOD_TYPES = ['unknown', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const GENDERS = [
  ['undisclosed', 'Prefer not to say'],
  ['female', 'Female'],
  ['male', 'Male'],
  ['non_binary', 'Non-binary'],
  ['other', 'Other'],
];

function view() {
  return html`
    <div class="grid grid--2">
      <div>
        <div class="card">
          <div class="card__head">
            <div>
              <div class="card__title">1 · Who is the patient?</div>
              <p class="card__sub">Search the record system, or register someone new.</p>
            </div>
          </div>
          <div class="card__body">
            <label class="field">
              <span class="field__label">Search existing patients</span>
              <input class="input" id="patient-search" placeholder="Name, MRN, phone or avatar name" autocomplete="off">
              <span class="field__hint">Start typing to search. Leave blank to register a new patient below.</span>
            </label>

            <div id="search-results"></div>
            <div id="selected-patient"></div>
          </div>
        </div>

        <div class="card" id="new-patient-card">
          <div class="card__head">
            <div class="card__title">New patient details</div>
            <button type="button" class="btn btn--sm btn--ghost" id="clear-selection" hidden>Register someone new instead</button>
          </div>
          <div class="card__body">
            <form id="patient-form">
              <div class="form-grid">
                <label class="field">
                  <span class="field__label">First name *</span>
                  <input class="input" name="first_name" required>
                </label>
                <label class="field">
                  <span class="field__label">Last name *</span>
                  <input class="input" name="last_name" required>
                </label>
                <label class="field">
                  <span class="field__label">Date of birth</span>
                  <input class="input" name="date_of_birth" type="date">
                </label>
                <label class="field">
                  <span class="field__label">Gender</span>
                  <select class="select" name="gender">
                    ${raw(GENDERS.map(([value, label]) => html`<option value="${value}">${label}</option>`).join(''))}
                  </select>
                </label>
                <label class="field">
                  <span class="field__label">Blood type</span>
                  <select class="select" name="blood_type">
                    ${raw(BLOOD_TYPES.map((t) => html`<option value="${t}">${t === 'unknown' ? 'Unknown' : t}</option>`).join(''))}
                  </select>
                </label>
                <label class="field">
                  <span class="field__label">Phone</span>
                  <input class="input" name="phone_number" placeholder="(555) 0100">
                </label>
                <label class="field">
                  <span class="field__label">SL avatar name</span>
                  <input class="input" name="sl_avatar_name" placeholder="Resident name">
                </label>
                <label class="field">
                  <span class="field__label">SL avatar key</span>
                  <input class="input mono" name="sl_avatar_key" placeholder="00000000-0000-0000-0000-000000000000">
                  <span class="field__hint">Lets in-world scanners find this record.</span>
                </label>
              </div>

              <fieldset class="fieldset">
                <legend>Emergency contact</legend>
                <div class="form-grid">
                  <label class="field">
                    <span class="field__label">Name</span>
                    <input class="input" name="emergency_contact_name">
                  </label>
                  <label class="field">
                    <span class="field__label">Phone</span>
                    <input class="input" name="emergency_contact_phone">
                  </label>
                </div>
              </fieldset>

              <fieldset class="fieldset">
                <legend>Insurance</legend>
                <div class="form-grid">
                  <label class="field">
                    <span class="field__label">Provider</span>
                    <input class="input" name="insurance_provider" list="provider-list" placeholder="Provider name">
                    <datalist id="provider-list"></datalist>
                  </label>
                  <label class="field">
                    <span class="field__label">Policy number</span>
                    <input class="input" name="insurance_number">
                  </label>
                </div>
              </fieldset>
            </form>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card__head">
            <div>
              <div class="card__title">2 · Visit details</div>
              <p class="card__sub">Queue number and check-in time are assigned automatically.</p>
            </div>
          </div>
          <div class="card__body">
            <form id="visit-form">
              <label class="field">
                <span class="field__label">Visit type *</span>
                <select class="select" name="visit_type" id="visit-type">
                  <option value="walk_in">Walk-in</option>
                  <option value="scheduled">Scheduled appointment</option>
                  <option value="emergency">Emergency</option>
                  <option value="follow_up">Follow-up</option>
                </select>
              </label>

              <label class="field">
                <span class="field__label">Triage priority *</span>
                <select class="select" name="priority" id="visit-priority">
                  <option value="normal">Normal</option>
                  <option value="urgent">Urgent</option>
                  <option value="emergency">Emergency</option>
                </select>
                <span class="field__hint">Emergency visits are pushed to the front of the queue.</span>
              </label>

              <label class="field">
                <span class="field__label">Reason for visit</span>
                <textarea class="textarea" name="chief_complaint" placeholder="In the patient's own words where possible"></textarea>
              </label>

              <label class="field">
                <span class="field__label">Assign to clinician</span>
                <select class="select" name="assigned_doctor_id" id="doctor-select">
                  <option value="">— Next available —</option>
                </select>
              </label>
            </form>

            <div id="checkin-error"></div>

            <button type="button" class="btn btn--primary btn--block mt-1" id="submit-checkin">
              Check in patient
            </button>
          </div>
        </div>

        <div class="card">
          <div class="card__head"><div class="card__title">Recent check-ins</div></div>
          <div class="card__body--flush" id="recent-checkins">
            ${raw(loadingState())}
          </div>
        </div>
      </div>
    </div>`;
}

async function loadReferenceData() {
  try {
    const [doctors, nurses, providers] = await Promise.all([
      api.get('/staff', { role: 'doctor', status: 'active', limit: 100 }),
      api.get('/staff', { role: 'nurse', status: 'active', limit: 100 }),
      api.get('/insurance/providers').catch(() => []),
    ]);

    const select = document.getElementById('doctor-select');
    if (select) {
      const options = [...doctors, ...nurses]
        .map((s) => html`<option value="${s.id}">${[s.display_title, s.full_name].filter(Boolean).join(' ')}${s.is_on_duty ? ' · on duty' : ''}</option>`)
        .join('');
      select.insertAdjacentHTML('beforeend', options);
    }

    const datalist = document.getElementById('provider-list');
    if (datalist) {
      datalist.innerHTML = providers.map((p) => html`<option value="${p.name}"></option>`).join('');
    }
  } catch {
    // Reference lists are conveniences; check-in still works without them.
  }
}

async function loadRecent() {
  const host = document.getElementById('recent-checkins');
  if (!host) return;

  try {
    const visits = await api.get('/visits', { limit: 8 });

    if (visits.length === 0) {
      render(host, emptyState('No visits yet today', 'Checked-in patients will be listed here.', '📋'));
      return;
    }

    render(host, html`
      <div class="table-wrap">
        <table class="table">
          <tbody>
            ${raw(visits.map((v) => html`
              <tr class="is-clickable priority-${v.priority}" data-href="/visits/${v.id}">
                <td style="width:44px"><strong>#${v.queue_number}</strong></td>
                <td>
                  <div class="row-title">${v.patient_name}</div>
                  <div class="row-sub">${v.mrn} · ${v.visit_number}</div>
                </td>
                <td class="text-right">${raw(statusBadge(v.status))}</td>
              </tr>`).join(''))}
          </tbody>
        </table>
      </div>`);
  } catch (err) {
    render(host, html`<div class="alert alert--error">${err.message}</div>`);
  }
}

function wireSearch(container) {
  const input = container.querySelector('#patient-search');
  const results = container.querySelector('#search-results');

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const term = input.value.trim();

    if (term.length < 2) {
      results.innerHTML = '';
      return;
    }

    // Debounced: the SL browser makes every keystroke-triggered request feel
    // expensive, and the search index does not need the pressure.
    searchTimer = setTimeout(async () => {
      try {
        const patients = await api.get('/patients', { search: term, limit: 6 });

        if (patients.length === 0) {
          render(results, html`<p class="muted" style="font-size:12.5px">No match. Fill in the details below to register a new patient.</p>`);
          return;
        }

        render(results, html`
          <div class="table-wrap mb-1">
            <table class="table">
              <tbody>
                ${raw(patients.map((p) => html`
                  <tr class="is-clickable" data-pick="${p.id}">
                    <td>
                      <div class="row-title">${p.full_name}</div>
                      <div class="row-sub">${p.mrn}${p.age !== null ? ` · ${p.age}y` : ''}${p.phone_number ? ` · ${p.phone_number}` : ''}</div>
                    </td>
                    <td class="text-right muted nowrap">${p.visit_count} visit(s)</td>
                  </tr>`).join(''))}
              </tbody>
            </table>
          </div>`);
      } catch (err) {
        render(results, html`<div class="alert alert--error">${err.message}</div>`);
      }
    }, 300);
  });

  on(container, 'click', '[data-pick]', async (_e, target) => {
    try {
      const patient = await api.get(`/patients/${target.dataset.pick}`);
      selectPatient(container, patient);
    } catch (err) {
      reportError(err);
    }
  });

  container.querySelector('#clear-selection').addEventListener('click', () => clearSelection(container));
}

function selectPatient(container, patient) {
  selectedPatient = patient;

  container.querySelector('#search-results').innerHTML = '';
  container.querySelector('#patient-search').value = '';
  container.querySelector('#new-patient-card').hidden = true;
  container.querySelector('#clear-selection').hidden = false;

  const allergies = (patient.allergies ?? []).filter((a) => ['severe', 'life_threatening'].includes(a.severity));

  render(container.querySelector('#selected-patient'), html`
    <div class="alert alert--ok">
      <strong>${patient.first_name} ${patient.last_name}</strong> · ${patient.mrn}
      ${patient.date_of_birth ? raw(html` · born ${fmtDate(patient.date_of_birth)}`) : ''}
      ${patient.blood_type && patient.blood_type !== 'unknown' ? raw(html` · ${patient.blood_type}`) : ''}
    </div>
    ${patient.active_visit
      ? raw(html`<div class="alert alert--warn">This patient already has an open visit (${patient.active_visit.visit_number}, queue #${patient.active_visit.queue_number}). Checking in again will be refused.</div>`)
      : ''}
    ${allergies.length > 0
      ? raw(html`<div class="alert alert--error">⚠ Severe allergies: ${allergies.map((a) => a.substance).join(', ')}</div>`)
      : ''}
    <button type="button" class="btn btn--sm btn--ghost" id="clear-selection-inline">Choose a different patient</button>
  `);

  container.querySelector('#clear-selection-inline').addEventListener('click', () => clearSelection(container));
}

function clearSelection(container) {
  selectedPatient = null;
  container.querySelector('#selected-patient').innerHTML = '';
  container.querySelector('#new-patient-card').hidden = false;
  container.querySelector('#clear-selection').hidden = true;
  container.querySelector('#patient-search').focus();
}

async function submit(container) {
  const button = container.querySelector('#submit-checkin');
  const errorBox = container.querySelector('#checkin-error');
  errorBox.innerHTML = '';

  const visitValues = readForm(container.querySelector('#visit-form'));

  const payload = {
    visit_type: visitValues.visit_type,
    priority: visitValues.priority,
    chief_complaint: visitValues.chief_complaint ?? null,
    assigned_doctor_id: visitValues.assigned_doctor_id ?? null,
  };

  if (selectedPatient) {
    payload.patient_id = selectedPatient.id;
  } else {
    const patientValues = readForm(container.querySelector('#patient-form'));

    if (!patientValues.first_name || !patientValues.last_name) {
      errorBox.innerHTML = html`<div class="alert alert--error">Enter the patient's first and last name, or pick an existing patient.</div>`;
      return;
    }

    payload.patient = {
      first_name: patientValues.first_name,
      last_name: patientValues.last_name,
      date_of_birth: patientValues.date_of_birth ?? null,
      gender: patientValues.gender ?? null,
      blood_type: patientValues.blood_type ?? null,
      phone_number: patientValues.phone_number ?? null,
      sl_avatar_name: patientValues.sl_avatar_name ?? null,
      sl_avatar_key: patientValues.sl_avatar_key ?? null,
      emergency_contact_name: patientValues.emergency_contact_name ?? null,
      emergency_contact_phone: patientValues.emergency_contact_phone ?? null,
      insurance_provider: patientValues.insurance_provider ?? null,
      insurance_number: patientValues.insurance_number ?? null,
    };
  }

  button.disabled = true;
  button.textContent = 'Checking in…';

  try {
    const visit = await api.post('/visits/checkin', payload);
    toastOk(`${visit.patient_name} checked in as queue #${visit.queue_number}.`);
    context.refreshBadges();
    context.navigate(`/visits/${visit.id}`);
  } catch (err) {
    errorBox.innerHTML = html`<div class="alert alert--error">${err.message}</div>`;
    reportError(err);
  } finally {
    button.disabled = false;
    button.textContent = 'Check in patient';
  }
}

export default {
  async render(container, ctx) {
    context = ctx;
    selectedPatient = null;
    ctx.setTitle('Patient Check-In', 'Reception');

    render(container, view());

    wireSearch(container);
    container.querySelector('#submit-checkin').addEventListener('click', () => submit(container));

    // Emergency visit type implies emergency triage; keep the two in step so
    // reception cannot accidentally queue a trauma as routine.
    const typeSelect = container.querySelector('#visit-type');
    const prioritySelect = container.querySelector('#visit-priority');
    typeSelect.addEventListener('change', () => {
      if (typeSelect.value === 'emergency') prioritySelect.value = 'emergency';
    });

    loadReferenceData();
    loadRecent();

    container.querySelector('#patient-search').focus();
  },

  destroy() {
    clearTimeout(searchTimer);
    selectedPatient = null;
  },
};
