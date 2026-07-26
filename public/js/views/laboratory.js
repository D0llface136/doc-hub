/**
 * Laboratory worklist and result entry.
 */
import { api } from '../api.js';
import { can } from '../store.js';
import {
  html, raw, render, on, emptyState, loadingState, statCard, statusBadge,
  fmtAgo, fmtDateTime, titleCase, toastOk, toastWarn, reportError,
  openModal, promptDialog, paginationBar, readForm,
} from '../ui.js';
import { onEvent } from '../realtime.js';

let context = null;
let unsubscribe = null;
let state = { status: 'ordered', page: 1, search: '' };
let searchTimer = null;

const TABS = [
  ['ordered', 'Ordered'],
  ['collected', 'Collected'],
  ['in_progress', 'In progress'],
  ['completed', 'Completed'],
  ['', 'All'],
];

async function load(container) {
  let summary = {};
  try {
    summary = await api.get('/laboratory/summary');
  } catch { /* decoration */ }

  render(container, html`
    <div class="grid grid--stats mb-2">
      ${raw(statCard({ label: 'Awaiting collection', value: summary.ordered ?? 0, tone: summary.ordered > 0 ? 'warn' : 'ok' }))}
      ${raw(statCard({ label: 'In progress', value: (summary.collected ?? 0) + (summary.in_progress ?? 0), tone: 'accent' }))}
      ${raw(statCard({ label: 'Completed', value: summary.completed ?? 0, tone: 'ok' }))}
      ${raw(statCard({ label: 'Pending STAT', value: summary.pending_stat ?? 0, tone: summary.pending_stat > 0 ? 'danger' : 'ok' }))}
      ${raw(statCard({ label: 'Critical (24h)', value: summary.critical_last_24h ?? 0, tone: summary.critical_last_24h > 0 ? 'danger' : 'ok' }))}
    </div>

    <div class="toolbar">
      <div class="segmented">
        ${raw(TABS.map(([value, label]) => html`
          <button type="button" class="segmented__btn ${state.status === value ? 'is-active' : ''}" data-status="${value}">${label}</button>`).join(''))}
      </div>
      <input class="input" id="lab-search" placeholder="Search test, patient or MRN" value="${state.search}" autocomplete="off">
    </div>

    <div class="card">
      <div class="card__body--flush" id="lab-list">${raw(loadingState())}</div>
    </div>`);

  wire(container);
  await fetchList(container);
}

async function fetchList(container) {
  const host = container.querySelector('#lab-list');
  if (!host) return;

  try {
    const orders = await api.get('/laboratory/orders', {
      status: state.status || undefined,
      page: state.page,
      limit: 25,
      search: state.search || undefined,
    });

    if (orders.length === 0) {
      render(host, emptyState('No orders here', 'Orders placed by clinicians appear in this worklist.', '🧪'));
      return;
    }

    render(host, html`
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>Patient</th><th>Test</th><th>Result</th><th class="col-optional">Ordered</th><th>Status</th><th></th></tr>
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
  const results = order.results ?? [];
  const canResult = can('lab:result');

  const resultCell = results.length === 0
    ? '<span class="muted">Pending</span>'
    : results.map((r) => html`
        <div>
          <span class="vital ${r.flag === 'critical' ? 'vital--red' : r.flag !== 'normal' ? 'vital--yellow' : 'vital--green'}">
            ${r.result_value}${r.unit ? ` ${r.unit}` : ''}
          </span>
          ${raw(statusBadge(r.flag))}
        </div>`).join('');

  return html`
    <tr class="priority-${order.priority === 'stat' ? 'emergency' : order.priority === 'urgent' ? 'urgent' : 'normal'}">
      <td class="is-clickable" data-href="/patients/${order.patient_id}">
        <div class="row-title">${order.patient_name}</div>
        <div class="row-sub mono">${order.mrn}${order.visit_number ? ` · ${order.visit_number}` : ''}</div>
      </td>
      <td>
        <div class="row-title">${order.test_name}</div>
        <div class="row-sub">
          ${titleCase(order.priority)}${order.specimen_type ? ` · ${order.specimen_type}` : ''}
          ${order.ordered_by_name ? ` · ${order.ordered_by_name}` : ''}
        </div>
      </td>
      <td>${raw(resultCell)}</td>
      <td class="col-optional muted nowrap">${fmtAgo(order.ordered_at)}</td>
      <td>${raw(statusBadge(order.status))}</td>
      <td class="text-right nowrap">
        <button type="button" class="btn btn--sm btn--ghost" data-view="${order.id}">View</button>
        ${canResult && order.status === 'ordered'
          ? raw(html`<button type="button" class="btn btn--sm btn--ghost" data-collect="${order.id}">Collected</button>`)
          : ''}
        ${canResult && ['ordered', 'collected', 'in_progress'].includes(order.status)
          ? raw(html`<button type="button" class="btn btn--sm btn--primary" data-result="${order.id}" data-name="${order.test_name}" data-range="${order.reference_range ?? ''}" data-unit="${order.unit ?? ''}">Enter result</button>`)
          : ''}
      </td>
    </tr>`;
}

function wire(container) {
  on(container, 'click', '[data-status]', (_e, target) => {
    state = { ...state, status: target.dataset.status, page: 1 };
    load(container);
  });

  const search = container.querySelector('#lab-search');
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state = { ...state, search: search.value.trim(), page: 1 };
      fetchList(container);
    }, 300);
  });

  on(container, 'click', '[data-collect]', async (_e, target) => {
    try {
      await api.post(`/laboratory/orders/${target.dataset.collect}/collect`);
      toastOk('Specimen marked collected.');
      await fetchList(container);
    } catch (err) {
      reportError(err);
    }
  });

  on(container, 'click', '[data-result]', (_e, target) => {
    openResultForm(container, target.dataset.result, {
      name: target.dataset.name,
      range: target.dataset.range,
      unit: target.dataset.unit,
    });
  });

  on(container, 'click', '[data-view]', async (_e, target) => {
    try {
      const order = await api.get(`/laboratory/orders/${target.dataset.view}`);
      showOrder(container, order);
    } catch (err) {
      reportError(err);
    }
  });
}

function openResultForm(container, orderId, test) {
  openModal({
    title: `Enter result — ${test.name}`,
    wide: true,
    body: html`
      <form id="result-form">
        <div class="form-grid">
          <label class="field">
            <span class="field__label">Result *</span>
            <input class="input" name="result_value" required placeholder="Value or finding">
          </label>
          <label class="field">
            <span class="field__label">Unit</span>
            <input class="input" name="unit" value="${test.unit ?? ''}">
          </label>
          <label class="field">
            <span class="field__label">Reference range</span>
            <input class="input" name="reference_range" value="${test.range ?? ''}">
          </label>
          <label class="field">
            <span class="field__label">Flag *</span>
            <select class="select" name="flag">
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="low">Low</option>
              <option value="abnormal">Abnormal</option>
              <option value="critical">Critical</option>
              <option value="inconclusive">Inconclusive</option>
            </select>
          </label>
        </div>

        <label class="field">
          <span class="field__label">Interpretation</span>
          <textarea class="textarea" name="interpretation" placeholder="What the result means clinically"></textarea>
        </label>

        <label class="field">
          <span class="field__label">Notes</span>
          <textarea class="textarea" name="notes" placeholder="Specimen quality, anything the clinician should know"></textarea>
        </label>

        <label class="check">
          <input type="checkbox" name="complete_order" checked>
          <span>Mark the order complete (untick if more results are to follow)</span>
        </label>
      </form>

      <div class="fieldset mt-2">
        <legend>Attach an image or report</legend>
        <div class="form-grid">
          <label class="field"><span class="field__label">File name</span><input class="input" id="attach-name" placeholder="scan.png"></label>
          <label class="field"><span class="field__label">Image URL</span><input class="input" id="attach-url" placeholder="https://…"></label>
        </div>
        <span class="field__hint">Results are stored as links, so any image host the SL browser can load will work.</span>
      </div>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Save result',
        class: 'btn--primary',
        onClick: async (root) => {
          const values = readForm(root.querySelector('#result-form'));
          if (!values.result_value) {
            toastWarn('Enter the result value.');
            return true;
          }

          const attachUrl = root.querySelector('#attach-url').value.trim();
          if (attachUrl) {
            values.attachments = [{
              file_name: root.querySelector('#attach-name').value.trim() || 'attachment',
              file_url: attachUrl,
            }];
          }

          await api.post(`/laboratory/orders/${orderId}/results`, values);
          toastOk(values.flag === 'critical'
            ? 'Critical result saved — the ordering clinician has been alerted.'
            : 'Result saved.');
          context.refreshBadges();
          await load(container);
        },
      },
    ],
  });
}

function showOrder(container, order) {
  const results = order.results ?? [];
  const attachments = order.attachments ?? [];

  openModal({
    title: order.test_name,
    wide: true,
    body: html`
      <dl class="kv">
        <dt>Patient</dt><dd>${order.patient_name} (${order.mrn})</dd>
        <dt>Visit</dt><dd>${order.visit_number ?? '—'}</dd>
        <dt>Priority</dt><dd>${titleCase(order.priority)}</dd>
        <dt>Ordered</dt><dd>${fmtDateTime(order.ordered_at)} by ${order.ordered_by_name ?? '—'}</dd>
        <dt>Collected</dt><dd>${order.collected_at ? `${fmtDateTime(order.collected_at)} by ${order.collected_by_name ?? '—'}` : 'not yet'}</dd>
        <dt>Status</dt><dd>${raw(statusBadge(order.status))}</dd>
      </dl>

      ${order.clinical_notes ? raw(html`
        <div class="mt-2"><div class="field__label">Clinical notes</div><div class="pre-wrap">${order.clinical_notes}</div></div>`) : ''}

      ${results.length > 0 ? raw(html`
        <div class="card mt-2">
          <div class="card__head"><div class="card__title">Results</div></div>
          <div class="card__body--flush">
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Value</th><th>Reference</th><th>Flag</th><th>By</th></tr></thead>
                <tbody>
                  ${raw(results.map((r) => html`
                    <tr>
                      <td class="vital ${r.flag === 'critical' ? 'vital--red' : r.flag !== 'normal' ? 'vital--yellow' : 'vital--green'}">
                        ${r.result_value}${r.unit ? ` ${r.unit}` : ''}
                      </td>
                      <td class="muted">${r.reference_range ?? '—'}</td>
                      <td>${raw(statusBadge(r.flag))}</td>
                      <td class="muted">${fmtDateTime(r.resulted_at)}</td>
                    </tr>
                    ${r.interpretation ? raw(html`<tr><td colspan="4" class="pre-wrap">${r.interpretation}</td></tr>`) : ''}`).join(''))}
                </tbody>
              </table>
            </div>
          </div>
        </div>`) : ''}

      ${attachments.length > 0 ? raw(html`
        <div class="mt-2">
          <div class="field__label">Attachments</div>
          <div class="flex flex-wrap gap-sm">
            ${raw(attachments.map((a) => html`
              <a class="btn btn--sm btn--ghost" href="${a.file_url}" target="_blank" rel="noopener">${a.file_name}</a>`).join(''))}
          </div>
        </div>`) : ''}`,
    actions: [
      ...(can('lab:order') && !['completed', 'cancelled'].includes(order.status)
        ? [{
            label: 'Cancel order',
            class: 'btn--danger',
            onClick: async () => {
              const reason = await promptDialog({
                title: 'Cancel order',
                label: 'Reason',
                required: false,
                confirmLabel: 'Cancel order',
              });
              if (reason === null) return;
              await api.post(`/laboratory/orders/${order.id}/cancel`, { reason });
              toastOk('Order cancelled.');
              await load(container);
            },
          }]
        : []),
      { label: 'Close', class: 'btn--ghost' },
    ],
  });
}

export default {
  async render(container, ctx) {
    context = ctx;
    state = { status: 'ordered', page: 1, search: '' };
    ctx.setTitle('Laboratory', 'Test worklist');

    await load(container);
    unsubscribe = onEvent('laboratory:updated', () => fetchList(container));
  },

  destroy() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    clearTimeout(searchTimer);
  },
};
