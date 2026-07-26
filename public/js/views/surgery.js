/**
 * Surgical records: schedule procedures, track them, record the outcome.
 */
import { api } from '../api.js';
import { can } from '../store.js';
import {
  html, raw, render, on, emptyState, loadingState, statusBadge, fmtDate,
  fmtDateTime, fmtDuration, titleCase, toastOk, toastWarn, reportError,
  openModal, paginationBar, readForm,
} from '../ui.js';

let context = null;
let state = { status: '', page: 1, search: '' };
let searchTimer = null;

const TABS = [
  ['', 'All'],
  ['scheduled', 'Scheduled'],
  ['in_progress', 'In theatre'],
  ['completed', 'Completed'],
];

const ANAESTHESIA = [
  ['none', 'None'], ['local', 'Local'], ['regional', 'Regional'],
  ['spinal', 'Spinal'], ['sedation', 'Sedation'], ['general', 'General'],
];

async function load(container) {
  render(container, html`
    <div class="toolbar">
      <div class="segmented">
        ${raw(TABS.map(([value, label]) => html`
          <button type="button" class="segmented__btn ${state.status === value ? 'is-active' : ''}" data-status="${value}">${label}</button>`).join(''))}
      </div>
      <input class="input" id="surg-search" placeholder="Search procedure, patient or MRN" value="${state.search}" autocomplete="off">
      ${can('surgery:write') ? raw('<button type="button" class="btn btn--primary" id="new-surgery">Schedule procedure</button>') : ''}
    </div>

    <div class="card">
      <div class="card__body--flush" id="surg-list">${raw(loadingState())}</div>
    </div>`);

  on(container, 'click', '[data-status]', (_e, target) => {
    state = { ...state, status: target.dataset.status, page: 1 };
    load(container);
  });

  const search = container.querySelector('#surg-search');
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state = { ...state, search: search.value.trim(), page: 1 };
      fetchList(container);
    }, 300);
  });

  const newBtn = container.querySelector('#new-surgery');
  if (newBtn) newBtn.addEventListener('click', () => openScheduler(container));

  on(container, 'click', '[data-open]', async (_e, target) => {
    try {
      const surgery = await api.get(`/surgery/${target.dataset.open}`);
      showSurgery(container, surgery);
    } catch (err) {
      reportError(err);
    }
  });

  on(container, 'click', '[data-start]', async (_e, target) => {
    try {
      await api.post(`/surgery/${target.dataset.start}/start`);
      toastOk('Procedure started.');
      await fetchList(container);
    } catch (err) {
      reportError(err);
    }
  });

  on(container, 'click', '[data-complete]', async (_e, target) => {
    try {
      const surgery = await api.get(`/surgery/${target.dataset.complete}`);
      openCompletion(container, surgery);
    } catch (err) {
      reportError(err);
    }
  });

  await fetchList(container);
}

async function fetchList(container) {
  const host = container.querySelector('#surg-list');
  if (!host) return;

  try {
    const surgeries = await api.get('/surgery', {
      status: state.status || undefined,
      page: state.page,
      limit: 25,
      search: state.search || undefined,
    });

    if (surgeries.length === 0) {
      render(host, emptyState('No surgical records', 'Scheduled and completed procedures appear here.', '🔪'));
      return;
    }

    render(host, html`
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>Patient</th><th>Procedure</th><th class="col-optional">Surgeon</th><th class="col-optional">When</th><th class="col-optional">Duration</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            ${raw(surgeries.map((s) => html`
              <tr>
                <td class="is-clickable" data-href="/patients/${s.patient_id}">
                  <div class="row-title">${s.patient_name}</div>
                  <div class="row-sub mono">${s.mrn}${s.blood_type && s.blood_type !== 'unknown' ? ` · ${s.blood_type}` : ''}</div>
                </td>
                <td>
                  <div class="row-title">${s.procedure_name}</div>
                  <div class="row-sub">
                    ${s.anesthesia_type ? `${titleCase(s.anesthesia_type)} anaesthesia` : 'Anaesthesia not set'}
                    ${s.operating_room ? ` · ${s.operating_room}` : ''}
                  </div>
                </td>
                <td class="col-optional">${s.surgeon_name ?? raw('<span class="muted">Unassigned</span>')}</td>
                <td class="col-optional muted nowrap">${s.start_time ? fmtDateTime(s.start_time) : s.scheduled_at ? fmtDateTime(s.scheduled_at) : '—'}</td>
                <td class="col-optional muted nowrap">${s.duration_minutes ? fmtDuration(s.duration_minutes) : '—'}</td>
                <td>
                  ${raw(statusBadge(s.status))}
                  ${s.outcome ? raw(html` ${statusBadge(s.outcome)}`) : ''}
                </td>
                <td class="text-right nowrap">
                  <button type="button" class="btn btn--sm btn--ghost" data-open="${s.id}">Open</button>
                  ${can('surgery:write') && s.status === 'scheduled'
                    ? raw(html`<button type="button" class="btn btn--sm btn--primary" data-start="${s.id}">Start</button>`)
                    : ''}
                  ${can('surgery:write') && s.status === 'in_progress'
                    ? raw(html`<button type="button" class="btn btn--sm btn--ok" data-complete="${s.id}">Complete</button>`)
                    : ''}
                </td>
              </tr>`).join(''))}
          </tbody>
        </table>
      </div>
      ${raw(paginationBar(surgeries.pagination, (page) => { state.page = page; fetchList(container); }))}`);
  } catch (err) {
    render(host, html`<div class="alert alert--error">${err.message}</div>`);
  }
}

async function openScheduler(container) {
  const [doctors, allStaff] = await Promise.all([
    api.get('/staff', { role: 'doctor', status: 'active', limit: 100 }),
    api.get('/staff', { status: 'active', limit: 100 }),
  ]);

  openModal({
    title: 'Schedule a procedure',
    wide: true,
    body: html`
      <label class="field">
        <span class="field__label">Patient *</span>
        <input class="input" id="sg-patient-search" placeholder="Search by name or MRN" autocomplete="off">
        <span class="field__hint" id="sg-patient-chosen">No patient selected.</span>
      </label>
      <div id="sg-patient-results" class="mb-2"></div>

      <div class="form-grid">
        <label class="field"><span class="field__label">Procedure *</span><input class="input" id="sg-name" placeholder="e.g. Appendectomy"></label>
        <label class="field"><span class="field__label">Procedure code</span><input class="input" id="sg-code"></label>
        <label class="field">
          <span class="field__label">Surgeon</span>
          <select class="select" id="sg-surgeon">
            <option value="">— To be assigned —</option>
            ${raw(doctors.map((d) => html`<option value="${d.id}">${[d.display_title, d.full_name].filter(Boolean).join(' ')}</option>`).join(''))}
          </select>
        </label>
        <label class="field">
          <span class="field__label">Anaesthesia</span>
          <select class="select" id="sg-anaesthesia">
            <option value="">Not decided</option>
            ${raw(ANAESTHESIA.map(([v, l]) => html`<option value="${v}">${l}</option>`).join(''))}
          </select>
        </label>
        <label class="field">
          <span class="field__label">Anaesthetist</span>
          <select class="select" id="sg-anaesthetist">
            <option value="">— None —</option>
            ${raw(doctors.map((d) => html`<option value="${d.id}">${[d.display_title, d.full_name].filter(Boolean).join(' ')}</option>`).join(''))}
          </select>
        </label>
        <label class="field"><span class="field__label">Operating room</span><input class="input" id="sg-room" placeholder="OR 1"></label>
        <label class="field"><span class="field__label">Scheduled date</span><input class="input" type="date" id="sg-date"></label>
        <label class="field"><span class="field__label">Scheduled time</span><input class="input" type="time" id="sg-time"></label>
        <label class="field"><span class="field__label">Cost</span><input class="input" type="number" min="0" step="0.01" id="sg-cost" value="0"></label>
      </div>

      <label class="field">
        <span class="field__label">Assisting staff</span>
        <select class="select" id="sg-assistants" multiple size="5">
          ${raw(allStaff.map((s) => html`<option value="${s.id}">${[s.display_title, s.full_name].filter(Boolean).join(' ')} — ${s.role_name}</option>`).join(''))}
        </select>
        <span class="field__hint">Hold Ctrl (or Cmd) to select more than one.</span>
      </label>`,
    onMount(root) {
      const searchInput = root.querySelector('#sg-patient-search');
      const results = root.querySelector('#sg-patient-results');

      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        const term = searchInput.value.trim();
        if (term.length < 2) return;

        searchTimer = setTimeout(async () => {
          try {
            const patients = await api.get('/patients', { search: term, limit: 6 });
            render(results, patients.length === 0
              ? html`<p class="muted" style="font-size:12.5px">No match.</p>`
              : html`
                <div class="flex flex-wrap gap-sm">
                  ${raw(patients.map((p) => html`
                    <button type="button" class="btn btn--sm btn--ghost" data-pick="${p.id}" data-name="${p.full_name}">
                      ${p.full_name} <span class="muted">${p.mrn}</span>
                    </button>`).join(''))}
                </div>`);

            results.querySelectorAll('[data-pick]').forEach((btn) => {
              btn.addEventListener('click', () => {
                root.dataset.patient = btn.dataset.pick;
                root.querySelector('#sg-patient-chosen').textContent = `Selected: ${btn.dataset.name}`;
                results.querySelectorAll('[data-pick]').forEach((b) => b.classList.remove('btn--primary'));
                btn.classList.add('btn--primary');
              });
            });
          } catch { /* keep previous */ }
        }, 300);
      });
    },
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Schedule',
        class: 'btn--primary',
        onClick: async (root) => {
          if (!root.dataset.patient) {
            toastWarn('Select a patient first.');
            return true;
          }

          const name = root.querySelector('#sg-name').value.trim();
          if (!name) {
            toastWarn('Name the procedure.');
            return true;
          }

          const date = root.querySelector('#sg-date').value;
          const time = root.querySelector('#sg-time').value;
          const scheduledAt = date ? new Date(`${date}T${time || '09:00'}`).toISOString() : null;

          const assistants = Array.from(root.querySelector('#sg-assistants').selectedOptions)
            .map((option) => ({ staff_id: option.value, role: 'Assistant' }));

          await api.post('/surgery', {
            patient_id: root.dataset.patient,
            procedure_name: name,
            procedure_code: root.querySelector('#sg-code').value.trim() || null,
            surgeon_id: root.querySelector('#sg-surgeon').value || null,
            anesthesia_type: root.querySelector('#sg-anaesthesia').value || null,
            anesthesiologist_id: root.querySelector('#sg-anaesthetist').value || null,
            operating_room: root.querySelector('#sg-room').value.trim() || null,
            scheduled_at: scheduledAt,
            cost: Number(root.querySelector('#sg-cost').value) || 0,
            assistants,
          });

          toastOk('Procedure scheduled.');
          await fetchList(container);
        },
      },
    ],
  });
}

function showSurgery(container, surgery) {
  const assistants = surgery.assistants ?? [];
  const actions = [{ label: 'Close', class: 'btn--ghost' }];

  if (can('surgery:write') && surgery.status === 'scheduled') {
    actions.push({
      label: 'Start procedure',
      class: 'btn--primary',
      onClick: async () => {
        await api.post(`/surgery/${surgery.id}/start`);
        toastOk('Procedure started.');
        await fetchList(container);
      },
    });
  }

  if (can('surgery:write') && surgery.status === 'in_progress') {
    actions.push({
      label: 'Record outcome',
      class: 'btn--ok',
      onClick: () => { openCompletion(container, surgery); },
    });
  }

  openModal({
    title: surgery.procedure_name,
    wide: true,
    body: html`
      <dl class="kv">
        <dt>Patient</dt><dd><a href="#/patients/${surgery.patient_id}">${surgery.patient_name}</a> (${surgery.mrn})</dd>
        <dt>Blood type</dt><dd>${surgery.blood_type && surgery.blood_type !== 'unknown' ? surgery.blood_type : '—'}</dd>
        <dt>Surgeon</dt><dd>${surgery.surgeon_name ?? '—'}</dd>
        <dt>Anaesthesia</dt><dd>${surgery.anesthesia_type ? titleCase(surgery.anesthesia_type) : '—'}${surgery.anesthesiologist_name ? ` · ${surgery.anesthesiologist_name}` : ''}</dd>
        <dt>Operating room</dt><dd>${surgery.operating_room ?? '—'}</dd>
        <dt>Scheduled</dt><dd>${surgery.scheduled_at ? fmtDateTime(surgery.scheduled_at) : '—'}</dd>
        <dt>Started</dt><dd>${surgery.start_time ? fmtDateTime(surgery.start_time) : '—'}</dd>
        <dt>Ended</dt><dd>${surgery.end_time ? fmtDateTime(surgery.end_time) : '—'}</dd>
        <dt>Duration</dt><dd>${surgery.duration_minutes ? fmtDuration(surgery.duration_minutes) : '—'}</dd>
        <dt>Status</dt><dd>${raw(statusBadge(surgery.status))}</dd>
        <dt>Outcome</dt><dd>${surgery.outcome ? raw(statusBadge(surgery.outcome)) : '—'}</dd>
      </dl>

      ${assistants.length > 0 ? raw(html`
        <div class="mt-2">
          <div class="field__label">Surgical team</div>
          <div class="flex flex-wrap gap-sm">
            ${raw(assistants.map((a) => html`<span class="badge badge--info">${a.name}${a.role ? ` · ${a.role}` : ''}</span>`).join(''))}
          </div>
        </div>`) : ''}

      ${surgery.operative_notes ? raw(html`<div class="mt-2"><div class="field__label">Operative notes</div><div class="pre-wrap">${surgery.operative_notes}</div></div>`) : ''}
      ${surgery.complications ? raw(html`<div class="alert alert--warn mt-2"><strong>Complications:</strong> ${surgery.complications}</div>`) : ''}
      ${surgery.post_op_instructions ? raw(html`<div class="mt-2"><div class="field__label">Post-operative instructions</div><div class="pre-wrap">${surgery.post_op_instructions}</div></div>`) : ''}`,
    actions,
  });
}

function openCompletion(container, surgery) {
  openModal({
    title: `Record outcome — ${surgery.procedure_name}`,
    wide: true,
    body: html`
      <form id="completion-form">
        <label class="field">
          <span class="field__label">Outcome *</span>
          <select class="select" name="outcome">
            <option value="successful">Successful</option>
            <option value="partial">Partially successful</option>
            <option value="unsuccessful">Unsuccessful</option>
            <option value="aborted">Aborted</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">Operative notes</span>
          <textarea class="textarea" name="operative_notes" rows="5" placeholder="Findings, technique, closure">${surgery.operative_notes ?? ''}</textarea>
        </label>
        <label class="field">
          <span class="field__label">Complications</span>
          <textarea class="textarea" name="complications" placeholder="Leave blank if none">${surgery.complications ?? ''}</textarea>
        </label>
        <label class="field">
          <span class="field__label">Post-operative instructions</span>
          <textarea class="textarea" name="post_op_instructions" rows="3">${surgery.post_op_instructions ?? ''}</textarea>
        </label>
      </form>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Complete procedure',
        class: 'btn--ok',
        onClick: async (root) => {
          await api.post(`/surgery/${surgery.id}/complete`, readForm(root.querySelector('#completion-form')));
          toastOk('Outcome recorded.');
          await fetchList(container);
        },
      },
    ],
  });
}

export default {
  async render(container, ctx) {
    context = ctx;
    state = { status: '', page: 1, search: '' };
    ctx.setTitle('Surgery', 'Operating theatre records');
    await load(container);
  },

  destroy() {
    clearTimeout(searchTimer);
  },
};
