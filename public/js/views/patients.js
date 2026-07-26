/**
 * Patient directory and the full electronic record.
 *
 * `#/patients`      searchable list
 * `#/patients/<id>` the complete chart, tabbed
 */
import { api } from '../api.js';
import { can } from '../store.js';
import {
  html, raw, render, on, readForm, emptyState, loadingState, paginationBar,
  statusBadge, fmtDate, fmtDateTime, fmtAgo, fmtMoney, fmtDuration, titleCase,
  toastOk, reportError, openModal, confirmDialog, esc, initials,
} from '../ui.js';

let context = null;
let searchTimer = null;
let listState = { page: 1, search: '' };
let chartTab = 'overview';

const BLOOD_TYPES = ['unknown', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const GENDERS = [
  ['undisclosed', 'Prefer not to say'], ['female', 'Female'], ['male', 'Male'],
  ['non_binary', 'Non-binary'], ['other', 'Other'],
];

// ===========================================================================
// List
// ===========================================================================

async function renderList(container) {
  render(container, html`
    <div class="toolbar">
      <input class="input" id="patient-search" placeholder="Search by name, MRN, phone or avatar name"
             value="${listState.search}" autocomplete="off">
      ${can('patients:write') ? raw('<button type="button" class="btn btn--primary" id="new-patient">New patient</button>') : ''}
    </div>
    <div class="card">
      <div class="card__body--flush" id="patient-list">${raw(loadingState())}</div>
    </div>`);

  const input = container.querySelector('#patient-search');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      listState = { page: 1, search: input.value.trim() };
      fetchList(container);
    }, 300);
  });

  const newBtn = container.querySelector('#new-patient');
  if (newBtn) newBtn.addEventListener('click', () => openNewPatient(container));

  on(container, 'click', '[data-patient]', (_e, target) => {
    context.navigate(`/patients/${target.dataset.patient}`);
  });

  await fetchList(container);

  // Deep link from the dashboard "New Patient" tile.
  if (context.query?.new === '1' && can('patients:write')) openNewPatient(container);
  input.focus();
}

async function fetchList(container) {
  const host = container.querySelector('#patient-list');
  if (!host) return;

  render(host, loadingState());

  try {
    const patients = await api.get('/patients', { page: listState.page, limit: 25, search: listState.search });

    if (patients.length === 0) {
      render(host, emptyState(
        listState.search ? 'No matching patients' : 'No patients registered yet',
        listState.search ? 'Try a different spelling, or the MRN.' : 'Register the first patient to get started.',
        '👤'
      ));
      return;
    }

    render(host, html`
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Patient</th>
              <th class="col-optional">MRN</th>
              <th class="col-optional">Age</th>
              <th class="col-optional">Blood</th>
              <th class="col-optional">Phone</th>
              <th>Visits</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            ${raw(patients.map((p) => html`
              <tr class="is-clickable" data-patient="${p.id}">
                <td>
                  <div class="row-title">
                    ${p.full_name}
                    ${p.allergy_count > 0 ? raw(html`<span class="badge badge--warn" title="${p.allergy_count} allergy record(s)">allergies</span>`) : ''}
                    ${p.is_deceased ? raw('<span class="badge">deceased</span>') : ''}
                  </div>
                  <div class="row-sub">${p.sl_avatar_name ?? ''}</div>
                </td>
                <td class="col-optional mono">${p.mrn}</td>
                <td class="col-optional">${p.age ?? '—'}</td>
                <td class="col-optional">${p.blood_type && p.blood_type !== 'unknown' ? p.blood_type : '—'}</td>
                <td class="col-optional">${p.phone_number ?? '—'}</td>
                <td class="num">${p.visit_count}</td>
                <td class="muted nowrap">${p.last_visit_at ? fmtAgo(p.last_visit_at) : 'never'}</td>
              </tr>`).join(''))}
          </tbody>
        </table>
      </div>
      ${raw(paginationBar(patients.pagination, (page) => {
        listState.page = page;
        fetchList(container);
      }))}`);
  } catch (err) {
    render(host, html`<div class="alert alert--error">${err.message}</div>`);
  }
}

function openNewPatient(container) {
  openModal({
    title: 'Register a new patient',
    wide: true,
    body: html`
      <form id="new-patient-form">
        <div class="form-grid">
          <label class="field"><span class="field__label">First name *</span><input class="input" name="first_name" required></label>
          <label class="field"><span class="field__label">Last name *</span><input class="input" name="last_name" required></label>
          <label class="field"><span class="field__label">Date of birth</span><input class="input" name="date_of_birth" type="date"></label>
          <label class="field">
            <span class="field__label">Gender</span>
            <select class="select" name="gender">${raw(GENDERS.map(([v, l]) => html`<option value="${v}">${l}</option>`).join(''))}</select>
          </label>
          <label class="field">
            <span class="field__label">Blood type</span>
            <select class="select" name="blood_type">${raw(BLOOD_TYPES.map((t) => html`<option value="${t}">${t === 'unknown' ? 'Unknown' : t}</option>`).join(''))}</select>
          </label>
          <label class="field"><span class="field__label">Phone</span><input class="input" name="phone_number"></label>
          <label class="field"><span class="field__label">Height (cm)</span><input class="input" name="height_cm" type="number" step="0.1" min="20" max="300"></label>
          <label class="field"><span class="field__label">Weight (kg)</span><input class="input" name="weight_kg" type="number" step="0.1" min="0.5" max="700"></label>
          <label class="field"><span class="field__label">SL avatar name</span><input class="input" name="sl_avatar_name"></label>
          <label class="field"><span class="field__label">SL avatar key</span><input class="input mono" name="sl_avatar_key" placeholder="UUID"></label>
        </div>
        <label class="field"><span class="field__label">Notes</span><textarea class="textarea" name="notes"></textarea></label>
      </form>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Register patient',
        class: 'btn--primary',
        onClick: async (root) => {
          const values = readForm(root.querySelector('#new-patient-form'));
          if (!values.first_name || !values.last_name) {
            reportError({ message: 'First and last name are required.' });
            return true;
          }
          const patient = await api.post('/patients', values);
          toastOk(`${patient.first_name} ${patient.last_name} registered as ${patient.mrn}.`);
          context.navigate(`/patients/${patient.id}`);
        },
      },
    ],
  });
}

// ===========================================================================
// Chart
// ===========================================================================

const TABS = [
  ['overview', 'Overview'],
  ['visits', 'Visit history'],
  ['vitals', 'Vitals'],
  ['medications', 'Medications'],
  ['results', 'Results'],
  ['billing', 'Billing'],
  ['documents', 'Documents'],
];

async function renderChart(container, patientId) {
  render(container, loadingState('Loading chart…'));

  let chart;
  try {
    chart = await api.get(`/patients/${patientId}/chart`);
  } catch (err) {
    render(container, html`<div class="alert alert--error">${err.message}</div>`);
    return;
  }

  const p = chart.patient;
  context.setTitle(`${p.first_name} ${p.last_name}`, `${p.mrn}${p.age !== null ? ` · ${p.age} years` : ''}`);

  const criticalAllergies = chart.allergies.filter((a) => ['severe', 'life_threatening'].includes(a.severity));

  render(container, html`
    ${criticalAllergies.length > 0 ? raw(html`
      <div class="alert alert--error">
        <strong>⚠ Allergy alert:</strong>
        ${criticalAllergies.map((a) => `${a.substance}${a.reaction ? ` (${a.reaction})` : ''}`).join(' · ')}
      </div>`) : ''}

    ${p.is_deceased ? raw('<div class="alert alert--warn">This patient is recorded as deceased.</div>') : ''}

    ${raw(renderHeader(chart))}

    <div class="toolbar mt-2">
      <div class="segmented">
        ${raw(TABS.map(([key, label]) => html`
          <button type="button" class="segmented__btn ${chartTab === key ? 'is-active' : ''}" data-tab="${key}">${label}</button>`).join(''))}
      </div>
    </div>

    <div id="chart-tab"></div>
  `);

  on(container, 'click', '[data-tab]', (_e, target) => {
    chartTab = target.dataset.tab;
    container.querySelectorAll('[data-tab]').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.tab === chartTab));
    renderTab(container, chart);
  });

  wireChartActions(container, chart);
  renderTab(container, chart);
}

function renderHeader(chart) {
  const p = chart.patient;
  const active = chart.visits.find((v) => ['waiting', 'being_seen'].includes(v.status));
  const latestVitals = chart.vitals[0];

  return html`
    <div class="card">
      <div class="card__body">
        <div class="flex flex-wrap" style="gap:16px;align-items:flex-start">
          <span class="who__avatar" style="width:52px;height:52px;font-size:16px">${initials(`${p.first_name} ${p.last_name}`)}</span>

          <div style="flex:1;min-width:220px">
            <h2 style="font-size:18px">${p.first_name} ${p.last_name}</h2>
            <div class="muted" style="font-size:12.5px">
              ${p.mrn}
              ${p.date_of_birth ? raw(html` · born ${fmtDate(p.date_of_birth)}`) : ''}
              ${p.gender ? raw(html` · ${titleCase(p.gender)}`) : ''}
              ${p.sl_avatar_name ? raw(html` · ${p.sl_avatar_name}`) : ''}
            </div>
            <div class="flex flex-wrap gap-sm mt-1">
              ${p.blood_type && p.blood_type !== 'unknown' ? raw(html`<span class="badge badge--danger">${p.blood_type}</span>`) : ''}
              ${chart.allergies.length > 0 ? raw(html`<span class="badge badge--warn">${chart.allergies.length} allerg${chart.allergies.length === 1 ? 'y' : 'ies'}</span>`) : ''}
              ${chart.conditions.filter((c) => c.status !== 'resolved').length > 0
                ? raw(html`<span class="badge badge--info">${chart.conditions.filter((c) => c.status !== 'resolved').length} condition(s)</span>`) : ''}
              ${active ? raw(html`<span class="badge badge--accent">Open visit ${active.visit_number}</span>`) : ''}
            </div>
          </div>

          <div class="btn-row">
            ${active ? raw(html`<a class="btn btn--primary btn--sm" href="#/visits/${active.id}">Open current visit</a>`) : ''}
            ${can('patients:write') ? raw('<button type="button" class="btn btn--ghost btn--sm" data-chart-act="edit">Edit details</button>') : ''}
            ${can('patients:write') ? raw('<button type="button" class="btn btn--ghost btn--sm" data-chart-act="allergy">Add allergy</button>') : ''}
            ${can('certificates:write') ? raw('<button type="button" class="btn btn--ghost btn--sm" data-chart-act="certificate">Issue certificate</button>') : ''}
          </div>
        </div>

        ${latestVitals ? raw(html`
          <div class="grid grid--stats mt-2">
            ${raw(vitalTile('Temp', latestVitals.temperature_c, '°C', latestVitals.flags?.temperature_c))}
            ${raw(vitalTile('BP', latestVitals.bp_systolic && latestVitals.bp_diastolic ? `${latestVitals.bp_systolic}/${latestVitals.bp_diastolic}` : null, 'mmHg', latestVitals.flags?.bp_systolic))}
            ${raw(vitalTile('Pulse', latestVitals.heart_rate, 'bpm', latestVitals.flags?.heart_rate))}
            ${raw(vitalTile('SpO₂', latestVitals.oxygen_saturation, '%', latestVitals.flags?.oxygen_saturation))}
            ${raw(vitalTile('BMI', latestVitals.bmi, '', latestVitals.flags?.bmi))}
          </div>
          <p class="muted mt-1 mb-0" style="font-size:11.5px">Vitals recorded ${fmtAgo(latestVitals.recorded_at)}</p>
        `) : ''}
      </div>
    </div>`;
}

function vitalTile(label, value, unit, flag) {
  const tone = flag === 'red' ? 'danger' : flag === 'yellow' ? 'warn' : flag === 'green' ? 'ok' : undefined;
  return html`
    <div class="stat ${tone ? `stat--${tone}` : ''}">
      <span class="stat__label">${label}</span>
      <span class="stat__value">${value ?? '—'}</span>
      ${unit && value !== null && value !== undefined ? raw(html`<span class="stat__meta">${unit}</span>`) : ''}
    </div>`;
}

function renderTab(container, chart) {
  const host = container.querySelector('#chart-tab');
  const renderers = {
    overview: overviewTab,
    visits: visitsTab,
    vitals: vitalsTab,
    medications: medicationsTab,
    results: resultsTab,
    billing: billingTab,
    documents: documentsTab,
  };
  render(host, renderers[chartTab](chart));
}

function overviewTab(chart) {
  const p = chart.patient;

  return html`
    <div class="grid grid--2">
      <div class="card">
        <div class="card__head"><div class="card__title">Demographics</div></div>
        <div class="card__body">
          <dl class="kv">
            <dt>Full name</dt><dd>${p.first_name} ${p.last_name}</dd>
            <dt>MRN</dt><dd class="mono">${p.mrn}</dd>
            <dt>Date of birth</dt><dd>${p.date_of_birth ? fmtDate(p.date_of_birth) : '—'}</dd>
            <dt>Age</dt><dd>${p.age ?? '—'}</dd>
            <dt>Gender</dt><dd>${p.gender ? titleCase(p.gender) : '—'}</dd>
            <dt>Blood type</dt><dd>${p.blood_type && p.blood_type !== 'unknown' ? p.blood_type : '—'}</dd>
            <dt>Height</dt><dd>${p.height_cm ? `${p.height_cm} cm` : '—'}</dd>
            <dt>Weight</dt><dd>${p.weight_kg ? `${p.weight_kg} kg` : '—'}</dd>
            <dt>Phone</dt><dd>${p.phone_number ?? '—'}</dd>
            <dt>SL avatar</dt><dd>${p.sl_avatar_name ?? '—'}</dd>
            <dt>Registered</dt><dd>${fmtDate(p.created_at)}</dd>
          </dl>
          ${p.notes ? raw(html`<div class="mt-2"><div class="field__label">Notes</div><div class="pre-wrap">${p.notes}</div></div>`) : ''}
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card__head">
            <div class="card__title">Allergies</div>
            ${can('patients:write') ? raw('<button type="button" class="btn btn--sm btn--ghost" data-chart-act="allergy">Add</button>') : ''}
          </div>
          <div class="card__body--flush">
            ${chart.allergies.length === 0
              ? raw(emptyState('No known allergies', '', '✓'))
              : raw(html`
                <div class="table-wrap"><table class="table"><tbody>
                  ${raw(chart.allergies.map((a) => html`
                    <tr>
                      <td>
                        <div class="row-title">${a.substance}</div>
                        ${a.reaction ? raw(html`<div class="row-sub">${a.reaction}</div>`) : ''}
                      </td>
                      <td class="text-right">${raw(statusBadge(a.severity))}</td>
                    </tr>`).join(''))}
                </tbody></table></div>`)}
          </div>
        </div>

        <div class="card">
          <div class="card__head">
            <div class="card__title">Chronic conditions</div>
            ${can('patients:write') ? raw('<button type="button" class="btn btn--sm btn--ghost" data-chart-act="condition">Add</button>') : ''}
          </div>
          <div class="card__body--flush">
            ${chart.conditions.length === 0
              ? raw(emptyState('None recorded', '', '✓'))
              : raw(html`
                <div class="table-wrap"><table class="table"><tbody>
                  ${raw(chart.conditions.map((c) => html`
                    <tr>
                      <td>
                        <div class="row-title">${c.condition}</div>
                        ${c.diagnosed_on ? raw(html`<div class="row-sub">since ${fmtDate(c.diagnosed_on)}</div>`) : ''}
                      </td>
                      <td class="text-right">${raw(statusBadge(c.status))}</td>
                    </tr>`).join(''))}
                </tbody></table></div>`)}
          </div>
        </div>

        <div class="card">
          <div class="card__head"><div class="card__title">Emergency contacts</div></div>
          <div class="card__body--flush">
            ${chart.emergency_contacts.length === 0
              ? raw(emptyState('None on file', '', '☎'))
              : raw(html`
                <div class="table-wrap"><table class="table"><tbody>
                  ${raw(chart.emergency_contacts.map((c) => html`
                    <tr>
                      <td>
                        <div class="row-title">${c.full_name}</div>
                        <div class="row-sub">${c.relationship ?? 'contact'}</div>
                      </td>
                      <td class="text-right">${c.phone_number ?? '—'}</td>
                    </tr>`).join(''))}
                </tbody></table></div>`)}
          </div>
        </div>

        <div class="card">
          <div class="card__head"><div class="card__title">Insurance</div></div>
          <div class="card__body--flush">
            ${chart.insurance.length === 0
              ? raw(emptyState('Self-pay', 'No insurance policy on file.', '💳'))
              : raw(html`
                <div class="table-wrap"><table class="table"><tbody>
                  ${raw(chart.insurance.map((i) => html`
                    <tr>
                      <td>
                        <div class="row-title">${i.provider_name ?? 'Provider not named'}</div>
                        <div class="row-sub mono">${i.policy_number}</div>
                      </td>
                      <td class="text-right">${raw(statusBadge(i.verification_status))}</td>
                    </tr>`).join(''))}
                </tbody></table></div>`)}
          </div>
        </div>
      </div>
    </div>`;
}

function visitsTab(chart) {
  if (chart.visits.length === 0) return emptyState('No visits recorded', 'This patient has not been seen yet.', '📋');

  return html`
    <div class="card">
      <div class="card__body--flush">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Date</th><th>Visit</th><th class="col-optional">Clinician</th>
                <th>Diagnosis</th><th class="col-optional">Rx / Labs</th>
                <th class="col-optional">Billed</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${raw(chart.visits.map((v) => html`
                <tr class="is-clickable priority-${v.priority}" data-href="/visits/${v.id}">
                  <td class="nowrap">${fmtDate(v.checked_in_at)}</td>
                  <td>
                    <div class="row-title mono">${v.visit_number}</div>
                    <div class="row-sub">${titleCase(v.visit_type)}${v.chief_complaint ? ` · ${v.chief_complaint.slice(0, 40)}` : ''}</div>
                  </td>
                  <td class="col-optional">${v.doctor_name ?? '—'}</td>
                  <td>${v.diagnoses ?? raw('<span class="muted">—</span>')}</td>
                  <td class="col-optional muted nowrap">${v.prescription_count} / ${v.lab_count}</td>
                  <td class="col-optional num">${v.billed_total ? fmtMoney(v.billed_total) : '—'}</td>
                  <td>${raw(statusBadge(v.status))}</td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function vitalsTab(chart) {
  if (chart.vitals.length === 0) return emptyState('No vitals recorded', 'Vitals taken during a visit appear here.', '📈');

  // Oldest first reads better as a history.
  const series = [...chart.vitals].reverse();

  const trend = (field, label, unit) => {
    const values = series.map((v) => Number(v[field])).filter((n) => Number.isFinite(n));
    if (values.length === 0) return '';

    const max = Math.max(...values);
    const min = Math.min(...values);
    const range = max - min || 1;

    const bars = series
      .map((v) => {
        const n = Number(v[field]);
        if (!Number.isFinite(n)) return '<span class="trend__bar" style="height:2px;opacity:.3"></span>';
        const height = 12 + ((n - min) / range) * 34;
        const flag = v.flags?.[field];
        const cls = flag === 'red' ? ' trend__bar--red' : flag === 'yellow' ? ' trend__bar--yellow' : '';
        return `<span class="trend__bar${cls}" style="height:${height.toFixed(0)}px" title="${esc(String(n))} ${esc(unit)}"></span>`;
      })
      .join('');

    const latest = values[values.length - 1];
    return html`
      <div class="card">
        <div class="card__head">
          <div class="card__title">${label}</div>
          <span class="mono">${latest} ${unit}</span>
        </div>
        <div class="card__body">
          <div class="trend">${raw(bars)}</div>
          <p class="muted mt-1 mb-0" style="font-size:11px">${values.length} reading(s) · range ${min}–${max} ${unit}</p>
        </div>
      </div>`;
  };

  return html`
    <div class="grid grid--3 mb-2">
      ${raw(trend('temperature_c', 'Temperature', '°C'))}
      ${raw(trend('bp_systolic', 'Systolic BP', 'mmHg'))}
      ${raw(trend('heart_rate', 'Heart rate', 'bpm'))}
      ${raw(trend('oxygen_saturation', 'Oxygen saturation', '%'))}
      ${raw(trend('blood_sugar_mgdl', 'Blood sugar', 'mg/dL'))}
      ${raw(trend('bmi', 'BMI', ''))}
    </div>

    <div class="card">
      <div class="card__head"><div class="card__title">All readings</div></div>
      <div class="card__body--flush">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>When</th><th>Temp</th><th>BP</th><th>HR</th>
                <th class="col-optional">RR</th><th>SpO₂</th>
                <th class="col-optional">Glucose</th><th class="col-optional">BMI</th>
                <th class="col-optional">By</th>
              </tr>
            </thead>
            <tbody>
              ${raw(chart.vitals.map((v) => html`
                <tr>
                  <td class="nowrap muted">${fmtDateTime(v.recorded_at)}</td>
                  <td class="vital ${v.flags?.temperature_c ? `vital--${v.flags.temperature_c}` : ''}">${v.temperature_c ?? '—'}</td>
                  <td class="vital ${v.flags?.bp_systolic ? `vital--${v.flags.bp_systolic}` : ''}">${v.bp_systolic && v.bp_diastolic ? `${v.bp_systolic}/${v.bp_diastolic}` : '—'}</td>
                  <td class="vital ${v.flags?.heart_rate ? `vital--${v.flags.heart_rate}` : ''}">${v.heart_rate ?? '—'}</td>
                  <td class="col-optional vital">${v.respiratory_rate ?? '—'}</td>
                  <td class="vital ${v.flags?.oxygen_saturation ? `vital--${v.flags.oxygen_saturation}` : ''}">${v.oxygen_saturation ?? '—'}</td>
                  <td class="col-optional vital">${v.blood_sugar_mgdl ?? '—'}</td>
                  <td class="col-optional vital">${v.bmi ?? '—'}</td>
                  <td class="col-optional muted">${v.recorded_by_name ?? '—'}</td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function medicationsTab(chart) {
  if (chart.prescriptions.length === 0) return emptyState('No prescriptions', 'Medications prescribed during a visit appear here.', '💊');

  return html`
    <div class="card">
      <div class="card__body--flush">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr><th>Date</th><th>Medication</th><th>Directions</th><th class="col-optional">Prescriber</th><th>Status</th></tr>
            </thead>
            <tbody>
              ${raw(chart.prescriptions.map((rx) => html`
                <tr>
                  <td class="nowrap muted">${fmtDate(rx.prescribed_at)}</td>
                  <td><div class="row-title">${rx.medication_name}</div><div class="row-sub">Qty ${rx.quantity}${rx.refills > 0 ? ` · ${rx.refills} refill(s)` : ''}</div></td>
                  <td>${rx.dosage}, ${rx.frequency}${rx.duration ? ` for ${rx.duration}` : ''}</td>
                  <td class="col-optional muted">${rx.prescriber_name ?? '—'}</td>
                  <td>${raw(statusBadge(rx.status))}</td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function resultsTab(chart) {
  const hasLabs = chart.laboratory.length > 0;
  const hasImaging = chart.radiology.length > 0;

  if (!hasLabs && !hasImaging) return emptyState('No results', 'Laboratory and imaging results appear here.', '🧪');

  return html`
    ${hasLabs ? raw(html`
      <div class="card">
        <div class="card__head"><div class="card__title">Laboratory</div></div>
        <div class="card__body--flush">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Date</th><th>Test</th><th>Result</th><th class="col-optional">Ordered by</th><th>Status</th></tr></thead>
              <tbody>
                ${raw(chart.laboratory.map((order) => {
                  const results = order.results ?? [];
                  const summary = results.length > 0
                    ? results.map((r) => `${r.result_value}${r.unit ? ` ${r.unit}` : ''}`).join(', ')
                    : '—';
                  const worstFlag = results.reduce((worst, r) =>
                    r.flag === 'critical' ? 'critical' : worst === 'critical' ? worst : r.flag !== 'normal' ? r.flag : worst, 'normal');

                  return html`
                    <tr>
                      <td class="nowrap muted">${fmtDate(order.ordered_at)}</td>
                      <td class="row-title">${order.test_name}</td>
                      <td>
                        <span class="${worstFlag === 'critical' ? 'vital vital--red' : worstFlag !== 'normal' ? 'vital vital--yellow' : ''}">${summary}</span>
                        ${results.length > 0 && worstFlag !== 'normal' ? raw(html` ${statusBadge(worstFlag)}`) : ''}
                      </td>
                      <td class="col-optional muted">${order.ordered_by_name ?? '—'}</td>
                      <td>${raw(statusBadge(order.status))}</td>
                    </tr>`;
                }).join(''))}
              </tbody>
            </table>
          </div>
        </div>
      </div>`) : ''}

    ${hasImaging ? raw(html`
      <div class="card">
        <div class="card__head"><div class="card__title">Imaging</div></div>
        <div class="card__body--flush">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Date</th><th>Study</th><th>Impression</th><th>Status</th></tr></thead>
              <tbody>
                ${raw(chart.radiology.map((study) => html`
                  <tr>
                    <td class="nowrap muted">${fmtDate(study.ordered_at)}</td>
                    <td>
                      <div class="row-title">${study.study_name}</div>
                      <div class="row-sub">${study.modality.toUpperCase()}${study.body_part ? ` · ${study.body_part}` : ''}</div>
                    </td>
                    <td>${study.impression ?? raw('<span class="muted">Awaiting interpretation</span>')}</td>
                    <td>${raw(statusBadge(study.status))}</td>
                  </tr>`).join(''))}
              </tbody>
            </table>
          </div>
        </div>
      </div>`) : ''}

    ${chart.surgeries.length > 0 ? raw(html`
      <div class="card">
        <div class="card__head"><div class="card__title">Surgical history</div></div>
        <div class="card__body--flush">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Date</th><th>Procedure</th><th class="col-optional">Surgeon</th><th>Outcome</th></tr></thead>
              <tbody>
                ${raw(chart.surgeries.map((s) => html`
                  <tr>
                    <td class="nowrap muted">${fmtDate(s.start_time ?? s.scheduled_at)}</td>
                    <td class="row-title">${s.procedure_name}</td>
                    <td class="col-optional muted">${s.surgeon_name ?? '—'}</td>
                    <td>${raw(s.outcome ? statusBadge(s.outcome) : statusBadge(s.status))}</td>
                  </tr>`).join(''))}
              </tbody>
            </table>
          </div>
        </div>
      </div>`) : ''}`;
}

function billingTab(chart) {
  if (chart.invoices.length === 0) return emptyState('No invoices', 'Charges raised for this patient appear here.', '🧾');

  const outstanding = chart.invoices.reduce((sum, i) => sum + Number(i.balance_due ?? 0), 0);

  return html`
    ${outstanding > 0 ? raw(html`<div class="alert alert--warn">Outstanding balance: <strong>${fmtMoney(outstanding)}</strong></div>`) : ''}
    <div class="card">
      <div class="card__body--flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Date</th><th>Invoice</th><th class="col-optional">Type</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead>
            <tbody>
              ${raw(chart.invoices.map((i) => html`
                <tr class="is-clickable" data-href="/billing/${i.id}">
                  <td class="nowrap muted">${fmtDate(i.created_at)}</td>
                  <td class="mono">${i.invoice_number}</td>
                  <td class="col-optional">${titleCase(i.billing_type)}</td>
                  <td class="num">${fmtMoney(i.total)}</td>
                  <td class="num">${fmtMoney(i.amount_paid)}</td>
                  <td class="num">${fmtMoney(i.balance_due)}</td>
                  <td>${raw(statusBadge(i.status))}</td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function documentsTab(chart) {
  if (chart.certificates.length === 0) {
    return html`
      ${raw(emptyState('No documents', 'Certificates and letters issued to this patient appear here.', '📄'))}
      ${can('certificates:write') ? raw('<div class="text-center"><button type="button" class="btn btn--primary" data-chart-act="certificate">Issue a certificate</button></div>') : ''}`;
  }

  return html`
    <div class="card">
      <div class="card__head">
        <div class="card__title">Issued documents</div>
        ${can('certificates:write') ? raw('<button type="button" class="btn btn--sm btn--primary" data-chart-act="certificate">New certificate</button>') : ''}
      </div>
      <div class="card__body--flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Issued</th><th>Document</th><th class="col-optional">Valid</th><th></th></tr></thead>
            <tbody>
              ${raw(chart.certificates.map((c) => html`
                <tr>
                  <td class="nowrap muted">${fmtDate(c.issued_at)}</td>
                  <td>
                    <div class="row-title">${c.title}</div>
                    <div class="row-sub mono">${c.certificate_number}</div>
                  </td>
                  <td class="col-optional muted nowrap">
                    ${c.valid_from ? fmtDate(c.valid_from) : '—'} → ${c.valid_until ? fmtDate(c.valid_until) : '—'}
                  </td>
                  <td class="text-right">
                    ${c.public_token
                      ? raw(html`<a class="btn btn--sm btn--ghost" href="/print.html?token=${encodeURIComponent(c.public_token)}" target="_blank" rel="noopener">Print</a>`)
                      : raw('<span class="muted">revoked</span>')}
                  </td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function wireChartActions(container, chart) {
  on(container, 'click', '[data-chart-act]', async (_e, target) => {
    const action = target.dataset.chartAct;
    const patientId = chart.patient.id;

    try {
      if (action === 'edit') return editPatient(container, chart.patient);
      if (action === 'allergy') return addAllergy(container, patientId);
      if (action === 'condition') return addCondition(container, patientId);
      if (action === 'certificate') return issueCertificate(container, chart);
    } catch (err) {
      reportError(err);
    }
  });
}

function editPatient(container, patient) {
  openModal({
    title: 'Edit patient details',
    wide: true,
    body: html`
      <form id="edit-patient-form">
        <div class="form-grid">
          <label class="field"><span class="field__label">First name</span><input class="input" name="first_name" value="${patient.first_name}"></label>
          <label class="field"><span class="field__label">Last name</span><input class="input" name="last_name" value="${patient.last_name}"></label>
          <label class="field"><span class="field__label">Date of birth</span><input class="input" name="date_of_birth" type="date" value="${patient.date_of_birth ?? ''}"></label>
          <label class="field">
            <span class="field__label">Gender</span>
            <select class="select" name="gender">
              ${raw(GENDERS.map(([v, l]) => html`<option value="${v}" ${patient.gender === v ? 'selected' : ''}>${l}</option>`).join(''))}
            </select>
          </label>
          <label class="field">
            <span class="field__label">Blood type</span>
            <select class="select" name="blood_type">
              ${raw(BLOOD_TYPES.map((t) => html`<option value="${t}" ${patient.blood_type === t ? 'selected' : ''}>${t === 'unknown' ? 'Unknown' : t}</option>`).join(''))}
            </select>
          </label>
          <label class="field"><span class="field__label">Phone</span><input class="input" name="phone_number" value="${patient.phone_number ?? ''}"></label>
          <label class="field"><span class="field__label">Height (cm)</span><input class="input" name="height_cm" type="number" step="0.1" value="${patient.height_cm ?? ''}"></label>
          <label class="field"><span class="field__label">Weight (kg)</span><input class="input" name="weight_kg" type="number" step="0.1" value="${patient.weight_kg ?? ''}"></label>
          <label class="field"><span class="field__label">SL avatar name</span><input class="input" name="sl_avatar_name" value="${patient.sl_avatar_name ?? ''}"></label>
          <label class="field"><span class="field__label">SL avatar key</span><input class="input mono" name="sl_avatar_key" value="${patient.sl_avatar_key ?? ''}"></label>
        </div>
        <label class="field"><span class="field__label">Notes</span><textarea class="textarea" name="notes">${patient.notes ?? ''}</textarea></label>
      </form>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Save changes',
        class: 'btn--primary',
        onClick: async (root) => {
          await api.patch(`/patients/${patient.id}`, readForm(root.querySelector('#edit-patient-form')));
          toastOk('Patient record updated.');
          renderChart(container, patient.id);
        },
      },
    ],
  });
}

function addAllergy(container, patientId) {
  openModal({
    title: 'Record an allergy',
    body: html`
      <form id="allergy-form">
        <label class="field"><span class="field__label">Substance *</span><input class="input" name="substance" required placeholder="e.g. Penicillin"></label>
        <label class="field"><span class="field__label">Reaction</span><input class="input" name="reaction" placeholder="e.g. Hives and swelling"></label>
        <label class="field">
          <span class="field__label">Severity</span>
          <select class="select" name="severity">
            <option value="mild">Mild</option>
            <option value="moderate" selected>Moderate</option>
            <option value="severe">Severe</option>
            <option value="life_threatening">Life-threatening</option>
          </select>
        </label>
      </form>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Add allergy',
        class: 'btn--primary',
        onClick: async (root) => {
          const values = readForm(root.querySelector('#allergy-form'));
          if (!values.substance) { reportError({ message: 'Enter the substance.' }); return true; }
          await api.post(`/patients/${patientId}/allergies`, values);
          toastOk('Allergy recorded.');
          renderChart(container, patientId);
        },
      },
    ],
  });
}

function addCondition(container, patientId) {
  openModal({
    title: 'Record a chronic condition',
    body: html`
      <form id="condition-form">
        <label class="field"><span class="field__label">Condition *</span><input class="input" name="condition" required placeholder="e.g. Type 2 diabetes"></label>
        <label class="field"><span class="field__label">Diagnosed on</span><input class="input" name="diagnosed_on" type="date"></label>
        <label class="field">
          <span class="field__label">Status</span>
          <select class="select" name="status">
            <option value="active" selected>Active</option>
            <option value="chronic">Chronic</option>
            <option value="in_remission">In remission</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>
        <label class="field"><span class="field__label">Notes</span><textarea class="textarea" name="notes"></textarea></label>
      </form>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Add condition',
        class: 'btn--primary',
        onClick: async (root) => {
          const values = readForm(root.querySelector('#condition-form'));
          if (!values.condition) { reportError({ message: 'Enter the condition.' }); return true; }
          await api.post(`/patients/${patientId}/conditions`, values);
          toastOk('Condition recorded.');
          renderChart(container, patientId);
        },
      },
    ],
  });
}

async function issueCertificate(container, chart) {
  const templates = await api.get('/certificates/templates');
  const patientId = chart.patient.id;
  const latestVisit = chart.visits[0];

  const renderFields = (template) => template.placeholders
    .map((name) => html`
      <label class="field">
        <span class="field__label">${titleCase(name)}</span>
        <input class="input" name="${name}">
      </label>`)
    .join('') || '<p class="muted">This template has no extra fields.</p>';

  openModal({
    title: 'Issue a medical certificate',
    wide: true,
    body: html`
      <label class="field">
        <span class="field__label">Template</span>
        <select class="select" id="cert-template">
          ${raw(templates.map((t) => html`<option value="${t.key}">${t.label}</option>`).join(''))}
        </select>
      </label>
      <div class="form-grid">
        <label class="field"><span class="field__label">Valid from</span><input class="input" id="cert-from" type="date"></label>
        <label class="field"><span class="field__label">Valid until</span><input class="input" id="cert-until" type="date"></label>
      </div>
      <form id="cert-fields">${raw(renderFields(templates[0]))}</form>`,
    onMount(root) {
      root.querySelector('#cert-template').addEventListener('change', (e) => {
        const template = templates.find((t) => t.key === e.target.value);
        root.querySelector('#cert-fields').innerHTML = renderFields(template);
      });
    },
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Issue certificate',
        class: 'btn--primary',
        onClick: async (root) => {
          const certificate = await api.post('/certificates', {
            patient_id: patientId,
            visit_id: latestVisit?.id ?? null,
            template: root.querySelector('#cert-template').value,
            fields: readForm(root.querySelector('#cert-fields')),
            valid_from: root.querySelector('#cert-from').value || null,
            valid_until: root.querySelector('#cert-until').value || null,
          });

          toastOk('Certificate issued.');
          if (certificate.public_url) window.open(certificate.public_url, '_blank', 'noopener');
          renderChart(container, patientId);
        },
      },
    ],
  });
}

// ===========================================================================

export default {
  async render(container, ctx) {
    context = ctx;

    if (ctx.id) {
      chartTab = ctx.query?.tab && TABS.some(([key]) => key === ctx.query.tab) ? ctx.query.tab : 'overview';
      await renderChart(container, ctx.id);
    } else {
      ctx.setTitle('Patients', 'Patient directory');
      listState = { page: 1, search: '' };
      await renderList(container);
    }
  },

  destroy() {
    clearTimeout(searchTimer);
  },
};
