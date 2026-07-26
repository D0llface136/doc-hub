/**
 * Waiting room queue.
 *
 * Sorted by triage priority then arrival. Refreshes on the `queue:updated`
 * event so two receptionists never work from different lists, plus a slow
 * timer that keeps the "waiting for N minutes" figures honest.
 */
import { api } from '../api.js';
import { can } from '../store.js';
import {
  html, raw, render, on, statCard, emptyState, statusBadge, fmtDuration, fmtTime,
  toastOk, reportError, openModal, confirmDialog, promptDialog, esc, loadingState,
} from '../ui.js';
import { onEvent } from '../realtime.js';

let unsubscribe = null;
let tickTimer = null;
let currentFilter = 'all';
let context = null;

const FILTERS = [
  ['all', 'All'],
  ['emergency', 'Emergency'],
  ['urgent', 'Urgent'],
  ['normal', 'Normal'],
];

async function load(container) {
  let payload;
  try {
    payload = await api.queue();
  } catch (err) {
    render(container, html`<div class="alert alert--error">${err.message}</div>`);
    return;
  }

  const { queue, summary } = payload;
  const visible = currentFilter === 'all' ? queue : queue.filter((entry) => entry.priority === currentFilter);

  render(container, html`
    <div class="grid grid--stats mb-2">
      ${raw(statCard({ label: 'Waiting', value: summary.waiting, tone: summary.waiting > 5 ? 'warn' : 'accent' }))}
      ${raw(statCard({ label: 'In consultation', value: summary.being_seen }))}
      ${raw(statCard({ label: 'Emergency', value: summary.emergency, tone: summary.emergency > 0 ? 'danger' : 'ok' }))}
      ${raw(statCard({ label: 'Urgent', value: summary.urgent, tone: summary.urgent > 0 ? 'warn' : 'ok' }))}
      ${raw(statCard({ label: 'Longest wait', value: fmtDuration(summary.longest_wait_minutes), tone: summary.longest_wait_minutes > 45 ? 'danger' : undefined }))}
      ${raw(statCard({ label: 'Clinicians on duty', value: summary.active_doctors, meta: `avg consult ${summary.average_consult_minutes}m` }))}
    </div>

    <div class="toolbar">
      <div class="segmented">
        ${raw(FILTERS.map(([value, label]) => html`
          <button type="button" class="segmented__btn ${currentFilter === value ? 'is-active' : ''}" data-filter="${value}">${label}</button>`).join(''))}
      </div>
      <div style="flex:1"></div>
      ${can('queue:manage') ? raw(html`
        <button type="button" class="btn btn--primary" id="call-next" ${summary.waiting === 0 ? 'disabled' : ''}>
          Call next patient
        </button>`) : ''}
      ${can('visits:write') ? raw('<a class="btn btn--ghost" href="#/checkin">Check in a patient</a>') : ''}
    </div>

    <div class="card">
      <div class="card__body--flush">
        ${visible.length === 0
          ? raw(emptyState(
              currentFilter === 'all' ? 'The waiting room is empty' : `No ${currentFilter} patients waiting`,
              'Patients appear here as they are checked in.',
              '✓'))
          : raw(renderTable(visible))}
      </div>
    </div>
  `);

  wire(container);
}

function renderTable(entries) {
  return html`
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th style="width:52px">Queue</th>
            <th>Patient</th>
            <th class="col-optional">Reason</th>
            <th class="col-optional">Clinician</th>
            <th>Waiting</th>
            <th class="col-optional">Est.</th>
            <th>Status</th>
            <th style="width:130px"></th>
          </tr>
        </thead>
        <tbody>
          ${raw(entries.map(renderRow).join(''))}
        </tbody>
      </table>
    </div>`;
}

function renderRow(entry) {
  const waitTone = entry.waiting_minutes > 45 ? 'vital--red' : entry.waiting_minutes > 20 ? 'vital--yellow' : '';

  return html`
    <tr class="priority-${entry.priority}" data-visit="${entry.visit_id}">
      <td><strong>#${entry.queue_number}</strong></td>
      <td class="is-clickable" data-href="/visits/${entry.visit_id}">
        <div class="row-title">
          ${entry.patient_name}
          ${entry.critical_allergies > 0 ? raw('<span class="badge badge--danger" title="Severe allergies on file">⚠ allergy</span>') : ''}
        </div>
        <div class="row-sub">
          ${entry.mrn}${entry.patient_age !== null && entry.patient_age !== undefined ? ` · ${entry.patient_age}y` : ''}
          · in at ${fmtTime(entry.checked_in_at)}
        </div>
      </td>
      <td class="col-optional">${entry.chief_complaint ?? '—'}</td>
      <td class="col-optional">${entry.doctor_name ?? raw('<span class="muted">Unassigned</span>')}</td>
      <td class="nowrap ${waitTone}">${fmtDuration(entry.waiting_minutes)}</td>
      <td class="col-optional muted nowrap">${entry.status === 'waiting' ? `~${entry.estimated_wait_minutes}m` : '—'}</td>
      <td>
        ${raw(statusBadge(entry.status))}
        ${raw(entry.priority === 'normal' ? '' : statusBadge(entry.priority))}
      </td>
      <td class="text-right nowrap">
        ${can('queue:manage') && entry.status === 'waiting'
          ? raw(html`<button type="button" class="btn btn--sm btn--primary" data-act="call" data-id="${entry.visit_id}">Call</button>`)
          : ''}
        <button type="button" class="btn btn--sm btn--ghost" data-act="menu" data-id="${entry.visit_id}" aria-label="More actions">⋯</button>
      </td>
    </tr>`;
}

function wire(container) {
  on(container, 'click', '[data-filter]', (_e, target) => {
    currentFilter = target.dataset.filter;
    load(container);
  });

  const callNext = container.querySelector('#call-next');
  if (callNext) {
    callNext.addEventListener('click', async () => {
      callNext.disabled = true;
      try {
        const result = await api.post('/queue/call-next', { assign_to_me: can('records:write') });
        if (!result.called) {
          toastOk(result.message ?? 'Nobody is waiting.');
        } else {
          toastOk(`Now seeing ${result.called.patient_name} (queue #${result.called.queue_number}).`);
          context.navigate(`/visits/${result.called.id}`);
          return;
        }
      } catch (err) {
        reportError(err);
      } finally {
        callNext.disabled = false;
        load(container);
      }
    });
  }

  on(container, 'click', '[data-act="call"]', async (e, target) => {
    e.stopPropagation();
    try {
      await api.post(`/queue/${target.dataset.id}/call`, { assign_to_me: can('records:write') });
      toastOk('Patient called.');
      context.navigate(`/visits/${target.dataset.id}`);
    } catch (err) {
      reportError(err);
      load(container);
    }
  });

  on(container, 'click', '[data-act="menu"]', (e, target) => {
    e.stopPropagation();
    openActions(container, target.dataset.id);
  });
}

function openActions(container, visitId) {
  const actions = [
    { key: 'open', label: 'Open visit record', always: true },
    { key: 'priority', label: 'Change priority', permission: 'queue:manage' },
    { key: 'transfer', label: 'Transfer to clinician', permission: 'queue:manage' },
    { key: 'notify', label: 'Notify assigned clinician', permission: 'queue:manage' },
    { key: 'noshow', label: 'Mark as no-show', permission: 'queue:manage', danger: true },
  ].filter((a) => a.always || can(a.permission));

  openModal({
    title: 'Queue actions',
    body: html`
      <div class="btn-row" style="flex-direction:column;align-items:stretch">
        ${raw(actions.map((a) => html`
          <button type="button" class="btn ${a.danger ? 'btn--danger' : 'btn--ghost'} btn--block" data-queue-act="${a.key}">${a.label}</button>`).join(''))}
      </div>`,
    actions: [{ label: 'Close', class: 'btn--ghost' }],
    onMount(root) {
      root.querySelectorAll('[data-queue-act]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const { closeModal } = await import('../ui.js');
          closeModal();
          await runAction(btn.dataset.queueAct, visitId, container);
        });
      });
    },
  });
}

async function runAction(action, visitId, container) {
  try {
    if (action === 'open') {
      context.navigate(`/visits/${visitId}`);
      return;
    }

    if (action === 'priority') {
      openModal({
        title: 'Set triage priority',
        body: html`
          <label class="field">
            <span class="field__label">Priority</span>
            <select class="select" id="q-priority">
              <option value="normal">Normal</option>
              <option value="urgent">Urgent</option>
              <option value="emergency">Emergency</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">Reason (optional)</span>
            <input class="input" id="q-reason" placeholder="Clinical justification">
          </label>`,
        actions: [
          { label: 'Cancel', class: 'btn--ghost' },
          {
            label: 'Apply',
            class: 'btn--primary',
            onClick: async (root) => {
              await api.post(`/queue/${visitId}/priority`, {
                priority: root.querySelector('#q-priority').value,
                reason: root.querySelector('#q-reason').value.trim() || null,
              });
              toastOk('Priority updated.');
              load(container);
            },
          },
        ],
      });
      return;
    }

    if (action === 'transfer') {
      const clinicians = await api.get('/staff', { role: 'doctor', status: 'active', limit: 100 });
      const nurses = await api.get('/staff', { role: 'nurse', status: 'active', limit: 100 });
      const options = [...clinicians, ...nurses];

      openModal({
        title: 'Transfer patient',
        body: html`
          <label class="field">
            <span class="field__label">Assign to</span>
            <select class="select" id="q-doctor">
              <option value="">— Unassigned —</option>
              ${raw(options.map((s) => html`
                <option value="${s.id}">${[s.display_title, s.full_name].filter(Boolean).join(' ')} — ${s.role_name}${s.is_on_duty ? ' (on duty)' : ''}</option>`).join(''))}
            </select>
          </label>
          <label class="field">
            <span class="field__label">Handover note (optional)</span>
            <textarea class="textarea" id="q-note" placeholder="Anything the receiving clinician should know"></textarea>
          </label>`,
        actions: [
          { label: 'Cancel', class: 'btn--ghost' },
          {
            label: 'Transfer',
            class: 'btn--primary',
            onClick: async (root) => {
              await api.post(`/queue/${visitId}/transfer`, {
                doctor_id: root.querySelector('#q-doctor').value || null,
                note: root.querySelector('#q-note').value.trim() || null,
              });
              toastOk('Patient transferred.');
              load(container);
            },
          },
        ],
      });
      return;
    }

    if (action === 'notify') {
      const message = await promptDialog({
        title: 'Notify clinician',
        label: 'Message',
        placeholder: 'e.g. Patient is deteriorating in the waiting room',
        multiline: true,
        confirmLabel: 'Send',
      });
      if (!message) return;

      await api.post(`/queue/${visitId}/notify`, { title: 'Waiting room', body: message });
      toastOk('Notification sent.');
      return;
    }

    if (action === 'noshow') {
      const confirmed = await confirmDialog({
        title: 'Mark as no-show',
        message: 'This closes the visit and removes the patient from the queue. Continue?',
        confirmLabel: 'Mark no-show',
        danger: true,
      });
      if (!confirmed) return;

      await api.post(`/queue/${visitId}/no-show`, { reason: 'Did not respond when called' });
      toastOk('Marked as a no-show.');
      load(container);
    }
  } catch (err) {
    reportError(err);
  }
}

export default {
  async render(container, ctx) {
    context = ctx;
    ctx.setTitle('Waiting Room', 'Live triage queue');
    render(container, loadingState());

    await load(container);

    unsubscribe = onEvent('queue:updated', () => load(container));
    // Wait timers drift; recompute them every half minute without a round trip
    // being strictly necessary, but a fetch also picks up other clients' work.
    tickTimer = setInterval(() => load(container), 30_000);
  },

  destroy() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    clearInterval(tickTimer);
    tickTimer = null;
    currentFilter = 'all';
  },
};
