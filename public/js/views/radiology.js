/**
 * Radiology worklist: perform studies, attach images, file interpretations.
 */
import { api } from '../api.js';
import { can } from '../store.js';
import {
  html, raw, render, on, emptyState, loadingState, statCard, statusBadge,
  fmtAgo, fmtDateTime, titleCase, toastOk, toastWarn, reportError,
  openModal, paginationBar, esc,
} from '../ui.js';
import { onEvent } from '../realtime.js';

let context = null;
let unsubscribe = null;
let state = { status: 'ordered', page: 1, search: '' };
let searchTimer = null;

const TABS = [
  ['ordered', 'Ordered'],
  ['in_progress', 'In progress'],
  ['awaiting_read', 'Awaiting read'],
  ['completed', 'Completed'],
  ['', 'All'],
];

async function load(container) {
  let summary = {};
  try {
    summary = await api.get('/radiology/summary');
  } catch { /* decoration */ }

  render(container, html`
    <div class="grid grid--stats mb-2">
      ${raw(statCard({ label: 'Ordered', value: summary.ordered ?? 0, tone: summary.ordered > 0 ? 'warn' : 'ok' }))}
      ${raw(statCard({ label: 'In progress', value: summary.in_progress ?? 0, tone: 'accent' }))}
      ${raw(statCard({ label: 'Awaiting read', value: summary.awaiting_read ?? 0, tone: summary.awaiting_read > 0 ? 'warn' : 'ok' }))}
      ${raw(statCard({ label: 'Completed', value: summary.completed ?? 0, tone: 'ok' }))}
    </div>

    <div class="toolbar">
      <div class="segmented">
        ${raw(TABS.map(([value, label]) => html`
          <button type="button" class="segmented__btn ${state.status === value ? 'is-active' : ''}" data-status="${value}">${label}</button>`).join(''))}
      </div>
      <input class="input" id="rad-search" placeholder="Search study, patient or MRN" value="${state.search}" autocomplete="off">
    </div>

    <div class="card">
      <div class="card__body--flush" id="rad-list">${raw(loadingState())}</div>
    </div>`);

  wire(container);
  await fetchList(container);
}

async function fetchList(container) {
  const host = container.querySelector('#rad-list');
  if (!host) return;

  try {
    const orders = await api.get('/radiology/orders', {
      status: state.status || undefined,
      page: state.page,
      limit: 25,
      search: state.search || undefined,
    });

    if (orders.length === 0) {
      render(host, emptyState('No imaging orders here', 'Studies ordered by clinicians appear in this worklist.', '🩻'));
      return;
    }

    render(host, html`
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>Patient</th><th>Study</th><th>Impression</th><th class="col-optional">Images</th><th class="col-optional">Ordered</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>${raw(orders.map(renderRow).join(''))}</tbody>
        </table>
      </div>
      ${raw(paginationBar(orders.pagination, (page) => { state.page = page; fetchList(container); }))}`);
  } catch (err) {
    render(host, html`<div class="alert alert--error">${err.message}</div>`);
  }
}

function renderRow(order) {
  const images = order.images ?? [];

  return html`
    <tr class="priority-${order.priority === 'stat' ? 'emergency' : order.priority === 'urgent' ? 'urgent' : 'normal'}">
      <td class="is-clickable" data-href="/patients/${order.patient_id}">
        <div class="row-title">${order.patient_name}</div>
        <div class="row-sub mono">${order.mrn}${order.visit_number ? ` · ${order.visit_number}` : ''}</div>
      </td>
      <td>
        <div class="row-title">${order.study_name}</div>
        <div class="row-sub">${order.modality.toUpperCase()}${order.body_part ? ` · ${order.body_part}` : ''} · ${titleCase(order.priority)}</div>
      </td>
      <td>${order.impression ?? raw('<span class="muted">Awaiting read</span>')}</td>
      <td class="col-optional num">${images.length}</td>
      <td class="col-optional muted nowrap">${fmtAgo(order.ordered_at)}</td>
      <td>${raw(statusBadge(order.status))}</td>
      <td class="text-right nowrap">
        <button type="button" class="btn btn--sm btn--ghost" data-view="${order.id}">Open</button>
        ${can('radiology:interpret') && order.status !== 'completed'
          ? raw(html`<button type="button" class="btn btn--sm btn--primary" data-interpret="${order.id}">Read</button>`)
          : ''}
      </td>
    </tr>`;
}

function wire(container) {
  on(container, 'click', '[data-status]', (_e, target) => {
    state = { ...state, status: target.dataset.status, page: 1 };
    load(container);
  });

  const search = container.querySelector('#rad-search');
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state = { ...state, search: search.value.trim(), page: 1 };
      fetchList(container);
    }, 300);
  });

  on(container, 'click', '[data-view]', async (_e, target) => {
    try {
      const order = await api.get(`/radiology/orders/${target.dataset.view}`);
      showStudy(container, order);
    } catch (err) {
      reportError(err);
    }
  });

  on(container, 'click', '[data-interpret]', async (_e, target) => {
    try {
      const order = await api.get(`/radiology/orders/${target.dataset.interpret}`);
      openInterpretation(container, order);
    } catch (err) {
      reportError(err);
    }
  });
}

function showStudy(container, order) {
  const images = order.images ?? [];

  const actions = [{ label: 'Close', class: 'btn--ghost' }];

  if (can('radiology:read') && order.status !== 'completed') {
    actions.unshift({
      label: 'Attach image',
      class: 'btn--ghost',
      onClick: () => { openImageForm(container, order.id); },
    });
  }

  if (can('radiology:interpret') && order.status !== 'completed') {
    actions.push({
      label: 'File interpretation',
      class: 'btn--primary',
      onClick: () => { openInterpretation(container, order); },
    });
  }

  openModal({
    title: order.study_name,
    wide: true,
    body: html`
      <dl class="kv">
        <dt>Patient</dt><dd>${order.patient_name} (${order.mrn})</dd>
        <dt>Modality</dt><dd>${order.modality.toUpperCase()}</dd>
        <dt>Body part</dt><dd>${order.body_part ?? '—'}</dd>
        <dt>Priority</dt><dd>${titleCase(order.priority)}</dd>
        <dt>Ordered</dt><dd>${fmtDateTime(order.ordered_at)} by ${order.ordered_by_name ?? '—'}</dd>
        <dt>Status</dt><dd>${raw(statusBadge(order.status))}</dd>
        ${order.interpreted_by_name ? raw(html`<dt>Read by</dt><dd>${order.interpreted_by_name}, ${fmtDateTime(order.interpreted_at)}</dd>`) : ''}
      </dl>

      ${order.clinical_history ? raw(html`
        <div class="mt-2"><div class="field__label">Clinical history</div><div class="pre-wrap">${order.clinical_history}</div></div>`) : ''}

      ${order.findings ? raw(html`
        <div class="mt-2"><div class="field__label">Findings</div><div class="pre-wrap">${order.findings}</div></div>`) : ''}

      ${order.impression ? raw(html`
        <div class="alert alert--info mt-2"><strong>Impression:</strong> ${order.impression}</div>`) : ''}

      <div class="mt-2">
        <div class="field__label">Images (${images.length})</div>
        ${images.length === 0
          ? raw('<p class="muted" style="font-size:12.5px">No images attached yet.</p>')
          : raw(html`
            <div class="grid grid--3">
              ${raw(images.map((img) => html`
                <div class="card">
                  <a href="${img.file_url}" target="_blank" rel="noopener">
                    <img src="${img.file_url}" alt="${img.caption ?? img.file_name}"
                         style="width:100%;height:150px;object-fit:cover;display:block;background:var(--surface-3)">
                  </a>
                  <div class="card__body" style="padding:8px 10px">
                    <div class="row-title" style="font-size:12px">${img.file_name}</div>
                    ${img.caption ? raw(html`<div class="row-sub">${img.caption}</div>`) : ''}
                    ${can('radiology:read') ? raw(html`
                      <button type="button" class="btn btn--sm btn--ghost mt-1" data-drop-image="${img.id}" data-order="${order.id}">Remove</button>`) : ''}
                  </div>
                </div>`).join(''))}
            </div>`)}
      </div>`,
    actions,
    onMount(root) {
      root.querySelectorAll('[data-drop-image]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api.delete(`/radiology/orders/${btn.dataset.order}/images/${btn.dataset.dropImage}`);
            toastOk('Image removed.');
            const refreshed = await api.get(`/radiology/orders/${btn.dataset.order}`);
            showStudy(container, refreshed);
          } catch (err) {
            reportError(err);
          }
        });
      });
    },
  });
}

function openImageForm(container, orderId) {
  openModal({
    title: 'Attach an image',
    body: html`
      <p class="dim">Images are stored as links. Upload the image to any host the Second Life browser can reach, then paste its URL here.</p>
      <label class="field"><span class="field__label">File name *</span><input class="input" id="img-name" placeholder="chest-pa.png"></label>
      <label class="field"><span class="field__label">Image URL *</span><input class="input" id="img-url" placeholder="https://…"></label>
      <label class="field"><span class="field__label">Caption</span><input class="input" id="img-caption" placeholder="AP view, left wrist"></label>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Attach',
        class: 'btn--primary',
        onClick: async (root) => {
          const url = root.querySelector('#img-url').value.trim();
          const name = root.querySelector('#img-name').value.trim();

          if (!url || !name) {
            toastWarn('File name and URL are both required.');
            return true;
          }

          await api.post(`/radiology/orders/${orderId}/images`, {
            file_name: name,
            file_url: url,
            caption: root.querySelector('#img-caption').value.trim() || null,
          });

          toastOk('Image attached. The study is now awaiting a read.');
          await load(container);
        },
      },
    ],
  });
}

function openInterpretation(container, order) {
  openModal({
    title: `Interpretation — ${order.study_name}`,
    wide: true,
    body: html`
      ${order.clinical_history ? raw(html`
        <div class="alert alert--info"><strong>Clinical history:</strong> ${order.clinical_history}</div>`) : ''}

      <label class="field">
        <span class="field__label">Findings</span>
        <textarea class="textarea" id="read-findings" rows="5" placeholder="Describe what is visible on the study">${order.findings ?? ''}</textarea>
      </label>

      <label class="field">
        <span class="field__label">Impression *</span>
        <textarea class="textarea" id="read-impression" rows="3" placeholder="The diagnostic conclusion">${order.impression ?? ''}</textarea>
      </label>

      <label class="check"><input type="checkbox" id="read-critical"><span>Critical finding — alert the ordering clinician immediately</span></label>
      <label class="check"><input type="checkbox" id="read-complete" checked><span>Mark the study complete</span></label>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'File report',
        class: 'btn--primary',
        onClick: async (root) => {
          const impression = root.querySelector('#read-impression').value.trim();
          if (!impression) {
            toastWarn('An impression is required.');
            return true;
          }

          await api.post(`/radiology/orders/${order.id}/interpret`, {
            findings: root.querySelector('#read-findings').value.trim() || null,
            impression,
            is_critical: root.querySelector('#read-critical').checked,
            mark_complete: root.querySelector('#read-complete').checked,
          });

          toastOk('Report filed.');
          await load(container);
        },
      },
    ],
  });
}

export default {
  async render(container, ctx) {
    context = ctx;
    state = { status: 'ordered', page: 1, search: '' };
    ctx.setTitle('Radiology', 'Imaging worklist');

    await load(container);
    unsubscribe = onEvent('radiology:updated', () => fetchList(container));
  },

  destroy() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    clearTimeout(searchTimer);
  },
};
