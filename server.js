import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'time-tracker.json');
const port = Number(process.env.PORT || 8787);

const emptyDb = () => ({
  company: {
    companyName: '',
    companyAddress: '',
    logoUrl: ''
  },
  customers: [],
  projects: [],
  entries: [],
  invoices: [],
  activeTimer: null,
  lastStoppedTimer: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

async function ensureDb() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    await writeDb(emptyDb());
  }
}

async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(dbPath, 'utf8');
  const parsed = { ...emptyDb(), ...JSON.parse(raw) };
  parsed.company = { ...emptyDb().company, ...(parsed.company || {}) };
  parsed.invoices = Array.isArray(parsed.invoices) ? parsed.invoices : [];
  parsed.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return parsed;
}

async function writeDb(db) {
  db.updatedAt = new Date().toISOString();
  const tmpPath = `${dbPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(db, null, 2));
  await fs.rename(tmpPath, dbPath);
}

const id = () => crypto.randomUUID();
const json = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
};
const notFound = (res) => json(res, 404, { error: 'Not found' });
const bad = (res, message, status = 400) => json(res, status, { error: message });

async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new Error('Invalid JSON'); }
}

function durationMs(entry) {
  if (!entry.startedAt || !entry.endedAt) return Number(entry.durationMs || 0);
  return Math.max(0, new Date(entry.endedAt) - new Date(entry.startedAt));
}

function projectPath(project, projectsById) {
  if (!project) return ['Unknown project'];
  const chain = [];
  const seen = new Set();
  let cursor = project;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift(cursor.name);
    cursor = cursor.parentProjectId ? projectsById[cursor.parentProjectId] : null;
  }
  return chain;
}

function invoiceNumber(db) {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const seq = String((db.invoices?.length || 0) + 1).padStart(3, '0');
  return `INV-${stamp}-${seq}`;
}

function invoiceTotals(entries, hourlyRate = 0, options = {}) {
  const noChargeEntryIds = new Set((options.noChargeEntryIds || []).map(String));
  const lineTotals = manualInvoiceTotals(options.lineItems || []);
  const totalMs = entries.reduce((sum, e) => sum + durationMs(e), 0);
  const billableMs = entries.reduce((sum, e) => noChargeEntryIds.has(e.id) ? sum : sum + durationMs(e), 0);
  const totalHours = totalMs / 36e5;
  return {
    totalMs: totalMs + lineTotals.totalMs,
    totalHours: totalHours + lineTotals.totalHours,
    billableMs,
    totalAmount: (billableMs / 36e5) * Number(hourlyRate || 0) + lineTotals.totalAmount
  };
}

function manualInvoiceTotals(lineItems = []) {
  const totalHours = lineItems.reduce((sum, item) => sum + Number(item.hours || 0), 0);
  const totalAmount = lineItems.reduce((sum, item) => sum + Number(item.hours || 0) * Number(item.rate || 0), 0);
  return { totalMs: totalHours * 36e5, totalHours, totalAmount };
}

function parseLineItems(lineItems = []) {
  return Array.isArray(lineItems) ? lineItems.map(item => ({
    date: String(item.date || '').trim(),
    description: String(item.description || '').trim(),
    hours: Math.max(0, Number(item.hours || 0)),
    rate: Math.max(0, Number(item.rate || 0))
  })).filter(item => item.description && (item.hours > 0 || item.rate > 0)) : [];
}

function companyInfo(payload = {}) {
  return {
    companyName: String(payload.companyName || '').trim(),
    companyAddress: String(payload.companyAddress || '').trim(),
    logoUrl: String(payload.logoUrl || '').trim()
  };
}

function invoiceBranding(payload = {}, db = emptyDb()) {
  const company = companyInfo(db.company || {});
  return {
    logoUrl: String(payload.logoUrl ?? company.logoUrl ?? '').trim(),
    companyName: String(payload.companyName ?? company.companyName ?? '').trim(),
    companyAddress: String(payload.companyAddress ?? company.companyAddress ?? '').trim()
  };
}

function setInvoiceEntriesPaidState(db, invoice, status, paidAt) {
  for (const entry of db.entries) {
    if (entry.invoiceId !== invoice.id) continue;
    if (status === 'paid') {
      entry.paidAt = paidAt;
    } else {
      delete entry.paidAt;
    }
    entry.updatedAt = new Date().toISOString();
  }
}

function applyInvoiceTotals(invoice, db) {
  const selected = (invoice.entryIds || []).map(entryId => db.entries.find(e => e.id === entryId)).filter(Boolean);
  const totals = invoice.type === 'manual'
    ? manualInvoiceTotals(invoice.lineItems || [])
    : invoiceTotals(selected, invoice.hourlyRate, { noChargeEntryIds: invoice.noChargeEntryIds || [], lineItems: invoice.lineItems || [] });
  invoice.totalHours = totals.totalHours;
  invoice.totalAmount = totals.totalAmount;
}

function enrich(db) {
  const customersById = Object.fromEntries(db.customers.map(c => [c.id, c]));
  const projectsById = Object.fromEntries(db.projects.map(p => [p.id, p]));
  const invoicesById = Object.fromEntries((db.invoices || []).map(i => [i.id, i]));
  const enrichedProjects = db.projects.map(p => ({
    ...p,
    parentProjectId: p.parentProjectId || '',
    projectPath: projectPath(p, projectsById),
    displayName: projectPath(p, projectsById).join(' / ')
  }));
  return {
    ...db,
    projects: enrichedProjects,
    invoices: (db.invoices || []).map(inv => {
      const invoiceEntries = inv.entryIds?.map(entryId => db.entries.find(e => e.id === entryId)).filter(Boolean) || [];
      const totals = inv.type === 'manual'
        ? manualInvoiceTotals(inv.lineItems || [])
        : invoiceTotals(invoiceEntries, inv.hourlyRate, { noChargeEntryIds: inv.noChargeEntryIds || [], lineItems: inv.lineItems || [] });
      return {
        ...inv,
        type: inv.type || 'time',
        entryIds: inv.entryIds || [],
        noChargeEntryIds: inv.noChargeEntryIds || [],
        lineItems: inv.lineItems || [],
        customerName: customersById[inv.customerId]?.name || inv.customerName || 'Manual customer',
        entryCount: invoiceEntries.length,
        totalMs: totals.totalMs,
        totalHours: totals.totalHours,
        totalAmount: totals.totalAmount
      };
    }).sort((a, b) => String(b.createdAt || b.issuedAt).localeCompare(String(a.createdAt || a.issuedAt))),
    entries: db.entries.map(e => {
      const project = projectsById[e.projectId];
      const customer = project ? customersById[project.customerId] : null;
      const path = projectPath(project, projectsById);
      const invoice = e.invoiceId ? invoicesById[e.invoiceId] : null;
      return {
        ...e,
        durationMs: durationMs(e),
        billed: !!invoice,
        billingStatus: invoice ? (invoice.status === 'paid' ? 'paid' : 'billed') : 'unbilled',
        invoiceNumber: invoice?.number || '',
        projectName: path.at(-1) || 'Unknown project',
        projectPath: path,
        projectDisplayName: path.join(' / '),
        customerName: customer?.name || 'Unknown customer'
      };
    })
  };
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function formatEastern(value, options = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(options.dateOnly ? {} : { hour: 'numeric', minute: '2-digit', hour12: true })
  }).format(date);
}

function pdfEscape(value) {
  return String(value ?? '').replace(/[\\()]/g, '\\$&').replace(/\r?\n/g, ' ');
}

function truncateText(value, max = 92) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function invoiceRows(invoice, entries) {
  const manualRows = (invoice.lineItems || []).map(item => ({
    date: item.date || '',
    description: item.description || '',
    notes: '',
    hours: Number(item.hours || 0),
    rate: Number(item.rate || 0),
    amount: Number(item.hours || 0) * Number(item.rate || 0)
  }));
  const noChargeEntryIds = new Set((invoice.noChargeEntryIds || []).map(String));
  const timeRows = entries.map(entry => {
    const noCharge = noChargeEntryIds.has(entry.id);
    const amount = noCharge ? 0 : (entry.durationMs / 36e5) * Number(invoice.hourlyRate || 0);
    return {
      date: formatEastern(entry.startedAt, { dateOnly: true }),
      description: entry.projectDisplayName || entry.projectName,
      notes: noCharge ? `${entry.notes || ''} Included / no charge`.trim() : entry.notes || '',
      hours: entry.durationMs / 36e5,
      rate: noCharge ? 'Included' : Number(invoice.hourlyRate || 0),
      amount
    };
  });
  return invoice.type === 'manual' ? manualRows : [...manualRows, ...timeRows];
}

function simpleInvoicePdf(invoice, entries) {
  const lines = [];
  const add = (text, x = 54, size = 10) => {
    lines.push(`BT /F1 ${size} Tf ${x} ${Math.max(54, y)} Td (${pdfEscape(text)}) Tj ET`);
    y -= Math.ceil(size * 1.45);
  };
  let y = 760;
  add(invoice.companyName || 'Invoice', 54, 18);
  if (invoice.companyAddress) {
    for (const line of String(invoice.companyAddress).split(/\r?\n/)) add(line, 54, 9);
  }
  y -= 12;
  add(`Invoice ${invoice.number}`, 54, 16);
  add(`Customer: ${invoice.customerName}`, 54, 10);
  add(`Status: ${invoice.status}${invoice.paidAt ? ` (${formatEastern(invoice.paidAt, { dateOnly: true })})` : ''}`, 54, 10);
  add(`Issued: ${formatEastern(invoice.issuedAt, { dateOnly: true })}${invoice.dueDate ? `    Due: ${invoice.dueDate}` : ''}`, 54, 10);
  y -= 14;
  add('Date        Description                                      Hours     Rate      Amount', 54, 9);
  add('--------------------------------------------------------------------------------', 54, 9);
  for (const row of invoiceRows(invoice, entries)) {
    const rate = typeof row.rate === 'string' ? row.rate : `$${Number(row.rate || 0).toFixed(2)}`;
    const line = `${String(row.date || '').padEnd(11)} ${truncateText(row.description, 42).padEnd(44)} ${Number(row.hours || 0).toFixed(2).padStart(6)} ${rate.padStart(10)} $${Number(row.amount || 0).toFixed(2).padStart(9)}`;
    add(line, 54, 8);
    if (row.notes) add(`  ${truncateText(row.notes, 100)}`, 54, 8);
    if (y < 92) break;
  }
  y -= 10;
  add(`Total hours: ${Number(invoice.totalHours || 0).toFixed(2)}`, 360, 11);
  add(`Total amount: $${Number(invoice.totalAmount || 0).toFixed(2)}`, 360, 12);
  if (invoice.notes) {
    y -= 10;
    add(`Notes: ${truncateText(invoice.notes, 110)}`, 54, 9);
  }
  const stream = lines.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function toCsv(db) {
  const enriched = enrich(db);
  const rows = [
    ['Date', 'Customer', 'Project', 'Start', 'End', 'Hours', 'Notes', 'Invoice'],
    ...enriched.entries
      .slice()
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .map(e => [
        formatEastern(e.startedAt, { dateOnly: true }),
        e.customerName,
        e.projectDisplayName || e.projectName,
        formatEastern(e.startedAt),
        formatEastern(e.endedAt),
        (e.durationMs / 36e5).toFixed(2),
        e.notes || '',
        e.invoiceNumber || ''
      ])
  ];
  return rows.map(row => row.map(csvEscape).join(',')).join('\n');
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) return bad(res, 'Invalid path', 403);
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.js' ? 'application/javascript; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  } catch {
    notFound(res);
  }
}

async function api(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;
  const method = req.method;
  const db = await readDb();

  if (method === 'GET' && route === '/api/state') return json(res, 200, enrich(db));
  if (method === 'GET' && route === '/api/export.csv') {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="time-entries.csv"'
    });
    return res.end(toCsv(db));
  }

  let payload = {};
  if (!['GET', 'HEAD'].includes(method)) payload = await bodyJson(req);

  if (method === 'PATCH' && route === '/api/company') {
    db.company = companyInfo(payload);
    await writeDb(db);
    return json(res, 200, db.company);
  }

  if (method === 'POST' && route === '/api/customers') {
    const name = String(payload.name || '').trim();
    if (!name) return bad(res, 'Customer name is required');
    const customer = { id: id(), name, archived: false, createdAt: new Date().toISOString() };
    db.customers.push(customer);
    await writeDb(db);
    return json(res, 201, customer);
  }

  if (method === 'POST' && route === '/api/projects') {
    const name = String(payload.name || '').trim();
    const customerId = String(payload.customerId || '').trim();
    const parentProjectId = String(payload.parentProjectId || '').trim();
    if (!name) return bad(res, 'Project name is required');
    if (!db.customers.some(c => c.id === customerId)) return bad(res, 'Valid customer is required');
    if (parentProjectId) {
      const parent = db.projects.find(p => p.id === parentProjectId);
      if (!parent) return bad(res, 'Parent project was not found');
      if (parent.customerId !== customerId) return bad(res, 'Parent project must belong to the selected customer');
    }
    const project = { id: id(), customerId, parentProjectId, name, color: payload.color || '#4f46e5', archived: false, createdAt: new Date().toISOString() };
    db.projects.push(project);
    await writeDb(db);
    return json(res, 201, project);
  }

  if (method === 'POST' && route === '/api/timer/start') {
    const projectId = String(payload.projectId || '').trim();
    if (db.activeTimer) return bad(res, 'A timer is already running');
    if (!db.projects.some(p => p.id === projectId)) return bad(res, 'Valid project is required');
    const startedAt = payload.startedAt ? new Date(payload.startedAt) : new Date();
    if (Number.isNaN(startedAt.valueOf())) return bad(res, 'Valid start time is required');
    db.activeTimer = { id: id(), projectId, startedAt: startedAt.toISOString(), notes: String(payload.notes || '') };
    await writeDb(db);
    return json(res, 201, db.activeTimer);
  }

  if (method === 'POST' && route === '/api/timer/stop') {
    if (!db.activeTimer) return bad(res, 'No active timer');
    const now = new Date().toISOString();
    const entry = {
      id: id(),
      projectId: db.activeTimer.projectId,
      startedAt: db.activeTimer.startedAt,
      endedAt: now,
      durationMs: Math.max(0, new Date(now) - new Date(db.activeTimer.startedAt)),
      notes: String(payload.notes ?? db.activeTimer.notes ?? ''),
      createdAt: now
    };

    db.lastStoppedTimer = { ...entry, savedAt: now, committed: false };
    await writeDb(db);

    db.entries.push(entry);
    db.activeTimer = null;
    db.lastStoppedTimer = { ...entry, savedAt: now, committed: true };
    await writeDb(db);
    return json(res, 201, entry);
  }

  if (method === 'PATCH' && route === '/api/timer') {
    if (!db.activeTimer) return bad(res, 'No active timer');
    db.activeTimer.notes = String(payload.notes || '');
    await writeDb(db);
    return json(res, 200, db.activeTimer);
  }

  if (method === 'POST' && route === '/api/entries') {
    const projectId = String(payload.projectId || '').trim();
    if (!db.projects.some(p => p.id === projectId)) return bad(res, 'Valid project is required');
    const startedAt = payload.startedAt ? new Date(payload.startedAt) : null;
    const endedAt = payload.endedAt ? new Date(payload.endedAt) : null;
    const hours = Number(payload.hours || 0);
    if (!startedAt || Number.isNaN(startedAt.valueOf())) return bad(res, 'Valid start time is required');
    let finalEndedAt = endedAt;
    if ((!finalEndedAt || Number.isNaN(finalEndedAt.valueOf())) && hours > 0) {
      finalEndedAt = new Date(startedAt.getTime() + hours * 36e5);
    }
    if (!finalEndedAt || Number.isNaN(finalEndedAt.valueOf()) || finalEndedAt <= startedAt) return bad(res, 'Valid end time or positive hours is required');
    const entry = {
      id: id(), projectId,
      startedAt: startedAt.toISOString(), endedAt: finalEndedAt.toISOString(),
      durationMs: finalEndedAt - startedAt,
      notes: String(payload.notes || ''), createdAt: new Date().toISOString()
    };
    db.entries.push(entry);
    await writeDb(db);
    return json(res, 201, entry);
  }

  const entryPatch = route.match(/^\/api\/entries\/([^/]+)$/);
  if (method === 'PATCH' && entryPatch) {
    const entry = db.entries.find(e => e.id === entryPatch[1]);
    if (!entry) return notFound(res);

    const projectId = String(payload.projectId || entry.projectId || '').trim();
    if (!db.projects.some(p => p.id === projectId)) return bad(res, 'Valid project is required');

    const startedAt = payload.startedAt ? new Date(payload.startedAt) : new Date(entry.startedAt);
    const endedAt = payload.endedAt ? new Date(payload.endedAt) : null;
    const hours = Number(payload.hours || 0);
    if (!startedAt || Number.isNaN(startedAt.valueOf())) return bad(res, 'Valid start time is required');

    let finalEndedAt = endedAt;
    if ((!finalEndedAt || Number.isNaN(finalEndedAt.valueOf())) && hours > 0) {
      finalEndedAt = new Date(startedAt.getTime() + hours * 36e5);
    }
    if (!finalEndedAt || Number.isNaN(finalEndedAt.valueOf()) || finalEndedAt <= startedAt) return bad(res, 'Valid end time or positive hours is required');

    entry.projectId = projectId;
    entry.startedAt = startedAt.toISOString();
    entry.endedAt = finalEndedAt.toISOString();
    entry.durationMs = finalEndedAt - startedAt;
    entry.notes = String(payload.notes || '');
    entry.updatedAt = new Date().toISOString();

    await writeDb(db);
    return json(res, 200, entry);
  }


  if (method === 'POST' && route === '/api/invoices') {
    const invoiceType = String(payload.type || 'time');
    if (invoiceType === 'manual') {
      const customerId = String(payload.customerId || '').trim();
      if (!db.customers.some(c => c.id === customerId)) return bad(res, 'Valid customer is required');
      const lineItems = parseLineItems(payload.lineItems);
      if (!lineItems.length) return bad(res, 'Add at least one invoice line item');
      const totals = manualInvoiceTotals(lineItems);
      const now = new Date().toISOString();
      const invoice = {
        id: id(),
        type: 'manual',
        number: invoiceNumber(db),
        customerId,
        entryIds: [],
        lineItems,
        hourlyRate: 0,
        totalHours: totals.totalHours,
        totalAmount: totals.totalAmount,
        status: 'unpaid',
        issuedAt: payload.issuedAt ? new Date(payload.issuedAt).toISOString() : now,
        dueDate: payload.dueDate ? String(payload.dueDate) : '',
        notes: String(payload.notes || ''),
        ...invoiceBranding(payload, db),
        paidAt: null,
        createdAt: now
      };
      db.invoices.push(invoice);
      await writeDb(db);
      return json(res, 201, enrich(db).invoices.find(i => i.id === invoice.id));
    }

    const entryIds = Array.isArray(payload.entryIds) ? [...new Set(payload.entryIds.map(String))] : [];
    if (!entryIds.length) return bad(res, 'Select at least one time entry');
    const selected = entryIds.map(entryId => db.entries.find(e => e.id === entryId));
    if (selected.some(e => !e)) return bad(res, 'One or more selected entries were not found');
    if (selected.some(e => e.invoiceId)) return bad(res, 'One or more selected entries have already been billed');

    const projectsById = Object.fromEntries(db.projects.map(p => [p.id, p]));
    const customerIds = [...new Set(selected.map(e => projectsById[e.projectId]?.customerId).filter(Boolean))];
    if (customerIds.length !== 1) return bad(res, 'Invoice entries must belong to one customer');

    const hourlyRate = Math.max(0, Number(payload.hourlyRate || 0));
    const selectedEntryIds = new Set(entryIds);
    const noChargeEntryIds = Array.isArray(payload.noChargeEntryIds)
      ? [...new Set(payload.noChargeEntryIds.map(String).filter(entryId => selectedEntryIds.has(entryId)))]
      : [];
    const lineItems = parseLineItems(payload.lineItems);
    const totals = invoiceTotals(selected, hourlyRate, { noChargeEntryIds, lineItems });
    const now = new Date().toISOString();
    const invoice = {
      id: id(),
      number: invoiceNumber(db),
      customerId: customerIds[0],
      entryIds,
      noChargeEntryIds,
      lineItems,
      hourlyRate,
      totalHours: totals.totalHours,
      totalAmount: totals.totalAmount,
      status: 'unpaid',
      issuedAt: payload.issuedAt ? new Date(payload.issuedAt).toISOString() : now,
      dueDate: payload.dueDate ? String(payload.dueDate) : '',
      notes: String(payload.notes || ''),
      ...invoiceBranding(payload, db),
      paidAt: null,
      createdAt: now
    };
    db.invoices.push(invoice);
    for (const entry of selected) {
      entry.invoiceId = invoice.id;
      entry.billedAt = now;
      entry.updatedAt = now;
    }
    await writeDb(db);
    return json(res, 201, enrich(db).invoices.find(i => i.id === invoice.id));
  }

  const invoicePatch = route.match(/^\/api\/invoices\/([^/]+)$/);
  if (method === 'PATCH' && invoicePatch) {
    const invoice = db.invoices.find(i => i.id === invoicePatch[1]);
    if (!invoice) return notFound(res);
    if (payload.status !== undefined) {
      const status = String(payload.status || '').trim();
      if (!['unpaid', 'paid'].includes(status)) return bad(res, 'Invoice status must be unpaid or paid');
      invoice.status = status;
      invoice.paidAt = status === 'paid' ? (invoice.paidAt || new Date().toISOString()) : null;
      setInvoiceEntriesPaidState(db, invoice, status, invoice.paidAt);
    }
    if (payload.dueDate !== undefined) invoice.dueDate = String(payload.dueDate || '');
    if (payload.notes !== undefined) invoice.notes = String(payload.notes || '');
    if (payload.logoUrl !== undefined) invoice.logoUrl = String(payload.logoUrl || '').trim();
    if (payload.companyName !== undefined) invoice.companyName = String(payload.companyName || '').trim();
    if (payload.companyAddress !== undefined) invoice.companyAddress = String(payload.companyAddress || '').trim();
    if (payload.lineItems !== undefined) invoice.lineItems = parseLineItems(payload.lineItems);
    if (payload.hourlyRate !== undefined) {
      invoice.hourlyRate = Math.max(0, Number(payload.hourlyRate || 0));
    }
    if (payload.entryIds !== undefined && invoice.type !== 'manual') {
      const entryIds = Array.isArray(payload.entryIds) ? [...new Set(payload.entryIds.map(String))] : [];
      const selected = entryIds.map(entryId => db.entries.find(e => e.id === entryId));
      if (selected.some(e => !e)) return bad(res, 'One or more selected entries were not found');
      if (selected.some(e => e.invoiceId && e.invoiceId !== invoice.id)) return bad(res, 'One or more selected entries are billed on another invoice');

      const projectsById = Object.fromEntries(db.projects.map(p => [p.id, p]));
      const customerIds = [...new Set(selected.map(e => projectsById[e.projectId]?.customerId).filter(Boolean))];
      if (customerIds.length > 1) return bad(res, 'Invoice entries must belong to one customer');
      if (customerIds.length === 1 && customerIds[0] !== invoice.customerId) return bad(res, 'Invoice entries must belong to this invoice customer');

      const nextEntryIds = new Set(entryIds);
      const now = new Date().toISOString();
      for (const entry of db.entries) {
        if (entry.invoiceId === invoice.id && !nextEntryIds.has(entry.id)) {
          delete entry.invoiceId;
          delete entry.billedAt;
          delete entry.paidAt;
          entry.updatedAt = now;
        }
      }
      for (const entry of selected) {
        entry.invoiceId = invoice.id;
        entry.billedAt = entry.billedAt || now;
        if (invoice.status === 'paid') entry.paidAt = invoice.paidAt || now;
        else delete entry.paidAt;
        entry.updatedAt = now;
      }
      invoice.entryIds = entryIds;
    }
    if (payload.noChargeEntryIds !== undefined && invoice.type !== 'manual') {
      const selectedEntryIds = new Set(invoice.entryIds || []);
      invoice.noChargeEntryIds = Array.isArray(payload.noChargeEntryIds)
        ? [...new Set(payload.noChargeEntryIds.map(String).filter(entryId => selectedEntryIds.has(entryId)))]
        : [];
    }
    if (invoice.type === 'manual' && !(invoice.lineItems || []).length) return bad(res, 'Manual invoices need at least one line item');
    if (invoice.type !== 'manual' && !(invoice.entryIds || []).length && !(invoice.lineItems || []).length) return bad(res, 'Keep at least one time entry or line item on the invoice');
    applyInvoiceTotals(invoice, db);
    invoice.updatedAt = new Date().toISOString();
    await writeDb(db);
    return json(res, 200, enrich(db).invoices.find(i => i.id === invoice.id));
  }

  const invoiceDelete = route.match(/^\/api\/invoices\/([^/]+)$/);
  if (method === 'DELETE' && invoiceDelete) {
    const index = db.invoices.findIndex(i => i.id === invoiceDelete[1]);
    if (index === -1) return notFound(res);
    const invoice = db.invoices[index];
    const now = new Date().toISOString();
    for (const entry of db.entries) {
      if (entry.invoiceId === invoice.id) {
        delete entry.invoiceId;
        delete entry.billedAt;
        delete entry.paidAt;
        entry.updatedAt = now;
      }
    }
    db.invoices.splice(index, 1);
    await writeDb(db);
    return json(res, 200, { ok: true });
  }

  const invoicePdf = route.match(/^\/api\/invoices\/([^/]+)\.pdf$/);
  if (method === 'GET' && invoicePdf) {
    const enriched = enrich(db);
    const invoice = enriched.invoices.find(i => i.id === invoicePdf[1]);
    if (!invoice) return notFound(res);
    const entries = enriched.entries.filter(e => invoice.entryIds.includes(e.id)).sort((a,b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const pdf = simpleInvoicePdf(invoice, entries);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoice.number}.pdf"`,
      'Cache-Control': 'no-store'
    });
    return res.end(pdf);
  }

  const invoiceHtml = route.match(/^\/api\/invoices\/([^/]+)\.html$/);
  if (method === 'GET' && invoiceHtml) {
    const invoice = enrich(db).invoices.find(i => i.id === invoiceHtml[1]);
    if (!invoice) return notFound(res);
    const entries = enrich(db).entries.filter(e => invoice.entryIds.includes(e.id)).sort((a,b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));
    const manualRows = (invoice.lineItems || []).map(item => `<tr><td>${esc(item.date || '')}</td><td>${esc(item.description)}</td><td></td><td class="num">${Number(item.hours || 0).toFixed(2)}</td><td class="num">$${Number(item.rate || 0).toFixed(2)}</td><td class="num">$${(Number(item.hours || 0) * Number(item.rate || 0)).toFixed(2)}</td></tr>`).join('');
    const noChargeEntryIds = new Set((invoice.noChargeEntryIds || []).map(String));
    const timeRows = entries.map(e => {
      const noCharge = noChargeEntryIds.has(e.id);
      const amount = noCharge ? 0 : (e.durationMs / 36e5) * Number(invoice.hourlyRate || 0);
      const rate = noCharge ? '<span class="included">Included</span>' : `$${Number(invoice.hourlyRate || 0).toFixed(2)}`;
      return `<tr><td>${esc(formatEastern(e.startedAt, { dateOnly: true }))}</td><td>${esc(e.projectDisplayName || e.projectName)}</td><td>${esc(e.notes || '')}${noCharge ? '<div class="muted">Included / no charge</div>' : ''}</td><td class="num">${(e.durationMs / 36e5).toFixed(2)}</td><td class="num">${rate}</td><td class="num">$${amount.toFixed(2)}</td></tr>`;
    }).join('');
    const rows = invoice.type === 'manual' ? manualRows : `${manualRows}${timeRows}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const companyAddress = invoice.companyAddress ? `<div class="companyAddress">${esc(invoice.companyAddress).replaceAll('\n', '<br>')}</div>` : '';
    const logo = invoice.logoUrl ? `<img class="invoiceLogo" src="${esc(invoice.logoUrl)}" alt="">` : '';
    const company = invoice.companyName || invoice.companyAddress || invoice.logoUrl
      ? `<section class="companyBlock">${logo}<div>${invoice.companyName ? `<strong>${esc(invoice.companyName)}</strong>` : ''}${companyAddress}</div></section>`
      : '';
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(invoice.number)}</title><style>body{font-family:system-ui,sans-serif;margin:40px;color:#1f2933}header{display:flex;justify-content:space-between;gap:20px;margin-bottom:30px}.muted{color:#6b7280}.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:#eef2ff}.included{display:inline-block;padding:3px 8px;border-radius:999px;background:#f3f4f6;color:#4b5563;font-weight:700}.companyBlock{display:flex;gap:14px;align-items:flex-start;margin-bottom:20px}.invoiceLogo{max-width:150px;max-height:80px;object-fit:contain}.companyAddress{white-space:normal;color:#4b5563;margin-top:4px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{border-bottom:1px solid #ddd;padding:10px;text-align:left;vertical-align:top}.num{text-align:right}.total{font-size:1.3rem;font-weight:800}.buttonRow{display:flex;gap:10px;margin-top:24px}button,a.button{padding:10px 14px;border:0;border-radius:10px;background:#2f6f4e;color:white;text-decoration:none;font:inherit}@media print{.buttonRow{display:none}}</style></head><body>${company}<header><div><p class="muted">Invoice</p><h1>${esc(invoice.number)}</h1><p><strong>${esc(invoice.customerName)}</strong></p></div><div><p>Status: <span class="badge">${esc(invoice.status)}</span></p><p>Issued: ${esc(formatEastern(invoice.issuedAt, { dateOnly: true }))}</p>${invoice.dueDate ? `<p>Due: ${esc(invoice.dueDate)}</p>` : ''}${invoice.paidAt ? `<p>Paid: ${esc(formatEastern(invoice.paidAt, { dateOnly: true }))}</p>` : ''}</div></header><table><thead><tr><th>Date</th><th>Project</th><th>Notes</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="3"></td><td class="num total">${invoice.totalHours.toFixed(2)}</td><td></td><td class="num total">$${invoice.totalAmount.toFixed(2)}</td></tr></tfoot></table>${invoice.notes ? `<p><strong>Notes:</strong> ${esc(invoice.notes)}</p>` : ''}<div class="buttonRow"><button onclick="window.print()">Print</button><a class="button" href="/api/invoices/${invoice.id}.pdf">Export PDF</a></div></body></html>`);
  }

  const entryDelete = route.match(/^\/api\/entries\/([^/]+)$/);
  if (method === 'DELETE' && entryDelete) {
    const before = db.entries.length;
    db.entries = db.entries.filter(e => e.id !== entryDelete[1]);
    if (db.entries.length === before) return notFound(res);
    await writeDb(db);
    return json(res, 200, { ok: true });
  }

  return notFound(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith('/api/')) return await api(req, res);
    return await serveStatic(req, res);
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: err.message || 'Server error' });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Customer Time Tracker running at http://localhost:${port}`);
});
