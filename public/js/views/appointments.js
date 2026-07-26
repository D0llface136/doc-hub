/**
 * Appointment scheduler.
 *
 * A day/week grid grouped by clinician, plus a list view. Slot availability
 * comes from each clinician's weekly working hours minus what is booked.
 */
import { api } from '../api.js';
import { can } from '../store.js';
import {
  html, raw, render, on, emptyState, loadingState, statusBadge, fmtDate,
  fmtTime, fmtDateTime, titleCase, toastOk, toastWarn, reportError,
  openModal, confirmDialog, esc,
} from '../ui.js';

let context = null;
let state = { date: todayIso(), days: 1, view: 'calendar', doctorId: '' };
let searchTimer = null;

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function shiftDate(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function load(container) {
  render(container, html`
    <div class="toolbar">
      <div class="segmented">
        <button type="button" class="segmented__btn ${state.view === 'calendar' ? 'is-active' : ''}" data-view="calendar">Calendar</button>
        <button type="button" class="segmented__btn ${state.view === 'list' ? 'is-active' : ''}" data-view="list">List</button>
      </div>

      <div class="flex gap-sm">
        <button type="button" class="btn btn--sm btn--ghost" id="prev-day">‹</button>
        <input class="input" type="date" id="date-picker" value="${state.date}" style="min-width:150px">
        <button type="button" class="btn btn--sm btn--ghost" id="next-day">›</button>
        <button type="button" class="btn btn--sm btn--ghost" id="today-btn">Today</button>
      </div>

      <select class="select" id="range-picker" style="max-width:130px">
        <option value="1" ${state.days === 1 ? 'selected' : ''}>Day</option>
        <option value="7" ${state.days === 7 ? 'selected' : ''}>Week</option>
        <option value="31" ${state.days === 31 ? 'selected' : ''}>Month</option>
      </select>

      <div style="flex:1"></div>

      ${can('appointments:write') ? raw('<button type="button" class="btn btn--primary" id="new-appointment">New appointment</button>') : ''}
      ${can('appointments:write') ? raw('<button type="button" class="btn btn--ghost" id="working-hours">Working hours</button>') : ''}
    </div>

    <div id="appt-body">${raw(loadingState())}</div>`);

  wire(container);
  await fetchBody(container);
}

async function fetchBody(container) {
  const host = container.querySelector('#appt-body');
  if (!host) return;

  render(host, loadingState());

  try {
    if (state.view === 'calendar') {
      const calendar = await api.get('/appointments/calendar', {
        date: state.date,
        days: state.days,
        doctor_id: state.doctorId || undefined,
      });
      render(host, renderCalendar(calendar));
    } else {
      const from = new Date(`${state.date}T00:00:00`).toISOString();
      const to = new Date(`${shiftDate(state.date, state.days)}T00:00:00`).toISOString();
      const list = await api.get('/appointments', { from, to, limit: 100 });
      render(host, renderList(list));
    }
  } catch (err) {
    render(host, html`<div class="alert alert--error">${err.message}</div>`);
  }
}

function renderCalendar(calendar) {
  const { doctors, appointments } = calendar;

  if (doctors.length === 0) {
    return emptyState('No clinicians available', 'Add doctors or nurses under Settings → Staff.', '👤');
  }

  const byDoctor = new Map();
  const unassigned = [];

  for (const appointment of appointments) {
    if (!appointment.doctor_id) unassigned.push(appointment);
    else {
      if (!byDoctor.has(appointment.doctor_id)) byDoctor.set(appointment.doctor_id, []);
      byDoctor.get(appointment.doctor_id).push(appointment);
    }
  }

  const column = (title, subtitle, items) => html`
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">${title}</div>
          <p class="card__sub">${subtitle}</p>
        </div>
        <span class="badge ${items.length > 0 ? 'badge--accent' : ''}">${items.length}</span>
      </div>
      <div class="card__body--flush">
        ${items.length === 0
          ? raw('<div class="empty" style="padding:20px"><div class="muted" style="font-size:12.5px">Nothing booked</div></div>')
          : raw(items.map(renderSlot).join(''))}
      </div>
    </div>`;

  return html`
    <div class="grid grid--3">
      ${raw(doctors.map((doctor) => column(
        [doctor.display_title, doctor.full_name].filter(Boolean).join(' '),
        doctor.is_on_duty ? 'On duty' : 'Off duty',
        byDoctor.get(doctor.id) ?? []
      )).join(''))}
      ${unassigned.length > 0 ? raw(column('Unassigned', 'No clinician chosen', unassigned)) : ''}
    </div>`;
}

function renderSlot(appointment) {
  const cancelled = ['cancelled', 'no_show', 'rescheduled'].includes(appointment.status);

  return html`
    <div style="padding:10px 12px;border-bottom:1px solid var(--border-soft);${cancelled ? 'opacity:.55' : ''}"
         class="is-clickable" data-appointment="${appointment.id}">
      <div class="flex flex-between gap-sm">
        <strong class="mono">${fmtTime(appointment.scheduled_start)}</strong>
        ${raw(statusBadge(appointment.status))}
      </div>
      <div class="row-title mt-1">${appointment.patient_name}</div>
      <div class="row-sub">
        ${titleCase(appointment.appointment_type)}
        ${appointment.reason ? ` · ${appointment.reason.slice(0, 50)}` : ''}
      </div>
      ${state.days > 1 ? raw(html`<div class="muted" style="font-size:11px">${fmtDate(appointment.scheduled_start)}</div>`) : ''}
    </div>`;
}

function renderList(appointments) {
  if (appointments.length === 0) {
    return emptyState('No appointments in this range', 'Try a wider date range, or book one.', '📅');
  }

  return html`
    <div class="card">
      <div class="card__body--flush">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr><th>When</th><th>Patient</th><th class="col-optional">Clinician</th><th class="col-optional">Type</th><th>Reason</th><th>Status</th></tr>
            </thead>
            <tbody>
              ${raw(appointments.map((a) => html`
                <tr class="is-clickable" data-appointment="${a.id}">
                  <td class="nowrap">
                    <div class="row-title">${fmtTime(a.scheduled_start)}</div>
                    <div class="row-sub">${fmtDate(a.scheduled_start)}</div>
                  </td>
                  <td>
                    <div class="row-title">${a.patient_name}</div>
                    <div class="row-sub mono">${a.mrn}</div>
                  </td>
                  <td class="col-optional">${a.doctor_name ?? raw('<span class="muted">Unassigned</span>')}</td>
                  <td class="col-optional">${titleCase(a.appointment_type)}</td>
                  <td>${a.reason ?? '—'}</td>
                  <td>${raw(statusBadge(a.status))}</td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function wire(container) {
  on(container, 'click', '[data-view]', (_e, target) => {
    state.view = target.dataset.view;
    load(container);
  });

  container.querySelector('#date-picker').addEventListener('change', (e) => {
    state.date = e.target.value || todayIso();
    fetchBody(container);
  });

  container.querySelector('#prev-day').addEventListener('click', () => {
    state.date = shiftDate(state.date, -state.days);
    container.querySelector('#date-picker').value = state.date;
    fetchBody(container);
  });

  container.querySelector('#next-day').addEventListener('click', () => {
    state.date = shiftDate(state.date, state.days);
    container.querySelector('#date-picker').value = state.date;
    fetchBody(container);
  });

  container.querySelector('#today-btn').addEventListener('click', () => {
    state.date = todayIso();
    container.querySelector('#date-picker').value = state.date;
    fetchBody(container);
  });

  container.querySelector('#range-picker').addEventListener('change', (e) => {
    state.days = Number(e.target.value);
    fetchBody(container);
  });

  const newBtn = container.querySelector('#new-appointment');
  if (newBtn) newBtn.addEventListener('click', () => openBooking(container));

  const hoursBtn = container.querySelector('#working-hours');
  if (hoursBtn) hoursBtn.addEventListener('click', () => openWorkingHours());

  on(container, 'click', '[data-appointment]', async (_e, target) => {
    try {
      const appointment = await api.get(`/appointments/${target.dataset.appointment}`);
      showAppointment(container, appointment);
    } catch (err) {
      reportError(err);
    }
  });
}

async function openBooking(container, preset = {}) {
  const [doctors, nurses] = await Promise.all([
    api.get('/staff', { role: 'doctor', status: 'active', limit: 100 }),
    api.get('/staff', { role: 'nurse', status: 'active', limit: 100 }),
  ]);
  const clinicians = [...doctors, ...nurses];

  openModal({
    title: 'Book an appointment',
    wide: true,
    body: html`
      <label class="field">
        <span class="field__label">Patient *</span>
        <input class="input" id="ap-patient-search" placeholder="Search by name or MRN" autocomplete="off">
        <span class="field__hint" id="ap-patient-chosen">No patient selected.</span>
      </label>
      <div id="ap-patient-results" class="mb-2"></div>

      <div class="form-grid">
        <label class="field">
          <span class="field__label">Clinician</span>
          <select class="select" id="ap-doctor">
            <option value="">— Any available —</option>
            ${raw(clinicians.map((s) => html`<option value="${s.id}">${[s.display_title, s.full_name].filter(Boolean).join(' ')}</option>`).join(''))}
          </select>
        </label>
        <label class="field">
          <span class="field__label">Date *</span>
          <input class="input" type="date" id="ap-date" value="${preset.date ?? state.date}">
        </label>
        <label class="field">
          <span class="field__label">Time *</span>
          <input class="input" type="time" id="ap-time" value="09:00">
        </label>
        <label class="field">
          <span class="field__label">Duration</span>
          <select class="select" id="ap-duration">
            <option value="15">15 minutes</option>
            <option value="30" selected>30 minutes</option>
            <option value="45">45 minutes</option>
            <option value="60">1 hour</option>
            <option value="90">1.5 hours</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">Type</span>
          <select class="select" id="ap-type">
            <option value="consultation">Consultation</option>
            <option value="follow_up">Follow-up</option>
            <option value="physical">Physical</option>
            <option value="procedure">Procedure</option>
            <option value="lab">Laboratory</option>
            <option value="imaging">Imaging</option>
            <option value="vaccination">Vaccination</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">Repeats</span>
          <select class="select" id="ap-recurrence">
            <option value="">Does not repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
      </div>

      <label class="field" id="ap-until-field" hidden>
        <span class="field__label">Repeat until</span>
        <input class="input" type="date" id="ap-until">
      </label>

      <label class="field"><span class="field__label">Reason</span><input class="input" id="ap-reason" placeholder="Why is the patient coming in?"></label>
      <label class="field"><span class="field__label">Notes</span><textarea class="textarea" id="ap-notes"></textarea></label>

      <div id="ap-slots"></div>`,
    onMount(root) {
      const searchInput = root.querySelector('#ap-patient-search');
      const results = root.querySelector('#ap-patient-results');

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
                root.querySelector('#ap-patient-chosen').textContent = `Selected: ${btn.dataset.name}`;
                results.querySelectorAll('[data-pick]').forEach((b) => b.classList.remove('btn--primary'));
                btn.classList.add('btn--primary');
              });
            });
          } catch { /* keep previous results */ }
        }, 300);
      });

      root.querySelector('#ap-recurrence').addEventListener('change', (e) => {
        root.querySelector('#ap-until-field').hidden = !e.target.value;
      });

      // Show the clinician's free slots once both a clinician and a date exist.
      const refreshSlots = async () => {
        const doctorId = root.querySelector('#ap-doctor').value;
        const date = root.querySelector('#ap-date').value;
        const slotHost = root.querySelector('#ap-slots');

        if (!doctorId || !date) {
          slotHost.innerHTML = '';
          return;
        }

        try {
          const { slots, reason } = await api.get('/appointments/availability', { doctor_id: doctorId, date });

          if (!slots || slots.length === 0) {
            render(slotHost, html`<div class="alert alert--warn">${reason ?? 'No working hours set for that day.'}</div>`);
            return;
          }

          render(slotHost, html`
            <div class="field__label">Available slots</div>
            <div class="flex flex-wrap gap-sm">
              ${raw(slots.map((slot) => html`
                <button type="button" class="btn btn--sm ${slot.available ? 'btn--ghost' : 'btn--ghost'}"
                        data-slot="${slot.start}" ${slot.available ? '' : 'disabled'}>
                  ${fmtTime(slot.start)}
                </button>`).join(''))}
            </div>`);

          slotHost.querySelectorAll('[data-slot]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const start = new Date(btn.dataset.slot);
              root.querySelector('#ap-time').value =
                `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
              slotHost.querySelectorAll('[data-slot]').forEach((b) => b.classList.remove('btn--primary'));
              btn.classList.add('btn--primary');
            });
          });
        } catch { /* slots are a convenience */ }
      };

      root.querySelector('#ap-doctor').addEventListener('change', refreshSlots);
      root.querySelector('#ap-date').addEventListener('change', refreshSlots);
    },
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Book appointment',
        class: 'btn--primary',
        onClick: async (root) => {
          const patientId = root.dataset.patient;
          if (!patientId) {
            toastWarn('Search for and select a patient first.');
            return true;
          }

          const date = root.querySelector('#ap-date').value;
          const time = root.querySelector('#ap-time').value;
          if (!date || !time) {
            toastWarn('Pick a date and time.');
            return true;
          }

          const start = new Date(`${date}T${time}`);
          const recurrence = root.querySelector('#ap-recurrence').value;

          const result = await api.post('/appointments', {
            patient_id: patientId,
            doctor_id: root.querySelector('#ap-doctor').value || null,
            scheduled_start: start.toISOString(),
            duration_minutes: Number(root.querySelector('#ap-duration').value),
            appointment_type: root.querySelector('#ap-type').value,
            reason: root.querySelector('#ap-reason').value.trim() || null,
            notes: root.querySelector('#ap-notes').value.trim() || null,
            recurrence_rule: recurrence || null,
            recurrence_until: recurrence ? root.querySelector('#ap-until').value || null : null,
          });

          toastOk(result.series_count > 1
            ? `${result.series_count} appointments booked.`
            : 'Appointment booked.');
          await fetchBody(container);
        },
      },
    ],
  });
}

function showAppointment(container, appointment) {
  const canWrite = can('appointments:write');
  const closed = ['completed', 'cancelled'].includes(appointment.status);

  const actions = [{ label: 'Close', class: 'btn--ghost' }];

  if (canWrite && !closed) {
    actions.unshift({
      label: 'Cancel appointment',
      class: 'btn--danger',
      onClick: async () => {
        const confirmed = await confirmDialog({
          title: 'Cancel appointment',
          message: `Cancel ${appointment.patient_name}'s appointment on ${fmtDateTime(appointment.scheduled_start)}?`,
          confirmLabel: 'Cancel it',
          danger: true,
        });
        if (!confirmed) return;

        await api.post(`/appointments/${appointment.id}/cancel`, { reason: 'Cancelled by clinic', cancel_series: false });
        toastOk('Appointment cancelled.');
        await fetchBody(container);
      },
    });

    actions.unshift({
      label: 'Reschedule',
      class: 'btn--ghost',
      onClick: () => { openReschedule(container, appointment); },
    });
  }

  if (can('visits:write') && ['scheduled', 'confirmed'].includes(appointment.status)) {
    actions.push({
      label: 'Check in now',
      class: 'btn--primary',
      onClick: async () => {
        const visit = await api.post('/visits/checkin', {
          patient_id: appointment.patient_id,
          appointment_id: appointment.id,
          visit_type: 'scheduled',
          chief_complaint: appointment.reason ?? null,
          assigned_doctor_id: appointment.doctor_id ?? null,
        });
        toastOk(`Checked in as queue #${visit.queue_number}.`);
        context.refreshBadges();
        context.navigate(`/visits/${visit.id}`);
      },
    });
  }

  openModal({
    title: 'Appointment',
    body: html`
      <dl class="kv">
        <dt>Patient</dt><dd><a href="#/patients/${appointment.patient_id}">${appointment.patient_name}</a> (${appointment.mrn})</dd>
        <dt>When</dt><dd>${fmtDateTime(appointment.scheduled_start)} – ${fmtTime(appointment.scheduled_end)}</dd>
        <dt>Clinician</dt><dd>${appointment.doctor_name ?? 'Unassigned'}</dd>
        <dt>Type</dt><dd>${titleCase(appointment.appointment_type)}</dd>
        <dt>Status</dt><dd>${raw(statusBadge(appointment.status))}</dd>
        <dt>Reason</dt><dd>${appointment.reason ?? '—'}</dd>
        ${appointment.patient_phone ? raw(html`<dt>Phone</dt><dd>${appointment.patient_phone}</dd>`) : ''}
        ${appointment.recurrence_rule ? raw(html`<dt>Repeats</dt><dd>${titleCase(appointment.recurrence_rule)} until ${fmtDate(appointment.recurrence_until)}</dd>`) : ''}
      </dl>
      ${appointment.notes ? raw(html`<div class="mt-2"><div class="field__label">Notes</div><div class="pre-wrap">${appointment.notes}</div></div>`) : ''}
      ${appointment.cancelled_reason ? raw(html`<div class="alert alert--warn mt-2">Cancelled: ${appointment.cancelled_reason}</div>`) : ''}`,
    actions,
  });
}

function openReschedule(container, appointment) {
  const start = new Date(appointment.scheduled_start);
  const isoDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;

  openModal({
    title: 'Reschedule appointment',
    body: html`
      <div class="form-grid">
        <label class="field"><span class="field__label">New date *</span><input class="input" type="date" id="rs-date" value="${isoDate}"></label>
        <label class="field"><span class="field__label">New time *</span><input class="input" type="time" id="rs-time" value="${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}"></label>
        <label class="field">
          <span class="field__label">Duration</span>
          <select class="select" id="rs-duration">
            <option value="15">15 minutes</option>
            <option value="30" selected>30 minutes</option>
            <option value="45">45 minutes</option>
            <option value="60">1 hour</option>
          </select>
        </label>
      </div>
      <label class="field"><span class="field__label">Reason for the change</span><input class="input" id="rs-reason"></label>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Reschedule',
        class: 'btn--primary',
        onClick: async (root) => {
          const date = root.querySelector('#rs-date').value;
          const time = root.querySelector('#rs-time').value;
          if (!date || !time) {
            toastWarn('Pick a date and time.');
            return true;
          }

          await api.post(`/appointments/${appointment.id}/reschedule`, {
            scheduled_start: new Date(`${date}T${time}`).toISOString(),
            duration_minutes: Number(root.querySelector('#rs-duration').value),
            reason: root.querySelector('#rs-reason').value.trim() || null,
          });

          toastOk('Appointment rescheduled.');
          await fetchBody(container);
        },
      },
    ],
  });
}

async function openWorkingHours() {
  const doctors = await api.get('/staff', { role: 'doctor', status: 'active', limit: 100 });
  if (doctors.length === 0) {
    toastWarn('No doctors to configure.');
    return;
  }

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const renderRows = (windows) => DAYS.map((label, day) => {
    const existing = windows.find((w) => w.day_of_week === day);
    return html`
      <tr>
        <td>
          <label class="flex gap-sm" style="cursor:pointer">
            <input type="checkbox" data-day="${day}" ${existing ? 'checked' : ''}>
            <span>${label}</span>
          </label>
        </td>
        <td><input class="input" type="time" data-start="${day}" value="${existing ? String(existing.start_time).slice(0, 5) : '09:00'}"></td>
        <td><input class="input" type="time" data-end="${day}" value="${existing ? String(existing.end_time).slice(0, 5) : '17:00'}"></td>
        <td><input class="input" type="number" min="5" max="240" step="5" data-slot="${day}" value="${existing?.slot_minutes ?? 30}"></td>
      </tr>`;
  }).join('');

  openModal({
    title: 'Working hours',
    wide: true,
    body: html`
      <label class="field">
        <span class="field__label">Clinician</span>
        <select class="select" id="wh-doctor">
          ${raw(doctors.map((d) => html`<option value="${d.id}">${[d.display_title, d.full_name].filter(Boolean).join(' ')}</option>`).join(''))}
        </select>
      </label>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Day</th><th>From</th><th>To</th><th>Slot (min)</th></tr></thead>
          <tbody id="wh-rows"></tbody>
        </table>
      </div>`,
    onMount(root) {
      const select = root.querySelector('#wh-doctor');
      const load = async () => {
        try {
          const windows = await api.get(`/appointments/availability/${select.value}`);
          root.querySelector('#wh-rows').innerHTML = renderRows(windows);
        } catch (err) {
          reportError(err);
        }
      };
      select.addEventListener('change', load);
      load();
    },
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Save hours',
        class: 'btn--primary',
        onClick: async (root) => {
          const doctorId = root.querySelector('#wh-doctor').value;
          const windows = [];

          root.querySelectorAll('[data-day]').forEach((box) => {
            if (!box.checked) return;
            const day = Number(box.dataset.day);
            windows.push({
              day_of_week: day,
              start_time: root.querySelector(`[data-start="${day}"]`).value,
              end_time: root.querySelector(`[data-end="${day}"]`).value,
              slot_minutes: Number(root.querySelector(`[data-slot="${day}"]`).value) || 30,
            });
          });

          await api.put(`/appointments/availability/${doctorId}`, { windows });
          toastOk('Working hours saved.');
        },
      },
    ],
  });
}

export default {
  async render(container, ctx) {
    context = ctx;
    state = { date: todayIso(), days: 1, view: 'calendar', doctorId: '' };
    ctx.setTitle('Appointments', 'Scheduling calendar');
    await load(container);
  },

  destroy() {
    clearTimeout(searchTimer);
  },
};
