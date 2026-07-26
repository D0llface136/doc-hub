/**
 * Billing: invoices, payments and insurance claims.
 *
 * `#/billing`      invoice list and revenue summary
 * `#/billing/<id>` a single invoice with its items and payment history
 */
import { api } from '../api.js';
import { can } from '../store.js';
import {
  html, raw, render, on, emptyState, loadingState, statCard, statusBadge,
  fmtDate, fmtDateTime, fmtMoney, titleCase, toastOk, toastWarn, reportError,
  openModal, confirmDialog, paginationBar, readForm, promptDialog,
} from '../ui.js';

let context = null;
let state = { status: '', page: 1, search: '' };
let searchTimer = null;

const TABS = [
  ['', 'All'],
  ['draft', 'Draft'],
  ['issued', 'Issued'],
  ['partially_paid', 'Part paid'],
  ['paid', 'Paid'],
];

// ===========================================================================
// List
// ===========================================================================

async function loadList(container) {
  let summary = {};
  try {
    summary = await api.get('/billing/summary', { days: 30 });
  } catch { /* decoration */ }

  render(container, html`
    <div class="grid grid--stats mb-2">
      ${raw(statCard({ label: "Today's revenue", value: fmtMoney(summary.today?.revenue ?? 0), meta: `${summary.today?.payments ?? 0} payment(s)`, tone: 'ok' }))}
      ${raw(statCard({ label: 'Last 30 days', value: fmtMoney(summary.period?.revenue ?? 0), meta: `${summary.period?.payments ?? 0} payment(s)` }))}
      ${raw(statCard({ label: 'Outstanding', value: fmtMoney(summary.outstanding?.outstanding ?? 0), meta: `${summary.outstanding?.open_invoices ?? 0} open invoice(s)`, tone: (summary.outstanding?.outstanding ?? 0) > 0 ? 'warn' : 'ok' }))}
      ${raw(statCard({ label: 'Overdue', value: summary.outstanding?.overdue ?? 0, tone: (summary.outstanding?.overdue ?? 0) > 0 ? 'danger' : 'ok' }))}
    </div>

    <div class="toolbar">
      <div class="segmented">
        ${raw(TABS.map(([value, label]) => html`
          <button type="button" class="segmented__btn ${state.status === value ? 'is-active' : ''}" data-status="${value}">${label}</button>`).join(''))}
      </div>
      <input class="input" id="bill-search" placeholder="Search invoice number, patient or MRN" value="${state.search}" autocomplete="off">
      ${can('billing:write') ? raw('<button type="button" class="btn btn--primary" id="new-invoice">New invoice</button>') : ''}
    </div>

    <div class="card">
      <div class="card__body--flush" id="invoice-list">${raw(loadingState())}</div>
    </div>`);

  on(container, 'click', '[data-status]', (_e, target) => {
    state = { ...state, status: target.dataset.status, page: 1 };
    loadList(container);
  });

  const search = container.querySelector('#bill-search');
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state = { ...state, search: search.value.trim(), page: 1 };
      fetchInvoices(container);
    }, 300);
  });

  const newBtn = container.querySelector('#new-invoice');
  if (newBtn) newBtn.addEventListener('click', () => openNewInvoice(container));

  on(container, 'click', '[data-invoice]', (_e, target) => {
    context.navigate(`/billing/${target.dataset.invoice}`);
  });

  await fetchInvoices(container);
}

async function fetchInvoices(container) {
  const host = container.querySelector('#invoice-list');
  if (!host) return;

  try {
    const invoices = await api.get('/billing/invoices', {
      status: state.status || undefined,
      page: state.page,
      limit: 25,
      search: state.search || undefined,
    });

    if (invoices.length === 0) {
      render(host, emptyState('No invoices', 'Invoices raised for visits appear here.', '🧾'));
      return;
    }

    render(host, html`
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>Invoice</th><th>Patient</th><th class="col-optional">Type</th><th>Total</th><th class="col-optional">Paid</th><th>Balance</th><th>Status</th></tr>
          </thead>
          <tbody>
            ${raw(invoices.map((i) => html`
              <tr class="is-clickable" data-invoice="${i.id}">
                <td>
                  <div class="row-title mono">${i.invoice_number}</div>
                  <div class="row-sub">${fmtDate(i.created_at)}${i.visit_number ? ` · ${i.visit_number}` : ''}</div>
                </td>
                <td>
                  <div class="row-title">${i.patient_name}</div>
                  <div class="row-sub mono">${i.mrn}</div>
                </td>
                <td class="col-optional">
                  ${titleCase(i.billing_type)}
                  ${i.insurance_status ? raw(html` ${statusBadge(i.insurance_status)}`) : ''}
                </td>
                <td class="num">${fmtMoney(i.total)}</td>
                <td class="col-optional num">${fmtMoney(i.amount_paid)}</td>
                <td class="num ${Number(i.balance_due) > 0 ? 'vital vital--yellow' : ''}">${fmtMoney(i.balance_due)}</td>
                <td>${raw(statusBadge(i.status))}</td>
              </tr>`).join(''))}
          </tbody>
        </table>
      </div>
      ${raw(paginationBar(invoices.pagination, (page) => { state.page = page; fetchInvoices(container); }))}`);
  } catch (err) {
    render(host, html`<div class="alert alert--error">${err.message}</div>`);
  }
}

async function openNewInvoice(container, presetVisitId = null) {
  openModal({
    title: 'Create an invoice',
    wide: true,
    body: html`
      <label class="field">
        <span class="field__label">Patient *</span>
        <input class="input" id="inv-patient-search" placeholder="Search by name or MRN" autocomplete="off">
        <span class="field__hint" id="inv-patient-chosen">No patient selected.</span>
      </label>
      <div id="inv-patient-results" class="mb-2"></div>

      <label class="field" id="inv-visit-field" hidden>
        <span class="field__label">Visit to bill</span>
        <select class="select" id="inv-visit"><option value="">— No visit —</option></select>
        <span class="field__hint">Charges for the visit, medications, labs, imaging and surgery are pulled in automatically.</span>
      </label>

      <div class="form-grid">
        <label class="field">
          <span class="field__label">Billing type</span>
          <select class="select" id="inv-type">
            <option value="self_pay">Self pay</option>
            <option value="insurance">Insurance</option>
            <option value="mixed">Mixed</option>
            <option value="waived">Waived</option>
          </select>
        </label>
        <label class="field"><span class="field__label">Discount</span><input class="input" type="number" min="0" step="0.01" id="inv-discount" value="0"></label>
        <label class="field"><span class="field__label">Tax</span><input class="input" type="number" min="0" step="0.01" id="inv-tax" value="0"></label>
        <label class="field"><span class="field__label">Due date</span><input class="input" type="date" id="inv-due"></label>
      </div>

      <label class="check">
        <input type="checkbox" id="inv-auto" checked>
        <span>Pull charges from the selected visit automatically</span>
      </label>`,
    onMount(root) {
      const searchInput = root.querySelector('#inv-patient-search');
      const results = root.querySelector('#inv-patient-results');

      const pickPatient = async (id, name) => {
        root.dataset.patient = id;
        root.querySelector('#inv-patient-chosen').textContent = `Selected: ${name}`;

        try {
          const visits = await api.get(`/patients/${id}/visits`, { limit: 20 });
          const select = root.querySelector('#inv-visit');
          select.innerHTML = '<option value="">— No visit —</option>' +
            visits.map((v) => html`<option value="${v.id}" ${presetVisitId === v.id ? 'selected' : ''}>${v.visit_number} · ${fmtDate(v.checked_in_at)} · ${titleCase(v.status)}</option>`).join('');
          root.querySelector('#inv-visit-field').hidden = false;
        } catch { /* visits list is optional */ }
      };

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
                results.querySelectorAll('[data-pick]').forEach((b) => b.classList.remove('btn--primary'));
                btn.classList.add('btn--primary');
                pickPatient(btn.dataset.pick, btn.dataset.name);
              });
            });
          } catch { /* keep previous */ }
        }, 300);
      });
    },
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Create invoice',
        class: 'btn--primary',
        onClick: async (root) => {
          if (!root.dataset.patient) {
            toastWarn('Select a patient first.');
            return true;
          }

          const invoice = await api.post('/billing/invoices', {
            patient_id: root.dataset.patient,
            visit_id: root.querySelector('#inv-visit').value || null,
            billing_type: root.querySelector('#inv-type').value,
            discount_amount: Number(root.querySelector('#inv-discount').value) || 0,
            tax_amount: Number(root.querySelector('#inv-tax').value) || 0,
            due_date: root.querySelector('#inv-due').value || null,
            auto_charges: root.querySelector('#inv-auto').checked,
          });

          toastOk(`Invoice ${invoice.invoice_number} created.`);
          context.navigate(`/billing/${invoice.id}`);
        },
      },
    ],
  });
}

// ===========================================================================
// Detail
// ===========================================================================

async function loadInvoice(container, invoiceId) {
  render(container, loadingState('Loading invoice…'));

  let invoice;
  try {
    invoice = await api.get(`/billing/invoices/${invoiceId}`);
  } catch (err) {
    render(container, html`<div class="alert alert--error">${err.message}</div>`);
    return;
  }

  context.setTitle(invoice.invoice_number, `${invoice.patient_name} · ${titleCase(invoice.status)}`);

  const canWrite = can('billing:write');
  const editable = !['paid', 'void', 'written_off'].includes(invoice.status);

  render(container, html`
    <div class="flex flex-wrap flex-between mb-2">
      <a class="btn btn--sm btn--ghost" href="#/billing">‹ All invoices</a>
      <div class="btn-row">
        ${canWrite && invoice.status === 'draft' ? raw('<button type="button" class="btn btn--sm btn--primary" data-act="issue">Issue invoice</button>') : ''}
        ${canWrite && editable && invoice.status !== 'draft' && Number(invoice.balance_due) > 0
          ? raw('<button type="button" class="btn btn--sm btn--ok" data-act="payment">Record payment</button>') : ''}
        ${canWrite && invoice.billing_type !== 'self_pay' && invoice.patient_insurance_id
          ? raw('<button type="button" class="btn btn--sm btn--ghost" data-act="claim">Insurance claim</button>') : ''}
        ${canWrite && editable && Number(invoice.amount_paid) === 0
          ? raw('<button type="button" class="btn btn--sm btn--danger" data-act="void">Void</button>') : ''}
        <button type="button" class="btn btn--sm btn--ghost" data-act="print">Print</button>
      </div>
    </div>

    <div class="grid grid--stats mb-2">
      ${raw(statCard({ label: 'Total', value: fmtMoney(invoice.total) }))}
      ${raw(statCard({ label: 'Insurance covers', value: fmtMoney(invoice.insurance_covered), tone: 'accent' }))}
      ${raw(statCard({ label: 'Paid', value: fmtMoney(invoice.amount_paid), tone: 'ok' }))}
      ${raw(statCard({ label: 'Balance due', value: fmtMoney(invoice.balance_due), tone: Number(invoice.balance_due) > 0 ? 'warn' : 'ok' }))}
    </div>

    <div class="grid grid--2">
      <div class="card">
        <div class="card__head">
          <div class="card__title">Charges</div>
          ${canWrite && editable ? raw('<button type="button" class="btn btn--sm btn--ghost" data-act="add-item">Add charge</button>') : ''}
        </div>
        <div class="card__body--flush">
          ${invoice.items.length === 0
            ? raw(emptyState('No charges', 'Add a line item to bill for.', '＋'))
            : raw(html`
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Description</th><th class="col-optional">Qty</th><th class="col-optional">Unit</th><th>Total</th><th></th></tr></thead>
                  <tbody>
                    ${raw(invoice.items.map((item) => html`
                      <tr>
                        <td>
                          <div class="row-title">${item.description}</div>
                          <div class="row-sub">${titleCase(item.item_type)}</div>
                        </td>
                        <td class="col-optional num">${item.quantity}</td>
                        <td class="col-optional num">${fmtMoney(item.unit_price)}</td>
                        <td class="num">${fmtMoney(item.line_total)}</td>
                        <td class="text-right">
                          ${canWrite && editable
                            ? raw(html`<button type="button" class="btn btn--sm btn--ghost" data-drop-item="${item.id}">×</button>`)
                            : ''}
                        </td>
                      </tr>`).join(''))}
                  </tbody>
                  <tfoot>
                    <tr><td colspan="3" class="text-right muted">Subtotal</td><td class="num">${fmtMoney(invoice.subtotal)}</td><td></td></tr>
                    ${Number(invoice.discount_amount) > 0 ? raw(html`<tr><td colspan="3" class="text-right muted">Discount</td><td class="num">−${fmtMoney(invoice.discount_amount)}</td><td></td></tr>`) : ''}
                    ${Number(invoice.tax_amount) > 0 ? raw(html`<tr><td colspan="3" class="text-right muted">Tax</td><td class="num">${fmtMoney(invoice.tax_amount)}</td><td></td></tr>`) : ''}
                    <tr><td colspan="3" class="text-right"><strong>Total</strong></td><td class="num"><strong>${fmtMoney(invoice.total)}</strong></td><td></td></tr>
                  </tfoot>
                </table>
              </div>`)}
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card__head"><div class="card__title">Invoice details</div></div>
          <div class="card__body">
            <dl class="kv">
              <dt>Invoice</dt><dd class="mono">${invoice.invoice_number}</dd>
              <dt>Patient</dt><dd><a href="#/patients/${invoice.patient_id}">${invoice.patient_name}</a></dd>
              <dt>MRN</dt><dd class="mono">${invoice.mrn}</dd>
              <dt>Visit</dt><dd>${invoice.visit_id ? raw(html`<a href="#/visits/${invoice.visit_id}">${invoice.visit_number}</a>`) : '—'}</dd>
              <dt>Billing type</dt><dd>${titleCase(invoice.billing_type)}</dd>
              <dt>Insurance</dt><dd>${invoice.insurance_provider ?? '—'}${invoice.insurance_status ? raw(html` ${statusBadge(invoice.insurance_status)}`) : ''}</dd>
              <dt>Policy</dt><dd class="mono">${invoice.policy_number ?? '—'}</dd>
              <dt>Claim</dt><dd>${invoice.claim_status ? raw(statusBadge(invoice.claim_status)) : '—'}</dd>
              <dt>Created</dt><dd>${fmtDateTime(invoice.created_at)}</dd>
              <dt>Issued</dt><dd>${invoice.issued_at ? fmtDateTime(invoice.issued_at) : 'not yet'}</dd>
              <dt>Due</dt><dd>${invoice.due_date ? fmtDate(invoice.due_date) : '—'}</dd>
              <dt>Status</dt><dd>${raw(statusBadge(invoice.status))}</dd>
            </dl>
            ${invoice.claim_notes ? raw(html`<div class="mt-2"><div class="field__label">Claim notes</div><div class="pre-wrap">${invoice.claim_notes}</div></div>`) : ''}
          </div>
        </div>

        <div class="card">
          <div class="card__head"><div class="card__title">Payments</div></div>
          <div class="card__body--flush">
            ${invoice.payments.length === 0
              ? raw(emptyState('No payments recorded', '', '💰'))
              : raw(html`
                <div class="table-wrap">
                  <table class="table">
                    <tbody>
                      ${raw(invoice.payments.map((p) => html`
                        <tr>
                          <td>
                            <div class="row-title">${fmtMoney(p.amount)}</div>
                            <div class="row-sub">${titleCase(p.method)}${p.reference ? ` · ${p.reference}` : ''}</div>
                          </td>
                          <td class="text-right muted nowrap">
                            <div>${fmtDate(p.paid_at)}</div>
                            <div class="row-sub">${p.received_by_name ?? ''}</div>
                          </td>
                        </tr>`).join(''))}
                    </tbody>
                  </table>
                </div>`)}
          </div>
        </div>
      </div>
    </div>`);

  wireInvoice(container, invoice);
}

function wireInvoice(container, invoice) {
  on(container, 'click', '[data-act]', async (_e, target) => {
    const action = target.dataset.act;

    try {
      if (action === 'print') return window.print();

      if (action === 'issue') {
        await api.post(`/billing/invoices/${invoice.id}/issue`);
        toastOk('Invoice issued.');
        return loadInvoice(container, invoice.id);
      }

      if (action === 'void') {
        const reason = await promptDialog({
          title: 'Void invoice',
          label: 'Reason',
          placeholder: 'Why is this invoice being voided?',
          confirmLabel: 'Void invoice',
        });
        if (!reason) return;

        await api.post(`/billing/invoices/${invoice.id}/void`, { reason });
        toastOk('Invoice voided.');
        return loadInvoice(container, invoice.id);
      }

      if (action === 'payment') return openPayment(container, invoice);
      if (action === 'claim') return openClaim(container, invoice);
      if (action === 'add-item') return openAddItem(container, invoice);
    } catch (err) {
      reportError(err);
    }
  });

  on(container, 'click', '[data-drop-item]', async (_e, target) => {
    const confirmed = await confirmDialog({
      title: 'Remove charge',
      message: 'Remove this line from the invoice? The total is recalculated.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;

    try {
      await api.delete(`/billing/invoices/${invoice.id}/items/${target.dataset.dropItem}`);
      toastOk('Charge removed.');
      await loadInvoice(container, invoice.id);
    } catch (err) {
      reportError(err);
    }
  });
}

function openPayment(container, invoice) {
  openModal({
    title: 'Record a payment',
    body: html`
      <div class="alert alert--info">Outstanding balance: <strong>${fmtMoney(invoice.balance_due)}</strong></div>
      <form id="payment-form">
        <div class="form-grid">
          <label class="field">
            <span class="field__label">Amount *</span>
            <input class="input" name="amount" type="number" min="0.01" step="0.01" value="${invoice.balance_due}">
          </label>
          <label class="field">
            <span class="field__label">Method</span>
            <select class="select" name="method">
              <option value="cash">Cash</option>
              <option value="linden">Linden dollars</option>
              <option value="card">Card</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="insurance">Insurance</option>
              <option value="waived">Waived</option>
              <option value="other">Other</option>
            </select>
          </label>
        </div>
        <label class="field"><span class="field__label">Reference</span><input class="input" name="reference" placeholder="Transaction ID"></label>
        <label class="field"><span class="field__label">Notes</span><input class="input" name="notes"></label>
      </form>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Record payment',
        class: 'btn--ok',
        onClick: async (root) => {
          const values = readForm(root.querySelector('#payment-form'));
          if (!values.amount || Number(values.amount) <= 0) {
            toastWarn('Enter an amount greater than zero.');
            return true;
          }

          const result = await api.post(`/billing/invoices/${invoice.id}/payments`, values);
          toastOk(Number(result.invoice.balance_due) === 0
            ? 'Paid in full.'
            : `Payment recorded. ${fmtMoney(result.invoice.balance_due)} still outstanding.`);
          await loadInvoice(container, invoice.id);
        },
      },
    ],
  });
}

function openClaim(container, invoice) {
  openModal({
    title: 'Insurance claim',
    body: html`
      <dl class="kv mb-2">
        <dt>Provider</dt><dd>${invoice.insurance_provider ?? '—'}</dd>
        <dt>Policy</dt><dd class="mono">${invoice.policy_number ?? '—'}</dd>
        <dt>Coverage estimate</dt><dd>${fmtMoney(invoice.insurance_covered)}</dd>
      </dl>

      <label class="field">
        <span class="field__label">Claim status</span>
        <select class="select" id="claim-status">
          <option value="submitted">Submitted</option>
          <option value="approved">Approved</option>
          <option value="partially_approved">Partially approved</option>
          <option value="denied">Denied</option>
        </select>
      </label>
      <label class="field"><span class="field__label">Claim reference</span><input class="input" id="claim-ref"></label>
      <label class="field">
        <span class="field__label">Approved amount</span>
        <input class="input" type="number" min="0" step="0.01" id="claim-amount" value="${invoice.insurance_covered}">
        <span class="field__hint">Recorded as an insurance payment when the claim is approved.</span>
      </label>
      <label class="field"><span class="field__label">Notes</span><textarea class="textarea" id="claim-notes"></textarea></label>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Save claim',
        class: 'btn--primary',
        onClick: async (root) => {
          await api.post(`/billing/invoices/${invoice.id}/claim`, {
            claim_status: root.querySelector('#claim-status').value,
            claim_reference: root.querySelector('#claim-ref').value.trim() || null,
            claim_notes: root.querySelector('#claim-notes').value.trim() || null,
            approved_amount: Number(root.querySelector('#claim-amount').value) || undefined,
          });
          toastOk('Claim updated.');
          await loadInvoice(container, invoice.id);
        },
      },
    ],
  });
}

function openAddItem(container, invoice) {
  openModal({
    title: 'Add a charge',
    body: html`
      <form id="item-form">
        <label class="field">
          <span class="field__label">Type</span>
          <select class="select" name="item_type">
            <option value="visit">Consultation</option>
            <option value="medication">Medication</option>
            <option value="laboratory">Laboratory</option>
            <option value="radiology">Imaging</option>
            <option value="surgery">Surgery</option>
            <option value="procedure">Procedure</option>
            <option value="supply">Supplies</option>
            <option value="other" selected>Other</option>
          </select>
        </label>
        <label class="field"><span class="field__label">Description *</span><input class="input" name="description" placeholder="What is being charged for"></label>
        <div class="form-grid">
          <label class="field"><span class="field__label">Quantity</span><input class="input" name="quantity" type="number" min="0.01" step="0.01" value="1"></label>
          <label class="field"><span class="field__label">Unit price *</span><input class="input" name="unit_price" type="number" min="0" step="0.01" value="0"></label>
        </div>
      </form>`,
    actions: [
      { label: 'Cancel', class: 'btn--ghost' },
      {
        label: 'Add charge',
        class: 'btn--primary',
        onClick: async (root) => {
          const values = readForm(root.querySelector('#item-form'));
          if (!values.description) {
            toastWarn('Enter a description.');
            return true;
          }

          await api.post(`/billing/invoices/${invoice.id}/items`, values);
          toastOk('Charge added.');
          await loadInvoice(container, invoice.id);
        },
      },
    ],
  });
}

// ===========================================================================

export default {
  async render(container, ctx) {
    context = ctx;

    if (ctx.id) {
      await loadInvoice(container, ctx.id);
    } else {
      state = { status: '', page: 1, search: '' };
      ctx.setTitle('Billing', 'Invoices and payments');
      await loadList(container);
    }
  },

  destroy() {
    clearTimeout(searchTimer);
  },
};
