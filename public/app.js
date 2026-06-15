let state = null;
let tick = null;
let currentView = 'track';
let editingEntryId = null;
const selectedInvoiceEntryIds = new Set();
const noChargeInvoiceEntryIds = new Set();

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = (value) => `$${money.format(Number(value || 0))}`;
const fmtHours = (ms) => `${(ms / 36e5).toFixed(2)}h`;
const fmtDate = (value) => value ? new Date(value).toLocaleDateString() : '';
const fmtClock = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
};
const toast = (msg) => { $('toast').textContent = msg; $('toast').hidden = false; setTimeout(() => $('toast').hidden = true, 2400); };
const selectedTimeTotal = (entries, noChargeIds = new Set()) => entries.reduce((sum, e) => noChargeIds.has(e.id) ? sum : sum + e.durationMs, 0);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function load() {
  state = await api('/api/state');
  render();
}

function customerById(id) { return state.customers.find(c => c.id === id); }
function projectById(id) { return state.projects.find(p => p.id === id); }
function projectLabel(project, includeCustomer = true) {
  const customer = customerById(project.customerId);
  const projectName = project.displayName || project.projectPath?.join(' / ') || project.name;
  return includeCustomer ? `${customer?.name || 'Unknown'} / ${projectName}` : projectName;
}

function projectOptions(select, placeholder = 'Choose project', options = {}) {
  const { customerId = '', includeCustomer = true, allOption = false } = options;
  const opts = state.projects
    .filter(p => !p.archived && (!customerId || p.customerId === customerId))
    .map(p => `<option value="${p.id}">${escapeHtml(projectLabel(p, includeCustomer))}</option>`)
    .join('');
  select.innerHTML = `<option value="">${placeholder}</option>${allOption ? '<option value="__all">All projects</option>' : ''}${opts}`;
}

function customerOptions(select, placeholder = 'Choose customer', allOption = false) {
  select.innerHTML = `<option value="">${placeholder}</option>${allOption ? '<option value="__all">All customers</option>' : ''}` + state.customers
    .filter(c => !c.archived)
    .map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

function render() {
  const selectedProjectCustomer = $('projectCustomer')?.value || '';
  const selectedInvoiceCustomer = $('invoiceCustomer')?.value || '';
  const selectedManualInvoiceCustomer = $('manualInvoiceCustomer')?.value || '';
  customerOptions($('projectCustomer'));
  if (selectedProjectCustomer) $('projectCustomer').value = selectedProjectCustomer;
  projectOptions($('parentProject'), 'Top-level project', { customerId: $('projectCustomer').value, includeCustomer: false });
  projectOptions($('timerProject'));
  projectOptions($('manualProject'));
  customerOptions($('reportCustomer'), 'All customers', true);
  projectOptions($('reportProject'), 'All projects', { allOption: true });
  customerOptions($('invoiceCustomer'), 'Choose customer');
  if (selectedInvoiceCustomer) $('invoiceCustomer').value = selectedInvoiceCustomer;
  customerOptions($('manualInvoiceCustomer'), 'Choose customer');
  if (selectedManualInvoiceCustomer) $('manualInvoiceCustomer').value = selectedManualInvoiceCustomer;
  projectOptions($('invoiceProject'), 'All projects', { customerId: $('invoiceCustomer').value, allOption: true, includeCustomer: false });
  renderTopStats();
  renderTimer();
  renderSummary();
  renderEntries();
  renderProjectTree();
  renderReports();
  renderInvoices();
  renderCompany();
}

function renderTopStats() {
  const todayMs = state.entries.filter(e => inRange(e, 'today')).reduce((sum, e) => sum + e.durationMs, 0);
  const weekMs = state.entries.filter(e => inRange(e, 'week')).reduce((sum, e) => sum + e.durationMs, 0);
  const unbilledMs = state.entries.filter(e => !e.billed).reduce((sum, e) => sum + e.durationMs, 0);
  $('topStats').innerHTML = `<span><strong>${fmtHours(todayMs)}</strong><small>today</small></span><span><strong>${fmtHours(weekMs)}</strong><small>week</small></span><span><strong>${fmtHours(unbilledMs)}</strong><small>unbilled</small></span>`;
}

function renderTimer() {
  const timer = state.activeTimer;
  $('startBtn').disabled = !!timer || state.projects.length === 0;
  $('stopBtn').disabled = !timer;
  $('timerProject').disabled = !!timer;
  $('timerStart').disabled = !!timer;
  if (timer) {
    const project = projectById(timer.projectId);
    $('timerLabel').textContent = project ? projectLabel(project) : 'Customer / Project';
    $('timerNotes').value = timer.notes || '';
    $('timerProject').value = timer.projectId;
    $('timerStart').value = toLocalInputValue(timer.startedAt);
  } else {
    $('timerLabel').textContent = 'No timer running';
    $('timerClock').textContent = '00:00:00';
    $('timerProject').disabled = false;
    $('timerStart').disabled = false;
    if (!$('timerStart').value) $('timerStart').value = toLocalInputValue(new Date());
  }
  clearInterval(tick);
  tick = setInterval(() => {
    $('timerClock').textContent = timer ? fmtClock(Date.now() - new Date(timer.startedAt).getTime()) : '00:00:00';
  }, 500);
}

function inRange(entry, range) {
  if (range === 'all') return true;
  const d = new Date(entry.startedAt);
  const now = new Date();
  const start = new Date(now);
  if (range === 'today') start.setHours(0,0,0,0);
  if (range === 'week') start.setDate(now.getDate() - now.getDay()), start.setHours(0,0,0,0);
  if (range === 'month') start.setDate(1), start.setHours(0,0,0,0);
  return d >= start;
}

function renderSummary() {
  const range = $('rangeSelect').value;
  const totals = new Map();
  for (const entry of state.entries.filter(e => inRange(e, range))) {
    const key = `${entry.customerName} / ${entry.projectDisplayName || entry.projectName}`;
    totals.set(key, (totals.get(key) || 0) + entry.durationMs);
  }
  const rows = [...totals.entries()].sort((a,b) => b[1] - a[1]);
  const total = rows.reduce((sum, [,ms]) => sum + ms, 0);
  $('summary').innerHTML = `
    <div class="summaryRow total"><strong>Total</strong><strong>${fmtHours(total)}</strong></div>
    ${rows.length ? rows.map(([name, ms]) => `<div class="summaryRow"><span>${escapeHtml(name)}</span><strong>${fmtHours(ms)}</strong></div>`).join('') : '<p class="muted">No time logged in this range yet.</p>'}
  `;
}

function billingBadge(e) {
  const cls = e.billingStatus === 'paid' ? 'paid' : e.billingStatus === 'billed' ? 'billed' : 'unbilled';
  const label = e.billingStatus === 'paid' ? `Paid · ${e.invoiceNumber}` : e.billingStatus === 'billed' ? `Billed · ${e.invoiceNumber}` : 'Unbilled';
  return `<span class="billBadge ${cls}">${escapeHtml(label)}</span>`;
}

function entryCard(e, allowActions = true) {
  const project = projectById(e.projectId);
  return `<article class="entry ${e.billed ? 'isBilled' : ''}">
    <div>
      <strong><span class="projectDot" style="background:${project?.color || '#8b5cf6'}"></span>${escapeHtml(e.customerName)} / ${escapeHtml(e.projectDisplayName || e.projectName)}</strong>
      <div class="entryMeta">${new Date(e.startedAt).toLocaleString()} → ${new Date(e.endedAt).toLocaleTimeString()} · ${fmtHours(e.durationMs)} · ${billingBadge(e)}</div>
      ${e.notes ? `<div class="entryNotes">${escapeHtml(e.notes)}</div>` : ''}
    </div>
    ${allowActions ? `<div class="entryActions"><button class="ghost" data-edit="${e.id}" ${e.billed ? 'disabled title="Billed entries are locked"' : ''}>Edit</button><button class="ghost" data-delete="${e.id}" ${e.billed ? 'disabled title="Billed entries are locked"' : ''}>Delete</button></div>` : ''}
  </article>`;
}

function localInputToIso(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return date.toISOString();
}

function toLocalInputValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function resetManualForm() {
  editingEntryId = null;
  $('manualTitle').textContent = 'Manual entry';
  $('manualSubmit').textContent = 'Save entry';
  $('manualCancel').hidden = true;
  $('manualProject').value = '';
  $('manualEnd').value = '';
  $('manualHours').value = '';
  $('manualNotes').value = '';
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  $('manualStart').value = now.toISOString().slice(0, 16);
}

function editEntry(id) {
  const entry = state.entries.find(e => e.id === id);
  if (!entry) return toast('Entry not found');
  if (entry.billed) return toast('Billed entries are locked');
  editingEntryId = id;
  $('manualTitle').textContent = 'Edit entry';
  $('manualSubmit').textContent = 'Save changes';
  $('manualCancel').hidden = false;
  $('manualProject').value = entry.projectId;
  $('manualStart').value = toLocalInputValue(entry.startedAt);
  $('manualEnd').value = toLocalInputValue(entry.endedAt);
  $('manualHours').value = (entry.durationMs / 36e5).toFixed(2);
  $('manualNotes').value = entry.notes || '';
  $('manualForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderEntries() {
  const entries = state.entries.slice().sort((a,b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const unbilled = entries.filter(e => !e.billed).length;
  $('entryCount').textContent = `${entries.length} saved · ${unbilled} unbilled`;
  $('entries').innerHTML = entries.length ? entries.slice(0, 50).map(e => entryCard(e)).join('') : '<p class="muted">No entries yet. Start a timer or add one manually.</p>';
}

function renderProjectTree() {
  $('projectCount').textContent = `${state.customers.length} customers · ${state.projects.length} projects`;
  if (!state.customers.length) {
    $('projectTree').innerHTML = '<p class="muted">No customers yet. Add one above to get started.</p>';
    return;
  }
  const projectsByParent = new Map();
  for (const p of state.projects) {
    const key = p.parentProjectId || 'root';
    projectsByParent.set(key, [...(projectsByParent.get(key) || []), p]);
  }
  const renderProject = (p, depth = 0) => {
    const children = projectsByParent.get(p.id) || [];
    const total = state.entries.filter(e => e.projectId === p.id).reduce((sum, e) => sum + e.durationMs, 0);
    return `<div class="treeItem" style="--depth:${depth}">
      <span><span class="projectDot" style="background:${p.color || '#8b5cf6'}"></span>${escapeHtml(p.name)}</span>
      <strong>${fmtHours(total)}</strong>
    </div>${children.map(c => renderProject(c, depth + 1)).join('')}`;
  };
  $('projectTree').innerHTML = state.customers.map(c => {
    const roots = state.projects.filter(p => p.customerId === c.id && !p.parentProjectId);
    const total = state.entries.filter(e => projectById(e.projectId)?.customerId === c.id).reduce((sum, e) => sum + e.durationMs, 0);
    return `<section class="customerBlock"><div class="treeCustomer"><strong>${escapeHtml(c.name)}</strong><strong>${fmtHours(total)}</strong></div>${roots.length ? roots.map(p => renderProject(p)).join('') : '<p class="muted indent">No projects yet.</p>'}</section>`;
  }).join('');
}

function filteredEntries(prefix, includeBilled = true) {
  const customerId = $(`${prefix}Customer`).value;
  const projectId = $(`${prefix}Project`).value;
  const from = $(`${prefix}From`).value ? new Date(`${$(`${prefix}From`).value}T00:00:00`) : null;
  const to = $(`${prefix}To`).value ? new Date(`${$(`${prefix}To`).value}T23:59:59`) : null;
  return state.entries.filter(e => {
    const project = projectById(e.projectId);
    const start = new Date(e.startedAt);
    if (!includeBilled && e.billed) return false;
    if (customerId && customerId !== '__all' && project?.customerId !== customerId) return false;
    if (projectId && projectId !== '__all' && e.projectId !== projectId) return false;
    if (from && start < from) return false;
    if (to && start > to) return false;
    return true;
  }).sort((a,b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function filteredReportEntries() {
  const status = $('reportBilling').value;
  return filteredEntries('report', true).filter(e => status === 'all' || e.billingStatus === status);
}
function filteredInvoiceEntries() { return filteredEntries('invoice', false); }

function renderReportRows(el, rows, empty) {
  el.innerHTML = rows.length ? rows.map(([label, ms]) => `<div class="summaryRow"><span>${escapeHtml(label)}</span><strong>${fmtHours(ms)}</strong></div>`).join('') : `<p class="muted">${empty}</p>`;
}

function renderReports() {
  const entries = filteredReportEntries();
  const totalMs = entries.reduce((sum, e) => sum + e.durationMs, 0);
  const days = new Set(entries.map(e => e.startedAt.slice(0, 10))).size;
  $('reportTotals').innerHTML = `
    <div class="reportCard"><strong>${fmtHours(totalMs)}</strong><span>Total time</span></div>
    <div class="reportCard"><strong>${entries.length}</strong><span>Entries</span></div>
    <div class="reportCard"><strong>${days}</strong><span>Worked days</span></div>
    <div class="reportCard"><strong>${money.format(totalMs / 36e5)}</strong><span>Decimal hours</span></div>
  `;
  const byCustomer = new Map();
  const byProject = new Map();
  for (const e of entries) {
    byCustomer.set(e.customerName, (byCustomer.get(e.customerName) || 0) + e.durationMs);
    const projectName = `${e.customerName} / ${e.projectDisplayName || e.projectName}`;
    byProject.set(projectName, (byProject.get(projectName) || 0) + e.durationMs);
  }
  const sorted = (map) => [...map.entries()].sort((a,b) => b[1] - a[1]);
  renderReportRows($('reportByCustomer'), sorted(byCustomer), 'No customer totals for this filter.');
  renderReportRows($('reportByProject'), sorted(byProject), 'No project totals for this filter.');
  $('reportEntryCount').textContent = `${entries.length} matching`;
  $('reportEntries').innerHTML = entries.length ? entries.map(e => entryCard(e, false)).join('') : '<p class="muted">No entries match the report filters.</p>';
}

function renderInvoices() {
  const entries = filteredInvoiceEntries();
  for (const id of [...selectedInvoiceEntryIds]) {
    if (!entries.some(e => e.id === id)) selectedInvoiceEntryIds.delete(id);
  }
  for (const id of [...noChargeInvoiceEntryIds]) {
    if (!selectedInvoiceEntryIds.has(id)) noChargeInvoiceEntryIds.delete(id);
  }
  $('invoiceEntryList').innerHTML = entries.length ? entries.map(e => `
    <article class="entry selectable ${selectedInvoiceEntryIds.has(e.id) ? 'selected' : ''}">
      <input type="checkbox" data-invoice-entry="${e.id}" ${selectedInvoiceEntryIds.has(e.id) ? 'checked' : ''} aria-label="Select entry" />
      <div>
        <strong>${escapeHtml(e.customerName)} / ${escapeHtml(e.projectDisplayName || e.projectName)}</strong>
        <div class="entryMeta">${new Date(e.startedAt).toLocaleString()} · ${fmtHours(e.durationMs)}</div>
        ${e.notes ? `<div class="entryNotes">${escapeHtml(e.notes)}</div>` : ''}
      </div>
      <label class="includedToggle">
        <input type="checkbox" data-no-charge-entry="${e.id}" ${noChargeInvoiceEntryIds.has(e.id) ? 'checked' : ''} ${selectedInvoiceEntryIds.has(e.id) ? '' : 'disabled'} />
        Included / no charge
      </label>
    </article>`).join('') : '<p class="muted">No unbilled entries match these filters.</p>';
  updateInvoiceSelectionTotal();

  const invoices = state.invoices || [];
  $('invoiceCount').textContent = `${invoices.length} total`;
  $('invoiceList').innerHTML = invoices.length ? invoices.map(inv => `
    <article class="entry invoiceCard">
      <div>
        <strong>${escapeHtml(inv.number)} · ${escapeHtml(inv.customerName)}</strong>
        <div class="entryMeta">${inv.type === 'manual' ? `${(inv.lineItems || []).length} manual lines` : `${inv.entryCount} entries`} · ${Number(inv.totalHours || 0).toFixed(2)} billable h · ${fmtMoney(inv.totalAmount)} · <span class="billBadge ${inv.status === 'paid' ? 'paid' : 'billed'}">${inv.status === 'paid' ? 'Paid' : 'Unpaid'}</span></div>
        <div class="entryMeta">Issued ${fmtDate(inv.issuedAt)}${inv.dueDate ? ` · Due ${escapeHtml(inv.dueDate)}` : ''}${inv.paidAt ? ` · Paid ${fmtDate(inv.paidAt)}` : ''}</div>
        ${inv.notes ? `<div class="entryNotes">${escapeHtml(inv.notes)}</div>` : ''}
      </div>
      <div class="entryActions invoiceActions">
        <a class="button ghost subtle" href="/api/invoices/${inv.id}.html" target="_blank" rel="noopener">Open</a>
        <a class="button ghost subtle" href="/api/invoices/${inv.id}.pdf">PDF</a>
        <a class="button ghost subtle" href="/invoice-edit.html?id=${encodeURIComponent(inv.id)}">Edit</a>
        <button class="ghost subtle" data-invoice-status="${inv.id}" data-status="${inv.status === 'paid' ? 'unpaid' : 'paid'}">Mark ${inv.status === 'paid' ? 'unpaid' : 'paid'}</button>
        <button class="ghost subtle dangerText" data-invoice-delete="${inv.id}">Delete</button>
      </div>
    </article>`).join('') : '<p class="muted">No invoices yet. Select unbilled entries above to create one.</p>';
}

function updateInvoiceSelectionTotal() {
  const selected = state.entries.filter(e => selectedInvoiceEntryIds.has(e.id));
  const totalMs = selected.reduce((sum, e) => sum + e.durationMs, 0);
  const billableMs = selected.reduce((sum, e) => noChargeInvoiceEntryIds.has(e.id) ? sum : sum + e.durationMs, 0);
  const rate = Number($('invoiceRate').value || 0);
  const fixedAmount = Number($('invoiceFixedAmount').value || 0);
  const fixedQty = Number($('invoiceFixedQty').value || (fixedAmount > 0 ? 1 : 0));
  const fixedTotal = fixedQty * fixedAmount;
  $('invoiceSelectionTotal').textContent = `${selected.length} selected · ${(totalMs / 36e5).toFixed(2)}h shown · ${(billableMs / 36e5).toFixed(2)}h charged · ${fmtMoney((billableMs / 36e5) * rate + fixedTotal)}`;
  $('createInvoiceBtn').disabled = selected.length === 0;
}

function invoiceFixedLineItems() {
  const date = $('invoiceFixedDate').value;
  const description = $('invoiceFixedDescription').value.trim();
  const rate = Number($('invoiceFixedAmount').value || 0);
  const hours = Number($('invoiceFixedQty').value || (rate > 0 ? 1 : 0));
  return description && (hours > 0 || rate > 0) ? [{ date, description, hours, rate }] : [];
}

function manualInvoiceLineTemplate(item = {}) {
  return `<div class="manualLine">
    <label>Date <input class="manualLineDate" type="date" value="${escapeHtml(item.date || '')}" /></label>
    <label>Description <input class="manualLineDescription" placeholder="Consulting services" value="${escapeHtml(item.description || '')}" /></label>
    <label>Hours / Qty <input class="manualLineHours" type="number" min="0" step="0.01" placeholder="1" value="${item.hours ?? ''}" /></label>
    <label>Rate <input class="manualLineRate" type="number" min="0" step="0.01" placeholder="150" value="${item.rate ?? ''}" /></label>
    <button type="button" class="ghost subtle removeManualLine">Remove</button>
  </div>`;
}

function invoiceLines(containerId) {
  return [...document.querySelectorAll(`#${containerId} .manualLine`)].map(line => ({
    date: line.querySelector('.manualLineDate')?.value || '',
    description: line.querySelector('.manualLineDescription')?.value || '',
    hours: Number(line.querySelector('.manualLineHours')?.value || 0),
    rate: Number(line.querySelector('.manualLineRate')?.value || 0)
  }));
}

function manualInvoiceLines() { return invoiceLines('manualInvoiceLines'); }

function updateManualInvoiceTotal() {
  const lines = manualInvoiceLines();
  const totalHours = lines.reduce((sum, item) => sum + Number(item.hours || 0), 0);
  const totalAmount = lines.reduce((sum, item) => sum + Number(item.hours || 0) * Number(item.rate || 0), 0);
  $('manualInvoiceTotal').textContent = `${totalHours.toFixed(2)}h · ${fmtMoney(totalAmount)}`;
}

function resetManualInvoiceForm() {
  $('manualInvoiceCustomer').value = '';
  $('manualInvoiceDueDate').value = '';
  $('manualInvoiceNotes').value = '';
  $('manualInvoiceLines').innerHTML = manualInvoiceLineTemplate();
  updateManualInvoiceTotal();
}

function renderCompany() {
  const company = state.company || {};
  $('companyName').value = company.companyName || '';
  $('companyAddress').value = company.companyAddress || '';
  $('companyLogoUrl').value = company.logoUrl || '';
  $('companyPreviewName').textContent = company.companyName || 'No company saved';
  $('companyPreviewAddress').textContent = company.companyAddress || '';
  const preview = $('companyLogoPreview');
  if (company.logoUrl) {
    preview.src = company.logoUrl;
    preview.hidden = false;
  } else {
    preview.removeAttribute('src');
    preview.hidden = true;
  }
}

function showView(view) {
  currentView = view;
  document.querySelectorAll('.navBtn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === `${view}View`));
  const titles = {
    track: ['Track time', 'Customer project timer'],
    projects: ['Organize work', 'Customers, projects & sub-projects'],
    reports: ['Review work', 'Time reports'],
    invoices: ['Bill work', 'Invoices & payment tracking'],
    company: ['Company profile', 'Invoice company settings']
  };
  $('viewEyebrow').textContent = titles[view][0];
  $('viewTitle').textContent = titles[view][1];
  if (view === 'reports') renderReports();
  if (view === 'invoices') renderInvoices();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));
}

document.querySelectorAll('.navBtn').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));

$('customerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: $('customerName').value }) });
  $('customerName').value = '';
  toast('Customer added');
  await load();
});

$('projectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ customerId: $('projectCustomer').value, parentProjectId: $('parentProject').value, name: $('projectName').value, color: $('projectColor').value }) });
  $('projectName').value = '';
  $('parentProject').value = '';
  toast('Project added');
  await load();
});

$('projectCustomer').addEventListener('change', () => {
  projectOptions($('parentProject'), 'Top-level project', { customerId: $('projectCustomer').value, includeCustomer: false });
});

$('timerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/timer/start', { method: 'POST', body: JSON.stringify({ projectId: $('timerProject').value, startedAt: localInputToIso($('timerStart').value), notes: $('timerNotes').value }) });
  toast('Timer started');
  await load();
});

$('stopBtn').addEventListener('click', async () => {
  await api('/api/timer/stop', { method: 'POST', body: JSON.stringify({ notes: $('timerNotes').value }) });
  $('timerNotes').value = '';
  $('timerStart').value = toLocalInputValue(new Date());
  toast('Time saved');
  await load();
});

$('timerNotes').addEventListener('change', async () => {
  if (state?.activeTimer) await api('/api/timer', { method: 'PATCH', body: JSON.stringify({ notes: $('timerNotes').value }) });
});

$('manualForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (!$('manualProject').value) return toast('Choose a project');
    if (!$('manualStart').value) return toast('Choose a start time');
    if (!$('manualEnd').value && !Number($('manualHours').value || 0)) return toast('Choose an end time or enter hours');

    const body = JSON.stringify({ projectId: $('manualProject').value, startedAt: localInputToIso($('manualStart').value), endedAt: localInputToIso($('manualEnd').value), hours: $('manualHours').value, notes: $('manualNotes').value });
    if (editingEntryId) {
      await api(`/api/entries/${editingEntryId}`, { method: 'PATCH', body });
      toast('Entry updated');
    } else {
      await api('/api/entries', { method: 'POST', body });
      toast('Entry saved');
    }
    resetManualForm();
    await load();
  } catch (err) {
    toast(err.message || 'Could not save entry');
  }
});

$('manualCancel').addEventListener('click', resetManualForm);

function syncManualEndFromHours() {
  if (!$('manualStart').value || !$('manualHours').value) return;
  const start = new Date($('manualStart').value);
  const hours = Number($('manualHours').value || 0);
  if (Number.isNaN(start.valueOf()) || hours <= 0) return;
  $('manualEnd').value = toLocalInputValue(new Date(start.getTime() + hours * 36e5));
}

function syncManualHoursFromTimes() {
  if (!$('manualStart').value || !$('manualEnd').value) return;
  const start = new Date($('manualStart').value);
  const end = new Date($('manualEnd').value);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end <= start) return;
  $('manualHours').value = ((end - start) / 36e5).toFixed(2);
}

$('manualHours').addEventListener('input', syncManualEndFromHours);
$('manualStart').addEventListener('input', syncManualHoursFromTimes);
$('manualEnd').addEventListener('input', syncManualHoursFromTimes);

$('rangeSelect').addEventListener('change', renderSummary);
['reportCustomer', 'reportProject', 'reportBilling', 'reportFrom', 'reportTo'].forEach(id => $(id).addEventListener('change', renderReports));
['invoiceCustomer', 'invoiceProject', 'invoiceFrom', 'invoiceTo'].forEach(id => $(id).addEventListener('change', () => {
  if (id === 'invoiceCustomer') projectOptions($('invoiceProject'), 'All projects', { customerId: $('invoiceCustomer').value, allOption: true, includeCustomer: false });
  renderInvoices();
}));
$('invoiceRate').addEventListener('input', updateInvoiceSelectionTotal);
['invoiceFixedDate', 'invoiceFixedDescription', 'invoiceFixedQty', 'invoiceFixedAmount'].forEach(id => $(id).addEventListener('input', updateInvoiceSelectionTotal));
$('selectAllInvoiceEntries').addEventListener('click', () => { filteredInvoiceEntries().forEach(e => selectedInvoiceEntryIds.add(e.id)); renderInvoices(); });
$('clearInvoiceEntries').addEventListener('click', () => { selectedInvoiceEntryIds.clear(); noChargeInvoiceEntryIds.clear(); renderInvoices(); });
$('invoiceEntryList').addEventListener('change', (e) => {
  const id = e.target?.dataset?.invoiceEntry;
  const noChargeId = e.target?.dataset?.noChargeEntry;
  if (id) {
    if (e.target.checked) selectedInvoiceEntryIds.add(id); else {
      selectedInvoiceEntryIds.delete(id);
      noChargeInvoiceEntryIds.delete(id);
    }
  } else if (noChargeId) {
    if (e.target.checked) noChargeInvoiceEntryIds.add(noChargeId); else noChargeInvoiceEntryIds.delete(noChargeId);
  } else {
    return;
  }
  renderInvoices();
});
$('createInvoiceBtn').addEventListener('click', async () => {
  try {
    const invoice = await api('/api/invoices', { method: 'POST', body: JSON.stringify({ entryIds: [...selectedInvoiceEntryIds], noChargeEntryIds: [...noChargeInvoiceEntryIds], lineItems: invoiceFixedLineItems(), hourlyRate: $('invoiceRate').value, dueDate: $('invoiceDueDate').value, notes: $('invoiceNotes').value }) });
    selectedInvoiceEntryIds.clear();
    noChargeInvoiceEntryIds.clear();
    $('invoiceNotes').value = '';
    $('invoiceFixedDate').value = '';
    $('invoiceFixedDescription').value = '';
    $('invoiceFixedQty').value = '';
    $('invoiceFixedAmount').value = '';
    toast(`Invoice ${invoice.number} created`);
    await load();
    window.open(`/api/invoices/${invoice.id}.html`, '_blank', 'noopener');
  } catch (err) {
    toast(err.message || 'Could not create invoice');
  }
});
$('addManualInvoiceLine').addEventListener('click', () => {
  $('manualInvoiceLines').insertAdjacentHTML('beforeend', manualInvoiceLineTemplate());
  updateManualInvoiceTotal();
});
$('manualInvoiceLines').addEventListener('input', updateManualInvoiceTotal);
$('manualInvoiceLines').addEventListener('click', (e) => {
  if (!e.target?.classList?.contains('removeManualLine')) return;
  const lines = document.querySelectorAll('#manualInvoiceLines .manualLine');
  if (lines.length <= 1) return toast('Keep at least one line');
  e.target.closest('.manualLine')?.remove();
  updateManualInvoiceTotal();
});
$('createManualInvoiceBtn').addEventListener('click', async () => {
  try {
    if (!$('manualInvoiceCustomer').value) return toast('Choose a customer');
    const invoice = await api('/api/invoices', { method: 'POST', body: JSON.stringify({ type: 'manual', customerId: $('manualInvoiceCustomer').value, lineItems: manualInvoiceLines(), dueDate: $('manualInvoiceDueDate').value, notes: $('manualInvoiceNotes').value }) });
    resetManualInvoiceForm();
    toast(`Invoice ${invoice.number} created`);
    await load();
    window.open(`/api/invoices/${invoice.id}.html`, '_blank', 'noopener');
  } catch (err) {
    toast(err.message || 'Could not create manual invoice');
  }
});
$('invoiceList').addEventListener('click', async (e) => {
  const deleteInvoiceId = e.target?.dataset?.invoiceDelete;
  if (deleteInvoiceId) {
    const invoice = state.invoices.find(inv => inv.id === deleteInvoiceId);
    if (!invoice) return toast('Invoice not found');
    if (!confirm(`Delete invoice ${invoice.number}? Its time entries will become unbilled again.`)) return;
    await api(`/api/invoices/${deleteInvoiceId}`, { method: 'DELETE' });
    toast('Invoice deleted');
    await load();
    return;
  }
  const invoiceId = e.target?.dataset?.invoiceStatus;
  if (!invoiceId) return;
  await api(`/api/invoices/${invoiceId}`, { method: 'PATCH', body: JSON.stringify({ status: e.target.dataset.status }) });
  toast(e.target.dataset.status === 'paid' ? 'Invoice marked paid' : 'Invoice marked unpaid');
  await load();
});

$('companyLogoFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('Choose an image file');
  const reader = new FileReader();
  reader.onload = () => {
    $('companyLogoUrl').value = String(reader.result || '');
    $('companyLogoPreview').src = $('companyLogoUrl').value;
    $('companyLogoPreview').hidden = false;
  };
  reader.onerror = () => toast('Could not load logo image');
  reader.readAsDataURL(file);
});

$('companyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/company', {
    method: 'PATCH',
    body: JSON.stringify({
      companyName: $('companyName').value,
      companyAddress: $('companyAddress').value,
      logoUrl: $('companyLogoUrl').value
    })
  });
  toast('Company info saved');
  await load();
});

$('entries').addEventListener('click', async (e) => {
  const editId = e.target?.dataset?.edit;
  if (editId) return editEntry(editId);
  const deleteId = e.target?.dataset?.delete;
  if (!deleteId) return;
  const entry = state.entries.find(e => e.id === deleteId);
  if (entry?.billed) return toast('Billed entries are locked');
  if (!confirm('Delete this time entry?')) return;
  await api(`/api/entries/${deleteId}`, { method: 'DELETE' });
  toast('Entry deleted');
  await load();
});

resetManualForm();
updateManualInvoiceTotal();
load().then(() => {
  if (location.hash === '#invoices') showView('invoices');
  if (location.hash === '#company') showView('company');
}).catch(err => toast(err.message));
