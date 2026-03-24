require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const csvParser = require('csv-parser');
const { Readable } = require('stream');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer'); // npm install nodemailer

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@geu.ac.in';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@123';

const MERITTO_SECRET = process.env.MERITTO_SECRET ||
  crypto.createHash('sha256').update((process.env.JWT_SECRET || 'default-secret-change-me') + '-meritto').digest('hex').slice(0, 32);

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/admission_dashboard';
mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch(e => { console.error('MongoDB error:', e); process.exit(1); });

// ─── User Schema ───
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  name: { type: String, default: '' },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  active: { type: Boolean, default: true }
}, { timestamps: true });
userSchema.index({ email: 1 });
const User = mongoose.model('User', userSchema);

function hashPass(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Login required' });
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token. Please login again.' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

const upload_mem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Login ───
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const emailLower = email.toLowerCase().trim();
    if (emailLower === ADMIN_EMAIL.toLowerCase() && password === ADMIN_PASSWORD) {
      const token = jwt.sign({ email: emailLower, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
      return res.json({ token, role: 'admin', name: 'Administrator', email: emailLower });
    }
    const user = await User.findOne({ email: emailLower, active: true });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.password !== hashPass(password)) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ email: user.email, role: 'user', userId: user._id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, role: 'user', name: user.name || user.email, email: user.email });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/users/upload', auth, adminOnly, upload_mem.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const users = [];
    await new Promise((resolve, reject) => {
      const stream = Readable.from(req.file.buffer.toString('utf-8'));
      stream.pipe(csvParser())
        .on('data', row => {
          const email = (row['Email'] || row['email'] || row['Email ID'] || row['EmailID'] || '').trim().toLowerCase();
          const password = (row['Password'] || row['password'] || '').trim();
          const name = (row['Name'] || row['name'] || '').trim();
          if (email && password) users.push({ email, password: hashPass(password), name, role: 'user', active: true });
        })
        .on('end', resolve).on('error', reject);
    });
    if (users.length === 0) return res.status(400).json({ error: 'No valid users found. CSV must have Email and Password columns.' });
    let created = 0, updated = 0;
    for (const u of users) {
      const result = await User.updateOne({ email: u.email }, { $set: u }, { upsert: true });
      if (result.upsertedCount > 0) created++; else updated++;
    }
    res.json({ success: true, created, updated, total: users.length });
  } catch (err) {
    res.status(500).json({ error: 'User upload failed: ' + err.message });
  }
});

app.get('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const users = await User.find({}, { password: 0 }).sort({ createdAt: -1 }).lean();
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  try { await User.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/users/:id/toggle', auth, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.active = !user.active;
    await user.save();
    res.json({ success: true, active: user.active });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Student Schema ───
const studentSchema = new mongoose.Schema({
  sno: String, courseType: String, courseName: String, studentId: String,
  leadId: String, name: String, fatherName: String, email: String, mobile: String,
  gender: String, dob: String, motherName: String, category: String, intake: String,
  applicationStatus: String, campus: String, enquiredCenter: String,
  registeredCenter: String, admittedCenter: String,
  dateOfEnquiry: String, dateOfRegistration: String, dateOfAdmission: String,
  enquiryDateParsed: Date, registrationDateParsed: Date, admissionDateParsed: Date,
  state: String, address: String, district: String, pincode: String, city: String,
  bloodGroup: String, religion: String, nationality: String, aadhar: String,
  tenthBoard: String, tenthSchool: String, tenthYear: String, tenthMarks: String, tenthTotal: String, tenthPercent: String,
  twelfthBoard: String, twelfthSchool: String, twelfthYear: String, twelfthMarks: String, twelfthTotal: String, twelfthPercent: String,
  gradBoard: String, gradSchool: String, gradYear: String, gradMarks: String, gradTotal: String, gradPercent: String,
  uploadBatch: String, rawData: Object
}, { timestamps: true });

studentSchema.index({ enquiryDateParsed: 1 });
studentSchema.index({ registrationDateParsed: 1 });
studentSchema.index({ admissionDateParsed: 1 });
studentSchema.index({ uploadBatch: 1 });
studentSchema.index({ courseName: 1 });
studentSchema.index({ enquiredCenter: 1 });
studentSchema.index({ registeredCenter: 1 });
studentSchema.index({ admittedCenter: 1 });
studentSchema.index({ campus: 1 });
studentSchema.index({ leadId: 1 });

const Student = mongoose.model('Student', studentSchema);

// ════════════════════════════════════════════════════
// ─── EMAIL REPORT FEATURE ───────────────────────────
// ════════════════════════════════════════════════════

// ─── Email Settings Schema ───
const emailSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'report_settings', unique: true },
  toEmails: [{ type: String, trim: true, lowercase: true }],
  ccEmails: [{ type: String, trim: true, lowercase: true }],
  mode: { type: String, enum: ['regular', 'online'], default: 'regular' },
  campuses: [{ type: String, trim: true }],   // ['GEU', 'GEHU'] etc.
  years: [{ type: Number }],                   // [2026, 2025, 2024]
  updatedAt: { type: Date, default: Date.now }
});
const EmailSettings = mongoose.model('EmailSettings', emailSettingsSchema);

// ─── Nodemailer transporter (auto-detects Gmail or Outlook from .env) ───
function createTransporter() {
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
  }
  // Outlook / Office365 fallback
  return nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: { user: process.env.OUTLOOK_EMAIL, pass: process.env.OUTLOOK_PASSWORD },
    tls: { ciphers: 'SSLv3', rejectUnauthorized: false }
  });
}

// ─── GET /api/email-settings ───
app.get('/api/email-settings', auth, adminOnly, async (req, res) => {
  try {
    const s = await EmailSettings.findOne({ key: 'report_settings' }).lean();
    res.json(s || { toEmails: [], ccEmails: [], mode: 'regular', campuses: ['GEU', 'GEHU'], years: [2026, 2025, 2024] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/email-settings ───
app.post('/api/email-settings', auth, adminOnly, async (req, res) => {
  try {
    const { toEmails, ccEmails, campuses, years, mode } = req.body;
    await EmailSettings.findOneAndUpdate(
      { key: 'report_settings' },
      { toEmails: toEmails || [], ccEmails: ccEmails || [], mode: normalizeMode(mode), campuses: campuses || [], years: years || [], updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Campus query helpers ───
function campusMatchQuery(campusCode) {
  if (!campusCode || campusCode === 'GEHU') {
    const re = { $regex: /^GEHU/ };
    return { $or: [{ registeredCenter: re }, { admittedCenter: re }, { campus: re }] };
  }
  return { $or: [{ registeredCenter: campusCode }, { admittedCenter: campusCode }, { campus: campusCode }] };
}

// ─── Helper: build report data ───
// Returns: { results[year][campusCode] = { reg, adm } }
async function buildReport(years, campuses, mode) {
  const today = new Date();
  const results = {};
  const modeQ = modeCourseQuery(mode);

  for (const year of years) {
    results[year] = {};
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, today.getUTCMonth(), today.getUTCDate(), 23, 59, 59, 999));

    for (const campus of campuses) {
      const cq = campusMatchQuery(campus === 'GEHU' ? 'GEHU' : campus);

      const andParts = [];
      if (cq && Object.keys(cq).length) andParts.push(cq);
      if (modeQ && Object.keys(modeQ).length) andParts.push(modeQ);

      const regFilter = {
        registrationDateParsed: { $gte: start, $lte: end },
        ...(andParts.length ? { $and: andParts } : {})
      };
      const admFilter = {
        admissionDateParsed: { $gte: start, $lte: end },
        ...(andParts.length ? { $and: andParts } : {})
      };

      const [reg, adm] = await Promise.all([
        Student.countDocuments(regFilter),
        Student.countDocuments(admFilter)
      ]);
      results[year][campus] = { reg, adm };
    }
  }
  return results;
}

// ─── Helper: build HTML email (single table, all years × campuses) ───
function buildEmailHTML(years, campuses, results) {
  const today = new Date();
  const timeStr = today.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = today.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });

  // Campus display labels
  const campusLabel = c => ({
    'GEU': 'GEU', 'GEHU': 'GEHU', 'GEHUDDN': 'GEHU-DDN',
    'GEHUHLD': 'GEHU-HLD', 'GEHUBTL': 'GEHU-BTL'
  }[c] || c);

  // Year colour palette
  const yearBg = ['#1e3a5f', '#3b1f6e', '#1a4731'];
  const yearFg = ['#93c5fd', '#c4b5fd', '#6ee7b7'];

  // Determine which campus combos to show per year
  // Each year block: [campus1, campus2, ..., Total]
  const hasSingleGehu = campuses.includes('GEHU') && !campuses.some(c => c.startsWith('GEHU') && c !== 'GEHU');
  const showCampuses = campuses; // as selected

  // Compute totals per year (sum of all selected campuses)
  function yearTotal(year, type) {
    return showCampuses.reduce((sum, c) => sum + (results[year]?.[c]?.[type] || 0), 0);
  }

  const colsPerYear = showCampuses.length + 1; // +1 for Total
  const totalCols = 1 + years.length * colsPerYear;

  // ── Header row 1: year groups ──
  let headerRow1 = `<th style="padding:12px 16px;background:#0f172a;color:#e2e8f0;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;border:1px solid #334155;text-align:left;">Status</th>`;
  years.forEach((y, i) => {
    const bg = yearBg[i % yearBg.length];
    headerRow1 += `<th colspan="${colsPerYear}" style="padding:12px 16px;background:${bg};color:white;font-size:13px;font-weight:800;text-align:center;border:1px solid #334155;letter-spacing:0.5px;">${y}</th>`;
  });

  // ── Header row 2: campus sub-columns ──
  let headerRow2 = `<th style="padding:9px 16px;background:#1e293b;color:#94a3b8;font-size:11px;font-weight:700;border:1px solid #334155;"></th>`;
  years.forEach((y, i) => {
    const bg = yearBg[i % yearBg.length] + 'bb';
    showCampuses.forEach(c => {
      headerRow2 += `<th style="padding:9px 10px;background:#1e293b;color:#94a3b8;font-size:11px;font-weight:700;text-align:center;border:1px solid #334155;text-transform:uppercase;letter-spacing:0.4px;">${campusLabel(c)}</th>`;
    });
    headerRow2 += `<th style="padding:9px 10px;background:#162032;color:#e2e8f0;font-size:11px;font-weight:800;text-align:center;border:1px solid #334155;text-transform:uppercase;letter-spacing:0.4px;">Total</th>`;
  });

  // ── Data rows ──
  const rows = [
    { label: 'Registration', type: 'reg', color: '#d97706', bgColor: '#451a03' },
    { label: 'Admitted',     type: 'adm', color: '#10b981', bgColor: '#052e16' }
  ];

  let dataRows = '';
  rows.forEach((row, rowIdx) => {
    const rowBg = rowIdx % 2 === 0 ? '#ffffff' : '#f8fafc';
    let tds = `<td style="padding:14px 16px;font-weight:700;font-size:13px;color:#0f172a;background:${rowBg};border:1px solid #e2e8f0;">${row.label}</td>`;

    years.forEach((y, yi) => {
      const total = yearTotal(y, row.type);
      showCampuses.forEach(c => {
        const val = results[y]?.[c]?.[row.type] || 0;
        tds += `<td style="padding:14px 10px;text-align:center;font-size:13px;font-weight:${val > 0 ? '700' : '400'};color:${val > 0 ? row.color : '#94a3b8'};background:${rowBg};border:1px solid #e2e8f0;">${val > 0 ? val : '-'}</td>`;
      });
      tds += `<td style="padding:14px 10px;text-align:center;font-size:14px;font-weight:800;color:${row.color};background:#f0fdf4;border:1px solid #e2e8f0;">${total}</td>`;
    });

    dataRows += `<tr>${tds}</tr>`;
  });

  // ── Year-over-year summary (newest vs previous, and newest vs oldest) ──
  let yoyHTML = '';
  const metrics = [
    { label: 'Registration', type: 'reg' },
    { label: 'Admitted', type: 'adm' }
  ];

  function buildYoYBlock(y1, y2) {
    return `
    <div style="padding:16px 20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;width:100%;">
      <div style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Year-over-Year Change (${y1} vs ${y2})</div>
      ${metrics.map(m => {
        const v1 = yearTotal(y1, m.type);
        const v2 = yearTotal(y2, m.type);
        const diff = v1 - v2;
        const pct = v2 > 0 ? ((diff / v2) * 100).toFixed(1) : '—';
        const color = diff > 0 ? '#15803d' : diff < 0 ? '#b91c1c' : '#64748b';
        const sign = diff > 0 ? '+' : '';
        return `<div style="font-size:13px;font-weight:600;color:#1e293b;margin-bottom:4px;">${m.label}: <span style="color:${color};font-weight:700;">${sign}${diff} (${sign}${pct}%)</span></div>`;
      }).join('')}
    </div>`;
  }

  const yoyBlocks = [];
  if (years.length >= 2) yoyBlocks.push(buildYoYBlock(years[0], years[1]));
  if (years.length >= 3) yoyBlocks.push(buildYoYBlock(years[0], years[2]));

  if (yoyBlocks.length === 1) {
    yoyHTML = `<div style="margin-top:20px;">${yoyBlocks[0]}</div>`;
  } else if (yoyBlocks.length >= 2) {
    yoyHTML = `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border-collapse:separate;">
      <tr>
        <td width="50%" valign="top" style="padding-right:6px;">${yoyBlocks[0]}</td>
        <td width="50%" valign="top" style="padding-left:6px;">${yoyBlocks[1]}</td>
      </tr>
    </table>`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:860px;margin:0 auto;padding:24px 16px;">

  <!-- Greeting -->
  <p style="font-size:14px;color:#1e293b;margin-bottom:16px;font-weight:500;">
    Hon'ble Sir,<br><br>
    Kindly find the admission data for both <strong>GEU</strong> and <strong>GEHU</strong>
    at <strong>${timeStr}</strong> till <strong>${dateStr}</strong>.
  </p>

  <!-- Header Banner -->
  <div style=";border-radius:12px;padding:20px 24px;margin-bottom:16px;">
    <div style="font-size:20px;font-weight:800;color:black;letter-spacing:-0.5px;"> GRAPHIC Era Admissions Report</div>
    <div style="font-size:12px;color:#94a3b8;margin-top:4px;">Period: 1 Jan → ${dateStr} &nbsp;·&nbsp; Years: ${years.join(' vs ')}</div>
  </div>

  <!-- Main Table -->
  <div style="background:white;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <thead>
        <tr>${headerRow1}</tr>
        <tr>${headerRow2}</tr>
      </thead>
      <tbody>
        ${dataRows}
      </tbody>
    </table>
  </div>

  ${yoyHTML}



</div>
</body>
</html>`;
}

// ─── GET /api/email-settings ───  (already defined above)
// ─── POST /api/email-settings ─── (already defined above)

// ─── GET /api/report-preview ───
app.get('/api/report-preview', auth, async (req, res) => {
  try {
    const yearsParam  = req.query.years;
    const campusParam = req.query.campuses;
    const mode = req.query.mode;
    if (!yearsParam || !campusParam) return res.status(400).json({ error: 'years and campuses params required' });

    const years   = yearsParam.split(',').map(Number).sort((a, b) => b - a);
    const campuses = campusParam.split(',').map(s => s.trim()).filter(Boolean);

    const results = await buildReport(years, campuses, mode);
    const html    = buildEmailHTML(years, campuses, results);
    res.json({ html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/send-report ───
app.post('/api/send-report', auth, adminOnly, async (req, res) => {
  try {
    const { years, campuses, mode } = req.body;
    if (!years || !years.length)   return res.status(400).json({ error: 'No years selected' });
    if (!campuses || !campuses.length) return res.status(400).json({ error: 'No campuses selected' });

    const settings = await EmailSettings.findOne({ key: 'report_settings' }).lean();
    if (!settings || !settings.toEmails || !settings.toEmails.length)
      return res.status(400).json({ error: 'No recipient emails configured. Please save email settings first.' });

    const hasGmail   = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD;
    const hasOutlook = process.env.OUTLOOK_EMAIL && process.env.OUTLOOK_PASSWORD;
    if (!hasGmail && !hasOutlook)
      return res.status(500).json({ error: 'No email credentials found in .env (set GMAIL_USER + GMAIL_APP_PASSWORD or OUTLOOK_EMAIL + OUTLOOK_PASSWORD)' });

    const sortedYears = [...years].map(Number).sort((a, b) => b - a);
    const reportMode  = mode ? normalizeMode(mode) : (settings?.mode ? normalizeMode(settings.mode) : 'regular');
    const results     = await buildReport(sortedYears, campuses, reportMode);
    const html        = buildEmailHTML(sortedYears, campuses, results);

    const today  = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
    const subject = `GEU Admissions Report – ${dateStr} (${sortedYears.join(' vs ')})`;

    const fromAddr = process.env.GMAIL_USER || process.env.OUTLOOK_EMAIL;
    const transporter = createTransporter();

    await transporter.sendMail({
      from: `"GEU Admissions Dashboard" <${fromAddr}>`,
      to:   settings.toEmails.join(', '),
      cc:   (settings.ccEmails || []).length ? settings.ccEmails.join(', ') : undefined,
      subject,
      html
    });

    console.log(`Report sent to: ${settings.toEmails.join(', ')}`);
    res.json({ success: true, sentTo: settings.toEmails, cc: settings.ccEmails || [] });
  } catch (err) {
    console.error('Send report error:', err);
    res.status(500).json({ error: 'Failed to send report: ' + err.message });
  }
});

// ════════════════════════════════════════════════════
// ─── DATE & CAMPUS HELPERS ──────────────────────────
// ════════════════════════════════════════════════════

const MONTH_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
function parseDate(str) {
  if (!str || !str.trim()) return null;
  const d = str.trim().split(' ')[0];

  const monMatch = d.match(/^(\d{1,2})[-/](\w{3})[-/](\d{2,4})$/);
  if (monMatch) {
    const day = parseInt(monMatch[1], 10);
    const mon = MONTH_MAP[monMatch[2].toLowerCase()];
    let yr = parseInt(monMatch[3], 10);
    if (yr < 100) yr += 2000;
    if (mon !== undefined && !isNaN(day) && !isNaN(yr)) return new Date(Date.UTC(yr, mon, day));
  }

  const numMatch = d.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (numMatch) {
    let a = parseInt(numMatch[1], 10), b = parseInt(numMatch[2], 10), yr = parseInt(numMatch[3], 10);
    if (yr < 100) yr += 2000;
    let day, mon;
    if (b > 12) { mon = a - 1; day = b; }
    else if (a > 12) { day = a; mon = b - 1; }
    else { day = a; mon = b - 1; }
    if (!isNaN(day) && !isNaN(mon) && !isNaN(yr)) return new Date(Date.UTC(yr, mon, day));
  }

  const isoMatch = d.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const yr = parseInt(isoMatch[1], 10), mon = parseInt(isoMatch[2], 10) - 1, day = parseInt(isoMatch[3], 10);
    if (!isNaN(day) && !isNaN(mon) && !isNaN(yr)) return new Date(Date.UTC(yr, mon, day));
  }

  const fallback = new Date(str.trim());
  return isNaN(fallback.getTime()) ? null : fallback;
}

function normalizeCampus(raw) {
  if (!raw) return '';
  const val = raw.trim().toLowerCase().replace(/[\s\-–—]+/g, ' ');
  if (/^geu(\s+dehradun)?$/.test(val) || val === 'geu dehradun') return 'GEU';
  if (val === 'gehuddn' || /gehu.*dehradun/.test(val)) return 'GEHUDDN';
  if (val === 'gehuhld' || /gehu.*haldwani/.test(val)) return 'GEHUHLD';
  if (val === 'gehubtl' || /gehu.*bhimtal/.test(val))  return 'GEHUBTL';
  if (/^gehu$/.test(val)) return 'GEHU';
  return raw.trim();
}

function displayCampus(code) {
  if (!code) return '';
  const map = { 'GEU': 'GEU', 'GEHUDDN': 'GEHU - DEHRADUN', 'GEHUHLD': 'GEHU - HALDWANI', 'GEHUBTL': 'GEHU - BHIMTAL', 'GEHU': 'GEHU' };
  return map[code] || code;
}

// ─── Upload CSV ───
app.post('/api/upload', auth, adminOnly, upload_mem.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const batchId = Date.now().toString();
    const records = [];

    await new Promise((resolve, reject) => {
      const stream = Readable.from(req.file.buffer.toString('utf-8'));
      stream.pipe(csvParser())
        .on('data', row => {
          const get = (...keys) => {
            for (const k of keys) { if (row[k] !== undefined && row[k] !== '') return row[k].toString().trim(); }
            const rowKeys = Object.keys(row);
            for (const k of keys) {
              const found = rowKeys.find(rk => rk.trim().toLowerCase() === k.trim().toLowerCase());
              if (found && row[found] !== undefined && row[found] !== '') return row[found].toString().trim();
            }
            return '';
          };
          const name = get('Name');
          if (!name) return;

          let enquiredCenter = get('Enquired Center'), registeredCenter = get('Registered Center'), admittedCenter = get('Admitted Center');
          const singleCampus = get('Campus');
          if (!enquiredCenter && singleCampus) enquiredCenter = singleCampus;
          if (!registeredCenter && singleCampus) registeredCenter = singleCampus;
          if (!admittedCenter && singleCampus) admittedCenter = singleCampus;

          const dateOfEnquiry = get('Date of Enquiry'), dateOfRegistration = get('Date of Registration'), dateOfAdmission = get('Date of Admission');

          records.push({
            sno: get('S. No.','S.No.','SNo','Sr No','Sr. No.'),
            courseType: get('Course Type','CourseType'),
            courseName: get('Course Name','Course','CourseName'),
            studentId: get('Student ID','StudentID','Student Id'),
            name, fatherName: get('Father name','Father Name','Father','FatherName'),
            email: get('Email ID','Email','EmailID'), mobile: get('Mobile','Phone','Contact'),
            gender: get('Gender'), dob: get('Date of Birth','DOB'),
            motherName: get('Mother name','Mother Name','Mother','MotherName'),
            category: get('Category'), intake: get('Intake','Year'),
            applicationStatus: get('Application Status','ApplicationStatus','Status'),
            campus: singleCampus, enquiredCenter, registeredCenter, admittedCenter,
            dateOfEnquiry, dateOfRegistration, dateOfAdmission,
            enquiryDateParsed: parseDate(dateOfEnquiry),
            registrationDateParsed: parseDate(dateOfRegistration),
            admissionDateParsed: parseDate(dateOfAdmission),
            state: get('Permamnent State','Permanent State','State'),
            address: get('Permanent Address','Address'),
            district: get('Permamnent District','Permanent District','District'),
            pincode: get('Permamnent PinCode','Permanent PinCode','Pincode','Pin Code'),
            city: get('Permamnent City','Permanent City','City'),
            bloodGroup: get('Blood Group','BloodGroup'), religion: get('Religion'),
            nationality: get('Nationality'), aadhar: get('Aadhar No','Aadhar','Aadhaar No','Aadhaar'),
            tenthBoard: get('10th Board'), tenthSchool: get('10th SchooCollege Name','10th School/College Name'),
            tenthYear: get('10th Year'), tenthMarks: get('10th Obtain Mark','10th Obtained Marks'),
            tenthTotal: get('10th Total Mark','10th Total Marks'), tenthPercent: get('10th Marks %','10th Percentage'),
            twelfthBoard: get('12th / Diploma Board','12th Board'),
            twelfthSchool: get('12th / Diploma School/College Name','12th School/College Name'),
            twelfthYear: get('12th / Diploma Year','12th Year'),
            twelfthMarks: get('12th / Diploma Obtain Mark','12th Obtained Marks'),
            twelfthTotal: get('12th / Diploma Total Mark','12th Total Marks'),
            twelfthPercent: get('12th / Diploma Marks %','12th Percentage'),
            gradBoard: get('Graduation Board'), gradSchool: get('Graduation School/College Name'),
            gradYear: get('Graduation Year'), gradMarks: get('Graduation Obtain Mark','Graduation Obtained Marks'),
            gradTotal: get('Graduation Total Mark','Graduation Total Marks'),
            gradPercent: get('Graduation Marks %','Graduation Percentage'),
            uploadBatch: batchId, rawData: row
          });
        })
        .on('end', resolve).on('error', reject);
    });

    if (records.length === 0) return res.status(400).json({ error: 'No valid student records found in CSV' });
    await Student.insertMany(records, { ordered: false });
    res.json({ success: true, count: records.length, batchId });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

const listProjection = {
  studentId:1, name:1, courseName:1, courseType:1, applicationStatus:1, gender:1, mobile:1,
  email:1, state:1, category:1, campus:1, enquiredCenter:1, registeredCenter:1, admittedCenter:1,
  dateOfEnquiry:1, dateOfRegistration:1, dateOfAdmission:1
};

function toLocalDate(str) {
  const parts = str.split('-');
  if (parts.length === 3) return new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
  return new Date(str + 'T00:00:00Z');
}

function normalizeMode(raw) {
  const v = (raw || '').toString().trim().toLowerCase();
  if (v === 'online') return 'online';
  return 'regular';
}

function modeCourseQuery(mode) {
  const m = normalizeMode(mode);
  // "Online" means courseName contains the word "online" anywhere (case-insensitive)
  if (m === 'online') return { courseName: { $regex: /online/i } };
  // "Regular" means courseName does NOT contain "online" (or is empty)
  return { $or: [{ courseName: { $not: /online/i } }, { courseName: { $exists: false } }, { courseName: null }, { courseName: '' }] };
}

function buildDateFilter(dateField, start, end, extra) {
  const q = { [dateField]: { $gte: start, $lte: end } };
  if (extra.campus) {
    const campusCode = normalizeCampus(extra.campus);
    if (campusCode === 'GEHU') {
      const gehuRe = { $regex: /^GEHU/ };
      q.$or = [{ enquiredCenter: gehuRe }, { registeredCenter: gehuRe }, { admittedCenter: gehuRe }, { campus: gehuRe }];
    } else {
      q.$or = [{ enquiredCenter: campusCode }, { registeredCenter: campusCode }, { admittedCenter: campusCode }, { campus: campusCode }];
    }
  }
  if (extra.course) q.courseName = extra.course;
  if (extra.mode) {
    q.$and = q.$and || [];
    q.$and.push(modeCourseQuery(extra.mode));
  }
  if (extra.year) {
    const dateStrField = dateField === 'enquiryDateParsed' ? 'dateOfEnquiry' : dateField === 'registrationDateParsed' ? 'dateOfRegistration' : 'dateOfAdmission';
    q[dateStrField] = { $regex: extra.year };
  }
  if (extra.search) {
    const re = { $regex: extra.search, $options: 'i' };
    q.$and = q.$and || [];
    q.$and.push({ $or: [{ name:re},{courseName:re},{studentId:re},{applicationStatus:re},{email:re},{mobile:re},{state:re},{category:re},{campus:re},{courseType:re},{enquiredCenter:re},{registeredCenter:re},{admittedCenter:re}] });
  }
  return q;
}

const mapDoc = (s, campusField, dateStrField) => ({
  _id: s._id, sid: s.studentId, name: s.name, course: s.courseName, courseType: s.courseType,
  status: s.applicationStatus, gender: s.gender, mobile: s.mobile, email: s.email,
  state: s.state, category: s.category, campus: displayCampus(s[campusField] || s.campus || ''),
  dateStr: s[dateStrField] || ''
});

app.get('/api/students', auth, async (req, res) => {
  try {
    const { startDate, endDate, mode } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required' });

    const start = toLocalDate(startDate), end = toLocalDate(endDate);
    end.setHours(23, 59, 59, 999);
    const dateRange = { $gte: start, $lte: end };
    const modeQ = modeCourseQuery(mode);

    const [enqCount, regCount, admCount, campusList, courseList, yearList] = await Promise.all([
      Student.countDocuments({ enquiryDateParsed: dateRange, ...modeQ }),
      Student.countDocuments({ registrationDateParsed: dateRange, ...modeQ }),
      Student.countDocuments({ admissionDateParsed: dateRange, ...modeQ }),
      Student.distinct('enquiredCenter').then(a => Student.distinct('registeredCenter').then(b => Student.distinct('admittedCenter').then(c => Student.distinct('campus').then(d => {
        const allRaw = [...a,...b,...c,...d].filter(Boolean);
        const codes = [...new Set(allRaw.map(normalizeCampus))].filter(Boolean);
        return codes.map(displayCampus).sort();
      })))),
      Student.distinct('courseName', modeQ).then(arr => arr.filter(Boolean).sort()),
      Student.aggregate([{ $match:{ enquiryDateParsed: dateRange, ...modeQ }},{ $project:{ y:{$year:'$enquiryDateParsed'}}},{ $group:{_id:'$y'}},{ $sort:{_id:1}}]).then(async enqYears => {
        const regYears = await Student.aggregate([{ $match:{ registrationDateParsed: dateRange, ...modeQ }},{ $project:{ y:{$year:'$registrationDateParsed'}}},{ $group:{_id:'$y'}}]);
        const admYears = await Student.aggregate([{ $match:{ admissionDateParsed: dateRange, ...modeQ }},{ $project:{ y:{$year:'$admissionDateParsed'}}},{ $group:{_id:'$y'}}]);
        return [...new Set([...enqYears,...regYears,...admYears].map(r=>r._id))].filter(Boolean).sort().map(String);
      })
    ]);

    res.json({ enquiryCount: enqCount, registrationCount: regCount, admissionCount: admCount, campuses: campusList, courses: courseList, years: yearList });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/students/page', auth, async (req, res) => {
  try {
    const { startDate, endDate, tab, page=1, limit=30, campus, course, year, search, mode } = req.query;
    if (!startDate || !endDate || !tab) return res.status(400).json({ error: 'startDate, endDate, tab required' });

    const start = toLocalDate(startDate), end = toLocalDate(endDate);
    end.setHours(23, 59, 59, 999);
    const pg = Math.max(1, parseInt(page)), lim = Math.min(100, Math.max(1, parseInt(limit) || 30)), skip = (pg-1)*lim;
    const extra = { campus, course, year, search, mode };

    if (tab === 'all') {
      const [enqDocs, regDocs, admDocs] = await Promise.all([
        Student.find(buildDateFilter('enquiryDateParsed', start, end, extra), listProjection).lean(),
        Student.find(buildDateFilter('registrationDateParsed', start, end, extra), listProjection).lean(),
        Student.find(buildDateFilter('admissionDateParsed', start, end, extra), listProjection).lean()
      ]);
      const all = [
        ...enqDocs.map(s => ({ ...mapDoc(s,'enquiredCenter','dateOfEnquiry'), dateType:'Enquiry' })),
        ...regDocs.map(s => ({ ...mapDoc(s,'registeredCenter','dateOfRegistration'), dateType:'Registration' })),
        ...admDocs.map(s => ({ ...mapDoc(s,'admittedCenter','dateOfAdmission'), dateType:'Admission' }))
      ];
      return res.json({ students: all.slice(skip, skip+lim), total: all.length, page: pg, totalPages: Math.ceil(all.length/lim) });
    }

    let dateField, campusField, dateStrField;
    if (tab==='enquiry') { dateField='enquiryDateParsed'; campusField='enquiredCenter'; dateStrField='dateOfEnquiry'; }
    else if (tab==='registration') { dateField='registrationDateParsed'; campusField='registeredCenter'; dateStrField='dateOfRegistration'; }
    else { dateField='admissionDateParsed'; campusField='admittedCenter'; dateStrField='dateOfAdmission'; }

    const filter = buildDateFilter(dateField, start, end, extra);
    const [docs, total] = await Promise.all([ Student.find(filter, listProjection).skip(skip).limit(lim).lean(), Student.countDocuments(filter) ]);
    res.json({ students: docs.map(s => mapDoc(s, campusField, dateStrField)), total, page: pg, totalPages: Math.ceil(total/lim) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/students/export', auth, async (req, res) => {
  try {
    const { startDate, endDate, tab, campus, course, year, search, mode } = req.query;
    if (!startDate || !endDate || !tab) return res.status(400).json({ error: 'startDate, endDate, tab required' });

    const start = toLocalDate(startDate), end = toLocalDate(endDate);
    end.setHours(23, 59, 59, 999);
    const extra = { campus, course, year, search, mode };

    if (tab==='all' || tab==='allSheets') {
      const [enqDocs, regDocs, admDocs] = await Promise.all([
        Student.find(buildDateFilter('enquiryDateParsed', start, end, extra), listProjection).lean(),
        Student.find(buildDateFilter('registrationDateParsed', start, end, extra), listProjection).lean(),
        Student.find(buildDateFilter('admissionDateParsed', start, end, extra), listProjection).lean()
      ]);
      return res.json({
        enquiries: enqDocs.map(s=>mapDoc(s,'enquiredCenter','dateOfEnquiry')),
        registrations: regDocs.map(s=>mapDoc(s,'registeredCenter','dateOfRegistration')),
        admissions: admDocs.map(s=>mapDoc(s,'admittedCenter','dateOfAdmission'))
      });
    }

    let dateField, campusField, dateStrField;
    if (tab==='enquiry') { dateField='enquiryDateParsed'; campusField='enquiredCenter'; dateStrField='dateOfEnquiry'; }
    else if (tab==='registration') { dateField='registrationDateParsed'; campusField='registeredCenter'; dateStrField='dateOfRegistration'; }
    else { dateField='admissionDateParsed'; campusField='admittedCenter'; dateStrField='dateOfAdmission'; }

    const docs = await Student.find(buildDateFilter(dateField, start, end, extra), listProjection).lean();
    res.json({ students: docs.map(s=>mapDoc(s, campusField, dateStrField)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/student/:id', auth, async (req, res) => {
  try {
    const s = await Student.findById(req.params.id).lean();
    if (!s) return res.status(404).json({ error: 'Student not found' });
    s.campus = displayCampus(s.campus); s.enquiredCenter = displayCampus(s.enquiredCenter);
    s.registeredCenter = displayCampus(s.registeredCenter); s.admittedCenter = displayCampus(s.admittedCenter);
    res.json(s);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/batches', auth, adminOnly, async (req, res) => {
  try {
    const batches = await Student.aggregate([{ $group:{ _id:'$uploadBatch', count:{$sum:1}, firstUpload:{$min:'$createdAt'}}},{ $sort:{firstUpload:-1}}]);
    res.json(batches);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/batch/:batchId', auth, adminOnly, async (req, res) => {
  try {
    const result = await Student.deleteMany({ uploadBatch: req.params.batchId });
    res.json({ deleted: result.deletedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/count', auth, async (req, res) => {
  try {
    const { mode } = req.query;
    const count = await Student.countDocuments(mode ? modeCourseQuery(mode) : {});
    res.json({ count });
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/compare', auth, async (req, res) => {
  try {
    const { startMonth, startDay, endMonth, endDay, year1, year2, year3, campus, course, mode } = req.query;
    if (!startMonth||!startDay||!endMonth||!endDay||!year1||!year2||!year3) return res.status(400).json({ error: 'All params required' });

    const y1=parseInt(year1), y2=parseInt(year2), y3=parseInt(year3);
    const sm=parseInt(startMonth)-1, sd=parseInt(startDay), em=parseInt(endMonth)-1, ed=parseInt(endDay);

    const start1=new Date(Date.UTC(y1,sm,sd)), end1=new Date(Date.UTC(y1,em,ed,23,59,59,999));
    const start2=new Date(Date.UTC(y2,sm,sd)), end2=new Date(Date.UTC(y2,em,ed,23,59,59,999));
    const start3=new Date(Date.UTC(y3,sm,sd)), end3=new Date(Date.UTC(y3,em,ed,23,59,59,999));
    const extra = { campus: campus||'', course: course||'', mode };

    const [enq1,reg1,adm1,enq2,reg2,adm2,enq3,reg3,adm3] = await Promise.all([
      Student.countDocuments(buildDateFilter('enquiryDateParsed',start1,end1,extra)),
      Student.countDocuments(buildDateFilter('registrationDateParsed',start1,end1,extra)),
      Student.countDocuments(buildDateFilter('admissionDateParsed',start1,end1,extra)),
      Student.countDocuments(buildDateFilter('enquiryDateParsed',start2,end2,extra)),
      Student.countDocuments(buildDateFilter('registrationDateParsed',start2,end2,extra)),
      Student.countDocuments(buildDateFilter('admissionDateParsed',start2,end2,extra)),
      Student.countDocuments(buildDateFilter('enquiryDateParsed',start3,end3,extra)),
      Student.countDocuments(buildDateFilter('registrationDateParsed',start3,end3,extra)),
      Student.countDocuments(buildDateFilter('admissionDateParsed',start3,end3,extra))
    ]);

    res.json({
      year1:{year:y1,enquiry:enq1,registration:reg1,admission:adm1,total:enq1+reg1+adm1},
      year2:{year:y2,enquiry:enq2,registration:reg2,admission:adm2,total:enq2+reg2+adm2},
      year3:{year:y3,enquiry:enq3,registration:reg3,admission:adm3,total:enq3+reg3+adm3}
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/compare/export', auth, async (req, res) => {
  try {
    const { startMonth, startDay, endMonth, endDay, year1, year2, year3, campus, course, mode } = req.query;
    if (!startMonth||!startDay||!endMonth||!endDay||!year1||!year2||!year3) return res.status(400).json({ error: 'All params required' });

    const y1=parseInt(year1), y2=parseInt(year2), y3=parseInt(year3);
    const sm=parseInt(startMonth)-1, sd=parseInt(startDay), em=parseInt(endMonth)-1, ed=parseInt(endDay);

    const start1=new Date(Date.UTC(y1,sm,sd)), end1=new Date(Date.UTC(y1,em,ed,23,59,59,999));
    const start2=new Date(Date.UTC(y2,sm,sd)), end2=new Date(Date.UTC(y2,em,ed,23,59,59,999));
    const start3=new Date(Date.UTC(y3,sm,sd)), end3=new Date(Date.UTC(y3,em,ed,23,59,59,999));
    const extra = { campus: campus||'', course: course||'', mode };

    const [enq1,reg1,adm1,enq2,reg2,adm2,enq3,reg3,adm3] = await Promise.all([
      Student.find(buildDateFilter('enquiryDateParsed',start1,end1,extra),listProjection).lean(),
      Student.find(buildDateFilter('registrationDateParsed',start1,end1,extra),listProjection).lean(),
      Student.find(buildDateFilter('admissionDateParsed',start1,end1,extra),listProjection).lean(),
      Student.find(buildDateFilter('enquiryDateParsed',start2,end2,extra),listProjection).lean(),
      Student.find(buildDateFilter('registrationDateParsed',start2,end2,extra),listProjection).lean(),
      Student.find(buildDateFilter('admissionDateParsed',start2,end2,extra),listProjection).lean(),
      Student.find(buildDateFilter('enquiryDateParsed',start3,end3,extra),listProjection).lean(),
      Student.find(buildDateFilter('registrationDateParsed',start3,end3,extra),listProjection).lean(),
      Student.find(buildDateFilter('admissionDateParsed',start3,end3,extra),listProjection).lean()
    ]);

    res.json({
      year1:{ year:y1, enquiries:enq1.map(s=>mapDoc(s,'enquiredCenter','dateOfEnquiry')), registrations:reg1.map(s=>mapDoc(s,'registeredCenter','dateOfRegistration')), admissions:adm1.map(s=>mapDoc(s,'admittedCenter','dateOfAdmission')) },
      year2:{ year:y2, enquiries:enq2.map(s=>mapDoc(s,'enquiredCenter','dateOfEnquiry')), registrations:reg2.map(s=>mapDoc(s,'registeredCenter','dateOfRegistration')), admissions:adm2.map(s=>mapDoc(s,'admittedCenter','dateOfAdmission')) },
      year3:{ year:y3, enquiries:enq3.map(s=>mapDoc(s,'enquiredCenter','dateOfEnquiry')), registrations:reg3.map(s=>mapDoc(s,'registeredCenter','dateOfRegistration')), admissions:adm3.map(s=>mapDoc(s,'admittedCenter','dateOfAdmission')) }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/migrate-campus', auth, adminOnly, async (req, res) => {
  try {
    const students = await Student.find({}, { campus:1, enquiredCenter:1, registeredCenter:1, admittedCenter:1 }).lean();
    let updated = 0;
    for (const s of students) {
      const updates = {};
      const nc = normalizeCampus(s.campus); if (nc !== s.campus && nc) { updates.campus = nc; }
      const ne = normalizeCampus(s.enquiredCenter); if (ne !== s.enquiredCenter && ne) { updates.enquiredCenter = ne; }
      const nr = normalizeCampus(s.registeredCenter); if (nr !== s.registeredCenter && nr) { updates.registeredCenter = nr; }
      const na = normalizeCampus(s.admittedCenter); if (na !== s.admittedCenter && na) { updates.admittedCenter = na; }
      if (Object.keys(updates).length > 0) { await Student.updateOne({ _id: s._id }, { $set: updates }); updated++; }
    }
    res.json({ migrated: updated, total: students.length, message: `Normalized ${updated} records to use campus codes` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/migrate-dates', auth, adminOnly, async (req, res) => {
  try {
    const students = await Student.find({}, { dateOfEnquiry:1, dateOfRegistration:1, dateOfAdmission:1 }).lean();
    let updated = 0;
    for (const s of students) {
      await Student.updateOne({ _id: s._id }, { $set: { enquiryDateParsed: parseDate(s.dateOfEnquiry), registrationDateParsed: parseDate(s.dateOfRegistration), admissionDateParsed: parseDate(s.dateOfAdmission) } });
      updated++;
    }
    res.json({ migrated: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Meritto Webhook ───
app.post('/api/meritto/webhook', async (req, res) => {
  try {
    const provided = req.headers['x-meritto-secret'] || req.query.secret || '';
    if (provided !== MERITTO_SECRET) return res.status(401).json({ error: 'Invalid secret token' });

    const payload = req.body;
    const items = Array.isArray(payload) ? payload : [payload];
    if (!items.length) return res.status(400).json({ error: 'Empty payload' });

    const get = (obj, ...keys) => {
      for (const k of keys) { if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return String(obj[k]).trim(); }
      const lower = Object.fromEntries(Object.entries(obj).map(([k,v]) => [k.toLowerCase().replace(/[^a-z0-9]/g,''), v]));
      for (const k of keys) { const nk = k.toLowerCase().replace(/[^a-z0-9]/g,''); if (lower[nk] !== undefined && lower[nk] !== null && lower[nk] !== '') return String(lower[nk]).trim(); }
      return '';
    };

    const batchId = 'meritto_' + Date.now();
    let created=0, updated=0, skipped=0;

    for (const item of items) {
      const firstName = get(item,'first_name','firstName'), lastName = get(item,'last_name','lastName');
      const name = get(item,'name','full_name','fullName','student_name','studentName') || [firstName,lastName].filter(Boolean).join(' ');
      if (!name) { skipped++; continue; }

      const email = get(item,'email','email_id','emailId').toLowerCase();
      const mobile = get(item,'mobile','phone','contact','mobile_number','phone_number');
      const campus = get(item,'campus','center','centre','campus_name','center_name');
      const enquiredCenter = get(item,'enquired_center','enquiry_center','enquiredCenter') || campus;
      const registeredCenter = get(item,'registered_center','registeredCenter') || campus;
      const admittedCenter = get(item,'admitted_center','admittedCenter') || campus;
      const dateOfEnquiry = get(item,'date_of_enquiry','enquiry_date','enquiryDate','lead_date','created_at','createdAt');
      const dateOfRegistration = get(item,'date_of_registration','registration_date','registrationDate');
      const dateOfAdmission = get(item,'date_of_admission','admission_date','admissionDate');

      const rawStatus = get(item,'status','lead_stage','leadStage','application_status','applicationStatus','stage');
      const statusMap = { enquiry:'Enquiry',enquired:'Enquiry',lead:'Enquiry',new:'Enquiry',registration:'Registered',registered:'Registered',admission:'Admitted',admitted:'Admitted',confirm:'Admitted',confirmed:'Admitted' };
      const applicationStatus = statusMap[(rawStatus||'').toLowerCase()] || rawStatus || 'Enquiry';

      const dateOfEnquiryFinal = dateOfEnquiry || (applicationStatus==='Enquiry' ? new Date().toISOString().slice(0,10) : '');
      const dateOfRegistrationFinal = dateOfRegistration || (applicationStatus==='Registered' ? new Date().toISOString().slice(0,10) : '');
      const dateOfAdmissionFinal = dateOfAdmission || (applicationStatus==='Admitted' ? new Date().toISOString().slice(0,10) : '');

      const record = {
        leadId: get(item,'lead_id','leadId','lead_ID','lead ID'),
        studentId: get(item,'student_id','studentId','application_id','applicationId','id'),
        name, email, mobile, gender: get(item,'gender'), dob: get(item,'dob','date_of_birth','dateOfBirth'),
        fatherName: get(item,'father_name','fatherName'), motherName: get(item,'mother_name','motherName'),
        category: get(item,'category','caste_category','casteCategory'),
        courseType: get(item,'course_level','courseLevel','course_type','courseType','program_type','programType'),
        courseName: get(item,'course_name','courseName','program','program_name','programName','course'),
        intake: get(item,'intake','batch','academic_year','academicYear','year'),
        applicationStatus, campus, enquiredCenter, registeredCenter, admittedCenter,
        dateOfEnquiry: dateOfEnquiryFinal, dateOfRegistration: dateOfRegistrationFinal, dateOfAdmission: dateOfAdmissionFinal,
        enquiryDateParsed: parseDate(dateOfEnquiryFinal), registrationDateParsed: parseDate(dateOfRegistrationFinal), admissionDateParsed: parseDate(dateOfAdmissionFinal),
        state: get(item,'state','permanent_state'), city: get(item,'city','permanent_city'),
        district: get(item,'district','permanent_district'), pincode: get(item,'pincode','pin_code','zip'),
        address: get(item,'address','permanent_address'), nationality: get(item,'nationality'),
        religion: get(item,'religion'), bloodGroup: get(item,'blood_group','bloodGroup'),
        aadhar: get(item,'aadhar','aadhaar','aadhar_no','aadhaar_no'),
        uploadBatch: batchId, rawData: item
      };

      const cleanRecord = Object.fromEntries(Object.entries(record).filter(([_,v]) => {
        if (v === null || v === undefined || v === '') return false;
        if (v instanceof Date && isNaN(v.getTime())) return false;
        return true;
      }));

      const leadId = record.leadId;
      if (leadId) {
        const result = await Student.updateOne({ leadId }, { $set: cleanRecord }, { upsert: true });
        if (result.upsertedCount > 0) created++; else updated++;
      } else {
        await Student.create(cleanRecord);
        created++;
      }
    }

    console.log(`Meritto webhook: created=${created} updated=${updated} skipped=${skipped}`);
    res.json({ success: true, received: items.length, created, updated, skipped });
  } catch (err) {
    console.error('Meritto webhook error:', err);
    res.status(500).json({ error: 'Webhook failed: ' + err.message });
  }
});

app.get('/api/meritto/info', auth, adminOnly, async (req, res) => {
  try {
    const count = await Student.countDocuments({ uploadBatch: /^meritto_/ });
    const last  = await Student.findOne({ uploadBatch: /^meritto_/ }, { createdAt: 1 }).sort({ createdAt: -1 }).lean();
    res.json({ secret: MERITTO_SECRET, webhookPath: '/api/meritto/webhook', totalRecords: count, lastReceived: last ? last.createdAt : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));