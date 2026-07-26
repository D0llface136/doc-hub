/**
 * Home dashboard.
 *
 * One `/api/stats/dashboard` call fills every widget, then live events refresh
 * it in place. Quick-access buttons are filtered by permission, so a
 * receptionist does not see a pharmacy shortcut they cannot use.
 */
import { api } from '../api.js';
import { store, can } from '../store.js';
import {
  html, raw, render, statCard, emptyState, fmtDuration, fmtMoney, fmtAgo,
  fmtDateTime, statusBadge, reportError, esc,
} from '../ui.js';
import { onEvent } from '../realtime.js';

const QUICK_ACTIONS = [
  { label: 'Patient Search', href: '/patients', permission: 'patients:read', icon: '🔍' },
  { label: 'New Patient', href: '/patients?new=1', permission: 'patients:write', icon: '➕' },
  { label: 'Check-In', href: '/checkin', permission: 'visits:write', icon: '📋' },
  { label: 'Waiting Room', href: '/queue', permission: 'visits:read', icon: '🕒' },
  { label: 'Appointments', href: '/appointments', permission: 'appointments:read', icon: '📅' },
  { label: 'Pharmacy', href: '/pharmacy', permission: 'pharmacy:read', icon: '💊' },
  { label: 'Laboratory', href: '/laboratory', permission: 'lab:read', icon: '🧪' },
  { label: 'Radiology', href: '/radiology', permission: 'radiology:read', icon: '🩻' },
  { label: 'Billing', href: '/billing', permission: 'billing:read', icon: '🧾' },
  { label: 'Messages', href: '/messages', permission: 'messaging:read', icon: '✉️' },
  { label: 'Reports', href: '/reports', permission: 'stats:read', icon: '📊' },
  { label: 'Settings', href: '/settings', icon: '⚙️' },
];

let unsubscribers = [];
let refreshTimer = null;

async function load(container, ctx) {
  let data;
  try {
    data = await api.dashboard();
  } catch (err) {
    reportError(err);
    render(container, html`<div class="alert alert--error">Could not load the dashboard: ${err.message}</div>`);
    return;
  }

  const staff = store.staff;
  const greeting = greetingFor(new Date());

  ctx.setTitle('Dashboard', `${greeting}, ${staff.display_title ? `${staff.display_title} ` : ''}${staff.full_name}`);

  render(container, html`
    ${raw(renderEmergencies(data.emergencies))}
    ${raw(renderStats(data))}
    ${raw(renderQuickActions())}

    <div class="grid grid--2 mt-2">
      ${raw(renderQueuePreview(data))}
      ${raw(renderActiveStaff(data.active_staff))}
    </div>

    <div class="grid grid--2 mt-2">
      ${raw(renderDepartments(data))}
      ${raw(renderNotifications(data.recent_notifications))}
    </div>
  `);
}

function greetingFor(date) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function renderEmergencies(emergencies) {
  if (!emergencies || emergencies.length === 0) return '';

  return html`
    <div class="card mb-2" style="border-color:var(--danger)">
      <div class="card__head">
        <div>
          <div class="card__title" style="color:var(--danger)">Active emergency codes</div>
          <p class="card__sub">${emergencies.length} code(s) currently active</p>
        </div>
        <a class="btn btn--sm btn--danger" href="#/emergency">Open emergency board</a>
      </div>
      <div class="card__body--flush">
        <div class="table-wrap">
          <table class="table">
            <tbody>
              ${raw(emergencies.map((e) => html`
                <tr>
                  <td><strong>${e.code_type.replace(/_/g, ' ').toUpperCase()}</strong></td>
                  <td>${e.location ?? '—'}</td>
                  <td class="col-optional">${e.description ?? ''}</td>
                  <td class="muted nowrap">${fmtAgo(e.activated_at)}</td>
                  <td>${raw(statusBadge(e.status))}</td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderStats(data) {
  const tiles = [];

  tiles.push(statCard({
    label: 'Patients waiting',
    value: data.queue.waiting,
    meta: data.queue.longest_wait_minutes > 0 ? `Longest wait ${fmtDuration(data.queue.longest_wait_minutes)}` : 'Queue is clear',
    tone: data.queue.waiting > 5 ? 'warn' : data.queue.waiting > 0 ? 'accent' : 'ok',
    href: can('visits:read') ? '/queue' : null,
  }));

  tiles.push(statCard({
    label: 'Being seen',
    value: data.queue.being_seen,
    meta: `${data.active_staff.length} clinician(s) on duty`,
    tone: 'accent',
    href: can('visits:read') ? '/queue' : null,
  }));

  tiles.push(statCard({
    label: 'Active emergencies',
    value: data.emergencies.length,
    meta: data.queue.emergency_waiting > 0 ? `${data.queue.emergency_waiting} emergency in queue` : 'No active codes',
    tone: data.emergencies.length > 0 ? 'danger' : 'ok',
    href: can('emergency:activate') ? '/emergency' : null,
  }));

  tiles.push(statCard({
    label: "Today's appointments",
    value: data.appointments.total,
    meta: `${data.appointments.upcoming} upcoming · ${data.appointments.completed} done`,
    href: can('appointments:read') ? '/appointments' : null,
  }));

  tiles.push(statCard({
    label: 'Visits today',
    value: data.today.total,
    meta: `${data.today.completed} completed · avg wait ${fmtDuration(data.today.avg_wait_minutes)}`,
  }));

  if (can('pharmacy:read')) {
    tiles.push(statCard({
      label: 'Pending prescriptions',
      value: data.pharmacy.pending,
      meta: `${data.pharmacy.ready} ready for collection`,
      tone: data.pharmacy.pending > 0 ? 'warn' : 'ok',
      href: '/pharmacy',
    }));
  }

  if (can('lab:read')) {
    tiles.push(statCard({
      label: 'Pending lab orders',
      value: data.laboratory.pending,
      meta: data.laboratory.pending_stat > 0 ? `${data.laboratory.pending_stat} STAT` : `${data.laboratory.completed_today} done today`,
      tone: data.laboratory.pending_stat > 0 ? 'danger' : data.laboratory.pending > 0 ? 'warn' : 'ok',
      href: '/laboratory',
    }));
  }

  if (can('billing:read')) {
    tiles.push(statCard({
      label: "Today's revenue",
      value: fmtMoney(data.revenue.today),
      meta: `${fmtMoney(data.revenue.outstanding)} outstanding`,
      tone: 'ok',
      href: '/billing',
    }));
  }

  return html`<div class="grid grid--stats">${raw(tiles.join(''))}</div>`;
}

function renderQuickActions() {
  const actions = QUICK_ACTIONS.filter((a) => !a.permission || can(a.permission));

  return html`
    <div class="card mt-2">
      <div class="card__head"><div class="card__title">Quick access</div></div>
      <div class="card__body">
        <div class="btn-row">
          ${raw(actions.map((a) => html`
            <a class="btn btn--ghost" href="#${a.href}">
              <span aria-hidden="true">${a.icon}</span> ${a.label}
            </a>`).join(''))}
        </div>
      </div>
    </div>`;
}

function renderQueuePreview(data) {
  const { queue } = data;

  return html`
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">Waiting room</div>
          <p class="card__sub">${queue.waiting} waiting · ${queue.being_seen} in consultation</p>
        </div>
        ${can('visits:read') ? raw('<a class="btn btn--sm btn--ghost" href="#/queue">Open</a>') : ''}
      </div>
      <div class="card__body" id="dash-queue">
        <div class="loading"><span class="spinner"></span></div>
      </div>
    </div>`;
}

async function fillQueuePreview() {
  const host = document.getElementById('dash-queue');
  if (!host || !can('visits:read')) return;

  try {
    const { queue } = await api.queue({ include_in_progress: 'false' });
    const top = queue.slice(0, 5);

    if (top.length === 0) {
      render(host, emptyState('Waiting room is empty', 'Checked-in patients appear here.', '✓'));
      return;
    }

    render(host, html`
      <div class="table-wrap">
        <table class="table">
          <tbody>
            ${raw(top.map((entry) => html`
              <tr class="is-clickable priority-${entry.priority}" data-href="/visits/${entry.visit_id}">
                <td style="width:44px"><strong>#${entry.queue_number}</strong></td>
                <td>
                  <div class="row-title">${entry.patient_name}</div>
                  <div class="row-sub">${entry.chief_complaint ?? 'No complaint recorded'}</div>
                </td>
                <td class="col-optional muted nowrap">${fmtDuration(entry.waiting_minutes)}</td>
                <td class="text-right">${raw(entry.priority === 'normal' ? '' : statusBadge(entry.priority))}</td>
              </tr>`).join(''))}
          </tbody>
        </table>
      </div>`);
  } catch (err) {
    render(host, html`<div class="alert alert--error">${err.message}</div>`);
  }
}

function renderActiveStaff(staffList) {
  if (!staffList || staffList.length === 0) {
    return html`
      <div class="card">
        <div class="card__head"><div class="card__title">On duty</div></div>
        <div class="card__body">${raw(emptyState('Nobody on duty', 'Flip the "On duty" switch to appear here.', '👤'))}</div>
      </div>`;
  }

  return html`
    <div class="card">
      <div class="card__head">
        <div class="card__title">On duty</div>
        <span class="badge badge--ok">${staffList.length}</span>
      </div>
      <div class="card__body--flush">
        <div class="table-wrap">
          <table class="table">
            <tbody>
              ${raw(staffList.map((s) => html`
                <tr>
                  <td>
                    <div class="row-title">${[s.display_title, s.full_name].filter(Boolean).join(' ')}</div>
                    <div class="row-sub">${s.role_name}</div>
                  </td>
                  <td class="text-right nowrap">
                    ${s.active_patients > 0
                      ? raw(html`<span class="badge badge--accent">${s.active_patients} with patient</span>`)
                      : raw('<span class="badge badge--ok">Available</span>')}
                  </td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderDepartments(data) {
  const rows = [];

  if (can('pharmacy:read')) {
    rows.push({ label: 'Pharmacy — pending', value: data.pharmacy.pending, href: '/pharmacy' });
    rows.push({ label: 'Pharmacy — ready', value: data.pharmacy.ready, href: '/pharmacy' });
  }
  if (can('lab:read')) {
    rows.push({ label: 'Laboratory — pending', value: data.laboratory.pending, href: '/laboratory' });
    rows.push({ label: 'Laboratory — done today', value: data.laboratory.completed_today, href: '/laboratory' });
  }
  rows.push({ label: 'Visits admitted today', value: data.today.admitted });
  rows.push({ label: 'No-shows today', value: data.today.no_shows });

  if (rows.length === 0) return '';

  return html`
    <div class="card">
      <div class="card__head"><div class="card__title">Department activity</div></div>
      <div class="card__body--flush">
        <div class="table-wrap">
          <table class="table">
            <tbody>
              ${raw(rows.map((row) => html`
                <tr ${row.href ? raw(`class="is-clickable" data-href="${esc(row.href)}"`) : ''}>
                  <td>${row.label}</td>
                  <td class="num"><strong>${row.value}</strong></td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderNotifications(notifications) {
  if (!notifications || notifications.length === 0) {
    return html`
      <div class="card">
        <div class="card__head"><div class="card__title">Recent notifications</div></div>
        <div class="card__body">${raw(emptyState('All caught up', 'New alerts will show here.', '✓'))}</div>
      </div>`;
  }

  return html`
    <div class="card">
      <div class="card__head"><div class="card__title">Recent notifications</div></div>
      <div class="card__body--flush">
        ${raw(notifications.map((n) => html`
          <div class="notif ${n.read_at ? 'is-read' : 'is-unread'}" ${n.link ? raw(`data-href="${esc(n.link.replace('#', ''))}"`) : ''}>
            <span class="notif__dot"></span>
            <div>
              <div class="notif__title">${n.title}</div>
              ${n.body ? raw(html`<div class="notif__body">${n.body}</div>`) : ''}
              <div class="notif__time">${fmtDateTime(n.created_at)}</div>
            </div>
          </div>`).join(''))}
      </div>
    </div>`;
}

export default {
  async render(container, ctx) {
    await load(container, ctx);
    fillQueuePreview();

    // Refresh when the things this screen shows actually change, plus a slow
    // safety net for the counters that have no event of their own.
    const reload = () => load(container, ctx).then(fillQueuePreview);
    unsubscribers = [
      onEvent('queue:updated', reload),
      onEvent('pharmacy:updated', reload),
      onEvent('laboratory:updated', reload),
      onEvent('emergency:activated', reload),
      onEvent('emergency:resolved', reload),
      onEvent('poll', reload),
    ];
    refreshTimer = setInterval(reload, 120_000);
  },

  destroy() {
    unsubscribers.forEach((off) => off());
    unsubscribers = [];
    clearInterval(refreshTimer);
    refreshTimer = null;
  },
};
