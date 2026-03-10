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

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@geu.ac.in';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@123';

// ─── MongoDB Connection ───
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

// ─── Helper: hash password (SHA256 — simple, no bcrypt needed for CSV passwords) ───
function hashPass(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

// ─── JWT Auth Middleware ───
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Login required' });
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    req.user = decoded; // { email, role }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token. Please login again.' });
  }
}

// ─── Admin-only Middleware ───
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ─── Multer for file uploads ───
const upload_mem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Login Endpoint ───
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const emailLower = email.toLowerCase().trim();

    // Check if admin
    if (emailLower === ADMIN_EMAIL.toLowerCase() && password === ADMIN_PASSWORD) {
      const token = jwt.sign({ email: emailLower, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
      return res.json({ token, role: 'admin', name: 'Administrator', email: emailLower });
    }

    // Check user in DB
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

// ─── Admin: Upload users CSV ───
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
          if (email && password) {
            users.push({ email, password: hashPass(password), name, role: 'user', active: true });
          }
        })
        .on('end', resolve)
        .on('error', reject);
    });

    if (users.length === 0) return res.status(400).json({ error: 'No valid users found. CSV must have Email and Password columns.' });

    // Upsert: update if email exists, insert if new
    let created = 0, updated = 0;
    for (const u of users) {
      const result = await User.updateOne(
        { email: u.email },
        { $set: u },
        { upsert: true }
      );
      if (result.upsertedCount > 0) created++;
      else updated++;
    }

    res.json({ success: true, created, updated, total: users.length });
  } catch (err) {
    console.error('User upload error:', err);
    res.status(500).json({ error: 'User upload failed: ' + err.message });
  }
});

// ─── Admin: List all users ───
app.get('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const users = await User.find({}, { password: 0 }).sort({ createdAt: -1 }).lean();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: Delete a user ───
app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: Toggle user active/inactive ───
app.patch('/api/users/:id/toggle', auth, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.active = !user.active;
    await user.save();
    res.json({ success: true, active: user.active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MongoDB Connection ───

// ─── Student Schema ───
const studentSchema = new mongoose.Schema({
  sno: String,
  courseType: String,
  courseName: String,
  studentId: String,
  name: String,
  fatherName: String,
  email: String,
  mobile: String,
  gender: String,
  dob: String,
  motherName: String,
  category: String,
  intake: String,
  applicationStatus: String,
  campus: String,
  enquiredCenter: String,
  registeredCenter: String,
  admittedCenter: String,
  dateOfEnquiry: String,
  dateOfRegistration: String,
  dateOfAdmission: String,
  // Parsed Date objects for fast MongoDB queries
  enquiryDateParsed: Date,
  registrationDateParsed: Date,
  admissionDateParsed: Date,
  state: String,
  address: String,
  district: String,
  pincode: String,
  city: String,
  bloodGroup: String,
  religion: String,
  nationality: String,
  aadhar: String,
  tenthBoard: String,
  tenthSchool: String,
  tenthYear: String,
  tenthMarks: String,
  tenthTotal: String,
  tenthPercent: String,
  twelfthBoard: String,
  twelfthSchool: String,
  twelfthYear: String,
  twelfthMarks: String,
  twelfthTotal: String,
  twelfthPercent: String,
  gradBoard: String,
  gradSchool: String,
  gradYear: String,
  gradMarks: String,
  gradTotal: String,
  gradPercent: String,
  uploadBatch: String,
  rawData: Object
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

const Student = mongoose.model('Student', studentSchema);

 // ─── Helper: parse multiple date formats to Date ───
const MONTH_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
function parseDate(str) {
  if (!str || !str.trim()) return null;
  const d = str.trim().split(' ')[0];

  // Try DD-Mon-YYYY (e.g. 1-Jan-2024)
  const monMatch = d.match(/^(\d{1,2})[-/](\w{3})[-/](\d{2,4})$/);
  if (monMatch) {
    const day = parseInt(monMatch[1], 10);
    const mon = MONTH_MAP[monMatch[2].toLowerCase()];
    let yr = parseInt(monMatch[3], 10);
    if (yr < 100) yr += 2000;
    if (mon !== undefined && !isNaN(day) && !isNaN(yr)) return new Date(Date.UTC(yr, mon, day));
  }

  // Try DD-MM-YYYY or DD/MM/YYYY (e.g. 14/12/2023, 01-01-2024)
  // Also handles MM/DD/YYYY when month > 12 (auto-swap)
  const numMatch = d.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (numMatch) {
    let a = parseInt(numMatch[1], 10);
    let b = parseInt(numMatch[2], 10);
    let yr = parseInt(numMatch[3], 10);
    if (yr < 100) yr += 2000;
    // If second number > 12, it can't be a month → must be MM/DD/YYYY
    let day, mon;
    if (b > 12) {
      // MM/DD/YYYY format (e.g. 2/29/2024)
      mon = a - 1;
      day = b;
    } else if (a > 12) {
      // DD/MM/YYYY format (e.g. 29/02/2024)
      day = a;
      mon = b - 1;
    } else {
      // Ambiguous (both <= 12) — assume DD/MM/YYYY
      day = a;
      mon = b - 1;
    }
    if (!isNaN(day) && !isNaN(mon) && !isNaN(yr)) return new Date(Date.UTC(yr, mon, day));
  }

  // Try YYYY-MM-DD
  const isoMatch = d.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const yr = parseInt(isoMatch[1], 10);
    const mon = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    if (!isNaN(day) && !isNaN(mon) && !isNaN(yr)) return new Date(Date.UTC(yr, mon, day));
  }

  // Fallback: let JS parse it (handles 'Monday, January 1, 2024' etc.)
  const fallback = new Date(str.trim());
  return isNaN(fallback.getTime()) ? null : fallback;
}

// ─── Upload CSV to MongoDB (ADMIN ONLY) ───
app.post('/api/upload', auth, adminOnly, upload_mem.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const batchId = Date.now().toString();
    const records = [];

    await new Promise((resolve, reject) => {
      const stream = Readable.from(req.file.buffer.toString('utf-8'));
      stream.pipe(csvParser())
        .on('data', row => {
          // Helper: get value from row trying multiple possible header names
          const get = (...keys) => {
            for (const k of keys) {
              if (row[k] !== undefined && row[k] !== '') return row[k].toString().trim();
            }
            const rowKeys = Object.keys(row);
            for (const k of keys) {
              const found = rowKeys.find(rk => rk.trim().toLowerCase() === k.trim().toLowerCase());
              if (found && row[found] !== undefined && row[found] !== '') return row[found].toString().trim();
            }
            return '';
          };

          const name = get('Name');
          if (!name) return;

          // Support both CSV formats
          let enquiredCenter = get('Enquired Center');
          let registeredCenter = get('Registered Center');
          let admittedCenter = get('Admitted Center');
          const singleCampus = get('Campus');
          if (!enquiredCenter && singleCampus) enquiredCenter = singleCampus;
          if (!registeredCenter && singleCampus) registeredCenter = singleCampus;
          if (!admittedCenter && singleCampus) admittedCenter = singleCampus;

          const dateOfEnquiry = get('Date of Enquiry', 'Date of Enquiry');
          const dateOfRegistration = get('Date of Registration', 'Date of Registration');
          const dateOfAdmission = get('Date of Admission', 'Date of Admission');

          records.push({
            sno: get('S. No.', 'S.No.', 'SNo', 'Sr No', 'Sr. No.'),
            courseType: get('Course Type', 'CourseType'),
            courseName: get('Course Name', 'Course', 'CourseName'),
            studentId: get('Student ID', 'StudentID', 'Student Id'),
            name,
            fatherName: get('Father name', 'Father Name', 'Father', 'FatherName'),
            email: get('Email ID', 'Email', 'EmailID'),
            mobile: get('Mobile', 'Phone', 'Contact'),
            gender: get('Gender'),
            dob: get('Date of Birth', 'DOB', 'Date of Birth'),
            motherName: get('Mother name', 'Mother Name', 'Mother', 'MotherName'),
            category: get('Category'),
            intake: get('Intake', 'Year'),
            applicationStatus: get('Application Status', 'ApplicationStatus', 'Status'),
            campus: singleCampus,
            enquiredCenter,
            registeredCenter,
            admittedCenter,
            dateOfEnquiry,
            dateOfRegistration,
            dateOfAdmission,
            enquiryDateParsed: parseDate(dateOfEnquiry),
            registrationDateParsed: parseDate(dateOfRegistration),
            admissionDateParsed: parseDate(dateOfAdmission),
            state: get('Permamnent State', 'Permanent State', 'State'),
            address: get('Permanent Address', 'Address'),
            district: get('Permamnent District', 'Permanent District', 'District'),
            pincode: get('Permamnent PinCode', 'Permanent PinCode', 'Pincode', 'Pin Code'),
            city: get('Permamnent City', 'Permanent City', 'City'),
            bloodGroup: get('Blood Group', 'BloodGroup'),
            religion: get('Religion'),
            nationality: get('Nationality'),
            aadhar: get('Aadhar No', 'Aadhar', 'Aadhaar No', 'Aadhaar'),
            tenthBoard: get('10th Board'),
            tenthSchool: get('10th SchooCollege Name', '10th School/College Name'),
            tenthYear: get('10th Year'),
            tenthMarks: get('10th Obtain Mark', '10th Obtained Marks'),
            tenthTotal: get('10th Total Mark', '10th Total Marks'),
            tenthPercent: get('10th Marks %', '10th Percentage'),
            twelfthBoard: get('12th / Diploma Board', '12th Board'),
            twelfthSchool: get('12th / Diploma School/College Name', '12th School/College Name'),
            twelfthYear: get('12th / Diploma Year', '12th Year'),
            twelfthMarks: get('12th / Diploma Obtain Mark', '12th Obtained Marks'),
            twelfthTotal: get('12th / Diploma Total Mark', '12th Total Marks'),
            twelfthPercent: get('12th / Diploma Marks %', '12th Percentage'),
            gradBoard: get('Graduation Board'),
            gradSchool: get('Graduation School/College Name'),
            gradYear: get('Graduation Year'),
            gradMarks: get('Graduation Obtain Mark', 'Graduation Obtained Marks'),
            gradTotal: get('Graduation Total Mark', 'Graduation Total Marks'),
            gradPercent: get('Graduation Marks %', 'Graduation Percentage'),
            uploadBatch: batchId,
            rawData: row
          });
        })
        .on('end', resolve)
        .on('error', reject);
    });

    if (records.length === 0) return res.status(400).json({ error: 'No valid student records found in CSV' });

    await Student.insertMany(records, { ordered: false });
    res.json({ success: true, count: records.length, batchId });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// ─── Projection for list queries (exclude heavy fields) ───
const listProjection = {
  studentId: 1, name: 1, courseName: 1, courseType: 1,
  applicationStatus: 1, gender: 1, mobile: 1, email: 1,
  state: 1, category: 1, campus: 1,
  enquiredCenter: 1, registeredCenter: 1, admittedCenter: 1,
  dateOfEnquiry: 1, dateOfRegistration: 1, dateOfAdmission: 1
};

// ─── Helper: parse YYYY-MM-DD string to UTC midnight ───
function toLocalDate(str) {
  const parts = str.split('-');
  if (parts.length === 3) {
    return new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
  }
  return new Date(str + 'T00:00:00Z');
}

// ─── Helper: build date filter and optional extra filters ───
function buildDateFilter(dateField, start, end, extra) {
  const q = { [dateField]: { $gte: start, $lte: end } };
  if (extra.campus) {
    q.$or = [
      { enquiredCenter: extra.campus },
      { registeredCenter: extra.campus },
      { admittedCenter: extra.campus },
      { campus: extra.campus }
    ];
  }
  if (extra.course) q.courseName = extra.course;
  if (extra.year) {
    // year filter: match on the raw date string containing that 4-digit year
    const dateStrField = dateField === 'enquiryDateParsed' ? 'dateOfEnquiry'
      : dateField === 'registrationDateParsed' ? 'dateOfRegistration' : 'dateOfAdmission';
    q[dateStrField] = { $regex: extra.year };
  }
  if (extra.search) {
    const re = { $regex: extra.search, $options: 'i' };
    q.$and = q.$and || [];
    q.$and.push({
      $or: [
        { name: re }, { courseName: re }, { studentId: re },
        { applicationStatus: re }, { email: re }, { mobile: re },
        { state: re }, { category: re }, { campus: re },
        { courseType: re }, { enquiredCenter: re }, { registeredCenter: re }, { admittedCenter: re }
      ]
    });
  }
  return q;
}

const mapDoc = (s, campusField, dateStrField) => ({
  _id: s._id,
  sid: s.studentId,
  name: s.name,
  course: s.courseName,
  courseType: s.courseType,
  status: s.applicationStatus,
  gender: s.gender,
  mobile: s.mobile,
  email: s.email,
  state: s.state,
  category: s.category,
  campus: s[campusField] || s.campus || '',
  dateStr: s[dateStrField] || ''
});

// ─── Summary: counts + dropdowns only (fast) ───
app.get('/api/students', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required' });

    const start = toLocalDate(startDate);
    const end = toLocalDate(endDate);
    end.setHours(23, 59, 59, 999);
    const dateRange = { $gte: start, $lte: end };

    const [enqCount, regCount, admCount, campusList, courseList, yearList] = await Promise.all([
      Student.countDocuments({ enquiryDateParsed: dateRange }),
      Student.countDocuments({ registrationDateParsed: dateRange }),
      Student.countDocuments({ admissionDateParsed: dateRange }),
      Student.distinct('enquiredCenter').then(a =>
        Student.distinct('registeredCenter').then(b =>
          Student.distinct('admittedCenter').then(c =>
            Student.distinct('campus').then(d =>
              [...new Set([...a, ...b, ...c, ...d])].filter(Boolean).sort()
            )
          )
        )
      ),
      Student.distinct('courseName').then(arr => arr.filter(Boolean).sort()),
      // Extract distinct years from date strings
      Student.aggregate([
        { $match: { enquiryDateParsed: dateRange } },
        { $project: { y: { $year: '$enquiryDateParsed' } } },
        { $group: { _id: '$y' } },
        { $sort: { _id: 1 } }
      ]).then(async enqYears => {
        const regYears = await Student.aggregate([
          { $match: { registrationDateParsed: dateRange } },
          { $project: { y: { $year: '$registrationDateParsed' } } },
          { $group: { _id: '$y' } }
        ]);
        const admYears = await Student.aggregate([
          { $match: { admissionDateParsed: dateRange } },
          { $project: { y: { $year: '$admissionDateParsed' } } },
          { $group: { _id: '$y' } }
        ]);
        return [...new Set([...enqYears, ...regYears, ...admYears].map(r => r._id))].filter(Boolean).sort().map(String);
      })
    ]);

    res.json({
      enquiryCount: enqCount,
      registrationCount: regCount,
      admissionCount: admCount,
      campuses: campusList,
      courses: courseList,
      years: yearList
    });
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Paginated students for a specific tab ───
app.get('/api/students/page', auth, async (req, res) => {
  try {
    const { startDate, endDate, tab, page = 1, limit = 30, campus, course, year, search } = req.query;
    if (!startDate || !endDate || !tab) return res.status(400).json({ error: 'startDate, endDate, tab required' });

    const start = toLocalDate(startDate);
    const end = toLocalDate(endDate);
    end.setHours(23, 59, 59, 999);

    const pg = Math.max(1, parseInt(page));
    const lim = Math.min(100, Math.max(1, parseInt(limit) || 30));
    const skip = (pg - 1) * lim;
    const extra = { campus, course, year, search };

    if (tab === 'all') {
      // For "all" tab: query all 3 types, merge, sort, paginate in-memory
      const [enqDocs, regDocs, admDocs] = await Promise.all([
        Student.find(buildDateFilter('enquiryDateParsed', start, end, extra), listProjection).lean(),
        Student.find(buildDateFilter('registrationDateParsed', start, end, extra), listProjection).lean(),
        Student.find(buildDateFilter('admissionDateParsed', start, end, extra), listProjection).lean()
      ]);
      const all = [
        ...enqDocs.map(s => ({ ...mapDoc(s, 'enquiredCenter', 'dateOfEnquiry'), dateType: 'Enquiry' })),
        ...regDocs.map(s => ({ ...mapDoc(s, 'registeredCenter', 'dateOfRegistration'), dateType: 'Registration' })),
        ...admDocs.map(s => ({ ...mapDoc(s, 'admittedCenter', 'dateOfAdmission'), dateType: 'Admission' }))
      ];
      const total = all.length;
      const pageData = all.slice(skip, skip + lim);
      return res.json({ students: pageData, total, page: pg, totalPages: Math.ceil(total / lim) });
    }

    // Single tab
    let dateField, campusField, dateStrField;
    if (tab === 'enquiry') { dateField = 'enquiryDateParsed'; campusField = 'enquiredCenter'; dateStrField = 'dateOfEnquiry'; }
    else if (tab === 'registration') { dateField = 'registrationDateParsed'; campusField = 'registeredCenter'; dateStrField = 'dateOfRegistration'; }
    else { dateField = 'admissionDateParsed'; campusField = 'admittedCenter'; dateStrField = 'dateOfAdmission'; }

    const filter = buildDateFilter(dateField, start, end, extra);
    const [docs, total] = await Promise.all([
      Student.find(filter, listProjection).skip(skip).limit(lim).lean(),
      Student.countDocuments(filter)
    ]);

    const students = docs.map(s => mapDoc(s, campusField, dateStrField));
    res.json({ students, total, page: pg, totalPages: Math.ceil(total / lim) });
  } catch (err) {
    console.error('Pagination error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Export all filtered students (for Excel download) ───
app.get('/api/students/export', auth, async (req, res) => {
  try {
    const { startDate, endDate, tab, campus, course, year, search } = req.query;
    if (!startDate || !endDate || !tab) return res.status(400).json({ error: 'startDate, endDate, tab required' });

    const start = toLocalDate(startDate);
    const end = toLocalDate(endDate);
    end.setHours(23, 59, 59, 999);
    const extra = { campus, course, year, search };

    if (tab === 'all' || tab === 'allSheets') {
      const [enqDocs, regDocs, admDocs] = await Promise.all([
        Student.find(buildDateFilter('enquiryDateParsed', start, end, extra), listProjection).lean(),
        Student.find(buildDateFilter('registrationDateParsed', start, end, extra), listProjection).lean(),
        Student.find(buildDateFilter('admissionDateParsed', start, end, extra), listProjection).lean()
      ]);
      const enquiries = enqDocs.map(s => mapDoc(s, 'enquiredCenter', 'dateOfEnquiry'));
      const registrations = regDocs.map(s => mapDoc(s, 'registeredCenter', 'dateOfRegistration'));
      const admissions = admDocs.map(s => mapDoc(s, 'admittedCenter', 'dateOfAdmission'));
      return res.json({ enquiries, registrations, admissions });
    }

    let dateField, campusField, dateStrField;
    if (tab === 'enquiry') { dateField = 'enquiryDateParsed'; campusField = 'enquiredCenter'; dateStrField = 'dateOfEnquiry'; }
    else if (tab === 'registration') { dateField = 'registrationDateParsed'; campusField = 'registeredCenter'; dateStrField = 'dateOfRegistration'; }
    else { dateField = 'admissionDateParsed'; campusField = 'admittedCenter'; dateStrField = 'dateOfAdmission'; }

    const docs = await Student.find(buildDateFilter(dateField, start, end, extra), listProjection).lean();
    const students = docs.map(s => mapDoc(s, campusField, dateStrField));
    res.json({ students });
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Get single student detail (for popup) ───
app.get('/api/student/:id', auth, async (req, res) => {
  try {
    const s = await Student.findById(req.params.id).lean();
    if (!s) return res.status(404).json({ error: 'Student not found' });
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get all upload batches ───
app.get('/api/batches', auth, adminOnly, async (req, res) => {
  try {
    const batches = await Student.aggregate([
      { $group: { _id: '$uploadBatch', count: { $sum: 1 }, firstUpload: { $min: '$createdAt' } } },
      { $sort: { firstUpload: -1 } }
    ]);
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete a batch ───
app.delete('/api/batch/:batchId', auth, adminOnly, async (req, res) => {
  try {
    const result = await Student.deleteMany({ uploadBatch: req.params.batchId });
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get total student count ───
app.get('/api/count', auth, async (req, res) => {
  try {
    const count = await Student.countDocuments();
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Migrate: backfill parsed dates for old records ───
app.post('/api/migrate-dates', auth, adminOnly, async (req, res) => {
  try {
    // Re-parse ALL records (force=true) to fix timezone issues
    const students = await Student.find({}, { dateOfEnquiry: 1, dateOfRegistration: 1, dateOfAdmission: 1 }).lean();
    let updated = 0;
    for (const s of students) {
      await Student.updateOne({ _id: s._id }, {
        $set: {
          enquiryDateParsed: parseDate(s.dateOfEnquiry),
          registrationDateParsed: parseDate(s.dateOfRegistration),
          admissionDateParsed: parseDate(s.dateOfAdmission)
        }
      });
      updated++;
    }
    res.json({ migrated: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve frontend ───
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
