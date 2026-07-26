/**
 * The visit / encounter screen.
 *
 * Everything a clinician does during a consultation lives here, split into
 * tabs that map onto the sections of a real note: vitals, symptoms,
 * examination, diagnosis, plan, prescriptions, orders, notes, discharge.
 */
import { api } from '../api.js';
import { can } from '../store.js';
import {
  html, raw, render, on, readForm, emptyState, loadingState, statusBadge,
  fmtDate, fmtDateTime, fmtTime, fmtDuration, fmtAgo, titleCase, esc,
  toastOk, toastWarn, reportError, openModal, closeModal, confirmDialog,
} from '../ui.js';

let context = null;
let visitId = null;
let data = null;
let activeTab = 'overview';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'vitals', label: 'Vitals', permission: 'vitals:read' },
  { key: 'symptoms', label: 'Symptoms', permission: 'records:read' },
  { key: 'exam', label: 'Examination', permission: 'records:read' },
  { key: 'diagnosis', label: 'Diagnosis', permission: 'records:read' },
  { key: 'plan', label: 'Treatment', permission: 'records:read' },
  { key: 'prescriptions', label: 'Prescriptions', permission: 'prescriptions:read' },
  { key: 'orders', label: 'Orders', permission: 'lab:read' },
  { key: 'notes', label: 'Notes', permission: 'records:read' },
  { key: 'discharge', label: 'Discharge', permission: 'discharge:write' },
];

const EXAM_SECTIONS = [
  ['general_appearance', 'General appearance'],
  ['heent', 'HEENT'],
  ['cardiovascular', 'Cardiovascular'],
  ['respiratory', 'Respiratory'],
  ['abdomen', 'Abdomen'],
  ['neurological', 'Neurological'],
  ['skin', 'Skin'],
  ['musculoskeletal', 'Musculoskeletal'],
];

async function load(container) {
  render(container, loadingState('Loading encounter…'));

  try {
    data = await api.get(`/visits/${visitId}`);
  } catch (err) {
    render(container, html`<div class="alert alert--error">${err.message}</div>`);
    return;
  }

  const v = data.visit;
  context.setTitle(v.patient_name, `${v.visit_number} · ${titleCase(v.visit_type)} · checked in ${fmtTime(v.checked_in_at)}`);

  const tabs = TABS.filter((t) => !t.permission || can(t.permission));
  if (!tabs.some((t) => t.key === activeTab)) activeTab = 'overview';

  const criticalAllergies = data.allergies.filter((a) => ['severe', 'life_threatening'].includes(a.severity));

  render(container, html`
    ${criticalAllergies.length > 0 ? raw(html`
      <div class="alert alert--error">
        <strong>⚠ Allergy alert:</strong>
        ${criticalAllergies.map((a) => `${a.substance}${a.reaction ? ` (${a.reaction})` : ''}`).join(' · ')}
      </div>`) : ''}

    ${raw(renderHeader())}

    <div class="toolbar mt-2">
      <div class="segmented">
        ${raw(tabs.map((t) => html`
          <button type="button" class="segmented__btn ${activeTab === t.key ? 'is-active' : ''}" data-tab="${t.key}">${t.label}</button>`).join(''))}
      </div>
    </div>

    <div id="visit-tab"></div>
  `);

  on(container, 'click', '[data-tab]', (_e, target) => {
    activeTab = target.dataset.tab;
    container.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === activeTab));
    renderTab(container);
  });

  wireHeaderActions(container);
  renderTab(container);
}

// --- Header ---------------------------------------------------------------

function renderHeader() {
  const v = data.visit;
  const latest = data.vitals[0];
  const canEdit = can('visits:write');
  const isOpen = ['waiting', 'being_seen'].includes(v.status);

  return html`
    <div class="card">
      <div class="card__body">
        <div class="flex flex-wrap flex-between" style="align-items:flex-start;gap:14px">
          <div style="min-width:220px">
            <h2 style="font-size:17px">
              <a href="#/patients/${v.patient_id}">${v.patient_name}</a>
            </h2>
            <div class="muted" style="font-size:12.5px">
              ${v.mrn}
              ${v.patient_age !== null && v.patient_age !== undefined ? raw(html` · ${v.patient_age}y`) : ''}
              ${v.gender ? raw(html` · ${titleCase(v.gender)}`) : ''}
              ${v.blood_type && v.blood_type !== 'unknown' ? raw(html` · <strong>${v.blood_type}</strong>`) : ''}
            </div>
            <div class="flex flex-wrap gap-sm mt-1">
              ${raw(statusBadge(v.status))}
              ${raw(v.priority === 'normal' ? '' : statusBadge(v.priority))}
              <span class="badge">Queue #${v.queue_number}</span>
              ${v.doctor_name ? raw(html`<span class="badge badge--accent">${v.doctor_name}</span>`) : raw('<span class="badge">Unassigned</span>')}
            </div>
          </div>

          <div class="btn-row">
            ${canEdit && v.status === 'waiting' ? raw('<button type="button" class="btn btn--sm btn--primary" data-visit-act="see">Start consultation</button>') : ''}
            ${canEdit && isOpen ? raw('<button type="button" class="btn btn--sm btn--ghost" data-visit-act="assign">Assign clinician</button>') : ''}
            ${canEdit && isOpen ? raw('<button type="button" class="btn btn--sm btn--ghost" data-visit-act="priority">Triage</button>') : ''}
            ${can('discharge:write') && isOpen ? raw('<button type="button" class="btn btn--sm btn--ok" data-visit-act="discharge">Discharge</button>') : ''}
          </div>
        </div>

        ${v.chief_complaint ? raw(html`
          <div class="mt-2">
            <div class="field__label">Chief complaint</div>
            <div class="pre-wrap">${v.chief_complaint}</div>
          </div>`) : ''}

        ${latest ? raw(html`
          <div class="grid grid--stats mt-2">
            ${raw(vitalTile('Temp', latest.temperature_c, '°C', latest.flags?.temperature_c))}
            ${raw(vitalTile('BP', latest.bp_systolic && latest.bp_diastolic ? `${latest.bp_systolic}/${latest.bp_diastolic}` : null, 'mmHg', latest.flags?.bp_systolic))}
            ${raw(vitalTile('Pulse', latest.heart_rate, 'bpm', latest.flags?.heart_rate))}
            ${raw(vitalTile('Resp', latest.respiratory_rate, '/min', latest.flags?.respiratory_rate))}
            ${raw(vitalTile('SpO₂', latest.oxygen_saturation, '%', latest.flags?.oxygen_saturation))}
            ${raw(vitalTile('Pain', v.pain_scale ?? latest.pain_scale, '/10', null))}
          </div>`) : ''}
      </div>
    </div>`;
}

function vitalTile(label, value, unit, flag) {
  const tone = flag === 'red' ? 'danger' : flag === 'yellow' ? 'warn' : flag === 'green' ? 'ok' : undefined;
  return html`
    <div class="stat ${tone ? `stat--${tone}` : ''}">
      <span class="stat__label">${label}</span>
      <span class="stat__value">${value ?? '—'}</span>
      ${value !== null && value !== undefined && unit ? raw(html`<span class="stat__meta">${unit}</span>`) : ''}
    </div>`;
}

// --- Tabs -----------------------------------------------------------------

function renderTab(container) {
  const host = container.querySelector('#visit-tab');
  const renderers = {
    overview: overviewTab, vitals: vitalsTab, symptoms: symptomsTab,
    exam: examTab, diagnosis: diagnosisTab, plan: planTab,
    prescriptions: prescriptionsTab, orders: ordersTab, notes: notesTab,
    discharge: dischargeTab,
  };

  render(host, renderers[activeTab](container));
  wireTab(container);
}

function overviewTab() {
  const v = data.visit;

  const timeline = [
    { at: v.checked_in_at, title: 'Checked in', detail: `by ${v.checked_in_by_name ?? 'reception'}` },
    v.called_at && { at: v.called_at, title: 'Called from the waiting room' },
    v.seen_at && { at: v.seen_at, title: 'Consultation started', detail: v.doctor_name ?? '' },
    ...data.vitals.map((x) => ({ at: x.recorded_at, title: 'Vitals recorded', detail: x.recorded_by_name ?? '' })),
    ...data.diagnoses.map((d) => ({ at: d.diagnosed_at, title: `Diagnosis: ${d.diagnosis_name ?? d.custom_name}`, detail: d.diagnosed_by_name ?? '' })),
    ...data.prescriptions.map((rx) => ({ at: rx.prescribed_at, title: `Prescribed ${rx.medication_name}`, detail: rx.prescriber_name ?? '' })),
    ...data.laboratory.map((lo) => ({ at: lo.ordered_at, title: `Lab ordered: ${lo.test_name}`, detail: lo.ordered_by_name ?? '' })),
    ...data.radiology.map((ro) => ({ at: ro.ordered_at, title: `Imaging ordered: ${ro.study_name}`, detail: ro.ordered_by_name ?? '' })),
    v.completed_at && { at: v.completed_at, title: 'Visit completed' },
    v.discharged_at && { at: v.discharged_at, title: `Discharged (${titleCase(v.disposition ?? '')})` },
  ]
    .filter(Boolean)
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  const primaryDx = data.diagnoses.find((d) => d.is_primary) ?? data.diagnoses[0];

  return html`
    <div class="grid grid--2">
      <div class="card">
        <div class="card__head"><div class="card__title">Encounter summary</div></div>
        <div class="card__body">
          <dl class="kv">
            <dt>Visit number</dt><dd class="mono">${v.visit_number}</dd>
            <dt>Type</dt><dd>${titleCase(v.visit_type)}</dd>
            <dt>Priority</dt><dd>${titleCase(v.priority)}</dd>
            <dt>Checked in</dt><dd>${fmtDateTime(v.checked_in_at)}</dd>
            <dt>Seen at</dt><dd>${v.seen_at ? fmtDateTime(v.seen_at) : 'not yet'}</dd>
            <dt>Wait</dt><dd>${v.seen_at ? fmtDuration((new Date(v.seen_at) - new Date(v.checked_in_at)) / 60000) : fmtDuration((Date.now() - new Date(v.checked_in_at)) / 60000) + ' (ongoing)'}</dd>
            <dt>Clinician</dt><dd>${v.doctor_name ?? '—'}</dd>
            <dt>Nurse</dt><dd>${v.nurse_name ?? '—'}</dd>
            <dt>Primary diagnosis</dt><dd>${primaryDx ? (primaryDx.diagnosis_name ?? primaryDx.custom_name) : '—'}</dd>
            <dt>Disposition</dt><dd>${v.disposition ? titleCase(v.disposition) : '—'}</dd>
          </dl>

          ${data.invoice ? raw(html`
            <div class="alert alert--info mt-2 mb-0">
              Invoice <a href="#/billing/${data.invoice.id}">${data.invoice.invoice_number}</a> —
              ${titleCase(data.invoice.status)}, balance ${data.invoice.balance_due}
            </div>`) : ''}
        </div>
      </div>

      <div class="card">
        <div class="card__head"><div class="card__title">Timeline</div></div>
        <div class="card__body">
          ${timeline.length === 0
            ? raw(emptyState('Nothing recorded yet', '', '·'))
            : raw(html`
              <div class="timeline">
                ${raw(timeline.map((item) => html`
                  <div class="timeline__item">
                    <div class="timeline__time">${fmtDateTime(item.at)}</div>
                    <div class="timeline__title">${item.title}</div>
                    ${item.detail ? raw(html`<div class="muted" style="font-size:12px">${item.detail}</div>`) : ''}
                  </div>`).join(''))}
              </div>`)}
        </div>
      </div>
    </div>`;
}

function vitalsTab() {
  const canWrite = can('vitals:write') && ['waiting', 'being_seen'].includes(data.visit.status);

  return html`
    ${canWrite ? raw(html`
      <div class="card">
        <div class="card__head"><div class="card__title">Record vitals</div></div>
        <div class="card__body">
          <form id="vitals-form">
            <div class="form-grid form-grid--3">
              <label class="field"><span class="field__label">Temperature (°C)</span><input class="input" name="temperature_c" type="number" step="0.1" min="20" max="46" placeholder="36.8"></label>
              <label class="field"><span class="field__label">Systolic (mmHg)</span><input class="input" name="bp_systolic" type="number" min="40" max="300" placeholder="120"></label>
              <label class="field"><span class="field__label">Diastolic (mmHg)</span><input class="input" name="bp_diastolic" type="number" min="20" max="200" placeholder="80"></label>
              <label class="field"><span class="field__label">Heart rate (bpm)</span><input class="input" name="heart_rate" type="number" min="10" max="300" placeholder="72"></label>
              <label class="field"><span class="field__label">Respiratory rate</span><input class="input" name="respiratory_rate" type="number" min="2" max="80" placeholder="16"></label>
              <label class="field"><span class="field__label">SpO₂ (%)</span><input class="input" name="oxygen_saturation" type="number" min="0" max="100" placeholder="98"></label>
              <label class="field"><span class="field__label">Blood sugar (mg/dL)</span><input class="input" name="blood_sugar_mgdl" type="number" min="10" max="1200"></label>
              <label class="field"><span class="field__label">Weight (kg)</span><input class="input" name="weight_kg" type="number" step="0.1" min="0.5" max="700"></label>
              <label class="field"><span class="field__label">Height (cm)</span><input class="input" name="height_cm" type="number" step="0.1" min="20" max="300"></label>
              <label class="field"><span class="field__label">Pain (0–10)</span><input class="input" name="pain_scale" type="number" min="0" max="10"></label>
            </div>
            <label class="field"><span class="field__label">Notes</span><input class="input" name="notes" placeholder="Anything unusual about the readings"></label>
            <button type="button" class="btn btn--primary" id="save-vitals">Save vitals</button>
            <span class="field__hint">BMI is calculated automatically from height and weight.</span>
          </form>
        </div>
      </div>`) : ''}

    <div class="card">
      <div class="card__head">
        <div class="card__title">This visit</div>
        <a class="btn btn--sm btn--ghost" href="#/patients/${data.visit.patient_id}?tab=vitals">Full history</a>
      </div>
      <div class="card__body--flush">
        ${data.vitals.length === 0
          ? raw(emptyState('No vitals recorded', 'Record the first set above.', '🌡'))
          : raw(html`
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>When</th><th>Temp</th><th>BP</th><th>HR</th><th class="col-optional">RR</th><th>SpO₂</th><th class="col-optional">Glucose</th><th class="col-optional">BMI</th><th class="col-optional">By</th></tr>
                </thead>
                <tbody>
                  ${raw(data.vitals.map((x) => html`
                    <tr>
                      <td class="nowrap muted">${fmtTime(x.recorded_at)}</td>
                      <td class="vital ${x.flags?.temperature_c ? `vital--${x.flags.temperature_c}` : ''}">${x.temperature_c ?? '—'}</td>
                      <td class="vital ${x.flags?.bp_systolic ? `vital--${x.flags.bp_systolic}` : ''}">${x.bp_systolic && x.bp_diastolic ? `${x.bp_systolic}/${x.bp_diastolic}` : '—'}</td>
                      <td class="vital ${x.flags?.heart_rate ? `vital--${x.flags.heart_rate}` : ''}">${x.heart_rate ?? '—'}</td>
                      <td class="col-optional vital ${x.flags?.respiratory_rate ? `vital--${x.flags.respiratory_rate}` : ''}">${x.respiratory_rate ?? '—'}</td>
                      <td class="vital ${x.flags?.oxygen_saturation ? `vital--${x.flags.oxygen_saturation}` : ''}">${x.oxygen_saturation ?? '—'}</td>
                      <td class="col-optional vital ${x.flags?.blood_sugar_mgdl ? `vital--${x.flags.blood_sugar_mgdl}` : ''}">${x.blood_sugar_mgdl ?? '—'}</td>
                      <td class="col-optional vital ${x.flags?.bmi ? `vital--${x.flags.bmi}` : ''}">${x.bmi ?? '—'}</td>
                      <td class="col-optional muted">${x.recorded_by_name ?? '—'}</td>
                    </tr>`).join(''))}
                </tbody>
              </table>
            </div>`)}
      </div>
    </div>`;
}

function symptomsTab() {
  const canWrite = can('records:write');
  const recorded = data.symptoms ?? [];

  return html`
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">Symptom checklist</div>
          <p class="card__sub">Tick everything the patient reports, then save. Unticking removes a symptom.</p>
        </div>
        ${canWrite ? raw('<button type="button" class="btn btn--sm btn--primary" id="save-symptoms">Save symptoms</button>') : ''}
      </div>
      <div class="card__body">
        <div id="symptom-catalog">${raw(loadingState('Loading checklist…'))}</div>

        ${canWrite ? raw(html`
          <div class="mt-2">
            <label class="field">
              <span class="field__label">Add a symptom that is not listed</span>
              <div class="flex">
                <input class="input" id="custom-symptom" placeholder="e.g. Ringing in the ears">
                <button type="button" class="btn btn--ghost" id="add-custom-symptom">Add</button>
              </div>
            </label>
            <div id="custom-symptom-list"></div>
          </div>`) : ''}

        ${recorded.length > 0 ? raw(html`
          <div class="mt-2">
            <div class="field__label">Currently recorded (${recorded.length})</div>
            <div class="flex flex-wrap gap-sm">
              ${raw(recorded.map((s) => html`<span class="badge badge--accent">${s.symptom_name ?? s.custom_name}${s.severity ? ` · ${s.severity}` : ''}</span>`).join(''))}
            </div>
          </div>`) : ''}
      </div>
    </div>`;
}

function examTab() {
  const exam = data.physical_exam ?? {};
  const canWrite = can('records:write');

  return html`
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">Physical examination</div>
          ${exam.examiner_name ? raw(html`<p class="card__sub">Last recorded by ${exam.examiner_name}, ${fmtAgo(exam.updated_at ?? exam.created_at)}</p>`) : ''}
        </div>
        ${canWrite ? raw('<button type="button" class="btn btn--sm btn--primary" id="save-exam">Save examination</button>') : ''}
      </div>
      <div class="card__body">
        <form id="exam-form">
          ${raw(EXAM_SECTIONS.map(([name, label]) => html`
            <label class="field">
              <span class="field__label">${label}</span>
              <textarea class="textarea" name="${name}" ${canWrite ? '' : 'disabled'}
                        placeholder="Findings for ${label.toLowerCase()}">${exam[name] ?? ''}</textarea>
            </label>`).join(''))}
          <label class="field">
            <span class="field__label">Additional notes</span>
            <textarea class="textarea" name="additional_notes" ${canWrite ? '' : 'disabled'}>${exam.additional_notes ?? ''}</textarea>
          </label>
        </form>
      </div>
    </div>`;
}

function diagnosisTab() {
  const canWrite = can('diagnoses:write');

  return html`
    <div class="card">
      <div class="card__head">
        <div class="card__title">Diagnoses</div>
        ${canWrite ? raw('<button type="button" class="btn btn--sm btn--primary" data-visit-act="add-diagnosis">Add diagnosis</button>') : ''}
      </div>
      <div class="card__body--flush">
        ${data.diagnoses.length === 0
          ? raw(emptyState('No diagnosis recorded', 'Search the library or enter a custom diagnosis.', '🔎'))
          : raw(html`
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Diagnosis</th><th class="col-optional">Code</th><th>Certainty</th><th class="col-optional">By</th><th></th></tr></thead>
                <tbody>
                  ${raw(data.diagnoses.map((d) => html`
                    <tr>
                      <td>
                        <div class="row-title">
                          ${d.diagnosis_name ?? d.custom_name}
                          ${d.is_primary ? raw('<span class="badge badge--accent">primary</span>') : ''}
                        </div>
                        ${d.notes ? raw(html`<div class="row-sub">${d.notes}</div>`) : ''}
                      </td>
                      <td class="col-optional mono muted">${d.diagnosis_code ?? '—'}</td>
                      <td>${raw(statusBadge(d.certainty))}</td>
                      <td class="col-optional muted">${d.diagnosed_by_name ?? '—'}</td>
                      <td class="text-right">
                        ${canWrite ? raw(html`<button type="button" class="btn btn--sm btn--ghost" data-remove-dx="${d.id}">Remove</button>`) : ''}
                      </td>
                    </tr>`).join(''))}
                </tbody>
              </table>
            </div>`)}
      </div>
    </div>`;
}

function planTab() {
  const canWrite = can('treatments:write');

  return html`
    <div class="card">
      <div class="card__head">
        <div class="card__title">Treatment plan</div>
        ${canWrite ? raw('<button type="button" class="btn btn--sm btn--primary" data-visit-act="add-treatment">Add to plan</button>') : ''}
      </div>
      <div class="card__body--flush">
        ${data.treatments.length === 0
          ? raw(emptyState('No treatment plan yet', 'Add observation, medication, referral, therapy, testing or admission.', '📝'))
          : raw(html`
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Type</th><th>Description</th><th class="col-optional">Ordered by</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  ${raw(data.treatments.map((t) => html`
                    <tr>
                      <td><span class="badge badge--info">${titleCase(t.treatment_type)}</span></td>
                      <td>
                        <div>${t.description ?? '—'}</div>
                        ${t.physician_notes ? raw(html`<div class="row-sub pre-wrap">${t.physician_notes}</div>`) : ''}
                      </td>
                      <td class="col-optional muted">${t.ordered_by_name ?? '—'}</td>
                      <td>${raw(statusBadge(t.status))}</td>
                      <td class="text-right">
                        ${canWrite && t.status !== 'completed'
                          ? raw(html`<button type="button" class="btn btn--sm btn--ghost" data-complete-treatment="${t.id}">Complete</button>`)
                          : ''}
                      </td>
                    </tr>`).join(''))}
                </tbody>
              </table>
            </div>`)}
      </div>
    </div>`;
}

function prescriptionsTab() {
  const canWrite = can('prescriptions:write');

  return html`
    <div class="card">
      <div class="card__head">
        <div class="card__title">Prescriptions</div>
        ${canWrite ? raw('<button type="button" class="btn btn--sm btn--primary" data-visit-act="prescribe">Write prescription</button>') : ''}
      </div>
      <div class="card__body--flush">
        ${data.prescriptions.length === 0
          ? raw(emptyState('Nothing prescribed', 'Search the formulary to write a prescription.', '💊'))
          : raw(html`
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Medication</th><th>Directions</th><th class="col-optional">Qty</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  ${raw(data.prescriptions.map((rx) => html`
                    <tr>
                      <td>
                        <div class="row-title">${rx.medication_name}</div>
                        <div class="row-sub">${fmtDateTime(rx.prescribed_at)} · ${rx.prescriber_name ?? ''}</div>
                      </td>
                      <td>
                        ${rx.dosage}, ${rx.frequency}${rx.duration ? ` for ${rx.duration}` : ''}
                        ${rx.instructions ? raw(html`<div class="row-sub">${rx.instructions}</div>`) : ''}
                      </td>
                      <td class="col-optional num">${rx.quantity}</td>
                      <td>
                        ${raw(statusBadge(rx.status))}
                        ${rx.pharmacy_status ? raw(html` ${statusBadge(rx.pharmacy_status)}`) : ''}
                      </td>
                      <td class="text-right nowrap">
                        <button type="button" class="btn btn--sm btn--ghost" data-rx-label="${rx.id}">Label</button>
                        ${canWrite && ['active'].includes(rx.status)
                          ? raw(html`<button type="button" class="btn btn--sm btn--primary" data-rx-send="${rx.id}">To pharmacy</button>`)
                          : ''}
                      </td>
                    </tr>`).join(''))}
                </tbody>
              </table>
            </div>`)}
      </div>
    </div>`;
}

function ordersTab() {
  return html`
    <div class="card">
      <div class="card__head">
        <div class="card__title">Laboratory orders</div>
        ${can('lab:order') ? raw('<button type="button" class="btn btn--sm btn--primary" data-visit-act="order-lab">Order tests</button>') : ''}
      </div>
      <div class="card__body--flush">
        ${data.laboratory.length === 0
          ? raw(emptyState('No lab orders', 'Order CBC, urinalysis, blood sugar and more.', '🧪'))
          : raw(html`
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Test</th><th>Result</th><th class="col-optional">Ordered</th><th>Status</th></tr></thead>
                <tbody>
                  ${raw(data.laboratory.map((order) => {
                    const results = order.results ?? [];
                    return html`
                      <tr>
                        <td>
                          <div class="row-title">${order.test_name}</div>
                          <div class="row-sub">${titleCase(order.priority)}${order.ordered_by_name ? ` · ${order.ordered_by_name}` : ''}</div>
                        </td>
                        <td>
                          ${results.length === 0 ? raw('<span class="muted">Pending</span>') : raw(results.map((r) => html`
                            <div>
                              <span class="vital ${r.flag === 'critical' ? 'vital--red' : r.flag !== 'normal' ? 'vital--yellow' : 'vital--green'}">
                                ${r.result_value}${r.unit ? ` ${r.unit}` : ''}
                              </span>
                              ${raw(statusBadge(r.flag))}
                              ${r.reference_range ? raw(html`<span class="muted" style="font-size:11px"> ref ${r.reference_range}</span>`) : ''}
                            </div>`).join(''))}
                        </td>
                        <td class="col-optional muted nowrap">${fmtAgo(order.ordered_at)}</td>
                        <td>${raw(statusBadge(order.status))}</td>
                      </tr>`;
                  }).join(''))}
                </tbody>
              </table>
            </div>`)}
      </div>
    </div>

    <div class="card">
      <div class="card__head">
        <div class="card__title">Imaging orders</div>
        ${can('radiology:order') ? raw('<button type="button" class="btn btn--sm btn--primary" data-visit-act="order-imaging">Order imaging</button>') : ''}
      </div>
      <div class="card__body--flush">
        ${data.radiology.length === 0
          ? raw(emptyState('No imaging ordered', 'X-Ray, CT, MRI and ultrasound.', '🩻'))
          : raw(html`
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Study</th><th>Impression</th><th class="col-optional">Images</th><th>Status</th></tr></thead>
                <tbody>
                  ${raw(data.radiology.map((study) => html`
                    <tr>
                      <td>
                        <div class="row-title">${study.study_name}</div>
                        <div class="row-sub">${study.modality.toUpperCase()}${study.body_part ? ` · ${study.body_part}` : ''}</div>
                      </td>
                      <td class="pre-wrap">${study.impression ?? raw('<span class="muted">Awaiting read</span>')}</td>
                      <td class="col-optional num">${(study.images ?? []).length}</td>
                      <td>${raw(statusBadge(study.status))}</td>
                    </tr>`).join(''))}
                </tbody>
              </table>
            </div>`)}
      </div>
    </div>`;
}

function notesTab() {
  const canWrite = can('records:write');

  return html`
    ${canWrite ? raw(html`
      <div class="card">
        <div class="card__head"><div class="card__title">Add a note</div></div>
        <div class="card__body">
          <form id="note-form">
            <div class="form-grid">
              <label class="field">
                <span class="field__label">Note type</span>
                <select class="select" name="note_type">
                  <option value="progress">Progress note</option>
                  <option value="physician">Physician note</option>
                  <option value="nursing">Nursing note</option>
                  <option value="triage">Triage note</option>
                  <option value="procedure">Procedure note</option>
                  <option value="addendum">Addendum</option>
                  <option value="general">General</option>
                </select>
              </label>
              <label class="check" style="align-self:end;margin-bottom:13px">
                <input type="checkbox" name="is_pinned">
                <span>Pin to the top of the chart</span>
              </label>
            </div>
            <label class="field">
              <span class="field__label">Note *</span>
              <textarea class="textarea" name="body" rows="5" placeholder="Clinical observations, discussion with the patient, plan…"></textarea>
            </label>
            <button type="button" class="btn btn--primary" id="save-note">Save note</button>
          </form>
        </div>
      </div>`) : ''}

    <div class="card">
      <div class="card__head"><div class="card__title">Notes (${data.notes.length})</div></div>
      <div class="card__body--flush">
        ${data.notes.length === 0
          ? raw(emptyState('No notes yet', '', '📝'))
          : raw(data.notes.map((n) => html`
            <div style="padding:13px 14px;border-bottom:1px solid var(--border-soft)">
              <div class="flex flex-between flex-wrap gap-sm">
                <span class="badge ${n.is_pinned ? 'badge--warn' : ''}">${titleCase(n.note_type)}${n.is_pinned ? ' · pinned' : ''}</span>
                <span class="muted" style="font-size:11.5px">${n.author_name ?? 'Unknown'} · ${fmtDateTime(n.created_at)}</span>
              </div>
              <div class="pre-wrap mt-1">${n.body}</div>
            </div>`).join(''))}
      </div>
    </div>`;
}

function dischargeTab() {
  if (data.discharge) {
    const d = data.discharge;
    return html`
      <div class="card">
        <div class="card__head">
          <div class="card__title">Discharged</div>
          <span class="badge badge--ok">${titleCase(d.discharge_status)}</span>
        </div>
        <div class="card__body">
          <dl class="kv">
            <dt>Discharged at</dt><dd>${fmtDateTime(d.discharged_at)}</dd>
            <dt>Condition</dt><dd>${d.condition_on_discharge ?? '—'}</dd>
            <dt>Follow-up</dt><dd>${d.follow_up_required ? `Yes${d.follow_up_date ? ` — ${fmtDate(d.follow_up_date)}` : ''}` : 'Not required'}</dd>
            ${d.transferred_to ? raw(html`<dt>Transferred to</dt><dd>${d.transferred_to}</dd>`) : ''}
          </dl>
          ${d.instructions ? raw(html`<div class="mt-2"><div class="field__label">Instructions</div><div class="pre-wrap">${d.instructions}</div></div>`) : ''}
          ${d.medication_summary ? raw(html`<div class="mt-2"><div class="field__label">Medications</div><div class="pre-wrap">${d.medication_summary}</div></div>`) : ''}
        </div>
      </div>`;
  }

  return html`
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">Discharge patient</div>
          <p class="card__sub">This closes the encounter and removes the patient from the queue.</p>
        </div>
      </div>
      <div class="card__body">
        <form id="discharge-form">
          <div class="form-grid">
            <label class="field">
              <span class="field__label">Outcome *</span>
              <select class="select" name="discharge_status">
                <option value="recovered">Recovered</option>
                <option value="improved">Improved</option>
                <option value="referred">Referred</option>
                <option value="transferred">Transferred</option>
                <option value="admitted">Admitted</option>
                <option value="ama">Left against medical advice</option>
                <option value="deceased">Deceased</option>
              </select>
            </label>
            <label class="field">
              <span class="field__label">Condition on discharge</span>
              <input class="input" name="condition_on_discharge" placeholder="e.g. Stable, ambulatory">
            </label>
            <label class="field">
              <span class="field__label">Transferred to</span>
              <input class="input" name="transferred_to" placeholder="Receiving facility, if applicable">
            </label>
            <label class="field">
              <span class="field__label">Follow-up date</span>
              <input class="input" name="follow_up_date" type="date">
            </label>
          </div>

          <label class="check">
            <input type="checkbox" name="follow_up_required">
            <span>Follow-up appointment required</span>
          </label>

          <label class="field">
            <span class="field__label">Discharge instructions</span>
            <textarea class="textarea" name="instructions" rows="4" placeholder="Rest, fluids, return if symptoms worsen…"></textarea>
          </label>

          <label class="field">
            <span class="field__label">Medication summary</span>
            <textarea class="textarea" name="medication_summary" placeholder="Leave blank to generate from this visit's prescriptions"></textarea>
          </label>

          <button type="button" class="btn btn--ok" id="do-discharge">Discharge patient</button>
        </form>
      </div>
    </div>`;
}

// --- Tab wiring -----------------------------------------------------------

function wireTab(container) {
  const host = container.querySelector('#visit-tab');

  const saveVitals = host.querySelector('#save-vitals');
  if (saveVitals) {
    saveVitals.addEventListener('click', async () => {
      const values = readForm(host.querySelector('#vitals-form'));
      const measured = Object.entries(values).filter(([key, value]) => key !== 'notes' && value !== undefined);
      if (measured.length === 0) {
        toastWarn('Enter at least one measurement.');
        return;
      }

      saveVitals.disabled = true;
      try {
        const record = await api.post(`/visits/${visitId}/vitals`, values);
        const red = Object.entries(record.flags ?? {}).filter(([, level]) => level === 'red');
        toastOk(red.length > 0 ? `Vitals saved — ${red.length} reading(s) outside safe range.` : 'Vitals saved.');
        await load(container);
      } catch (err) {
        reportError(err);
      } finally {
        saveVitals.disabled = false;
      }
    });
  }

  if (activeTab === 'symptoms') loadSymptomCatalog(container);

  const saveExam = host.querySelector('#save-exam');
  if (saveExam) {
    saveExam.addEventListener('click', async () => {
      saveExam.disabled = true;
      try {
        await api.put(`/visits/${visitId}/exam`, readForm(host.querySelector('#exam-form')));
        toastOk('Examination saved.');
        await load(container);
      } catch (err) {
        reportError(err);
      } finally {
        saveExam.disabled = false;
      }
    });
  }

  const saveNote = host.querySelector('#save-note');
  if (saveNote) {
    saveNote.addEventListener('click', async () => {
      const values = readForm(host.querySelector('#note-form'));
      if (!values.body) {
        toastWarn('Write something first.');
        return;
      }
      saveNote.disabled = true;
      try {
        await api.post(`/visits/${visitId}/notes`, values);
        toastOk('Note saved.');
        await load(container);
      } catch (err) {
        reportError(err);
      } finally {
        saveNote.disabled = false;
      }
    });
  }

  const discharge = host.querySelector('#do-discharge');
  if (discharge) {
    discharge.addEventListener('click', async () => {
      const values = readForm(host.querySelector('#discharge-form'));
      const confirmed = await confirmDialog({
        title: 'Discharge patient',
        message: `Close this encounter with outcome "${titleCase(values.discharge_status)}"? The patient leaves the queue.`,
        confirmLabel: 'Discharge',
      });
      if (!confirmed) return;

      discharge.disabled = true;
      try {
        await api.post(`/visits/${visitId}/discharge`, values);
        toastOk('Patient discharged.');
        context.refreshBadges();
        await load(container);
      } catch (err) {
        reportError(err);
      } finally {
        discharge.disabled = false;
      }
    });
  }

  on(host, 'click', '[data-remove-dx]', async (_e, target) => {
    try {
      await api.delete(`/visits/${visitId}/diagnoses/${target.dataset.removeDx}`);
      toastOk('Diagnosis removed.');
      await load(container);
    } catch (err) {
      reportError(err);
    }
  });

  on(host, 'click', '[data-complete-treatment]', async (_e, target) => {
    try {
      await api.patch(`/visits/${visitId}/treatments/${target.dataset.completeTreatment}`, { status: 'completed' });
      toastOk('Marked complete.');
      await load(container);
    } catch (err) {
      reportError(err);
    }
  });

  on(host, 'click', '[data-rx-send]', async (_e, target) => {
    try {
      await api.post(`/prescriptions/${target.dataset.rxSend}/send`, { priority: 'normal' });
      toastOk('Sent to the pharmacy.');
      context.refreshBadges();
      await load(container);
    } catch (err) {
      reportError(err);
    }
  });

  on(host, 'click', '[data-rx-label]', async (_e, target) => {
    try {
      const label = await api.get(`/prescriptions/${target.dataset.rxLabel}/label`);
      showLabel(label);
    } catch (err) {
      reportError(err);
    }
  });
}

// --- Symptom checklist ----------------------------------------------------

let customSymptoms = [];

async function loadSymptomCatalog(container) {
  const host = container.querySelector('#symptom-catalog');
  if (!host) return;

  try {
    const catalog = await api.get('/catalog/symptoms');
    const recordedIds = new Set((data.symptoms ?? []).map((s) => s.symptom_id).filter(Boolean));
    customSymptoms = (data.symptoms ?? []).filter((s) => !s.symptom_id && s.custom_name).map((s) => s.custom_name);

    render(host, html`
      <div class="check-grid">
        ${raw(catalog.map((s) => html`
          <label class="check ${recordedIds.has(s.id) ? 'is-checked' : ''}">
            <input type="checkbox" data-symptom="${s.id}" ${recordedIds.has(s.id) ? 'checked' : ''} ${can('records:write') ? '' : 'disabled'}>
            <span>${s.name}</span>
          </label>`).join(''))}
      </div>`);

    host.querySelectorAll('[data-symptom]').forEach((box) => {
      box.addEventListener('change', () => box.closest('.check').classList.toggle('is-checked', box.checked));
    });

    renderCustomList(container);
  } catch (err) {
    render(host, html`<div class="alert alert--error">${err.message}</div>`);
  }
}

function renderCustomList(container) {
  const host = container.querySelector('#custom-symptom-list');
  if (!host) return;

  render(host, customSymptoms.length === 0 ? '' : html`
    <div class="flex flex-wrap gap-sm">
      ${raw(customSymptoms.map((name, index) => html`
        <span class="badge badge--accent">
          ${name}
          <button type="button" class="iconbtn" style="width:16px;height:16px;font-size:14px" data-drop-custom="${index}" aria-label="Remove">&times;</button>
        </span>`).join(''))}
    </div>`);

  host.querySelectorAll('[data-drop-custom]').forEach((btn) => {
    btn.addEventListener('click', () => {
      customSymptoms.splice(Number(btn.dataset.dropCustom), 1);
      renderCustomList(container);
    });
  });

  const addBtn = container.querySelector('#add-custom-symptom');
  const input = container.querySelector('#custom-symptom');
  if (addBtn && !addBtn.dataset.wired) {
    addBtn.dataset.wired = 'true';
    const add = () => {
      const value = input.value.trim();
      if (!value) return;
      if (!customSymptoms.includes(value)) customSymptoms.push(value);
      input.value = '';
      renderCustomList(container);
    };
    addBtn.addEventListener('click', add);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
    });
  }

  const saveBtn = container.querySelector('#save-symptoms');
  if (saveBtn && !saveBtn.dataset.wired) {
    saveBtn.dataset.wired = 'true';
    saveBtn.addEventListener('click', async () => {
      const checked = Array.from(container.querySelectorAll('[data-symptom]:checked')).map((box) => ({ symptom_id: box.dataset.symptom }));
      const customs = customSymptoms.map((name) => ({ custom_name: name }));

      saveBtn.disabled = true;
      try {
        await api.put(`/visits/${visitId}/symptoms`, { symptoms: [...checked, ...customs] });
        toastOk('Symptoms saved.');
        await load(container);
      } catch (err) {
        reportError(err);
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
}

// --- Header actions -------------------------------------------------------

function wireHeaderActions(container) {
  on(container, 'click', '[data-visit-act]', async (_e, target) => {
    const action = target.dataset.visitAct;
    try {
      if (action === 'see') return startConsultation(container);
      if (action === 'assign') return assignClinician(container);
      if (action === 'priority') return changePriority(container);
      if (action === 'discharge') { activeTab = 'discharge'; return renderTabAndTabs(container); }
      if (action === 'add-diagnosis') return addDiagnosis(container);
      if (action === 'add-treatment') return addTreatment(container);
      if (action === 'prescribe') return prescribe(container);
      if (action === 'order-lab') return orderLab(container);
      if (action === 'order-imaging') return orderImaging(container);
    } catch (err) {
      reportError(err);
    }
  });
}

function renderTabAndTabs(container) {
  container.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === activeTab));
  renderTab(container);
}

async function startConsultation(container) {
  await api.patch(`/visits/${visitId}`, { status: 'being_seen' });
  toastOk('Consultation started.');
  context.refreshBadges();
  await load(container);
}

async function assignClinician(container) {
  const [doctors, nurses] = await Promise.all([
    api.get('/staff', { role: 'doctor', status: 'active', limit: 100 }),
    api.get('/staff', { role: 'nurse', status: 'active', limit: 100 }),
  ]);

  openModal({
    title: 'Assign clinician',
    body: html`
      <label class="field">
        <span class="field__label">Doctor</span>
        <select class="select" id="assign-doctor">
          <option value="">— Unassigned —</option>
          ${raw(doctors.map((s) => html`<option value="${s.id}" ${data.visit.assigned_doctor_id === s.id ? 'selected' : ''}>${[s.display_title, s.full_name].filter(Boolean).join(' ')}${s.is_on_duty ? ' · on duty' : ''}</option>`).join(''))}
        </select>
      </label>
      <label class="field">
        <span class="field__label">Nurse</span>
        <select class="select" id="assign-nurse">
          <option value="">— Unassigned —</option>
          ${raw(nurses.map((s) => html`<option value="${s.id}" ${data.visit.assigned_nurse_id === s.id ? 'selected' : ''}>${s.full_name}${s.is_on_duty ? ' · on duty' : ''}</option>`).join(''))}
        </select>
      </label>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Save',
        class: 'btn--primary',
        onClick: async (root) => {
          await api.patch(`/visits/${visitId}`, {
            assigned_doctor_id: root.querySelector('#assign-doctor').value || null,
            assigned_nurse_id: root.querySelector('#assign-nurse').value || null,
          });
          toastOk('Assignment updated.');
          await load(container);
        },
      },
    ],
  });
}

function changePriority(container) {
  openModal({
    title: 'Triage priority',
    body: html`
      <label class="field">
        <span class="field__label">Priority</span>
        <select class="select" id="visit-priority">
          <option value="normal" ${data.visit.priority === 'normal' ? 'selected' : ''}>Normal</option>
          <option value="urgent" ${data.visit.priority === 'urgent' ? 'selected' : ''}>Urgent</option>
          <option value="emergency" ${data.visit.priority === 'emergency' ? 'selected' : ''}>Emergency</option>
        </select>
      </label>
      <label class="field">
        <span class="field__label">Pain scale (0–10)</span>
        <input class="input" id="visit-pain" type="number" min="0" max="10" value="${data.visit.pain_scale ?? ''}">
      </label>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Save',
        class: 'btn--primary',
        onClick: async (root) => {
          const pain = root.querySelector('#visit-pain').value;
          await api.patch(`/visits/${visitId}`, {
            priority: root.querySelector('#visit-priority').value,
            pain_scale: pain === '' ? null : Number(pain),
          });
          toastOk('Triage updated.');
          context.refreshBadges();
          await load(container);
        },
      },
    ],
  });
}

async function addDiagnosis(container) {
  const common = await api.get('/catalog/diagnoses', { common_only: 'true', limit: 50 });

  openModal({
    title: 'Add a diagnosis',
    body: html`
      <label class="field">
        <span class="field__label">Search the library</span>
        <input class="input" id="dx-search" placeholder="Type at least two letters" autocomplete="off">
      </label>
      <div id="dx-results" class="mb-2"></div>

      <div class="fieldset">
        <legend>Or enter a custom diagnosis</legend>
        <label class="field"><span class="field__label">Diagnosis</span><input class="input" id="dx-custom"></label>
        <label class="check"><input type="checkbox" id="dx-library"><span>Add it to the searchable library</span></label>
      </div>

      <div class="form-grid">
        <label class="field">
          <span class="field__label">Certainty</span>
          <select class="select" id="dx-certainty">
            <option value="confirmed">Confirmed</option>
            <option value="probable">Probable</option>
            <option value="suspected">Suspected</option>
            <option value="ruled_out">Ruled out</option>
          </select>
        </label>
        <label class="check" style="align-self:end;margin-bottom:13px">
          <input type="checkbox" id="dx-primary" ${data.diagnoses.length === 0 ? 'checked' : ''}>
          <span>Primary diagnosis</span>
        </label>
      </div>
      <label class="field"><span class="field__label">Notes</span><textarea class="textarea" id="dx-notes"></textarea></label>`,
    onMount(root) {
      const results = root.querySelector('#dx-results');
      const search = root.querySelector('#dx-search');
      let selectedId = null;
      let timer = null;

      const show = (list) => {
        render(results, list.length === 0
          ? html`<p class="muted" style="font-size:12.5px">No match — use the custom field below.</p>`
          : html`
            <div class="flex flex-wrap gap-sm">
              ${raw(list.map((d) => html`
                <button type="button" class="btn btn--sm btn--ghost" data-dx="${d.id}" data-name="${d.name}">${d.name}${d.code ? ` (${d.code})` : ''}</button>`).join(''))}
            </div>`);

        results.querySelectorAll('[data-dx]').forEach((btn) => {
          btn.addEventListener('click', () => {
            selectedId = btn.dataset.dx;
            root.dataset.selected = selectedId;
            results.querySelectorAll('[data-dx]').forEach((b) => b.classList.remove('btn--primary'));
            btn.classList.add('btn--primary');
            root.querySelector('#dx-custom').value = '';
          });
        });
      };

      show(common);

      search.addEventListener('input', () => {
        clearTimeout(timer);
        const term = search.value.trim();
        if (term.length < 2) return show(common);
        timer = setTimeout(async () => {
          try {
            show(await api.get('/catalog/diagnoses', { search: term, limit: 20 }));
          } catch { /* keep the previous list */ }
        }, 250);
      });
    },
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Add diagnosis',
        class: 'btn--primary',
        onClick: async (root) => {
          const custom = root.querySelector('#dx-custom').value.trim();
          const selected = root.dataset.selected;

          if (!custom && !selected) {
            toastWarn('Pick a diagnosis from the library, or type a custom one.');
            return true;
          }

          await api.post(`/visits/${visitId}/diagnoses`, {
            diagnosis_id: custom ? null : selected,
            custom_name: custom || null,
            is_primary: root.querySelector('#dx-primary').checked,
            certainty: root.querySelector('#dx-certainty').value,
            notes: root.querySelector('#dx-notes').value.trim() || null,
            add_to_library: root.querySelector('#dx-library').checked,
          });

          toastOk('Diagnosis recorded.');
          await load(container);
        },
      },
    ],
  });
}

function addTreatment(container) {
  openModal({
    title: 'Add to the treatment plan',
    body: html`
      <label class="field">
        <span class="field__label">Type *</span>
        <select class="select" id="tx-type">
          <option value="observation">Observation</option>
          <option value="medication">Medication</option>
          <option value="referral">Referral</option>
          <option value="physical_therapy">Physical therapy</option>
          <option value="laboratory">Laboratory testing</option>
          <option value="imaging">Imaging</option>
          <option value="admission">Hospital admission</option>
          <option value="procedure">Procedure</option>
          <option value="counseling">Counselling</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label class="field"><span class="field__label">Description</span><input class="input" id="tx-desc" placeholder="What is planned"></label>
      <label class="field"><span class="field__label">Physician notes</span><textarea class="textarea" id="tx-notes"></textarea></label>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Add to plan',
        class: 'btn--primary',
        onClick: async (root) => {
          await api.post(`/visits/${visitId}/treatments`, {
            treatment_type: root.querySelector('#tx-type').value,
            description: root.querySelector('#tx-desc').value.trim() || null,
            physician_notes: root.querySelector('#tx-notes').value.trim() || null,
          });
          toastOk('Treatment plan updated.');
          await load(container);
        },
      },
    ],
  });
}

async function prescribe(container) {
  openModal({
    title: 'Write a prescription',
    wide: true,
    body: html`
      <label class="field">
        <span class="field__label">Search the formulary</span>
        <input class="input" id="rx-search" placeholder="Type at least two letters" autocomplete="off">
      </label>
      <div id="rx-results" class="mb-2"></div>

      <div class="form-grid">
        <label class="field"><span class="field__label">Medication *</span><input class="input" id="rx-name" placeholder="Name and strength"></label>
        <label class="field"><span class="field__label">Dosage *</span><input class="input" id="rx-dosage" placeholder="e.g. One tablet"></label>
        <label class="field"><span class="field__label">Frequency *</span><input class="input" id="rx-frequency" placeholder="e.g. Every 8 hours"></label>
        <label class="field"><span class="field__label">Duration</span><input class="input" id="rx-duration" placeholder="e.g. 7 days"></label>
        <label class="field"><span class="field__label">Quantity</span><input class="input" id="rx-quantity" type="number" min="1" value="1"></label>
        <label class="field"><span class="field__label">Refills</span><input class="input" id="rx-refills" type="number" min="0" max="12" value="0"></label>
      </div>

      <label class="field">
        <span class="field__label">Instructions for the patient</span>
        <textarea class="textarea" id="rx-instructions" placeholder="Take one tablet every 8 hours with food."></textarea>
      </label>

      <label class="check"><input type="checkbox" id="rx-send" checked><span>Send to the pharmacy queue immediately</span></label>`,
    onMount(root) {
      const results = root.querySelector('#rx-results');
      const search = root.querySelector('#rx-search');
      let timer = null;

      const show = (list) => {
        render(results, list.length === 0
          ? html`<p class="muted" style="font-size:12.5px">No match — type the medication name manually below.</p>`
          : html`
            <div class="flex flex-wrap gap-sm">
              ${raw(list.map((m) => html`
                <button type="button" class="btn btn--sm btn--ghost" data-med="${m.id}"
                        data-name="${[m.name, m.strength].filter(Boolean).join(' ')}"
                        data-dosage="${m.default_dosage ?? ''}"
                        data-frequency="${m.default_frequency ?? ''}"
                        data-instructions="${m.default_instructions ?? ''}">
                  ${m.name}${m.strength ? ` ${m.strength}` : ''}
                  ${m.is_controlled ? raw('<span class="badge badge--danger">controlled</span>') : ''}
                  ${m.stock_quantity <= 0 ? raw('<span class="badge badge--warn">out of stock</span>') : ''}
                </button>`).join(''))}
            </div>`);

        results.querySelectorAll('[data-med]').forEach((btn) => {
          btn.addEventListener('click', () => {
            root.dataset.medication = btn.dataset.med;
            root.querySelector('#rx-name').value = btn.dataset.name;
            if (btn.dataset.dosage) root.querySelector('#rx-dosage').value = btn.dataset.dosage;
            if (btn.dataset.frequency) root.querySelector('#rx-frequency').value = btn.dataset.frequency;
            if (btn.dataset.instructions) root.querySelector('#rx-instructions').value = btn.dataset.instructions;
            results.querySelectorAll('[data-med]').forEach((b) => b.classList.remove('btn--primary'));
            btn.classList.add('btn--primary');
          });
        });
      };

      api.get('/catalog/medications', { limit: 12 }).then(show).catch(() => {});

      search.addEventListener('input', () => {
        clearTimeout(timer);
        const term = search.value.trim();
        if (term.length < 2) return;
        timer = setTimeout(async () => {
          try {
            show(await api.get('/catalog/medications', { search: term, limit: 20 }));
          } catch { /* keep the previous list */ }
        }, 250);
      });

      // Typing a name by hand invalidates any catalogue selection.
      root.querySelector('#rx-name').addEventListener('input', () => {
        delete root.dataset.medication;
        results.querySelectorAll('[data-med]').forEach((b) => b.classList.remove('btn--primary'));
      });
    },
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Prescribe',
        class: 'btn--primary',
        onClick: async (root) => {
          const payload = {
            patient_id: data.visit.patient_id,
            visit_id: visitId,
            medication_id: root.dataset.medication ?? null,
            medication_name: root.querySelector('#rx-name').value.trim() || null,
            dosage: root.querySelector('#rx-dosage').value.trim(),
            frequency: root.querySelector('#rx-frequency').value.trim(),
            duration: root.querySelector('#rx-duration').value.trim() || null,
            quantity: Number(root.querySelector('#rx-quantity').value) || 1,
            refills: Number(root.querySelector('#rx-refills').value) || 0,
            instructions: root.querySelector('#rx-instructions').value.trim() || null,
            send_to_pharmacy: root.querySelector('#rx-send').checked,
          };

          if (!payload.medication_name && !payload.medication_id) {
            toastWarn('Choose or name a medication.');
            return true;
          }
          if (!payload.dosage || !payload.frequency) {
            toastWarn('Dosage and frequency are required.');
            return true;
          }

          const result = await api.post('/prescriptions', payload);

          if (result.allergy_warnings?.length > 0) {
            toastWarn(`Prescribed, but this patient has a recorded allergy to: ${result.allergy_warnings.map((a) => a.substance).join(', ')}`);
          } else {
            toastOk('Prescription written.');
          }

          context.refreshBadges();
          await load(container);
        },
      },
    ],
  });
}

async function orderLab(container) {
  const tests = await api.get('/catalog/lab-tests', { category: 'laboratory' });

  openModal({
    title: 'Order laboratory tests',
    wide: true,
    body: html`
      <div class="check-grid mb-2">
        ${raw(tests.map((t) => html`
          <label class="check">
            <input type="checkbox" data-test="${t.id}">
            <span>${t.name}<span class="row-sub"> ${t.specimen_type ?? ''} · ~${t.turnaround_minutes}m</span></span>
          </label>`).join(''))}
      </div>
      <div class="form-grid">
        <label class="field">
          <span class="field__label">Priority</span>
          <select class="select" id="lab-priority">
            <option value="routine">Routine</option>
            <option value="urgent">Urgent</option>
            <option value="stat">STAT</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span class="field__label">Clinical notes for the laboratory</span>
        <textarea class="textarea" id="lab-notes" placeholder="Relevant history, what you are looking for"></textarea>
      </label>`,
    onMount(root) {
      root.querySelectorAll('[data-test]').forEach((box) => {
        box.addEventListener('change', () => box.closest('.check').classList.toggle('is-checked', box.checked));
      });
    },
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Place order',
        class: 'btn--primary',
        onClick: async (root) => {
          const selected = Array.from(root.querySelectorAll('[data-test]:checked')).map((box) => ({ test_id: box.dataset.test }));
          if (selected.length === 0) {
            toastWarn('Select at least one test.');
            return true;
          }

          await api.post('/laboratory/orders', {
            patient_id: data.visit.patient_id,
            visit_id: visitId,
            priority: root.querySelector('#lab-priority').value,
            clinical_notes: root.querySelector('#lab-notes').value.trim() || null,
            tests: selected,
          });

          toastOk(`${selected.length} test(s) ordered.`);
          context.refreshBadges();
          await load(container);
        },
      },
    ],
  });
}

async function orderImaging(container) {
  const studies = await api.get('/catalog/lab-tests', { category: 'imaging' });

  openModal({
    title: 'Order an imaging study',
    body: html`
      <label class="field">
        <span class="field__label">Study *</span>
        <select class="select" id="img-study">
          ${raw(studies.map((s) => html`<option value="${s.id}" data-name="${s.name}" data-modality="${s.modality ?? 'xray'}">${s.name}</option>`).join(''))}
        </select>
      </label>
      <div class="form-grid">
        <label class="field"><span class="field__label">Body part</span><input class="input" id="img-part" placeholder="e.g. Left wrist"></label>
        <label class="field">
          <span class="field__label">Priority</span>
          <select class="select" id="img-priority">
            <option value="routine">Routine</option>
            <option value="urgent">Urgent</option>
            <option value="stat">STAT</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span class="field__label">Clinical history</span>
        <textarea class="textarea" id="img-history" placeholder="Mechanism of injury, symptoms, what you want ruled out"></textarea>
      </label>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Place order',
        class: 'btn--primary',
        onClick: async (root) => {
          const option = root.querySelector('#img-study').selectedOptions[0];

          await api.post('/radiology/orders', {
            patient_id: data.visit.patient_id,
            visit_id: visitId,
            test_id: option.value,
            study_name: option.dataset.name,
            modality: option.dataset.modality || 'xray',
            body_part: root.querySelector('#img-part').value.trim() || null,
            priority: root.querySelector('#img-priority').value,
            clinical_history: root.querySelector('#img-history').value.trim() || null,
          });

          toastOk('Imaging ordered.');
          await load(container);
        },
      },
    ],
  });
}

function showLabel(label) {
  openModal({
    title: 'Prescription label',
    body: html`
      <div class="card" style="background:var(--surface-2)">
        <div class="card__body">
          <div style="text-align:center;border-bottom:1px dashed var(--border);padding-bottom:8px;margin-bottom:10px">
            <strong>${label.clinic_name}</strong>
          </div>
          <dl class="kv">
            <dt>Patient</dt><dd>${label.patient_name}</dd>
            <dt>MRN</dt><dd class="mono">${label.patient_mrn}</dd>
            <dt>Medication</dt><dd><strong>${label.medication}</strong></dd>
            <dt>Dosage</dt><dd>${label.dosage}</dd>
            <dt>Frequency</dt><dd>${label.frequency}</dd>
            ${label.duration ? raw(html`<dt>Duration</dt><dd>${label.duration}</dd>`) : ''}
            <dt>Quantity</dt><dd>${label.quantity}</dd>
            <dt>Refills</dt><dd>${label.refills}</dd>
            <dt>Prescriber</dt><dd>${label.prescriber}</dd>
            <dt>Issued</dt><dd>${fmtDate(label.prescribed_at)}</dd>
          </dl>
          <div class="alert alert--info mt-2 mb-0">${label.instructions}</div>
        </div>
      </div>

      <label class="field mt-2">
        <span class="field__label">In-world rez payload</span>
        <textarea class="textarea mono" readonly rows="3" id="rez-payload">${label.rez_payload}</textarea>
        <span class="field__hint">Paste into a prescription-bottle script, or have it fetch <span class="mono">/api/lsl/prescription?id=…</span></span>
      </label>`,
    actions: [
      { label: 'Copy payload', class: 'btn--ghost', onClick: (root) => {
        const field = root.querySelector('#rez-payload');
        field.select();
        try {
          document.execCommand('copy');
          toastOk('Copied.');
        } catch {
          toastWarn('Select the text and copy manually.');
        }
        return true;
      } },
      { label: 'Print', class: 'btn--ghost', onClick: () => { window.print(); return true; } },
      { label: 'Close', class: 'btn--primary' },
    ],
  });
}

// ===========================================================================

export default {
  async render(container, ctx) {
    context = ctx;
    visitId = ctx.id;
    activeTab = ctx.query?.tab ?? 'overview';
    customSymptoms = [];

    if (!visitId) {
      render(container, emptyState('No visit selected', 'Open a visit from the waiting room or a patient chart.', '📋'));
      return;
    }

    await load(container);
  },

  destroy() {
    data = null;
    visitId = null;
    customSymptoms = [];
  },
};
