let state = null;
let invoice = null;
const selectedEntryIds = new Set();
const noChargeEntryIds = new Set();

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = (value) => `$${money.format(Number(value || 0))}`;
const fmtHours = (ms) => `${(ms / 36e5).toFixed(2)}h`;
const toast = (msg) => { $('toast').textContent = msg; $('toast').hidden = false; setTimeout(() => $('toast').hidden = true, 2400); };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function invoiceId() {
  return new URLSearchParams(location.search).get('id') || '';
}

function customerForEntry(entry) {
  const project = state.projects.find(p => p.id === entry.projectId);
  return project?.customerId || '';
}

function lineTemplate(item = {}) {
  return `<div class="manualLine">
    <label>Date <input class="manualLineDate" type="date" value="${escapeHtml(item.date || '')}" /></label>
    <label>Description <input class="manualLineDescription" placeholder="Consulting services" value="${escapeHtml(item.description || '')}" /></label>
    <label>Hours / Qty <input class="manualLineHours" type="number" min="0" step="0.01" placeholder="1" value="${item.hours ?? ''}" /></label>
    <label>Rate <input class="manualLineRate" type="number" min="0" step="0.01" placeholder="150" value="${item.rate ?? ''}" /></label>
    <button type="button" class="ghost subtle removeManualLine">Remove</button>
  </div>`;
}

function lineItems() {
  return [...document.querySelectorAll('#lineItems .manualLine')].map(line => ({
    date: line.querySelector('.manualLineDate')?.value || '',
    description: line.querySelector('.manualLineDescription')?.value || '',
    hours: Number(line.querySelector('.manualLineHours')?.value || 0),
    rate: Number(line.querySelector('.manualLineRate')?.value || 0)
  }));
}

function lineHours(lines) {
  return lines.reduce((sum, item) => sum + Number(item.hours || 0), 0);
}

function lineTotal(lines) {
  return lines.reduce((sum, item) => sum + Number(item.hours || 0) * Number(item.rate || 0), 0);
}

function eligibleEntries() {
  if (invoice.type === 'manual') return [];
  return state.entries
    .filter(entry => customerForEntry(entry) === invoice.customerId && (!entry.billed || selectedEntryIds.has(entry.id)))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function renderEntries() {
  if (invoice.type === 'manual') {
    $('entriesPanel').hidden = true;
    return;
  }
  $('entriesPanel').hidden = false;
  for (const id of [...noChargeEntryIds]) {
    if (!selectedEntryIds.has(id)) noChargeEntryIds.delete(id);
  }
  const entries = eligibleEntries();
  $('entryList').innerHTML = entries.length ? entries.map(entry => `
    <article class="entry selectable ${selectedEntryIds.has(entry.id) ? 'selected' : ''}">
      <input type="checkbox" data-entry-id="${entry.id}" ${selectedEntryIds.has(entry.id) ? 'checked' : ''} aria-label="Keep entry on invoice" />
      <div>
        <strong>${escapeHtml(entry.customerName)} / ${escapeHtml(entry.projectDisplayName || entry.projectName)}</strong>
        <div class="entryMeta">${new Date(entry.startedAt).toLocaleString()} · ${fmtHours(entry.durationMs)} · ${selectedEntryIds.has(entry.id) ? 'On invoice' : 'Unbilled'}</div>
        ${entry.notes ? `<div class="entryNotes">${escapeHtml(entry.notes)}</div>` : ''}
      </div>
      <label class="includedToggle">
        <input type="checkbox" data-no-charge-id="${entry.id}" ${noChargeEntryIds.has(entry.id) ? 'checked' : ''} ${selectedEntryIds.has(entry.id) ? '' : 'disabled'} />
        Included / no charge
      </label>
    </article>`).join('') : '<p class="muted">No eligible time entries for this customer.</p>';
}

function updateTotal() {
  const lines = lineItems();
  const selected = state.entries.filter(entry => selectedEntryIds.has(entry.id));
  const shownHours = lineHours(lines) + selected.reduce((sum, entry) => sum + entry.durationMs, 0) / 36e5;
  const billableMs = invoice.type === 'manual' ? 0 : selected.reduce((sum, entry) => noChargeEntryIds.has(entry.id) ? sum : sum + entry.durationMs, 0);
  const billableHours = lineHours(lines) + billableMs / 36e5;
  const amount = lineTotal(lines) + (billableMs / 36e5) * Number($('hourlyRate').value || 0);
  $('totalPreview').textContent = `${shownHours.toFixed(2)}h shown · ${billableHours.toFixed(2)}h charged · ${fmtMoney(amount)}`;
}

function render() {
  $('invoiceTitle').textContent = invoice.number;
  $('invoiceMeta').textContent = `${invoice.customerName} · ${invoice.status === 'paid' ? 'Paid' : 'Unpaid'}`;
  $('openInvoice').href = `/api/invoices/${invoice.id}.html`;
  $('pdfInvoice').href = `/api/invoices/${invoice.id}.pdf`;
  $('companyName').value = invoice.companyName || state.company?.companyName || '';
  $('logoUrl').value = invoice.logoUrl || state.company?.logoUrl || '';
  $('companyAddress').value = invoice.companyAddress || state.company?.companyAddress || '';
  $('dueDate').value = invoice.dueDate || '';
  $('notes').value = invoice.notes || '';
  $('hourlyRate').value = Number(invoice.hourlyRate || 0) || '';
  $('rateField').hidden = invoice.type === 'manual';
  $('lineItems').innerHTML = (invoice.lineItems || []).length
    ? invoice.lineItems.map(item => lineTemplate(item)).join('')
    : lineTemplate();
  renderEntries();
  updateTotal();
}

async function load() {
  const id = invoiceId();
  if (!id) throw new Error('Missing invoice id');
  state = await api('/api/state');
  invoice = state.invoices.find(item => item.id === id);
  if (!invoice) throw new Error('Invoice not found');
  selectedEntryIds.clear();
  noChargeEntryIds.clear();
  (invoice.entryIds || []).forEach(entryId => selectedEntryIds.add(entryId));
  (invoice.noChargeEntryIds || []).forEach(entryId => noChargeEntryIds.add(entryId));
  render();
}

$('addLine').addEventListener('click', () => {
  $('lineItems').insertAdjacentHTML('beforeend', lineTemplate());
  updateTotal();
});

$('lineItems').addEventListener('input', updateTotal);
$('lineItems').addEventListener('click', (event) => {
  if (!event.target?.classList?.contains('removeManualLine')) return;
  const lines = document.querySelectorAll('#lineItems .manualLine');
  if (lines.length <= 1) return toast('Keep at least one line editor');
  event.target.closest('.manualLine')?.remove();
  updateTotal();
});

$('hourlyRate').addEventListener('input', updateTotal);

$('entryList').addEventListener('change', (event) => {
  const entryId = event.target?.dataset?.entryId;
  const noChargeId = event.target?.dataset?.noChargeId;
  if (entryId) {
    if (event.target.checked) selectedEntryIds.add(entryId); else {
      selectedEntryIds.delete(entryId);
      noChargeEntryIds.delete(entryId);
    }
  } else if (noChargeId) {
    if (event.target.checked) noChargeEntryIds.add(noChargeId); else noChargeEntryIds.delete(noChargeId);
  } else {
    return;
  }
  renderEntries();
  updateTotal();
});

$('saveInvoice').addEventListener('click', async () => {
  try {
    await api(`/api/invoices/${invoice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        companyName: $('companyName').value,
        logoUrl: $('logoUrl').value,
        companyAddress: $('companyAddress').value,
        dueDate: $('dueDate').value,
        notes: $('notes').value,
        hourlyRate: invoice.type === 'manual' ? undefined : $('hourlyRate').value,
        lineItems: lineItems(),
        entryIds: invoice.type === 'manual' ? undefined : [...selectedEntryIds],
        noChargeEntryIds: invoice.type === 'manual' ? undefined : [...noChargeEntryIds]
      })
    });
    location.href = '/#invoices';
  } catch (err) {
    toast(err.message || 'Could not save invoice');
  }
});

load().catch(err => toast(err.message));
