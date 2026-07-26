/**
 * UI toolkit: safe templating, toasts, modals, formatters and shared widgets.
 *
 * Everything that puts server data on screen goes through `html`, which escapes
 * interpolated values. Patient names, notes and free text are attacker-
 * controlled in the sense that anyone with a keyboard can type a script tag
 * into a chief complaint - escaping by default is the only sane posture.
 */

// --- Templating ------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a value for insertion into HTML text or an attribute. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Marker for pre-built HTML that must not be escaped again. */
class Raw {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

/** Opt a value out of escaping. Only ever pass markup you built yourself. */
export const raw = (value) => new Raw(value);

/**
 * Tagged template that escapes every interpolation.
 *
 *   html`<td>${patient.name}</td>`          // escaped
 *   html`<tbody>${raw(rowsMarkup)}</tbody>` // not escaped
 *
 * Arrays are joined, so `${items.map(renderRow)}` works as expected.
 */
export function html(strings, ...values) {
  return strings.reduce((acc, str, i) => {
    if (i === 0) return str;
    const value = values[i - 1];

    let rendered;
    if (value instanceof Raw) rendered = value.value;
    else if (Array.isArray(value)) rendered = value.map((v) => (v instanceof Raw ? v.value : esc(v))).join('');
    else if (value === null || value === undefined || value === false) rendered = '';
    else rendered = esc(value);

    return acc + rendered + str;
  }, '');
}

/** Render markup into a container and return it, for chaining event wiring. */
export function render(container, markup) {
  container.innerHTML = markup instanceof Raw ? markup.value : markup;
  return container;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/**
 * Delegated event binding. Survives re-renders, which matters because most
 * views replace their whole DOM subtree on refresh.
 */
export function on(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  });
}

// --- Formatters ------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

export function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

/** "just now", "12m ago", "3h ago", "5d ago". */
export function fmtAgo(value) {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return '—';

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(value);
}

/** Minutes as "45m" or "2h 05m". */
export function fmtDuration(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 60) return `${Math.round(n)}m`;
  return `${Math.floor(n / 60)}h ${pad(Math.round(n % 60))}m`;
}

let currencySymbol = 'L$';
export function setCurrency(symbol) { currencySymbol = symbol || 'L$'; }

export function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${currencySymbol}0.00`;
  return `${currencySymbol}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Turn "sent_to_pharmacy" into "Sent to pharmacy". */
export function titleCase(value) {
  if (!value) return '';
  const spaced = String(value).replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function initials(name) {
  if (!name) return '--';
  return String(name)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '--';
}

// --- Status colours --------------------------------------------------------

/** Map a status string onto a badge modifier class. */
const STATUS_TONE = {
  // visits & queue
  waiting: 'warn', being_seen: 'accent', completed: 'ok', discharged: 'ok',
  admitted: 'info', no_show: '', cancelled: '',
  // priority
  normal: '', urgent: 'warn', emergency: 'danger',
  // pharmacy
  pending: 'warn', in_progress: 'accent', ready: 'ok', picked_up: 'ok', rejected: 'danger',
  // lab / imaging
  ordered: 'warn', collected: 'accent', awaiting_read: 'warn', scheduled: 'info',
  // billing
  draft: '', issued: 'warn', partially_paid: 'warn', paid: 'ok', overdue: 'danger',
  void: '', written_off: '',
  // lab result flags
  high: 'warn', low: 'warn', critical: 'danger', abnormal: 'warn', inconclusive: '',
  // insurance
  verified: 'ok', denied: 'danger', expired: 'danger', unverified: '',
  // severity
  mild: '', moderate: 'warn', severe: 'danger', life_threatening: 'danger',
  // generic
  active: 'ok', inactive: '', suspended: 'danger', resolved: 'ok', acknowledged: 'warn',
  successful: 'ok', partial: 'warn', unsuccessful: 'danger', aborted: 'danger',
};

export function statusBadge(status, label) {
  if (!status) return '';
  const tone = STATUS_TONE[status] ?? '';
  const cls = tone ? `badge badge--${tone}` : 'badge';
  return html`<span class="${cls}">${label ?? titleCase(status)}</span>`;
}

export function priorityBadge(priority) {
  if (!priority || priority === 'normal') return '';
  return statusBadge(priority);
}

// --- Toasts ----------------------------------------------------------------

const toastHost = () => document.getElementById('toasts');

/**
 * Show a transient message.
 * @param {string} message
 * @param {{type?: 'info'|'ok'|'warn'|'error', title?: string, duration?: number}} options
 */
export function toast(message, options = {}) {
  const host = toastHost();
  if (!host) return;

  const { type = 'info', title, duration = type === 'error' ? 6500 : 4000 } = options;

  const node = document.createElement('div');
  node.className = `toast toast--${type}`;
  node.innerHTML = html`
    <div class="toast__body">
      ${title ? raw(html`<div class="toast__title">${title}</div>`) : ''}
      <div class="toast__text">${message}</div>
    </div>
    <button type="button" class="iconbtn" aria-label="Dismiss">&times;</button>
  `;

  const dismiss = () => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 200);
  };

  node.querySelector('button').addEventListener('click', dismiss);
  host.appendChild(node);

  const timer = setTimeout(dismiss, duration);
  node.addEventListener('click', () => clearTimeout(timer), { once: true });
}

export const toastOk = (msg, title) => toast(msg, { type: 'ok', title });
export const toastError = (msg, title) => toast(msg, { type: 'error', title: title ?? 'Something went wrong' });
export const toastWarn = (msg, title) => toast(msg, { type: 'warn', title });

/** Report an ApiError sensibly, expanding validation details when present. */
export function reportError(err) {
  if (!err) return;
  if (Array.isArray(err.details) && err.details.length > 0) {
    const lines = err.details.map((d) => `${d.field}: ${d.message}`).join(' · ');
    toast(lines, { type: 'error', title: err.message });
  } else {
    toastError(err.message ?? String(err));
  }
  if (!err.code) console.error(err);
}

// --- Modal -----------------------------------------------------------------

let modalCleanup = null;

/**
 * Open the shared modal.
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.body   HTML built with the `html` helper
 * @param {Array<{label: string, class?: string, value?: any, onClick?: Function}>} [options.actions]
 * @param {boolean} [options.wide]
 * @param {(root: HTMLElement) => void} [options.onMount] wire up the body's inputs
 */
export function openModal({ title, body, actions = [], wide = false, onMount }) {
  const modal = document.getElementById('modal');
  const panel = modal.querySelector('.modal__panel');

  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  panel.classList.toggle('modal__panel--wide', wide);

  const foot = document.getElementById('modal-foot');
  foot.innerHTML = actions
    .map((action, index) => html`<button type="button" class="btn ${action.class ?? 'btn--ghost'}" data-action="${index}">${action.label}</button>`)
    .join('');

  foot.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = actions[Number(btn.dataset.action)];
      if (!action.onClick) return closeModal();

      btn.disabled = true;
      try {
        const keepOpen = await action.onClick(document.getElementById('modal-body'));
        if (keepOpen !== true) closeModal();
      } catch (err) {
        reportError(err);
      } finally {
        btn.disabled = false;
      }
    });
  });

  modal.hidden = false;

  const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onKey);
  modalCleanup = () => document.removeEventListener('keydown', onKey);

  if (onMount) onMount(document.getElementById('modal-body'));

  // Focus the first field so keyboard entry works without an extra click,
  // which matters a lot inside the SL browser.
  const firstInput = modal.querySelector('input, select, textarea');
  if (firstInput) setTimeout(() => firstInput.focus(), 40);
}

export function closeModal() {
  const modal = document.getElementById('modal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.getElementById('modal-body').innerHTML = '';
  document.getElementById('modal-foot').innerHTML = '';
  if (modalCleanup) modalCleanup();
  modalCleanup = null;
}

/** Confirmation dialog. Resolves true/false. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: html`<p class="mb-0">${message}</p>`,
      actions: [
        { label: 'Cancel', class: 'btn--ghost', onClick: () => { resolve(false); } },
        { label: confirmLabel, class: danger ? 'btn--danger' : 'btn--primary', onClick: () => { resolve(true); } },
      ],
    });
  });
}

/**
 * Prompt for a short piece of text. Resolves the string, or null if cancelled.
 */
export function promptDialog({ title, label, placeholder = '', required = true, multiline = false, confirmLabel = 'Save' }) {
  return new Promise((resolve) => {
    const controlId = 'prompt-input';
    const control = multiline
      ? html`<textarea class="textarea" id="${controlId}" placeholder="${placeholder}"></textarea>`
      : html`<input class="input" id="${controlId}" placeholder="${placeholder}">`;

    openModal({
      title,
      body: html`<label class="field"><span class="field__label">${label}</span>${raw(control)}</label>`,
      actions: [
        { label: 'Cancel', class: 'btn--ghost', onClick: () => { resolve(null); } },
        {
          label: confirmLabel,
          class: 'btn--primary',
          onClick: (root) => {
            const value = root.querySelector(`#${controlId}`).value.trim();
            if (required && !value) {
              toastWarn('Please enter a value.');
              return true; // keep the dialog open
            }
            resolve(value);
            return false;
          },
        },
      ],
    });
  });
}

// --- Shared markup helpers -------------------------------------------------

export function emptyState(title, hint, icon = '∅') {
  return html`
    <div class="empty">
      <div class="empty__icon">${icon}</div>
      <div class="empty__title">${title}</div>
      ${hint ? raw(html`<div>${hint}</div>`) : ''}
    </div>`;
}

export function loadingState(label = 'Loading…') {
  return html`<div class="loading"><span class="spinner"></span> ${label}</div>`;
}

export function statCard({ label, value, meta, tone, href }) {
  const cls = ['stat', tone ? `stat--${tone}` : '', href ? 'stat--link' : ''].filter(Boolean).join(' ');
  return html`
    <div class="${cls}" ${href ? raw(`data-href="${esc(href)}"`) : ''}>
      <span class="stat__label">${label}</span>
      <span class="stat__value">${value}</span>
      ${meta ? raw(html`<span class="stat__meta">${meta}</span>`) : ''}
    </div>`;
}

/** Pagination footer. `onPage` receives the new page number. */
export function paginationBar(pagination, onPage) {
  if (!pagination || pagination.pages <= 1) return '';
  const { page, pages, total } = pagination;

  const bar = html`
    <div class="pagination">
      <span>Page ${page} of ${pages} · ${total} total</span>
      <span class="flex gap-sm">
        <button type="button" class="btn btn--sm btn--ghost" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Previous</button>
        <button type="button" class="btn btn--sm btn--ghost" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next</button>
      </span>
    </div>`;

  // The caller renders the string; wiring happens on the next tick once it is
  // in the DOM.
  if (onPage) {
    setTimeout(() => {
      document.querySelectorAll('.pagination [data-page]').forEach((btn) => {
        btn.addEventListener('click', () => onPage(Number(btn.dataset.page)));
      });
    }, 0);
  }

  return bar;
}

/** Read every named control inside a container into a plain object. */
export function readForm(root) {
  const values = {};
  root.querySelectorAll('[name]').forEach((field) => {
    const key = field.name;

    if (field.type === 'checkbox') {
      if (field.dataset.list === 'true') {
        values[key] = values[key] ?? [];
        if (field.checked) values[key].push(field.value);
      } else {
        values[key] = field.checked;
      }
      return;
    }

    if (field.type === 'radio') {
      if (field.checked) values[key] = field.value;
      return;
    }

    const value = field.value.trim();
    // Empty optional fields become undefined so PATCH endpoints leave them be.
    values[key] = value === '' ? undefined : field.type === 'number' ? Number(value) : value;
  });
  return values;
}

// --- Emergency alert sound -------------------------------------------------

let audioContext = null;

/**
 * Two-tone alert, synthesised rather than loaded from a file. That keeps the
 * CSP tight and avoids shipping an asset the SL browser may refuse to decode.
 * Silently does nothing if the browser blocks audio before a user gesture.
 */
export function playAlert() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;

    audioContext = audioContext ?? new Ctor();
    if (audioContext.state === 'suspended') audioContext.resume();

    const now = audioContext.currentTime;
    [0, 0.34, 0.68].forEach((offset, index) => {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();

      osc.type = 'sine';
      osc.frequency.value = index % 2 === 0 ? 880 : 660;

      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.22, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.26);

      osc.connect(gain).connect(audioContext.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.3);
    });
  } catch {
    /* audio is a nicety, never a failure */
  }
}
