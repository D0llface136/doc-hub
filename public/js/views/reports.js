/**
 * Reports view.
 *
 * Provides a lightweight reporting surface for the statistics dashboard and
 * the most useful operational summaries. It keeps the UI responsive in the
 * Second Life MOAP browser by using one data fetch and rendering tables with
 * simple controls.
 */
import { api } from '../api.js';
import { html, render, esc, raw, fmtMoney } from '../ui.js';

function buildSummaryCard(title, value, subtitle) {
  return html`
    <article class="card card--compact">
      <h3>${esc(title)}</h3>
      <div class="metric metric--large">${esc(value)}</div>
      <p class="dim">${esc(subtitle)}</p>
    </article>`;
}

export default {
  async render(container, context) {
    context.setTitle('Reports', 'Operational and financial summaries');

    let overview;
    let diagnoses;
    let workload;
    try {
      [overview, diagnoses, workload] = await Promise.all([
        api.get('/stats/overview', { days: 30 }),
        api.get('/stats/diagnoses', { days: 30, limit: 10 }),
        api.get('/stats/workload', { days: 30 }),
      ]);
    } catch (err) {
      render(container, html`<div class="alert alert--error">${esc(err.message)}</div>`);
      return;
    }

    const cards = [
      buildSummaryCard('Visits', overview.visits?.total_visits ?? 0, 'Last 30 days'),
      buildSummaryCard('Completed', overview.visits?.completed ?? 0, 'Visits concluded'),
      buildSummaryCard('Avg wait', `${overview.wait_times?.avg_wait_minutes ?? 0} min`, 'From check-in to seen'),
      buildSummaryCard('Revenue', `${fmtMoney(overview.financial?.revenue ?? 0)}`, 'Payments posted'),
    ];

    const diagnosisRows = diagnoses.length > 0
      ? diagnoses.map((item) => html`
          <tr>
            <td>${esc(item.diagnosis)}</td>
            <td>${esc(item.category ?? '—')}</td>
            <td>${esc(item.count)}</td>
            <td>${esc(item.unique_patients)}</td>
          </tr>`).join('')
      : html`<tr><td colspan="4" class="dim">No diagnosis data yet.</td></tr>`;

    const workloadRows = workload.length > 0
      ? workload.map((item) => html`
          <tr>
            <td>${esc(item.full_name)}</td>
            <td>${esc(item.role_name ?? 'Staff')}</td>
            <td>${esc(item.patients_seen ?? 0)}</td>
            <td>${esc(item.prescriptions ?? 0)}</td>
          </tr>`).join('')
      : html`<tr><td colspan="4" class="dim">No workload data yet.</td></tr>`;

    render(container, html`
      <section class="stack stack--lg">
        <div class="grid grid--4">
          ${cards.join('')}
        </div>

        <div class="grid grid--2">
          <article class="card">
            <div class="card__head">
              <h2>Most common diagnoses</h2>
            </div>
            <table class="table">
              <thead>
                <tr><th>Diagnosis</th><th>Category</th><th>Count</th><th>Patients</th></tr>
              </thead>
              <tbody>${raw(diagnosisRows)}</tbody>
            </table>
          </article>

          <article class="card">
            <div class="card__head">
              <h2>Workload snapshot</h2>
            </div>
            <table class="table">
              <thead>
                <tr><th>Staff</th><th>Role</th><th>Visits</th><th>Rx</th></tr>
              </thead>
              <tbody>${raw(workloadRows)}</tbody>
            </table>
          </article>
        </div>
      </section>
    `);
  },
};

