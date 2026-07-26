/**
 * Application shell: authentication, navigation, routing and the pieces of
 * chrome that live outside any single view (emergency banner, notification
 * drawer, live-connection indicator).
 */
import { api, token, setUnauthorizedHandler, ApiError } from './api.js';
import { store, setState, patchState, can, subscribe } from './store.js';
import { connect, disconnect, onEvent } from './realtime.js';
import {
  $, html, raw, esc, render, toast, toastOk, toastError, reportError,
  openModal, closeModal, confirmDialog, initials, fmtAgo, setCurrency,
  playAlert, loadingState, emptyState,
} from './ui.js';

// --- Route table -----------------------------------------------------------
//
// Views are loaded on demand. The SL browser parses everything it downloads,
// so not shipping fifteen screens to a receptionist who only uses two keeps
// the HUD responsive.

const ROUTES = {
  dashboard:     { load: () => import('./views/dashboard.js'),    title: 'Dashboard' },
  queue:         { load: () => import('./views/queue.js'),        title: 'Waiting Room', permission: 'visits:read' },
  checkin:       { load: () => import('./views/checkin.js'),      title: 'Patient Check-In', permission: 'visits:write' },
  patients:      { load: () => import('./views/patients.js'),     title: 'Patients', permission: 'patients:read' },
  visits:        { load: () => import('./views/visit.js'),        title: 'Visit', permission: 'visits:read' },
  appointments:  { load: () => import('./views/appointments.js'), title: 'Appointments', permission: 'appointments:read' },
  pharmacy:      { load: () => import('./views/pharmacy.js'),     title: 'Pharmacy', permission: 'pharmacy:read' },
  laboratory:    { load: () => import('./views/laboratory.js'),   title: 'Laboratory', permission: 'lab:read' },
  radiology:     { load: () => import('./views/radiology.js'),    title: 'Radiology', permission: 'radiology:read' },
  surgery:       { load: () => import('./views/surgery.js'),      title: 'Surgery', permission: 'surgery:read' },
  billing:       { load: () => import('./views/billing.js'),      title: 'Billing', permission: 'billing:read' },
  messages:      { load: () => import('./views/messages.js'),     title: 'Staff Messages', permission: 'messaging:read' },
  emergency:     { load: () => import('./views/emergency.js'),    title: 'Emergency', permission: 'emergency:activate' },
  reports:       { load: () => import('./views/reports.js'),      title: 'Reports', permission: 'stats:read' },
  settings:      { load: () => import('./views/settings.js'),     title: 'Settings' },
};

/** Sidebar structure. Items whose permission is missing are simply not shown. */
const NAV = [
  {
    group: 'Clinical',
    items: [
      { route: 'dashboard', label: 'Dashboard', icon: 'grid' },
      { route: 'queue', label: 'Waiting Room', icon: 'clock', permission: 'visits:read', badge: 'queue' },
      { route: 'checkin', label: 'Check-In', icon: 'plus', permission: 'visits:write' },
      { route: 'patients', label: 'Patients', icon: 'users', permission: 'patients:read' },
      { route: 'appointments', label: 'Appointments', icon: 'calendar', permission: 'appointments:read' },
    ],
  },
  {
    group: 'Departments',
    items: [
      { route: 'pharmacy', label: 'Pharmacy', icon: 'pill', permission: 'pharmacy:read', badge: 'pharmacy' },
      { route: 'laboratory', label: 'Laboratory', icon: 'flask', permission: 'lab:read', badge: 'lab' },
      { route: 'radiology', label: 'Radiology', icon: 'scan', permission: 'radiology:read' },
      { route: 'surgery', label: 'Surgery', icon: 'scalpel', permission: 'surgery:read' },
    ],
  },
  {
    group: 'Operations',
    items: [
      { route: 'billing', label: 'Billing', icon: 'receipt', permission: 'billing:read' },
      { route: 'messages', label: 'Messages', icon: 'mail', permission: 'messaging:read', badge: 'messages' },
      { route: 'emergency', label: 'Emergency', icon: 'alert', permission: 'emergency:activate' },
      { route: 'reports', label: 'Reports', icon: 'chart', permission: 'stats:read' },
      { route: 'settings', label: 'Settings', icon: 'cog' },
    ],
  },
];

const ICONS = {
  grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" fill="currentColor" opacity=".85"/>',
  clock: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  users: '<circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19a5.5 5.5 0 0111 0M16 11.2a3 3 0 000-6M17.5 19a5 5 0 00-2-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  pill: '<rect x="3" y="9" width="18" height="6" rx="3" fill="none" stroke="currentColor" stroke-width="1.8" transform="rotate(-45 12 12)"/><path d="M8.5 8.5l7 7" stroke="currentColor" stroke-width="1.8"/>',
  flask: '<path d="M10 3v6L5 18a2 2 0 001.8 3h10.4A2 2 0 0019 18l-5-9V3M8.5 3h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 015.5 4H8M16 4h2.5A1.5 1.5 0 0120 5.5V8M20 16v2.5a1.5 1.5 0 01-1.5 1.5H16M8 20H5.5A1.5 1.5 0 014 18.5V16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4 12h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  scalpel: '<path d="M4 20l7-7M13 11l7-7-2 8-5 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 8h6M9 12h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 6.5l8.5 6 8.5-6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  alert: '<path d="M12 3l9 16H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9v5M12 16.5v.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  cog: '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};

// --- Boot ------------------------------------------------------------------

const els = {};

async function boot() {
  cacheElements();
  wireChrome();

  setUnauthorizedHandler(() => {
    // A dropped session should not silently show empty screens.
    signOutLocal();
    toastError('Your session ended. Please sign in again.');
  });

  await loadPublicSettings();

  if (token.get()) {
    try {
      const staff = await api.me();
      await startSession(staff);
      return;
    } catch {
      token.clear();
    }
  }

  showLogin();
}

function cacheElements() {
  els.login = $('#login-screen');
  els.app = $('#app');
  els.view = $('#view');
  els.nav = $('#nav');
  els.sidebar = $('#sidebar');
  els.scrim = $('#sidebar-scrim');
  els.pageTitle = $('#page-title');
  els.pageSubtitle = $('#page-subtitle');
  els.notifDrawer = $('#notif-drawer');
  els.notifList = $('#notif-list');
  els.drawerScrim = $('#drawer-scrim');
  els.notifCount = $('#notif-count');
  els.banner = $('#emergency-banner');
  els.conn = $('#conn-indicator');
}

async function loadPublicSettings() {
  try {
    const settings = await api.publicSettings();
    setState('settings', settings);

    const name = settings['clinic.name'] ?? 'Clinic HUD';
    document.title = name;
    $('#login-clinic-name').textContent = name;
    $('#sidebar-clinic-name').textContent = name;
    if (settings['clinic.tagline']) $('#login-tagline').textContent = settings['clinic.tagline'];
    setCurrency(settings['clinic.currency']);
  } catch {
    // A clinic that has not been seeded yet still needs a usable login screen.
  }
}

// --- Authentication --------------------------------------------------------

function showLogin() {
  els.login.hidden = false;
  els.app.hidden = true;
  document.body.classList.remove('has-emergency');
  els.banner.hidden = true;
  $('#login-username').focus();
}

async function startSession(staff) {
  setState('staff', staff);
  patchState('unread', staff.unread ?? {});

  els.login.hidden = true;
  els.app.hidden = false;

  $('#who-name').textContent = staff.full_name;
  $('#who-role').textContent = staff.role?.name ?? '';
  $('#who-initials').textContent = initials(staff.full_name);
  $('#duty-toggle').checked = Boolean(staff.is_on_duty);

  buildNav();
  startClock();
  connect();
  wireRealtime();

  await refreshEmergencies();
  await refreshNotifications();

  if (staff.must_change_password) {
    promptPasswordChange();
  }

  handleRoute();
}

function signOutLocal() {
  token.clear();
  setState('staff', null);
  disconnect();
  showLogin();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const button = $('#login-submit');
  const errorBox = $('#login-error');
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = 'Signing in…';

  try {
    const result = await api.login($('#login-username').value.trim(), $('#login-password').value);
    token.set(result.token);
    $('#login-password').value = '';
    await startSession(result.staff);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

function promptPasswordChange() {
  openModal({
    title: 'Choose a new password',
    body: html`
      <p class="dim">This account is using a temporary password. Set your own before continuing.</p>
      <label class="field">
        <span class="field__label">Current password</span>
        <input class="input" type="password" id="pw-current" autocomplete="current-password">
      </label>
      <label class="field">
        <span class="field__label">New password</span>
        <input class="input" type="password" id="pw-new" autocomplete="new-password">
        <span class="field__hint">At least 10 characters, including a letter and a number.</span>
      </label>`,
    actions: [
      { label: 'Later', class: 'btn--ghost' },
      {
        label: 'Update password',
        class: 'btn--primary',
        onClick: async (root) => {
          const current = root.querySelector('#pw-current').value;
          const next = root.querySelector('#pw-new').value;
          if (!current || !next) {
            toast('Fill in both fields.', { type: 'warn' });
            return true;
          }
          await api.post('/auth/change-password', { current_password: current, new_password: next });
          toastOk('Password updated.');
          return false;
        },
      },
    ],
  });
}

// --- Navigation ------------------------------------------------------------

function buildNav() {
  const markup = NAV.map((section) => {
    const items = section.items.filter((item) => !item.permission || can(item.permission));
    if (items.length === 0) return '';

    const links = items
      .map(
        (item) => html`
          <a class="nav__item" href="#/${item.route}" data-route="${item.route}">
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">${raw(ICONS[item.icon] ?? '')}</svg>
            <span>${item.label}</span>
            ${item.badge ? raw(`<span class="nav__badge" data-badge="${esc(item.badge)}" hidden>0</span>`) : ''}
          </a>`
      )
      .join('');

    return html`<div class="nav__group">${section.group}</div>${raw(links)}`;
  }).join('');

  render(els.nav, markup);
  refreshNavBadges();
}

/** Live counts on the sidebar, refreshed from dashboard data and SSE events. */
async function refreshNavBadges() {
  const set = (name, value) => {
    const badge = els.nav.querySelector(`[data-badge="${name}"]`);
    if (!badge) return;
    badge.textContent = value > 99 ? '99+' : String(value);
    badge.hidden = !value;
  };

  try {
    if (can('visits:read')) {
      const { summary } = await api.queue({ include_in_progress: 'false' });
      set('queue', summary.waiting);
    }
    if (can('pharmacy:read')) {
      const summary = await api.get('/pharmacy/queue/summary');
      set('pharmacy', summary.pending);
    }
    if (can('lab:read')) {
      const summary = await api.get('/laboratory/summary');
      set('lab', summary.ordered + summary.collected + summary.in_progress);
    }
    set('messages', store.unread.messages ?? 0);
  } catch {
    // Badges are decoration; a failure here must not break navigation.
  }
}

function setActiveNav(route) {
  els.nav.querySelectorAll('.nav__item').forEach((link) => {
    link.classList.toggle('is-active', link.dataset.route === route);
  });
}

// --- Router ----------------------------------------------------------------

let currentView = null;

/** Parse "#/patients/abc-123?tab=notes" into its parts. */
function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = hash.split('?');
  const segments = pathPart.split('/').filter(Boolean);

  return {
    route: segments[0] || 'dashboard',
    id: segments[1] ?? null,
    sub: segments[2] ?? null,
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
  };
}

async function handleRoute() {
  if (!store.staff) return;

  const { route, id, sub, query } = parseHash();
  const definition = ROUTES[route];

  closeSidebar();
  closeDrawer();

  if (!definition) {
    els.pageTitle.textContent = 'Not found';
    els.pageSubtitle.textContent = '';
    render(els.view, emptyState('Page not found', `No screen matches "${esc(route)}".`, '?'));
    return;
  }

  if (definition.permission && !can(definition.permission)) {
    els.pageTitle.textContent = 'No access';
    els.pageSubtitle.textContent = '';
    render(els.view, emptyState('Not permitted', `Your role cannot open ${definition.title}.`, '⛔'));
    return;
  }

  setActiveNav(route);
  els.pageTitle.textContent = definition.title;
  els.pageSubtitle.textContent = '';
  render(els.view, loadingState());

  // Give the previous view a chance to clear its timers and subscriptions.
  if (currentView?.destroy) {
    try { currentView.destroy(); } catch (err) { console.error(err); }
  }

  try {
    const module = await definition.load();
    currentView = module.default ?? module;

    const context = {
      id,
      sub,
      query,
      setTitle: (title, subtitle) => {
        els.pageTitle.textContent = title;
        els.pageSubtitle.textContent = subtitle ?? '';
      },
      navigate,
      refreshBadges: refreshNavBadges,
    };

    await currentView.render(els.view, context);
    els.view.scrollTop = 0;
  } catch (err) {
    console.error('[router]', err);
    if (err instanceof ApiError && err.status === 404) {
      render(els.view, emptyState('Not found', err.message, '∅'));
    } else {
      render(els.view, html`<div class="alert alert--error">${err.message ?? 'This screen failed to load.'}</div>`);
    }
  }
}

export function navigate(path) {
  const target = path.startsWith('#') ? path : `#${path.startsWith('/') ? '' : '/'}${path}`;
  if (window.location.hash === target) handleRoute();
  else window.location.hash = target;
}

window.addEventListener('hashchange', handleRoute);

// --- Chrome wiring ---------------------------------------------------------

function wireChrome() {
  $('#menu-btn').addEventListener('click', () => {
    els.sidebar.classList.add('is-open');
    els.scrim.hidden = false;
  });
  $('#sidebar-close').addEventListener('click', closeSidebar);
  els.scrim.addEventListener('click', closeSidebar);

  $('#logout-btn').addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Sign out',
      message: 'End this session? You will be marked off duty.',
      confirmLabel: 'Sign out',
    });
    if (!confirmed) return;

    try { await api.logout(); } catch { /* sign out locally regardless */ }
    signOutLocal();
  });

  $('#duty-toggle').addEventListener('change', async (e) => {
    try {
      await api.post('/auth/duty', { on_duty: e.target.checked });
      toastOk(e.target.checked ? 'You are on duty.' : 'You are off duty.');
    } catch (err) {
      e.target.checked = !e.target.checked;
      reportError(err);
    }
  });

  $('#notif-btn').addEventListener('click', () => {
    els.notifDrawer.hidden = !els.notifDrawer.hidden;
    els.drawerScrim.hidden = els.notifDrawer.hidden;
    if (!els.notifDrawer.hidden) refreshNotifications();
  });
  $('#notif-close').addEventListener('click', closeDrawer);
  els.drawerScrim.addEventListener('click', closeDrawer);

  $('#notif-read-all').addEventListener('click', async () => {
    try {
      await api.post('/notifications/read-all');
      await refreshNotifications();
      toastOk('All notifications marked read.');
    } catch (err) {
      reportError(err);
    }
  });

  $('#emergency-btn').addEventListener('click', openEmergencyDialog);
  $('#emergency-ack').addEventListener('click', acknowledgeTopEmergency);

  // Modal scrim / close buttons.
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-modal-close]')) closeModal();
  });

  // Stat tiles and table rows opt into navigation with data-href.
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-href]');
    if (target && !e.target.closest('button, a, input, select, textarea')) {
      navigate(target.dataset.href);
    }
  });

  subscribe('connected', (isConnected) => {
    els.conn.classList.toggle('is-live', isConnected);
    els.conn.classList.toggle('is-down', !isConnected);
    els.conn.title = isConnected ? 'Live updates connected' : 'Live updates offline';
  });
}

function closeSidebar() {
  els.sidebar.classList.remove('is-open');
  els.scrim.hidden = true;
}

function closeDrawer() {
  els.notifDrawer.hidden = true;
  els.drawerScrim.hidden = true;
}

function startClock() {
  const tick = () => {
    const now = new Date();
    const stamp = now.toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    });
    $('#sidebar-clock').textContent = stamp;
  };
  tick();
  setInterval(tick, 30_000);
}

// --- Notifications ---------------------------------------------------------

async function refreshNotifications() {
  try {
    const [list, counts] = await Promise.all([
      api.get('/notifications', { limit: 25 }),
      api.get('/notifications/count'),
    ]);

    patchState('unread', counts);

    const unreadTotal = Number(counts.notifications ?? 0);
    els.notifCount.textContent = unreadTotal > 99 ? '99+' : String(unreadTotal);
    els.notifCount.hidden = unreadTotal === 0;

    const badge = els.nav.querySelector('[data-badge="messages"]');
    if (badge) {
      const messages = Number(counts.messages ?? 0);
      badge.textContent = messages > 99 ? '99+' : String(messages);
      badge.hidden = messages === 0;
    }

    if (list.length === 0) {
      render(els.notifList, emptyState('Nothing new', 'Notifications will appear here.', '✓'));
      return;
    }

    render(
      els.notifList,
      list
        .map(
          (n) => html`
            <div class="notif ${n.read_at ? 'is-read' : 'is-unread'} ${n.type === 'emergency' ? 'notif--emergency' : ''}"
                 data-id="${n.id}" ${n.link ? raw(`data-link="${esc(n.link)}"`) : ''}>
              <span class="notif__dot"></span>
              <div>
                <div class="notif__title">${n.title}</div>
                ${n.body ? raw(html`<div class="notif__body">${n.body}</div>`) : ''}
                <div class="notif__time">${fmtAgo(n.created_at)}</div>
              </div>
            </div>`
        )
        .join('')
    );

    els.notifList.querySelectorAll('.notif').forEach((node) => {
      node.addEventListener('click', async () => {
        try { await api.post(`/notifications/${node.dataset.id}/read`); } catch { /* non-critical */ }
        if (node.dataset.link) {
          navigate(node.dataset.link);
          closeDrawer();
        }
        refreshNotifications();
      });
    });
  } catch (err) {
    console.error('[notifications]', err);
  }
}

// --- Emergency -------------------------------------------------------------

async function refreshEmergencies() {
  try {
    const active = await api.get('/emergency/active');
    setState('emergencies', active);
    renderBanner();
  } catch {
    /* the banner is best-effort */
  }
}

function renderBanner() {
  const active = store.emergencies;

  if (!active || active.length === 0) {
    els.banner.hidden = true;
    document.body.classList.remove('has-emergency');
    return;
  }

  const top = active[0];
  $('#emergency-title').textContent = top.label ?? top.code_type.replace(/_/g, ' ').toUpperCase();
  $('#emergency-detail').textContent = [top.location, top.description].filter(Boolean).join(' · ') ||
    `Raised by ${top.activated_by_name ?? 'staff'}`;

  els.banner.hidden = false;
  document.body.classList.add('has-emergency');
  $('#emergency-ack').hidden = top.status === 'acknowledged';
}

async function acknowledgeTopEmergency() {
  const top = store.emergencies?.[0];
  if (!top) return;
  try {
    await api.post(`/emergency/${top.id}/acknowledge`);
    toastOk('Acknowledged. Responders have been notified.');
    await refreshEmergencies();
  } catch (err) {
    reportError(err);
  }
}

function openEmergencyDialog() {
  if (!can('emergency:activate')) {
    toast('Your role cannot raise an emergency code.', { type: 'warn' });
    return;
  }

  const codes = [
    ['code_blue', 'Code Blue — cardiac arrest'],
    ['trauma', 'Trauma alert'],
    ['code_red', 'Code Red — fire'],
    ['mass_casualty', 'Mass casualty incident'],
    ['lockdown', 'Facility lockdown'],
    ['code_black', 'Code Black — bomb threat'],
  ];

  openModal({
    title: 'Raise an emergency code',
    body: html`
      <div class="alert alert--warn">This alerts every member of staff currently signed in. Use it only for a real in-character emergency.</div>
      <label class="field">
        <span class="field__label">Code</span>
        <select class="select" id="em-code">
          ${raw(codes.map(([value, label]) => html`<option value="${value}">${label}</option>`).join(''))}
        </select>
      </label>
      <label class="field">
        <span class="field__label">Location</span>
        <input class="input" id="em-location" placeholder="e.g. Trauma Bay 2, Reception, Ward B">
      </label>
      <label class="field">
        <span class="field__label">Details</span>
        <textarea class="textarea" id="em-detail" placeholder="What is happening, and what is needed?"></textarea>
      </label>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Activate code',
        class: 'btn--danger',
        onClick: async (root) => {
          await api.post('/emergency', {
            code_type: root.querySelector('#em-code').value,
            location: root.querySelector('#em-location').value.trim() || null,
            description: root.querySelector('#em-detail').value.trim() || null,
          });
          toastOk('Emergency code activated. All staff have been alerted.');
          await refreshEmergencies();
        },
      },
    ],
  });
}

// --- Realtime handlers -----------------------------------------------------

function wireRealtime() {
  onEvent('notification', (payload) => {
    refreshNotifications();
    if (payload.type === 'emergency') return; // the banner covers this
    toast(payload.body ?? '', { title: payload.title, type: payload.type === 'warning' ? 'warn' : 'info' });
  });

  onEvent('message', (payload) => {
    toast(payload.body?.slice(0, 120) ?? '', {
      title: `${payload.sender_name}: ${payload.subject ?? 'New message'}`,
      type: payload.priority === 'urgent' ? 'warn' : 'info',
    });
    refreshNotifications();
  });

  onEvent('emergency:activated', (payload) => {
    setState('emergencies', [payload, ...store.emergencies]);
    renderBanner();
    if (payload.sound && store.settings['alerts.emergency_sound'] !== false) playAlert();
    toast(payload.description ?? payload.location ?? 'Respond immediately.', { title: payload.label, type: 'error', duration: 10_000 });
  });

  onEvent('emergency:resolved', refreshEmergencies);
  onEvent('emergency:cleared', refreshEmergencies);
  onEvent('emergency:acknowledged', refreshEmergencies);

  onEvent('queue:updated', refreshNavBadges);
  onEvent('pharmacy:updated', refreshNavBadges);
  onEvent('laboratory:updated', refreshNavBadges);
  onEvent('poll', refreshNavBadges);
}

// --- Go --------------------------------------------------------------------

boot().catch((err) => {
  console.error('[boot]', err);
  document.body.innerHTML = html`
    <div style="padding:40px;text-align:center;color:#e6edf5;font-family:sans-serif">
      <h1>Could not start</h1>
      <p>${err.message ?? 'Unknown error'}</p>
      <button onclick="location.reload()" style="padding:8px 16px;margin-top:12px">Reload</button>
    </div>`;
});

// Views import these rather than reaching for globals.
export { refreshNavBadges, refreshNotifications, refreshEmergencies };
