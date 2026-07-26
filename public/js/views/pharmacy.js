/**
 * Pharmacy terminal.
 *
 * A worklist grouped by state: pending → ready → picked up. Refreshes live so
 * two pharmacists never fill the same script twice.
 */
import { api } from '../api.js';
import { can } from '../store.js';
import {
  html, raw, render, on, emptyState, loadingState, statCard, statusBadge,
  fmtAgo, fmtDuration, fmtMoney, titleCase, toastOk, toastWarn, reportError,
  openModal, promptDialog, paginationBar,
} from '../ui.js';
import { onEvent } from '../realtime.js';

let context = null;
let unsubscribe = null;
let state = { status: 'pending', page: 1, search: '' };
let searchTimer = null;

const TABS = [
  ['pending', 'Pending'],
  ['ready', 'Ready'],
  ['picked_up', 'Picked up'],
  ['rejected', 'Rejected'],
  ['', 'All'],
];

async function load(container) {
  let summary = {};
  try {
    summary = await api.get('/pharmacy/queue/summary');
  } catch { /* summary is decoration */ }

  render(container, html`
    <div class="grid grid--stats mb-2">
      ${raw(statCard({ label: 'Pending', value: summary.pending ?? 0, tone: summary.pending > 0 ? 'warn' : 'ok' }))}
      ${raw(statCard({ label: 'Ready for collection', value: summary.ready ?? 0, tone: 'accent' }))}
      ${raw(statCard({ label: 'Dispensed', value: summary.picked_up ?? 0, tone: 'ok' }))}
      ${raw(statCard({ label: 'Rejected', value: summary.rejected ?? 0, tone: summary.rejected > 0 ? 'danger' : undefined }))}
      ${raw(statCard({ label: 'Oldest pending', value: fmtDuration(summary.oldest_pending_minutes ?? 0), tone: (summary.oldest_pending_minutes ?? 0) > 30 ? 'danger' : undefined }))}
    </div>

    <div class="toolbar">
      <div class="segmented">
        ${raw(TABS.map(([value, label]) => html`
          <button type="button" class="segmented__btn ${state.status === value ? 'is-active' : ''}" data-status="${value}">${label}</button>`).join(''))}
      </div>
      <input class="input" id="pharm-search" placeholder="Search medication, patient or MRN" value="${state.search}" autocomplete="off">
      ${can('catalog:manage') ? raw('<button type="button" class="btn btn--ghost" id="stock-btn">Stock levels</button>') : ''}
    </div>

    <div class="card">
      <div class="card__body--flush" id="pharm-list">${raw(loadingState())}</div>
    </div>`);

  wire(container);
  await fetchList(container);
}

async function fetchList(container) {
  const host = container.querySelector('#pharm-list');
  if (!host) return;

  try {
    const entries = await api.get('/pharmacy/queue', {
      status: state.status || undefined,
      page: state.page,
      limit: 25,
      search: state.search || undefined,
    });

    if (entries.length === 0) {
      render(host, emptyState(
        state.status === 'pending' ? 'Nothing to fill' : 'No entries',
        state.status === 'pending' ? 'New prescriptions arrive here automatically.' : 'Try another tab or search term.',
        '💊'
      ));
      return;
    }

    render(host, html`
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Patient</th><th>Medication</th><th class="col-optional">Directions</th>
              <th class="col-optional">Prescriber</th><th>Waiting</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${raw(entries.map(renderRow).join(''))}
          </tbody>
        </table>
      </div>
      ${raw(paginationBar(entries.pagination, (page) => { state.page = page; fetchList(container); }))}`);
  } catch (err) {
    render(host, html`<div class="alert alert--error">${err.message}</div>`);
  }
}

function renderRow(entry) {
  const waitTone = entry.waiting_minutes > 30 ? 'vital--red' : entry.waiting_minutes > 15 ? 'vital--yellow' : '';
  const manage = can('pharmacy:manage');

  return html`
    <tr class="priority-${entry.priority}">
      <td class="is-clickable" data-href="/patients/${entry.patient_id}">
        <div class="row-title">${entry.patient_name}</div>
        <div class="row-sub mono">${entry.mrn}</div>
      </td>
      <td>
        <div class="row-title">
          ${entry.medication_name}
          ${entry.is_controlled ? raw('<span class="badge badge--danger">controlled</span>') : ''}
        </div>
        <div class="row-sub">
          Qty ${entry.quantity}
          ${entry.stock_quantity !== null && entry.stock_quantity !== undefined
            ? raw(html` · stock ${entry.stock_quantity}${entry.stock_quantity < entry.quantity ? ' ⚠' : ''}`)
            : ''}
        </div>
      </td>
      <td class="col-optional">
        ${entry.dosage}, ${entry.frequency}${entry.duration ? ` for ${entry.duration}` : ''}
      </td>
      <td class="col-optional muted">${entry.prescriber_name ?? '—'}</td>
      <td class="nowrap ${waitTone}">${fmtDuration(entry.waiting_minutes)}</td>
      <td>
        ${raw(statusBadge(entry.status))}
        ${raw(entry.priority === 'normal' ? '' : statusBadge(entry.priority))}
      </td>
      <td class="text-right nowrap">
        <button type="button" class="btn btn--sm btn--ghost" data-detail="${entry.id}">Details</button>
        ${manage && ['pending', 'in_progress'].includes(entry.status)
          ? raw(html`<button type="button" class="btn btn--sm btn--primary" data-fill="${entry.id}">Fill</button>`)
          : ''}
        ${manage && entry.status === 'ready'
          ? raw(html`<button type="button" class="btn btn--sm btn--ok" data-dispense="${entry.id}">Dispense</button>`)
          : ''}
      </td>
    </tr>`;
}

function wire(container) {
  on(container, 'click', '[data-status]', (_e, target) => {
    state = { ...state, status: target.dataset.status, page: 1 };
    load(container);
  });

  const search = container.querySelector('#pharm-search');
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state = { ...state, search: search.value.trim(), page: 1 };
      fetchList(container);
    }, 300);
  });

  const stockBtn = container.querySelector('#stock-btn');
  if (stockBtn) stockBtn.addEventListener('click', showStock);

  on(container, 'click', '[data-fill]', async (_e, target) => {
    target.disabled = true;
    try {
      const result = await api.post(`/pharmacy/queue/${target.dataset.fill}/fill`);
      if (result.stock_warning) toastWarn(result.stock_warning);
      else toastOk('Filled and ready for collection.');
      context.refreshBadges();
      await load(container);
    } catch (err) {
      reportError(err);
      target.disabled = false;
    }
  });

  on(container, 'click', '[data-dispense]', async (_e, target) => {
    const collectedBy = await promptDialog({
      title: 'Dispense medication',
      label: 'Collected by (leave blank for the patient)',
      placeholder: 'Name of the person collecting',
      required: false,
      confirmLabel: 'Dispense',
    });
    if (collectedBy === null) return;

    try {
      await api.post(`/pharmacy/queue/${target.dataset.dispense}/dispense`, { collected_by: collectedBy || null });
      toastOk('Dispensed.');
      context.refreshBadges();
      await load(container);
    } catch (err) {
      reportError(err);
    }
  });

  on(container, 'click', '[data-detail]', async (_e, target) => {
    try {
      const entry = await api.get(`/pharmacy/queue/${target.dataset.detail}`);
      showDetail(container, entry);
    } catch (err) {
      reportError(err);
    }
  });
}

function showDetail(container, entry) {
  const manage = can('pharmacy:manage');

  const actions = [{ label: 'Close', class: 'btn--ghost' }];

  if (manage && ['pending', 'in_progress'].includes(entry.status)) {
    actions.push({
      label: 'Reject',
      class: 'btn--danger',
      onClick: async () => {
        const reason = await promptDialog({
          title: 'Reject prescription',
          label: 'Reason (sent back to the prescriber)',
          placeholder: 'e.g. Interacts with an existing medication',
          multiline: true,
          confirmLabel: 'Reject',
        });
        if (!reason) return;
        await api.post(`/pharmacy/queue/${entry.id}/reject`, { reason });
        toastOk('Rejected and returned to the prescriber.');
        await load(container);
      },
    });
    actions.push({
      label: 'Fill',
      class: 'btn--primary',
      onClick: async () => {
        const result = await api.post(`/pharmacy/queue/${entry.id}/fill`);
        if (result.stock_warning) toastWarn(result.stock_warning);
        else toastOk('Filled.');
        context.refreshBadges();
        await load(container);
      },
    });
  }

  openModal({
    title: 'Prescription detail',
    body: html`
      ${entry.allergies?.length > 0 ? raw(html`
        <div class="alert alert--error">
          <strong>⚠ Recorded allergies:</strong>
          ${entry.allergies.map((a) => `${a.substance} (${a.severity})`).join(' · ')}
        </div>`) : ''}

      <dl class="kv">
        <dt>Patient</dt><dd>${entry.patient_name}</dd>
        <dt>MRN</dt><dd class="mono">${entry.mrn}</dd>
        <dt>Medication</dt><dd><strong>${entry.medication_name}</strong></dd>
        <dt>Dosage</dt><dd>${entry.dosage}</dd>
        <dt>Frequency</dt><dd>${entry.frequency}</dd>
        <dt>Duration</dt><dd>${entry.duration ?? '—'}</dd>
        <dt>Quantity</dt><dd>${entry.quantity}</dd>
        <dt>Refills</dt><dd>${entry.refills}</dd>
        <dt>Prescriber</dt><dd>${entry.prescriber_name ?? '—'}</dd>
        <dt>Prescribed</dt><dd>${fmtAgo(entry.prescribed_at)}</dd>
        <dt>Status</dt><dd>${raw(statusBadge(entry.status))}</dd>
        ${entry.unit_cost ? raw(html`<dt>Unit cost</dt><dd>${fmtMoney(entry.unit_cost)}</dd>`) : ''}
        ${entry.stock_quantity !== null && entry.stock_quantity !== undefined
          ? raw(html`<dt>In stock</dt><dd>${entry.stock_quantity}</dd>`) : ''}
        ${entry.filled_by_name ? raw(html`<dt>Filled by</dt><dd>${entry.filled_by_name}</dd>`) : ''}
        ${entry.dispensed_by_name ? raw(html`<dt>Dispensed by</dt><dd>${entry.dispensed_by_name}</dd>`) : ''}
      </dl>

      ${entry.instructions ? raw(html`<div class="alert alert--info mt-2">${entry.instructions}</div>`) : ''}
      ${entry.rejected_reason ? raw(html`<div class="alert alert--error mt-2">Rejected: ${entry.rejected_reason}</div>`) : ''}
      ${entry.notes ? raw(html`<div class="mt-2"><div class="field__label">Notes</div><div class="pre-wrap">${entry.notes}</div></div>`) : ''}`,
    actions,
  });
}

async function showStock() {
  try {
    const { low_stock, totals } = await api.get('/pharmacy/stock');

    openModal({
      title: 'Stock levels',
      wide: true,
      body: html`
        <div class="grid grid--stats mb-2">
          ${raw(statCard({ label: 'Items stocked', value: totals.total_items }))}
          ${raw(statCard({ label: 'Low stock', value: totals.low_stock, tone: totals.low_stock > 0 ? 'warn' : 'ok' }))}
          ${raw(statCard({ label: 'Out of stock', value: totals.out_of_stock, tone: totals.out_of_stock > 0 ? 'danger' : 'ok' }))}
        </div>

        ${low_stock.length === 0
          ? raw(emptyState('Everything is above its reorder level', '', '✓'))
          : raw(html`
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Medication</th><th>In stock</th><th>Reorder at</th><th></th></tr></thead>
                <tbody>
                  ${raw(low_stock.map((m) => html`
                    <tr>
                      <td>
                        <div class="row-title">${m.name}${m.strength ? ` ${m.strength}` : ''}</div>
                        <div class="row-sub">${m.category ?? ''}${m.is_controlled ? ' · controlled' : ''}</div>
                      </td>
                      <td class="num ${m.stock_quantity === 0 ? 'vital vital--red' : 'vital vital--yellow'}">${m.stock_quantity}</td>
                      <td class="num muted">${m.reorder_level}</td>
                      <td class="text-right">
                        <button type="button" class="btn btn--sm btn--ghost" data-restock="${m.id}" data-name="${m.name}">Receive stock</button>
                      </td>
                    </tr>`).join(''))}
                </tbody>
              </table>
            </div>`)}`,
      actions: [{ label: 'Close', class: 'btn--ghost' }],
      onMount(root) {
        root.querySelectorAll('[data-restock]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const amount = await promptDialog({
              title: `Receive stock — ${btn.dataset.name}`,
              label: 'Quantity received',
              placeholder: '100',
              confirmLabel: 'Add to stock',
            });
            if (!amount) return;

            const quantity = Number(amount);
            if (!Number.isFinite(quantity) || quantity <= 0) {
              toastWarn('Enter a positive number.');
              return;
            }

            try {
              await api.post(`/catalog/medications/${btn.dataset.restock}/stock`, {
                adjustment: quantity,
                reason: 'Stock delivery received',
              });
              toastOk('Stock updated.');
              showStock();
            } catch (err) {
              reportError(err);
            }
          });
        });
      },
    });
  } catch (err) {
    reportError(err);
  }
}

export default {
  async render(container, ctx) {
    context = ctx;
    state = { status: 'pending', page: 1, search: '' };
    ctx.setTitle('Pharmacy', 'Prescription queue');

    await load(container);
    unsubscribe = onEvent('pharmacy:updated', () => fetchList(container));
  },

  destroy() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    clearTimeout(searchTimer);
  },
};
