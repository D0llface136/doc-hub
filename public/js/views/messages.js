/**
 * Internal staff messaging with read receipts.
 */
import { api } from '../api.js';
import { can } from '../store.js';
import {
  html, raw, render, on, emptyState, loadingState, statusBadge, fmtDateTime,
  fmtAgo, titleCase, toastOk, toastWarn, reportError, openModal, paginationBar,
} from '../ui.js';
import { onEvent } from '../realtime.js';

let context = null;
let unsubscribe = null;
let state = { box: 'inbox', page: 1, unreadOnly: false };

const DEPARTMENTS = [
  ['all', 'Everyone'],
  ['reception', 'Reception'],
  ['nursing', 'Nurses'],
  ['doctors', 'Doctors'],
  ['laboratory', 'Laboratory'],
  ['pharmacy', 'Pharmacy'],
  ['radiology', 'Radiology'],
  ['administration', 'Administration'],
];

async function load(container) {
  render(container, html`
    <div class="toolbar">
      <div class="segmented">
        <button type="button" class="segmented__btn ${state.box === 'inbox' ? 'is-active' : ''}" data-box="inbox">Inbox</button>
        <button type="button" class="segmented__btn ${state.box === 'sent' ? 'is-active' : ''}" data-box="sent">Sent</button>
      </div>
      ${state.box === 'inbox' ? raw(html`
        <label class="check" style="margin:0">
          <input type="checkbox" id="unread-only" ${state.unreadOnly ? 'checked' : ''}>
          <span>Unread only</span>
        </label>`) : ''}
      <div style="flex:1"></div>
      ${state.box === 'inbox' ? raw('<button type="button" class="btn btn--ghost" id="read-all">Mark all read</button>') : ''}
      ${can('messaging:write') ? raw('<button type="button" class="btn btn--primary" id="compose">Compose</button>') : ''}
    </div>

    <div class="card">
      <div class="card__body--flush" id="message-list">${raw(loadingState())}</div>
    </div>`);

  on(container, 'click', '[data-box]', (_e, target) => {
    state = { ...state, box: target.dataset.box, page: 1 };
    load(container);
  });

  const unreadToggle = container.querySelector('#unread-only');
  if (unreadToggle) {
    unreadToggle.addEventListener('change', (e) => {
      state.unreadOnly = e.target.checked;
      state.page = 1;
      fetchList(container);
    });
  }

  const readAll = container.querySelector('#read-all');
  if (readAll) {
    readAll.addEventListener('click', async () => {
      try {
        const result = await api.post('/messages/read-all');
        toastOk(`${result.marked_read} message(s) marked read.`);
        context.refreshBadges();
        await fetchList(container);
      } catch (err) {
        reportError(err);
      }
    });
  }

  const compose = container.querySelector('#compose');
  if (compose) compose.addEventListener('click', () => openCompose(container));

  on(container, 'click', '[data-message]', async (_e, target) => {
    try {
      const message = await api.get(`/messages/${target.dataset.message}`);
      if (state.box === 'inbox') {
        await api.post(`/messages/${target.dataset.message}/read`).catch(() => {});
        context.refreshBadges();
      }
      showMessage(container, message);
    } catch (err) {
      reportError(err);
    }
  });

  await fetchList(container);
}

async function fetchList(container) {
  const host = container.querySelector('#message-list');
  if (!host) return;

  try {
    const messages = state.box === 'inbox'
      ? await api.get('/messages/inbox', { page: state.page, limit: 25, unread_only: state.unreadOnly ? 'true' : undefined })
      : await api.get('/messages/sent', { page: state.page, limit: 25 });

    if (messages.length === 0) {
      render(host, emptyState(
        state.box === 'inbox' ? 'No messages' : 'Nothing sent yet',
        state.box === 'inbox' ? 'Messages from colleagues appear here.' : 'Compose a message to a department or a colleague.',
        '✉'
      ));
      return;
    }

    render(host, state.box === 'inbox' ? renderInbox(messages) : renderSent(messages));

    const bar = paginationBar(messages.pagination, (page) => { state.page = page; fetchList(container); });
    if (bar) host.insertAdjacentHTML('beforeend', bar);
  } catch (err) {
    render(host, html`<div class="alert alert--error">${err.message}</div>`);
  }
}

function renderInbox(messages) {
  return messages.map((m) => html`
    <div class="notif ${m.read_at ? 'is-read' : 'is-unread'} ${m.priority === 'urgent' ? 'notif--emergency' : ''}"
         data-message="${m.id}">
      <span class="notif__dot"></span>
      <div style="flex:1;min-width:0">
        <div class="flex flex-between gap-sm flex-wrap">
          <div class="notif__title">${m.subject ?? '(no subject)'}</div>
          <span class="muted nowrap" style="font-size:11px">${fmtAgo(m.created_at)}</span>
        </div>
        <div class="notif__body">${String(m.body).slice(0, 140)}${String(m.body).length > 140 ? '…' : ''}</div>
        <div class="flex flex-wrap gap-sm mt-1">
          <span class="badge">${m.sender_name ?? 'System'}</span>
          ${m.department ? raw(html`<span class="badge badge--info">${titleCase(m.department)}</span>`) : ''}
          ${m.priority !== 'normal' ? raw(statusBadge(m.priority === 'urgent' ? 'emergency' : m.priority, titleCase(m.priority))) : ''}
          ${m.related_patient_name ? raw(html`<span class="badge badge--accent">${m.related_patient_name}</span>`) : ''}
        </div>
      </div>
    </div>`).join('');
}

function renderSent(messages) {
  return html`
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Subject</th><th class="col-optional">To</th><th>Read</th><th>Sent</th></tr></thead>
        <tbody>
          ${raw(messages.map((m) => html`
            <tr class="is-clickable" data-message="${m.id}">
              <td>
                <div class="row-title">${m.subject ?? '(no subject)'}</div>
                <div class="row-sub">${String(m.body).slice(0, 70)}</div>
              </td>
              <td class="col-optional">${m.department ? titleCase(m.department) : `${m.recipient_count} recipient(s)`}</td>
              <td class="num">${m.read_count} / ${m.recipient_count}</td>
              <td class="muted nowrap">${fmtAgo(m.created_at)}</td>
            </tr>`).join(''))}
        </tbody>
      </table>
    </div>`;
}

function showMessage(container, message) {
  openModal({
    title: message.subject ?? '(no subject)',
    wide: true,
    body: html`
      <div class="flex flex-wrap gap-sm mb-2">
        <span class="badge">${message.sender_title ? `${message.sender_title} ` : ''}${message.sender_name ?? 'System'}</span>
        ${message.department ? raw(html`<span class="badge badge--info">${titleCase(message.department)}</span>`) : ''}
        ${message.priority !== 'normal' ? raw(statusBadge(message.priority === 'urgent' ? 'emergency' : message.priority, titleCase(message.priority))) : ''}
        <span class="muted" style="font-size:12px">${fmtDateTime(message.created_at)}</span>
      </div>

      <div class="pre-wrap">${message.body}</div>

      ${message.related_patient_id ? raw(html`
        <div class="alert alert--info mt-2">
          Related patient: <a href="#/patients/${message.related_patient_id}">open chart</a>
        </div>`) : ''}

      ${message.receipts?.length > 0 ? raw(html`
        <div class="card mt-2">
          <div class="card__head"><div class="card__title">Read receipts</div></div>
          <div class="card__body--flush">
            <div class="table-wrap">
              <table class="table">
                <tbody>
                  ${raw(message.receipts.map((r) => html`
                    <tr>
                      <td>${r.full_name}</td>
                      <td class="text-right">
                        ${r.read_at
                          ? raw(html`<span class="badge badge--ok">read ${fmtAgo(r.read_at)}</span>`)
                          : raw('<span class="badge">unread</span>')}
                      </td>
                    </tr>`).join(''))}
                </tbody>
              </table>
            </div>
          </div>
        </div>`) : ''}`,
    actions: [
      ...(can('messaging:write') && message.sender_id
        ? [{
            label: 'Reply',
            class: 'btn--ghost',
            onClick: () => {
              openCompose(container, {
                recipientIds: [message.sender_id],
                subject: message.subject ? `Re: ${message.subject}` : 'Re:',
                recipientName: message.sender_name,
              });
            },
          }]
        : []),
      { label: 'Close', class: 'btn--primary' },
    ],
  });
}

async function openCompose(container, preset = {}) {
  let staff = [];
  try {
    staff = await api.get('/staff', { status: 'active', limit: 200 });
  } catch { /* department broadcast still works */ }

  openModal({
    title: 'New message',
    wide: true,
    body: html`
      ${preset.recipientName ? raw(html`<div class="alert alert--info">Replying to ${preset.recipientName}</div>`) : ''}

      <div class="form-grid">
        <label class="field">
          <span class="field__label">Send to department</span>
          <select class="select" id="msg-department">
            <option value="">— No department —</option>
            ${raw(DEPARTMENTS.map(([v, l]) => html`<option value="${v}">${l}</option>`).join(''))}
          </select>
        </label>
        <label class="field">
          <span class="field__label">Priority</span>
          <select class="select" id="msg-priority">
            <option value="low">Low</option>
            <option value="normal" selected>Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
      </div>

      <label class="field">
        <span class="field__label">Or specific colleagues</span>
        <select class="select" id="msg-recipients" multiple size="6">
          ${raw(staff.map((s) => html`
            <option value="${s.id}" ${preset.recipientIds?.includes(s.id) ? 'selected' : ''}>
              ${[s.display_title, s.full_name].filter(Boolean).join(' ')} — ${s.role_name}${s.is_on_duty ? ' (on duty)' : ''}
            </option>`).join(''))}
        </select>
        <span class="field__hint">Hold Ctrl (or Cmd) to select more than one. You can combine this with a department.</span>
      </label>

      <label class="field"><span class="field__label">Subject</span><input class="input" id="msg-subject" value="${preset.subject ?? ''}"></label>
      <label class="field"><span class="field__label">Message *</span><textarea class="textarea" id="msg-body" rows="6"></textarea></label>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Send',
        class: 'btn--primary',
        onClick: async (root) => {
          const body = root.querySelector('#msg-body').value.trim();
          if (!body) {
            toastWarn('Write a message first.');
            return true;
          }

          const department = root.querySelector('#msg-department').value || null;
          const recipientIds = Array.from(root.querySelector('#msg-recipients').selectedOptions).map((o) => o.value);

          if (!department && recipientIds.length === 0) {
            toastWarn('Choose a department or at least one colleague.');
            return true;
          }

          const result = await api.post('/messages', {
            department,
            recipient_ids: recipientIds,
            subject: root.querySelector('#msg-subject').value.trim() || null,
            body,
            priority: root.querySelector('#msg-priority').value,
          });

          toastOk(`Sent to ${result.recipient_count} recipient(s).`);
          await fetchList(container);
        },
      },
    ],
  });
}

export default {
  async render(container, ctx) {
    context = ctx;
    state = { box: 'inbox', page: 1, unreadOnly: false };
    ctx.setTitle('Staff Messages', 'Internal communication');

    await load(container);
    unsubscribe = onEvent('message', () => fetchList(container));
  },

  destroy() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  },
};
