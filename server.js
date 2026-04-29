const dotenv = require('dotenv');
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const csvParser = require('csv-parser');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer'); // npm install nodemailer
const XLSX = require('xlsx'); // npm install xlsx

dotenv.config();
dotenv.config({ path: path.join(__dirname, 'photography', '.env'), override: false });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const photographyPublicDir = path.join(__dirname, 'photography', 'public');
const photographyUploadsDir = path.join(__dirname, 'photography', 'uploads');
const photographyTempDir = path.join(photographyUploadsDir, '.tmp');
const photographyEnvPath = path.join(__dirname, 'photography', '.env');
const photographyEnv = fs.existsSync(photographyEnvPath)
  ? dotenv.parse(fs.readFileSync(photographyEnvPath))
  : {};
fs.mkdirSync(photographyUploadsDir, { recursive: true });
fs.mkdirSync(photographyTempDir, { recursive: true });
app.use('/photography', express.static(photographyPublicDir));

const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadBucketCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} =
  require(path.join(__dirname, 'photography', 'node_modules', '@aws-sdk', 'client-s3'));
const { getSignedUrl } =
  require(path.join(__dirname, 'photography', 'node_modules', '@aws-sdk', 's3-request-presigner'));

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@geu.ac.in';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@123';
const AWS_REGION = photographyEnv.PHOTOGRAPHY_AWS_REGION || photographyEnv.AWS_REGION || process.env.PHOTOGRAPHY_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
const S3_BUCKET_NAME = photographyEnv.PHOTOGRAPHY_S3_BUCKET_NAME || photographyEnv.S3_BUCKET_NAME || process.env.PHOTOGRAPHY_S3_BUCKET_NAME || process.env.S3_BUCKET_NAME || '';
const photographyCredentials =
  (photographyEnv.PHOTOGRAPHY_AWS_ACCESS_KEY_ID && photographyEnv.PHOTOGRAPHY_AWS_SECRET_ACCESS_KEY)
    ? {
        accessKeyId: photographyEnv.PHOTOGRAPHY_AWS_ACCESS_KEY_ID,
        secretAccessKey: photographyEnv.PHOTOGRAPHY_AWS_SECRET_ACCESS_KEY
      }
    : (photographyEnv.AWS_ACCESS_KEY_ID && photographyEnv.AWS_SECRET_ACCESS_KEY)
      ? {
          accessKeyId: photographyEnv.AWS_ACCESS_KEY_ID,
          secretAccessKey: photographyEnv.AWS_SECRET_ACCESS_KEY
        }
      : (process.env.PHOTOGRAPHY_AWS_ACCESS_KEY_ID && process.env.PHOTOGRAPHY_AWS_SECRET_ACCESS_KEY)
        ? {
            accessKeyId: process.env.PHOTOGRAPHY_AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.PHOTOGRAPHY_AWS_SECRET_ACCESS_KEY
          }
        : (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
          ? {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
            }
          : undefined;

const MERITTO_SECRET = process.env.MERITTO_SECRET ||
  crypto.createHash('sha256').update((process.env.JWT_SECRET || 'default-secret-change-me') + '-meritto').digest('hex').slice(0, 32);

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/admission_dashboard';
mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch(e => { console.error('MongoDB error:', e); process.exit(1); });

// ─── User Schema ───
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  name: { type: String, default: '' },
  role: { type: String, enum: ['user', 'admin', 'photography'], default: 'user' },
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

function dashboardOnly(req, res, next) {
  if (req.user.role === 'photography') {
    return res.status(403).json({ error: 'Photography users can only access the photography folder.' });
  }
  next();
}

function photographyAccessOnly(req, res, next) {
  if (!['admin', 'photography'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Photography access required' });
  }
  next();
}

function parseFileSizeLimitMb(value, fallbackMb) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMb;
}

const upload_mem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const photographyMaxFileSizeMb = parseFileSizeLimitMb(
  photographyEnv.PHOTOGRAPHY_MAX_FILE_SIZE_MB || photographyEnv.MAX_FILE_SIZE_MB || process.env.PHOTOGRAPHY_MAX_FILE_SIZE_MB || process.env.MAX_FILE_SIZE_MB,
  102400
);
const photographyUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, photographyTempDir),
    filename: (_req, file, cb) => {
      const extension = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
    }
  }),
  limits: { fileSize: photographyMaxFileSizeMb * 1024 * 1024 }
});
const photographyS3 = S3_BUCKET_NAME
  ? new S3Client({ region: AWS_REGION, followRegionRedirects: true, ...(photographyCredentials ? { credentials: photographyCredentials } : {}) })
  : null;
const photographyMultipartPartSize = Math.max(
  5 * 1024 * 1024,
  parseFileSizeLimitMb(
    photographyEnv.PHOTOGRAPHY_MULTIPART_PART_SIZE_MB ||
    process.env.PHOTOGRAPHY_MULTIPART_PART_SIZE_MB ||
    '16',
    16
  ) * 1024 * 1024
);
const photographyMultipartSignedUrlExpirySeconds = 60 * 15;

function normalizePhotographyRelativePath(fileOrName, relativePath) {
  const fallbackName =
    typeof fileOrName === 'string'
      ? path.basename(fileOrName)
      : path.basename(fileOrName.originalname);
  const normalized = String(relativePath || fallbackName)
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');

  return normalized || fallbackName;
}

function buildPhotographyObjectKey(file, relativePath) {
  return `library/${normalizePhotographyRelativePath(file, relativePath)}`;
}

function buildPhotographyObjectKeyFromPath(fileName, relativePath) {
  return `library/${normalizePhotographyRelativePath(fileName, relativePath)}`;
}

function formatBytes(value) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** index;
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function derivePhotoKind(fileName, mimeType = '') {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  const ext = path.extname(fileName).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'].includes(ext)) return 'video';
  return 'file';
}

function ensurePhotographyS3Configured(res) {
  if (photographyS3 && S3_BUCKET_NAME) {
    return true;
  }

  res.status(500).json({
    message: 'Photography S3 is not configured.',
    details: 'Set photography/.env with S3_BUCKET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and optionally AWS_REGION.'
  });
  return false;
}

async function listPhotographyObjects() {
  const objects = [];
  let continuationToken;

  do {
    const response = await photographyS3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET_NAME,
      Prefix: 'library/',
      ContinuationToken: continuationToken
    }));

    if (response.Contents) {
      objects.push(...response.Contents.filter((item) => item.Key && !item.Key.endsWith('/')));
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

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
    const token = jwt.sign({ email: user.email, role: user.role || 'user', userId: user._id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, role: user.role || 'user', name: user.name || user.email, email: user.email });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/users/upload', auth, adminOnly, upload_mem.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const requestedRole = req.body.role === 'photography' ? 'photography' : 'user';
    const users = [];
    await new Promise((resolve, reject) => {
      const stream = Readable.from(req.file.buffer.toString('utf-8'));
      stream.pipe(csvParser())
        .on('data', row => {
          const email = (row['Email'] || row['email'] || row['Email ID'] || row['EmailID'] || '').trim().toLowerCase();
          const password = (row['Password'] || row['password'] || '').trim();
          const name = (row['Name'] || row['name'] || '').trim();
          const csvRole = (row['Role'] || row['role'] || '').trim().toLowerCase();
          const role = csvRole === 'photography' ? 'photography' : requestedRole;
          if (email && password) users.push({ email, password: hashPass(password), name, role, active: true });
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

app.get('/api/photography/session', auth, photographyAccessOnly, async (req, res) => {
  try {
    const user = req.user.userId ? await User.findById(req.user.userId, { password: 0 }).lean() : null;
    res.json({
      ok: true,
      role: req.user.role,
      email: req.user.email,
      name: user?.name || req.user.email
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/photography/health', auth, photographyAccessOnly, async (_req, res) => {
  try {
    if (!ensurePhotographyS3Configured(res)) {
      return;
    }

    await photographyS3.send(new HeadBucketCommand({ Bucket: S3_BUCKET_NAME }));
    res.json({ ok: true, bucket: S3_BUCKET_NAME, region: AWS_REGION });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Unable to connect to the configured S3 bucket.', details: err.message });
  }
});

app.get('/api/photography/files', auth, photographyAccessOnly, async (_req, res) => {
  try {
    if (!ensurePhotographyS3Configured(res)) {
      return;
    }

    const objects = await listPhotographyObjects();
    const files = objects
      .sort((a, b) => new Date(b.LastModified || 0) - new Date(a.LastModified || 0))
      .map((item) => {
        const key = item.Key;
        const name = path.basename(key);
        const size = item.Size || 0;
        return {
          key,
          name,
          relativePath: key.replace(/^library\//, ''),
          size,
          sizeLabel: formatBytes(size),
          lastModified: item.LastModified,
          kind: derivePhotoKind(name),
          downloadUrl: `/api/photography/files/download?key=${encodeURIComponent(key)}`
        };
      });

    files.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    res.json({
      files,
      summary: {
        totalFiles: files.length,
        totalBytes,
        totalSizeLabel: formatBytes(totalBytes)
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Unable to load photography files.', details: err.message });
  }
});

app.get('/api/photography/files/download', auth, photographyAccessOnly, async (req, res) => {
  try {
    if (!ensurePhotographyS3Configured(res)) {
      return;
    }

    const key = typeof req.query.key === 'string' ? req.query.key : '';
    if (!key) {
      return res.status(400).json({ message: 'File key is required.' });
    }
    const signedUrl = await getSignedUrl(
      photographyS3,
      new GetObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${path.basename(key)}"`
      }),
      { expiresIn: 60 * 10 }
    );
    res.redirect(signedUrl);
  } catch (err) {
    res.status(404).json({ message: 'File not found.' });
  }
});

app.post('/api/photography/upload', auth, photographyAccessOnly, photographyUpload.array('files'), async (req, res) => {
  const requestedPaths = Array.isArray(req.body.paths)
    ? req.body.paths
    : req.body.paths
      ? [req.body.paths]
      : [];
  const files = req.files ?? [];

  if (!files.length) {
    return res.status(400).json({ message: 'No files were uploaded.' });
  }

  try {
    if (!ensurePhotographyS3Configured(res)) {
      await Promise.all(files.map(async (file) => {
        if (file.path) {
          await fs.promises.unlink(file.path).catch(() => {});
        }
      }));
      return;
    }

    const uploaded = [];

    for (const [index, file] of files.entries()) {
      const key = buildPhotographyObjectKey(file, requestedPaths[index]);
      const fileName = path.basename(key);

      await photographyS3.send(new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key,
        Body: fs.createReadStream(file.path),
        ContentType: file.mimetype || 'application/octet-stream'
      }));

      await fs.promises.unlink(file.path).catch(() => {});

      uploaded.push({
        key,
        name: fileName,
        relativePath: normalizePhotographyRelativePath(file, requestedPaths[index]),
        size: file.size,
        sizeLabel: formatBytes(file.size)
      });
    }

    res.status(201).json({ message: 'Files uploaded successfully.', uploaded });
  } catch (err) {
    console.error('Photography upload failed:', err);
    await Promise.all(files.map(async (file) => {
      if (file.path) {
        await fs.promises.unlink(file.path).catch(() => {});
      }
    }));
    res.status(500).json({ message: 'Upload failed.', details: err.message });
  }
});

app.post('/api/photography/multipart/init', auth, photographyAccessOnly, async (req, res) => {
  try {
    if (!ensurePhotographyS3Configured(res)) {
      return;
    }

    const {
      fileName,
      relativePath,
      contentType,
      size
    } = req.body ?? {};

    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({ message: 'A valid fileName is required.' });
    }

    const key = buildPhotographyObjectKeyFromPath(fileName, relativePath || fileName);
    const multipart = await photographyS3.send(new CreateMultipartUploadCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      ContentType: typeof contentType === 'string' && contentType ? contentType : 'application/octet-stream'
    }));

    return res.status(201).json({
      key,
      uploadId: multipart.UploadId,
      partSize: photographyMultipartPartSize,
      size: Number(size) || 0
    });
  } catch (err) {
    return res.status(500).json({
      message: 'Failed to initialize multipart upload.',
      details: err.message
    });
  }
});

app.post('/api/photography/direct-upload/sign', auth, photographyAccessOnly, async (req, res) => {
  try {
    if (!ensurePhotographyS3Configured(res)) {
      return;
    }

    const { fileName, relativePath, contentType } = req.body ?? {};

    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({ message: 'A valid fileName is required.' });
    }

    const key = buildPhotographyObjectKeyFromPath(fileName, relativePath || fileName);
    const signedUrl = await getSignedUrl(
      photographyS3,
      new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key,
        ContentType: typeof contentType === 'string' && contentType ? contentType : 'application/octet-stream'
      }),
      { expiresIn: photographyMultipartSignedUrlExpirySeconds }
    );

    return res.json({
      key,
      signedUrl,
      expiresIn: photographyMultipartSignedUrlExpirySeconds
    });
  } catch (err) {
    return res.status(500).json({
      message: 'Failed to sign direct upload.',
      details: err.message
    });
  }
});

app.post('/api/photography/multipart/sign', auth, photographyAccessOnly, async (req, res) => {
  try {
    if (!ensurePhotographyS3Configured(res)) {
      return;
    }

    const { key, uploadId, partNumber } = req.body ?? {};
    const numericPartNumber = Number(partNumber);

    if (!key || typeof key !== 'string' || !uploadId || typeof uploadId !== 'string' || !Number.isInteger(numericPartNumber) || numericPartNumber < 1) {
      return res.status(400).json({ message: 'key, uploadId, and a valid partNumber are required.' });
    }

    const signedUrl = await getSignedUrl(
      photographyS3,
      new UploadPartCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key,
        UploadId: uploadId,
        PartNumber: numericPartNumber
      }),
      { expiresIn: photographyMultipartSignedUrlExpirySeconds }
    );

    return res.json({
      signedUrl,
      expiresIn: photographyMultipartSignedUrlExpirySeconds
    });
  } catch (err) {
    return res.status(500).json({
      message: 'Failed to sign multipart upload part.',
      details: err.message
    });
  }
});

app.post('/api/photography/multipart/complete', auth, photographyAccessOnly, async (req, res) => {
  try {
    if (!ensurePhotographyS3Configured(res)) {
      return;
    }

    const { key, uploadId, parts } = req.body ?? {};
    if (!key || typeof key !== 'string' || !uploadId || typeof uploadId !== 'string' || !Array.isArray(parts) || !parts.length) {
      return res.status(400).json({ message: 'key, uploadId, and parts are required.' });
    }

    const normalizedParts = parts
      .map((part) => ({
        ETag: part?.ETag,
        PartNumber: Number(part?.PartNumber)
      }))
      .filter((part) => part.ETag && Number.isInteger(part.PartNumber) && part.PartNumber > 0)
      .sort((a, b) => a.PartNumber - b.PartNumber);

    if (!normalizedParts.length) {
      return res.status(400).json({ message: 'No valid multipart parts were provided.' });
    }

    await photographyS3.send(new CompleteMultipartUploadCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: normalizedParts
      }
    }));

    return res.json({
      message: 'Multipart upload completed successfully.',
      key
    });
  } catch (err) {
    return res.status(500).json({
      message: 'Failed to complete multipart upload.',
      details: err.message
    });
  }
});

app.post('/api/photography/multipart/abort', auth, photographyAccessOnly, async (req, res) => {
  try {
    if (!ensurePhotographyS3Configured(res)) {
      return;
    }

    const { key, uploadId } = req.body ?? {};
    if (!key || typeof key !== 'string' || !uploadId || typeof uploadId !== 'string') {
      return res.status(400).json({ message: 'key and uploadId are required.' });
    }

    await photographyS3.send(new AbortMultipartUploadCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      UploadId: uploadId
    }));

    return res.json({
      message: 'Multipart upload aborted.'
    });
  } catch (err) {
    return res.status(500).json({
      message: 'Failed to abort multipart upload.',
      details: err.message
    });
  }
});

app.delete('/api/photography/files', auth, photographyAccessOnly, async (req, res) => {
  const { key } = req.body ?? {};
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ message: 'A valid file key is required.' });
  }

  try {
    if (!ensurePhotographyS3Configured(res)) {
      return;
    }

    await photographyS3.send(new DeleteObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key
    }));
    res.json({ message: 'File deleted successfully.' });
  } catch (err) {
    res.status(500).json({ message: 'Delete failed.', details: err.message });
  }
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
// ─── SMTP EMAIL CAMPAIGN FEATURE ────────────────────
// ════════════════════════════════════════════════════

// ─── Email Campaign Schema ───
const emailCampaignSchema = new mongoose.Schema({
  name: { type: String, required: true },
  subject: { type: String, default: '' },
  htmlContent: { type: String, required: true },
  totalRecipients: { type: Number, default: 0 },
  sentCount: { type: Number, default: 0 },
  deliveredCount: { type: Number, default: 0 },
  openedCount: { type: Number, default: 0 },
  clickedCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  status: { type: String, enum: ['draft', 'sending', 'sent', 'failed'], default: 'draft' },
  recipients: [{
    email: { type: String, required: true },
    status: { type: String, enum: ['pending', 'sent', 'failed', 'delivered', 'opened', 'clicked'], default: 'pending' },
    sentAt: Date,
    deliveredAt: Date,
    openedAt: Date,
    clickedAt: Date,
    error: String,
    opens: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 }
  }],
  trackingId: { type: String, unique: true, sparse: true },
  createdBy: { type: String },
  createdAt: { type: Date, default: Date.now },
  sentAt: Date
});

emailCampaignSchema.index({ trackingId: 1 });
emailCampaignSchema.index({ 'recipients.email': 1 });
const EmailCampaign = mongoose.model('EmailCampaign', emailCampaignSchema);

// ─── SMTP Transporter (uses OUTLOOK_EMAIL1 and OUTLOOK_PASSWORD1) ───
function createSMTPTransporter() {
  const email = process.env.OUTLOOK_EMAIL1 || process.env.OUTLOOK_EMAIL;
  const password = process.env.OUTLOOK_PASSWORD1 || process.env.OUTLOOK_PASSWORD;
  
  if (!email || !password) {
    throw new Error('SMTP credentials not found. Set OUTLOOK_EMAIL1 and OUTLOOK_PASSWORD1 in .env');
  }

  return nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: { user: email, pass: password },
    tls: { ciphers: 'SSLv3', rejectUnauthorized: false }
  });
}

// ─── POST /api/smtp/upload - Upload CSV/XLSX with emails ───
app.post('/api/smtp/upload', auth, adminOnly, upload_mem.single('emailFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    let emails = [];
    const fileExt = req.file.originalname.split('.').pop().toLowerCase();

    if (fileExt === 'csv') {
      // Parse CSV
      await new Promise((resolve, reject) => {
        const stream = Readable.from(req.file.buffer.toString('utf-8'));
        stream.pipe(csvParser())
          .on('data', row => {
            // Look for email column (try multiple possible headers)
            const email = (row['Email'] || row['email'] || row['EMAIL'] || row['Mail'] || row['mail'] || 
                          row['Email ID'] || row['email_id'] || row['E-mail'] || row['e-mail'] || '').trim().toLowerCase();
            if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              emails.push(email);
            }
          })
          .on('end', resolve)
          .on('error', reject);
      });
    } else if (fileExt === 'xlsx' || fileExt === 'xls') {
      // Parse Excel
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet);
      
      data.forEach(row => {
        const email = (row['Email'] || row['email'] || row['EMAIL'] || row['Mail'] || row['mail'] || 
                      row['Email ID'] || row['email_id'] || row['E-mail'] || row['e-mail'] || '').toString().trim().toLowerCase();
        if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          emails.push(email);
        }
      });
    } else {
      return res.status(400).json({ error: 'Unsupported file format. Please upload CSV or XLSX.' });
    }

    // Remove duplicates
    emails = [...new Set(emails)];

    if (emails.length === 0) {
      return res.status(400).json({ error: 'No valid email addresses found in file. Ensure there is an "Email" column.' });
    }

    res.json({ success: true, emails, count: emails.length });
  } catch (err) {
    console.error('Email upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// ─── POST /api/smtp/preview - Preview email HTML ───
app.post('/api/smtp/preview', auth, adminOnly, async (req, res) => {
  try {
    const { htmlContent } = req.body;
    if (!htmlContent) return res.status(400).json({ error: 'HTML content required' });
    
    // Return the HTML with tracking pixel removed for preview
    let previewHtml = htmlContent;
    
    res.json({ success: true, html: previewHtml });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/smtp/send - Send email campaign ───
app.post('/api/smtp/send', auth, adminOnly, async (req, res) => {
  try {
    const { emails, subject, htmlContent, campaignName } = req.body;
    
    if (!emails || !emails.length) return res.status(400).json({ error: 'No email recipients provided' });
    if (!htmlContent) return res.status(400).json({ error: 'HTML content required' });
    if (!subject) return res.status(400).json({ error: 'Email subject required' });

    // Create campaign
    const trackingId = crypto.randomBytes(16).toString('hex');
    const campaign = await EmailCampaign.create({
      name: campaignName || 'Campaign ' + new Date().toISOString(),
      subject,
      htmlContent,
      totalRecipients: emails.length,
      recipients: emails.map(email => ({ email, status: 'pending' })),
      trackingId,
      createdBy: req.user.email,
      status: 'sending'
    });

    // Send emails in background (don't wait)
    sendCampaignEmails(campaign._id, trackingId).catch(err => {
      console.error('Campaign send error:', err);
    });

    res.json({ 
      success: true, 
      campaignId: campaign._id,
      message: 'Campaign started. Emails are being sent in background.',
      totalRecipients: emails.length
    });
  } catch (err) {
    console.error('Send campaign error:', err);
    res.status(500).json({ error: 'Failed to start campaign: ' + err.message });
  }
});

// ─── Background function to send emails ───
async function sendCampaignEmails(campaignId, trackingId) {
  try {
    const campaign = await EmailCampaign.findById(campaignId);
    if (!campaign) return;

    const transporter = createSMTPTransporter();
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    
    let sent = 0, failed = 0;

    for (let i = 0; i < campaign.recipients.length; i++) {
      const recipient = campaign.recipients[i];
      
      try {
        // Add tracking pixel and link tracking
        const recipientId = recipient._id.toString();
        const trackingPixel = `<img src="${baseUrl}/api/smtp/track/open/${trackingId}/${recipientId}" width="1" height="1" style="display:none;" alt="" />`;
        
        // Add tracking to links
        let trackedHtml = campaign.htmlContent;
        trackedHtml = trackedHtml.replace(
          /<a\s+([^>]*href=["']([^"']+)["'][^>]*)>/gi,
          (match, attrs, url) => {
            const trackedUrl = `${baseUrl}/api/smtp/track/click/${trackingId}/${recipientId}?url=${encodeURIComponent(url)}`;
            return `<a ${attrs.replace(url, trackedUrl)}>`;
          }
        );
        
        trackedHtml += trackingPixel;

        await transporter.sendMail({
          from: `"GEU Admissions" <${process.env.OUTLOOK_EMAIL1 || process.env.OUTLOOK_EMAIL}>`,
          to: recipient.email,
          subject: campaign.subject,
          html: trackedHtml
        });

        campaign.recipients[i].status = 'sent';
        campaign.recipients[i].sentAt = new Date();
        sent++;
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (err) {
        campaign.recipients[i].status = 'failed';
        campaign.recipients[i].error = err.message;
        failed++;
      }
    }

    campaign.sentCount = sent;
    campaign.failedCount = failed;
    campaign.status = failed === campaign.totalRecipients ? 'failed' : 'sent';
    campaign.sentAt = new Date();
    await campaign.save();

    console.log(`Campaign ${campaignId} completed: ${sent} sent, ${failed} failed`);
  } catch (err) {
    console.error('sendCampaignEmails error:', err);
    await EmailCampaign.findByIdAndUpdate(campaignId, { status: 'failed' });
  }
}

// ─── GET /api/smtp/track/open/:trackingId/:recipientId - Track email opens ───
app.get('/api/smtp/track/open/:trackingId/:recipientId', async (req, res) => {
  try {
    const { trackingId, recipientId } = req.params;
    
    const campaign = await EmailCampaign.findOne({ trackingId });
    if (campaign) {
      const recipient = campaign.recipients.id(recipientId);
      if (recipient) {
        recipient.opens = (recipient.opens || 0) + 1;
        if (!recipient.openedAt) {
          recipient.openedAt = new Date();
          recipient.status = 'opened';
          campaign.openedCount = (campaign.openedCount || 0) + 1;
        }
        await campaign.save();
      }
    }
  } catch (err) {
    console.error('Track open error:', err);
  }
  
  // Return 1x1 transparent pixel
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  });
  res.end(pixel);
});

// ─── GET /api/smtp/track/click/:trackingId/:recipientId - Track link clicks ───
app.get('/api/smtp/track/click/:trackingId/:recipientId', async (req, res) => {
  try {
    const { trackingId, recipientId } = req.params;
    const { url } = req.query;
    
    const campaign = await EmailCampaign.findOne({ trackingId });
    if (campaign) {
      const recipient = campaign.recipients.id(recipientId);
      if (recipient) {
        recipient.clicks = (recipient.clicks || 0) + 1;
        if (!recipient.clickedAt) {
          recipient.clickedAt = new Date();
          recipient.status = 'clicked';
          campaign.clickedCount = (campaign.clickedCount || 0) + 1;
        }
        await campaign.save();
      }
    }
    
    // Redirect to original URL
    res.redirect(url || 'https://geu.ac.in');
  } catch (err) {
    console.error('Track click error:', err);
    res.redirect(req.query.url || 'https://geu.ac.in');
  }
});

// ─── GET /api/smtp/campaigns - List all campaigns ───
app.get('/api/smtp/campaigns', auth, adminOnly, async (req, res) => {
  try {
    const campaigns = await EmailCampaign.find()
      .select('-recipients -htmlContent')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/smtp/campaign/:id - Get campaign details with tracking ───
app.get('/api/smtp/campaign/:id', auth, adminOnly, async (req, res) => {
  try {
    const campaign = await EmailCampaign.findById(req.params.id).lean();
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    
    res.json({ campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/smtp/campaign/:id - Delete campaign ───
app.delete('/api/smtp/campaign/:id', auth, adminOnly, async (req, res) => {
  try {
    await EmailCampaign.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// ─── EMAIL REPORT FEATURE ───────────────────────────
// ════════════════════════════════════════════════════

// ─── Email Settings Schema ───
const emailSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'report_settings', unique: true },
  toEmails: [{ type: String, trim: true, lowercase: true }],
  ccEmails: [{ type: String, trim: true, lowercase: true }],
  mode: { type: String, enum: ['regular', 'online'], default: 'regular' },
  campuses: [{ type: String, trim: true }],
  years: [{ type: Number }],
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
  if (!campusCode) return {};
  return campusFilterQuery(campusCode, ['registeredCenter', 'admittedCenter', 'campus']);
}

// ─── Helper: build report data ───
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

// ─── Helper: build HTML email ───
function buildEmailHTML(years, campuses, results) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
  const primaryYear = years.includes(2026) ? 2026 : years[0];

  const campusLabel = c => ({
    'GEU': 'GEU', 'GEHU': 'GEHU', 'GEHUDDN': 'GEHU-DDN',
    'GEHUHLD': 'GEHU-HLD', 'GEHUBTL': 'GEHU-BTL'
  }[c] || c);

  const showCampuses = campuses;
  const showCombined2026Total = years.includes(2026) && showCampuses.includes('GEHU') && showCampuses.includes('GEU');

  function yearTotal(year, type) {
    return showCampuses.reduce((sum, campus) => sum + (results[year]?.[campus]?.[type] || 0), 0);
  }

  const campusSummary = showCampuses.map(campusLabel).join(' and ');
  const campusBodyBg = campus => (campus === 'GEU' ? '#c6c6c6' : '#c6dbef');
  const topHeaderBg = '#c9ddc8';
  const yearHeaderBg = '#f6dcc8';

  let headerRow1 = `<th style="padding:18px 24px;background:${topHeaderBg};color:#000000;font-size:18px;font-weight:800;border:1px solid #a8a8a8;text-align:left;">Status</th>`;
  showCampuses.forEach((campus, i) => {
    const bg = topHeaderBg;
    headerRow1 += `<th colspan="${years.length}" style="padding:18px 16px;background:${bg};color:#000000;font-size:18px;font-weight:800;text-align:center;border:1px solid #a8a8a8;letter-spacing:0.2px;">${campusLabel(campus)}</th>`;
  });
  if (showCombined2026Total) {
    headerRow1 += `<th colspan="1" style="padding:18px 16px;background:${topHeaderBg};color:#000000;font-size:18px;font-weight:800;text-align:center;border:1px solid #a8a8a8;letter-spacing:0.2px;">Total GEU & GEHU</th>`;
  }

  let headerRow2 = `<th style="padding:14px 16px;background:#f7efc9;color:#000000;font-size:14px;font-weight:700;border:1px solid #a8a8a8;"></th>`;
  showCampuses.forEach(() => {
    years.forEach(y => {
      headerRow2 += `<th style="padding:14px 10px;background:${yearHeaderBg};color:#000000;font-size:14px;font-weight:800;text-align:center;border:1px solid #a8a8a8;">${y}</th>`;
    });
  });
  if (showCombined2026Total) {
    headerRow2 += `<th style="padding:14px 10px;background:${yearHeaderBg};color:#000000;font-size:14px;font-weight:800;text-align:center;border:1px solid #a8a8a8;">2026</th>`;
  }

  const rows = [
    { label: 'Registration', type: 'reg', color: '#d97706', bgColor: '#451a03' },
    { label: 'Admitted', type: 'adm', color: '#10b981', bgColor: '#052e16' }
  ];

  let dataRows = '';
  rows.forEach(row => {
    let tds = `<td style="padding:20px 24px;font-weight:800;font-size:18px;color:#000000;background:#f7efc9;border:1px solid #a8a8a8;">${row.label}</td>`;

    showCampuses.forEach(campus => {
      years.forEach(y => {
        const val = results[y]?.[campus]?.[row.type] || 0;
        tds += `<td style="padding:20px 10px;text-align:center;font-size:18px;font-weight:800;color:#000000;background:${campusBodyBg(campus)};border:1px solid #a8a8a8;">${val > 0 ? val : '-'}</td>`;
      });
    });
    if (showCombined2026Total) {
      const combined2026 = (results[2026]?.GEHU?.[row.type] || 0) + (results[2026]?.GEU?.[row.type] || 0);
      tds += `<td style="padding:20px 10px;text-align:center;font-size:18px;font-weight:800;color:#000000;background:#d8d6f1;border:1px solid #a8a8a8;">${combined2026 > 0 ? combined2026 : '-'}</td>`;
    }

    dataRows += `<tr>${tds}</tr>`;
  });

  let yoyHTML = '';
  const metrics = [
    { label: 'Registration', type: 'reg' },
    { label: 'Admitted', type: 'adm' }
  ];

  function buildCampusYoYBlock(campus) {
    const comparisonYears = years.filter(year => year !== primaryYear);
    return `
    <div style="padding:16px 20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;width:100%;">
      <div style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">${campusLabel(campus)} Comparison</div>
      ${metrics.map(m => {
        const comparisons = comparisonYears.map(compareYear => {
          const primaryValue = results[primaryYear]?.[campus]?.[m.type] || 0;
          const compareValue = results[compareYear]?.[campus]?.[m.type] || 0;
          const diff = primaryValue - compareValue;
          const pct = compareValue > 0 ? `${((diff / compareValue) * 100).toFixed(1)}%` : '—';
          const color = diff > 0 ? '#15803d' : diff < 0 ? '#b91c1c' : '#64748b';
          const sign = diff > 0 ? '+' : '';
          return `<div style="font-size:12px;font-weight:600;color:#334155;margin-top:4px;">${primaryYear} vs ${compareYear}: <span style="color:${color};font-weight:700;">${sign}${diff} (${sign}${pct})</span></div>`;
        });
        return `<div style="font-size:13px;font-weight:700;color:#1e293b;margin-bottom:10px;">${m.label}${comparisons.join('')}</div>`;
      }).join('')}
    </div>`;
  }

  const yoyBlocks = showCampuses.map(buildCampusYoYBlock);

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

  <p style="font-size:14px;color:#1e293b;margin-bottom:16px;font-weight:500;">
    Hon'ble Sir,<br><br>
    Kindly find the admission data for <strong>${campusSummary}</strong>
    at <strong>5:30 pm</strong> till <strong>${dateStr}</strong>.
  </p>

  <div style=";border-radius:12px;padding:20px 24px;margin-bottom:16px;">
    <div style="font-size:20px;font-weight:800;color:black;letter-spacing:-0.5px;">Graphic Era Admissions Report</div>
    <div style="font-size:12px;color:#94a3b8;margin-top:4px;">Period: 1 Jan → ${dateStr} &nbsp;·&nbsp; Years: ${years.join(' vs ')} &nbsp;·&nbsp;/div>
  </div>

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

// ─── GET /api/report-preview ───
app.get('/api/report-preview', auth, dashboardOnly, async (req, res) => {
  try {
    const yearsParam = req.query.years;
    const campusParam = req.query.campuses;
    const mode = req.query.mode;
    if (!yearsParam || !campusParam) return res.status(400).json({ error: 'years and campuses params required' });

    const years = yearsParam.split(',').map(Number).sort((a, b) => b - a);
    const campuses = campusParam.split(',').map(s => s.trim()).filter(Boolean);

    const results = await buildReport(years, campuses, mode);
    const html = buildEmailHTML(years, campuses, results);
    res.json({ html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/send-report ───
app.post('/api/send-report', auth, adminOnly, async (req, res) => {
  try {
    const { years, campuses, mode } = req.body;
    if (!years || !years.length) return res.status(400).json({ error: 'No years selected' });
    if (!campuses || !campuses.length) return res.status(400).json({ error: 'No campuses selected' });

    const settings = await EmailSettings.findOne({ key: 'report_settings' }).lean();
    if (!settings || !settings.toEmails || !settings.toEmails.length)
      return res.status(400).json({ error: 'No recipient emails configured. Please save email settings first.' });

    const hasGmail = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD;
    const hasOutlook = process.env.OUTLOOK_EMAIL && process.env.OUTLOOK_PASSWORD;
    if (!hasGmail && !hasOutlook)
      return res.status(500).json({ error: 'No email credentials found in .env (set GMAIL_USER + GMAIL_APP_PASSWORD or OUTLOOK_EMAIL + OUTLOOK_PASSWORD)' });

    const sortedYears = [...years].map(Number).sort((a, b) => b - a);
    const reportMode = mode ? normalizeMode(mode) : (settings?.mode ? normalizeMode(settings.mode) : 'regular');
    const results = await buildReport(sortedYears, campuses, reportMode);
    const html = buildEmailHTML(sortedYears, campuses, results);

    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
    const subject = `GEU Admissions Report – ${dateStr} (${sortedYears.join(' vs ')})`;

    const fromAddr = process.env.GMAIL_USER || process.env.OUTLOOK_EMAIL;
    const transporter = createTransporter();

    await transporter.sendMail({
      from: `"GEU Admissions Dashboard" <${fromAddr}>`,
      to: settings.toEmails.join(', '),
      cc: (settings.ccEmails || []).length ? settings.ccEmails.join(', ') : undefined,
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

const MONTH_MAP = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
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
  if (val === 'gehubtl' || /gehu.*bhimtal/.test(val)) return 'GEHUBTL';
  if (/^gehu$/.test(val)) return 'GEHU';
  return raw.trim();
}

function campusFieldCondition(field, rawCampus) {
  const campusCode = normalizeCampus(rawCampus);
  if (!campusCode) return null;
  if (campusCode === 'GEHU') return { [field]: { $regex: /^GEHU/i } };

  const aliasPatterns = {
    GEU: /^(GEU|GEU[\s-]*DEHRADUN)$/i,
    GEHUDDN: /^(GEHUDDN|GEHU[\s-]*DEHRADUN)$/i,
    GEHUHLD: /^(GEHUHLD|GEHU[\s-]*HALDWANI)$/i,
    GEHUBTL: /^(GEHUBTL|GEHU[\s-]*BHIMTAL)$/i
  };

  return { [field]: aliasPatterns[campusCode] || new RegExp(`^${campusCode}$`, 'i') };
}

function campusFilterQuery(rawCampus, fields = ['enquiredCenter', 'registeredCenter', 'admittedCenter', 'campus']) {
  const conditions = fields.map(field => campusFieldCondition(field, rawCampus)).filter(Boolean);
  return conditions.length ? { $or: conditions } : {};
}

function displayCampus(code) {
  if (!code) return '';
  const normalized = normalizeCampus(code);
  const map = { 'GEU': 'GEU', 'GEHUDDN': 'GEHU - DEHRADUN', 'GEHUHLD': 'GEHU - HALDWANI', 'GEHUBTL': 'GEHU - BHIMTAL', 'GEHU': 'GEHU' };
  return map[normalized] || code;
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
          const normalizedCampus = normalizeCampus(singleCampus);
          const normalizedEnquiredCenter = normalizeCampus(enquiredCenter);
          const normalizedRegisteredCenter = normalizeCampus(registeredCenter);
          const normalizedAdmittedCenter = normalizeCampus(admittedCenter);

          const dateOfEnquiry = get('Date of Enquiry'), dateOfRegistration = get('Date of Registration'), dateOfAdmission = get('Date of Admission');

          records.push({
            sno: get('S. No.', 'S.No.', 'SNo', 'Sr No', 'Sr. No.'),
            courseType: get('Course Type', 'CourseType'),
            courseName: get('Course Name', 'Course', 'CourseName'),
            studentId: get('Student ID', 'StudentID', 'Student Id'),
            name, fatherName: get('Father name', 'Father Name', 'Father', 'FatherName'),
            email: get('Email ID', 'Email', 'EmailID'), mobile: get('Mobile', 'Phone', 'Contact'),
            gender: get('Gender'), dob: get('Date of Birth', 'DOB'),
            motherName: get('Mother name', 'Mother Name', 'Mother', 'MotherName'),
            category: get('Category'), intake: get('Intake', 'Year'),
            applicationStatus: get('Application Status', 'ApplicationStatus', 'Status'),
            campus: normalizedCampus || singleCampus,
            enquiredCenter: normalizedEnquiredCenter || enquiredCenter,
            registeredCenter: normalizedRegisteredCenter || registeredCenter,
            admittedCenter: normalizedAdmittedCenter || admittedCenter,
            dateOfEnquiry, dateOfRegistration, dateOfAdmission,
            enquiryDateParsed: parseDate(dateOfEnquiry),
            registrationDateParsed: parseDate(dateOfRegistration),
            admissionDateParsed: parseDate(dateOfAdmission),
            state: get('Permamnent State', 'Permanent State', 'State'),
            address: get('Permanent Address', 'Address'),
            district: get('Permamnent District', 'Permanent District', 'District'),
            pincode: get('Permamnent PinCode', 'Permanent PinCode', 'Pincode', 'Pin Code'),
            city: get('Permamnent City', 'Permanent City', 'City'),
            bloodGroup: get('Blood Group', 'BloodGroup'), religion: get('Religion'),
            nationality: get('Nationality'), aadhar: get('Aadhar No', 'Aadhar', 'Aadhaar No', 'Aadhaar'),
            tenthBoard: get('10th Board'), tenthSchool: get('10th SchooCollege Name', '10th School/College Name'),
            tenthYear: get('10th Year'), tenthMarks: get('10th Obtain Mark', '10th Obtained Marks'),
            tenthTotal: get('10th Total Mark', '10th Total Marks'), tenthPercent: get('10th Marks %', '10th Percentage'),
            twelfthBoard: get('12th / Diploma Board', '12th Board'),
            twelfthSchool: get('12th / Diploma School/College Name', '12th School/College Name'),
            twelfthYear: get('12th / Diploma Year', '12th Year'),
            twelfthMarks: get('12th / Diploma Obtain Mark', '12th Obtained Marks'),
            twelfthTotal: get('12th / Diploma Total Mark', '12th Total Marks'),
            twelfthPercent: get('12th / Diploma Marks %', '12th Percentage'),
            gradBoard: get('Graduation Board'), gradSchool: get('Graduation School/College Name'),
            gradYear: get('Graduation Year'), gradMarks: get('Graduation Obtain Mark', 'Graduation Obtained Marks'),
            gradTotal: get('Graduation Total Mark', 'Graduation Total Marks'),
            gradPercent: get('Graduation Marks %', 'Graduation Percentage'),
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
  studentId: 1, name: 1, courseName: 1, courseType: 1, applicationStatus: 1, gender: 1, mobile: 1,
  email: 1, state: 1, category: 1, campus: 1, enquiredCenter: 1, registeredCenter: 1, admittedCenter: 1,
  dateOfEnquiry: 1, dateOfRegistration: 1, dateOfAdmission: 1
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
  if (m === 'online') return { courseName: { $regex: /online/i } };
  return { $or: [{ courseName: { $not: /online/i } }, { courseName: { $exists: false } }, { courseName: null }, { courseName: '' }] };
}

function buildDateFilter(dateField, start, end, extra) {
  const q = { [dateField]: { $gte: start, $lte: end } };
  if (extra.campus) {
    Object.assign(q, campusFilterQuery(extra.campus));
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
    q.$and.push({ $or: [{ name: re }, { courseName: re }, { studentId: re }, { applicationStatus: re }, { email: re }, { mobile: re }, { state: re }, { category: re }, { campus: re }, { courseType: re }, { enquiredCenter: re }, { registeredCenter: re }, { admittedCenter: re }] });
  }
  return q;
}

const mapDoc = (s, campusField, dateStrField) => ({
  _id: s._id, sid: s.studentId, name: s.name, course: s.courseName, courseType: s.courseType,
  status: s.applicationStatus, gender: s.gender, mobile: s.mobile, email: s.email,
  state: s.state, category: s.category, campus: displayCampus(s[campusField] || s.campus || ''),
  dateStr: s[dateStrField] || ''
});

app.get('/api/students', auth, dashboardOnly, async (req, res) => {
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
        const allRaw = [...a, ...b, ...c, ...d].filter(Boolean);
        const codes = [...new Set(allRaw.map(normalizeCampus))].filter(Boolean);
        return codes.map(displayCampus).sort();
      })))),
      Student.distinct('courseName', modeQ).then(arr => arr.filter(Boolean).sort()),
      Student.aggregate([{ $match: { enquiryDateParsed: dateRange, ...modeQ } }, { $project: { y: { $year: '$enquiryDateParsed' } } }, { $group: { _id: '$y' } }, { $sort: { _id: 1 } }]).then(async enqYears => {
        const regYears = await Student.aggregate([{ $match: { registrationDateParsed: dateRange, ...modeQ } }, { $project: { y: { $year: '$registrationDateParsed' } } }, { $group: { _id: '$y' } }]);
        const admYears = await Student.aggregate([{ $match: { admissionDateParsed: dateRange, ...modeQ } }, { $project: { y: { $year: '$admissionDateParsed' } } }, { $group: { _id: '$y' } }]);
        return [...new Set([...enqYears, ...regYears, ...admYears].map(r => r._id))].filter(Boolean).sort().map(String);
      })
    ]);

    res.json({ enquiryCount: enqCount, registrationCount: regCount, admissionCount: admCount, campuses: campusList, courses: courseList, years: yearList });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/students/page', auth, dashboardOnly, async (req, res) => {
  try {
    const { startDate, endDate, tab, page = 1, limit = 30, campus, course, year, search, mode } = req.query;
    if (!startDate || !endDate || !tab) return res.status(400).json({ error: 'startDate, endDate, tab required' });

    const start = toLocalDate(startDate), end = toLocalDate(endDate);
    end.setHours(23, 59, 59, 999);
    const pg = Math.max(1, parseInt(page)), lim = Math.min(100, Math.max(1, parseInt(limit) || 30)), skip = (pg - 1) * lim;
    const extra = { campus, course, year, search, mode };

    if (tab === 'all') {
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
      return res.json({ students: all.slice(skip, skip + lim), total: all.length, page: pg, totalPages: Math.ceil(all.length / lim) });
    }

    let dateField, campusField, dateStrField;
    if (tab === 'enquiry') { dateField = 'enquiryDateParsed'; campusField = 'enquiredCenter'; dateStrField = 'dateOfEnquiry'; }
    else if (tab === 'registration') { dateField = 'registrationDateParsed'; campusField = 'registeredCenter'; dateStrField = 'dateOfRegistration'; }
    else { dateField = 'admissionDateParsed'; campusField = 'admittedCenter'; dateStrField = 'dateOfAdmission'; }

    const filter = buildDateFilter(dateField, start, end, extra);
    const [docs, total] = await Promise.all([Student.find(filter, listProjection).skip(skip).limit(lim).lean(), Student.countDocuments(filter)]);
    res.json({ students: docs.map(s => mapDoc(s, campusField, dateStrField)), total, page: pg, totalPages: Math.ceil(total / lim) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/students/export', auth, dashboardOnly, async (req, res) => {
  try {
    const { startDate, endDate, tab, campus, course, year, search, mode } = req.query;
    if (!startDate || !endDate || !tab) return res.status(400).json({ error: 'startDate, endDate, tab required' });

    const start = toLocalDate(startDate), end = toLocalDate(endDate);
    end.setHours(23, 59, 59, 999);
    const extra = { campus, course, year, search, mode };

    if (tab === 'all' || tab === 'allSheets') {
      const [enqDocs, regDocs, admDocs] = await Promise.all([
        Student.find(buildDateFilter('enquiryDateParsed', start, end, extra), listProjection).lean(),
        Student.find(buildDateFilter('registrationDateParsed', start, end, extra), listProjection).lean(),
        Student.find(buildDateFilter('admissionDateParsed', start, end, extra), listProjection).lean()
      ]);
      return res.json({
        enquiries: enqDocs.map(s => mapDoc(s, 'enquiredCenter', 'dateOfEnquiry')),
        registrations: regDocs.map(s => mapDoc(s, 'registeredCenter', 'dateOfRegistration')),
        admissions: admDocs.map(s => mapDoc(s, 'admittedCenter', 'dateOfAdmission'))
      });
    }

    let dateField, campusField, dateStrField;
    if (tab === 'enquiry') { dateField = 'enquiryDateParsed'; campusField = 'enquiredCenter'; dateStrField = 'dateOfEnquiry'; }
    else if (tab === 'registration') { dateField = 'registrationDateParsed'; campusField = 'registeredCenter'; dateStrField = 'dateOfRegistration'; }
    else { dateField = 'admissionDateParsed'; campusField = 'admittedCenter'; dateStrField = 'dateOfAdmission'; }

    const docs = await Student.find(buildDateFilter(dateField, start, end, extra), listProjection).lean();
    res.json({ students: docs.map(s => mapDoc(s, campusField, dateStrField)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/student/:id', auth, dashboardOnly, async (req, res) => {
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
    const batches = await Student.aggregate([{ $group: { _id: '$uploadBatch', count: { $sum: 1 }, firstUpload: { $min: '$createdAt' } } }, { $sort: { firstUpload: -1 } }]);
    res.json(batches);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/batch/:batchId', auth, adminOnly, async (req, res) => {
  try {
    const result = await Student.deleteMany({ uploadBatch: req.params.batchId });
    res.json({ deleted: result.deletedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/count', auth, dashboardOnly, async (req, res) => {
  try {
    const { mode } = req.query;
    const count = await Student.countDocuments(mode ? modeCourseQuery(mode) : {});
    res.json({ count });
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/compare', auth, dashboardOnly, async (req, res) => {
  try {
    const { startMonth, startDay, endMonth, endDay, year1, year2, year3, campus, course, mode } = req.query;
    if (!startMonth || !startDay || !endMonth || !endDay || !year1 || !year2 || !year3) return res.status(400).json({ error: 'All params required' });

    const y1 = parseInt(year1), y2 = parseInt(year2), y3 = parseInt(year3);
    const sm = parseInt(startMonth) - 1, sd = parseInt(startDay), em = parseInt(endMonth) - 1, ed = parseInt(endDay);

    const start1 = new Date(Date.UTC(y1, sm, sd)), end1 = new Date(Date.UTC(y1, em, ed, 23, 59, 59, 999));
    const start2 = new Date(Date.UTC(y2, sm, sd)), end2 = new Date(Date.UTC(y2, em, ed, 23, 59, 59, 999));
    const start3 = new Date(Date.UTC(y3, sm, sd)), end3 = new Date(Date.UTC(y3, em, ed, 23, 59, 59, 999));
    const extra = { campus: campus || '', course: course || '', mode };

    const [enq1, reg1, adm1, enq2, reg2, adm2, enq3, reg3, adm3] = await Promise.all([
      Student.countDocuments(buildDateFilter('enquiryDateParsed', start1, end1, extra)),
      Student.countDocuments(buildDateFilter('registrationDateParsed', start1, end1, extra)),
      Student.countDocuments(buildDateFilter('admissionDateParsed', start1, end1, extra)),
      Student.countDocuments(buildDateFilter('enquiryDateParsed', start2, end2, extra)),
      Student.countDocuments(buildDateFilter('registrationDateParsed', start2, end2, extra)),
      Student.countDocuments(buildDateFilter('admissionDateParsed', start2, end2, extra)),
      Student.countDocuments(buildDateFilter('enquiryDateParsed', start3, end3, extra)),
      Student.countDocuments(buildDateFilter('registrationDateParsed', start3, end3, extra)),
      Student.countDocuments(buildDateFilter('admissionDateParsed', start3, end3, extra))
    ]);

    res.json({
      year1: { year: y1, enquiry: enq1, registration: reg1, admission: adm1, total: enq1 + reg1 + adm1 },
      year2: { year: y2, enquiry: enq2, registration: reg2, admission: adm2, total: enq2 + reg2 + adm2 },
      year3: { year: y3, enquiry: enq3, registration: reg3, admission: adm3, total: enq3 + reg3 + adm3 }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/compare/export', auth, dashboardOnly, async (req, res) => {
  try {
    const { startMonth, startDay, endMonth, endDay, year1, year2, year3, campus, course, mode } = req.query;
    if (!startMonth || !startDay || !endMonth || !endDay || !year1 || !year2 || !year3) return res.status(400).json({ error: 'All params required' });

    const y1 = parseInt(year1), y2 = parseInt(year2), y3 = parseInt(year3);
    const sm = parseInt(startMonth) - 1, sd = parseInt(startDay), em = parseInt(endMonth) - 1, ed = parseInt(endDay);

    const start1 = new Date(Date.UTC(y1, sm, sd)), end1 = new Date(Date.UTC(y1, em, ed, 23, 59, 59, 999));
    const start2 = new Date(Date.UTC(y2, sm, sd)), end2 = new Date(Date.UTC(y2, em, ed, 23, 59, 59, 999));
    const start3 = new Date(Date.UTC(y3, sm, sd)), end3 = new Date(Date.UTC(y3, em, ed, 23, 59, 59, 999));
    const extra = { campus: campus || '', course: course || '', mode };

    const [enq1, reg1, adm1, enq2, reg2, adm2, enq3, reg3, adm3] = await Promise.all([
      Student.find(buildDateFilter('enquiryDateParsed', start1, end1, extra), listProjection).lean(),
      Student.find(buildDateFilter('registrationDateParsed', start1, end1, extra), listProjection).lean(),
      Student.find(buildDateFilter('admissionDateParsed', start1, end1, extra), listProjection).lean(),
      Student.find(buildDateFilter('enquiryDateParsed', start2, end2, extra), listProjection).lean(),
      Student.find(buildDateFilter('registrationDateParsed', start2, end2, extra), listProjection).lean(),
      Student.find(buildDateFilter('admissionDateParsed', start2, end2, extra), listProjection).lean(),
      Student.find(buildDateFilter('enquiryDateParsed', start3, end3, extra), listProjection).lean(),
      Student.find(buildDateFilter('registrationDateParsed', start3, end3, extra), listProjection).lean(),
      Student.find(buildDateFilter('admissionDateParsed', start3, end3, extra), listProjection).lean()
    ]);

    res.json({
      year1: { year: y1, enquiries: enq1.map(s => mapDoc(s, 'enquiredCenter', 'dateOfEnquiry')), registrations: reg1.map(s => mapDoc(s, 'registeredCenter', 'dateOfRegistration')), admissions: adm1.map(s => mapDoc(s, 'admittedCenter', 'dateOfAdmission')) },
      year2: { year: y2, enquiries: enq2.map(s => mapDoc(s, 'enquiredCenter', 'dateOfEnquiry')), registrations: reg2.map(s => mapDoc(s, 'registeredCenter', 'dateOfRegistration')), admissions: adm2.map(s => mapDoc(s, 'admittedCenter', 'dateOfAdmission')) },
      year3: { year: y3, enquiries: enq3.map(s => mapDoc(s, 'enquiredCenter', 'dateOfEnquiry')), registrations: reg3.map(s => mapDoc(s, 'registeredCenter', 'dateOfRegistration')), admissions: adm3.map(s => mapDoc(s, 'admittedCenter', 'dateOfAdmission')) }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function buildDayList(startMonth, startDay, endMonth, endDay) {
  const s = new Date(Date.UTC(2000, startMonth - 1, startDay));
  const e = new Date(Date.UTC(2000, endMonth - 1, endDay));
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || e < s) return null;
  const days = [];
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push({ month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  }
  return days;
}

function makeUTCDate(year, month, day, endOfDay) {
  const d = new Date(Date.UTC(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

async function getAvailableYears() {
  const fields = ['enquiryDateParsed', 'registrationDateParsed', 'admissionDateParsed'];
  const yearSet = new Set();
  for (const field of fields) {
    const rows = await Student.aggregate([
      { $match: { [field]: { $type: 'date' } } },
      { $group: { _id: { $year: '$' + field } } },
      { $sort: { _id: 1 } }
    ]);
    rows.forEach(r => { if (r && r._id) yearSet.add(r._id); });
  }
  return Array.from(yearSet).sort((a, b) => a - b);
}

app.get('/api/compare/daywise', auth, adminOnly, async (req, res) => {
  try {
    const { startDate, endDate, years, metric } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required' });
    const sp = startDate.split('-'), ep = endDate.split('-');
    if (sp.length !== 3 || ep.length !== 3) return res.status(400).json({ error: 'Invalid date format' });
    const sm = parseInt(sp[1], 10), sd = parseInt(sp[2], 10);
    const em = parseInt(ep[1], 10), ed = parseInt(ep[2], 10);
    if (!sm || !sd || !em || !ed) return res.status(400).json({ error: 'Invalid dates' });

    const dayList = buildDayList(sm, sd, em, ed);
    if (!dayList) return res.status(400).json({ error: 'End date must be on or after start date (same-year range)' });

    const allowedYears = [2024, 2025, 2026];
    const yearList = (years || '')
      .split(',')
      .map(v => parseInt(String(v).trim(), 10))
      .filter(v => allowedYears.includes(v));
    const finalYears = yearList.length ? yearList : allowedYears.slice();
    if (!finalYears.length) return res.status(400).json({ error: 'No valid years provided' });

    const metricKey = (metric || '').toString().trim().toLowerCase();
    const allowedMetrics = ['registration', 'admission', 'enquiry', 'total'];
    const selectedMetric = allowedMetrics.includes(metricKey) ? metricKey : 'registration';

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const rows = dayList.map(d => ({
      key: String(d.month).padStart(2, '0') + '-' + String(d.day).padStart(2, '0'),
      label: String(d.day).padStart(2, '0') + ' ' + monthNames[d.month - 1],
      years: {}
    }));
    const rowMap = new Map(rows.map(r => [r.key, r]));

    const skippedYears = [];
    for (const year of finalYears) {
      const start = makeUTCDate(year, sm, sd, false);
      const end = makeUTCDate(year, em, ed, true);
      if (!start || !end || end < start) { skippedYears.push(year); continue; }

      const extra = {};
      const tasks = [];
      if (selectedMetric === 'enquiry' || selectedMetric === 'total') {
        tasks.push(Student.aggregate([
          { $match: buildDateFilter('enquiryDateParsed', start, end, extra) },
          { $group: { _id: { m: { $month: '$enquiryDateParsed' }, d: { $dayOfMonth: '$enquiryDateParsed' } }, count: { $sum: 1 } } }
        ]));
      } else {
        tasks.push(Promise.resolve([]));
      }
      if (selectedMetric === 'registration' || selectedMetric === 'total') {
        tasks.push(Student.aggregate([
          { $match: buildDateFilter('registrationDateParsed', start, end, extra) },
          { $group: { _id: { m: { $month: '$registrationDateParsed' }, d: { $dayOfMonth: '$registrationDateParsed' } }, count: { $sum: 1 } } }
        ]));
      } else {
        tasks.push(Promise.resolve([]));
      }
      if (selectedMetric === 'admission' || selectedMetric === 'total') {
        tasks.push(Student.aggregate([
          { $match: buildDateFilter('admissionDateParsed', start, end, extra) },
          { $group: { _id: { m: { $month: '$admissionDateParsed' }, d: { $dayOfMonth: '$admissionDateParsed' } }, count: { $sum: 1 } } }
        ]));
      } else {
        tasks.push(Promise.resolve([]));
      }
      const [enqAgg, regAgg, admAgg] = await Promise.all(tasks);

      const enqMap = new Map(enqAgg.map(r => [String(r._id.m).padStart(2, '0') + '-' + String(r._id.d).padStart(2, '0'), r.count]));
      const regMap = new Map(regAgg.map(r => [String(r._id.m).padStart(2, '0') + '-' + String(r._id.d).padStart(2, '0'), r.count]));
      const admMap = new Map(admAgg.map(r => [String(r._id.m).padStart(2, '0') + '-' + String(r._id.d).padStart(2, '0'), r.count]));

      for (const day of dayList) {
        const key = String(day.month).padStart(2, '0') + '-' + String(day.day).padStart(2, '0');
        const row = rowMap.get(key);
        if (!row) continue;
        const enquiry = enqMap.get(key) || 0;
        const registration = regMap.get(key) || 0;
        const admission = admMap.get(key) || 0;
        row.years[String(year)] = { enquiry, registration, admission, total: enquiry + registration + admission };
      }
    }

    res.json({ years: finalYears, rows, skippedYears, metric: selectedMetric });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/migrate-campus', auth, adminOnly, async (req, res) => {
  try {
    const students = await Student.find({}, { campus: 1, enquiredCenter: 1, registeredCenter: 1, admittedCenter: 1 }).lean();
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
    const students = await Student.find({}, { dateOfEnquiry: 1, dateOfRegistration: 1, dateOfAdmission: 1 }).lean();
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
      const lower = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ''), v]));
      for (const k of keys) { const nk = k.toLowerCase().replace(/[^a-z0-9]/g, ''); if (lower[nk] !== undefined && lower[nk] !== null && lower[nk] !== '') return String(lower[nk]).trim(); }
      return '';
    };

    const batchId = 'meritto_' + Date.now();
    let created = 0, updated = 0, skipped = 0;

    for (const item of items) {
      const firstName = get(item, 'first_name', 'firstName'), lastName = get(item, 'last_name', 'lastName');
      const name = get(item, 'name', 'full_name', 'fullName', 'student_name', 'studentName') || [firstName, lastName].filter(Boolean).join(' ');
      if (!name) { skipped++; continue; }

      const email = get(item, 'email', 'email_id', 'emailId').toLowerCase();
      const mobile = get(item, 'mobile', 'phone', 'contact', 'mobile_number', 'phone_number');
      const campusRaw = get(item, 'campus', 'center', 'centre', 'campus_name', 'center_name');
      const enquiredCenterRaw = get(item, 'enquired_center', 'enquiry_center', 'enquiredCenter') || campusRaw;
      const registeredCenterRaw = get(item, 'registered_center', 'registeredCenter') || campusRaw;
      const admittedCenterRaw = get(item, 'admitted_center', 'admittedCenter') || campusRaw;
      const campus = normalizeCampus(campusRaw) || campusRaw;
      const enquiredCenter = normalizeCampus(enquiredCenterRaw) || enquiredCenterRaw;
      const registeredCenter = normalizeCampus(registeredCenterRaw) || registeredCenterRaw;
      const admittedCenter = normalizeCampus(admittedCenterRaw) || admittedCenterRaw;
      const dateOfEnquiry = get(item, 'date_of_enquiry', 'enquiry_date', 'enquiryDate', 'lead_date', 'created_at', 'createdAt');
      const dateOfRegistration = get(item, 'date_of_registration', 'registration_date', 'registrationDate');
      const dateOfAdmission = get(item, 'date_of_admission', 'admission_date', 'admissionDate');

      const rawStatus = get(item, 'status', 'lead_stage', 'leadStage', 'application_status', 'applicationStatus', 'stage');
      const statusMap = { enquiry: 'Enquiry', enquired: 'Enquiry', lead: 'Enquiry', new: 'Enquiry', registration: 'Registered', registered: 'Registered', admission: 'Admitted', admitted: 'Admitted', confirm: 'Admitted', confirmed: 'Admitted' };
      const applicationStatus = statusMap[(rawStatus || '').toLowerCase()] || rawStatus || 'Enquiry';

      const dateOfEnquiryFinal = dateOfEnquiry || (applicationStatus === 'Enquiry' ? new Date().toISOString().slice(0, 10) : '');
      const dateOfRegistrationFinal = dateOfRegistration || (applicationStatus === 'Registered' ? new Date().toISOString().slice(0, 10) : '');
      const dateOfAdmissionFinal = dateOfAdmission || (applicationStatus === 'Admitted' ? new Date().toISOString().slice(0, 10) : '');

      const record = {
        leadId: get(item, 'lead_id', 'leadId', 'lead_ID', 'lead ID'),
        studentId: get(item, 'student_id', 'studentId', 'application_id', 'applicationId', 'id'),
        name, email, mobile, gender: get(item, 'gender'), dob: get(item, 'dob', 'date_of_birth', 'dateOfBirth'),
        fatherName: get(item, 'father_name', 'fatherName'), motherName: get(item, 'mother_name', 'motherName'),
        category: get(item, 'category', 'caste_category', 'casteCategory'),
        courseType: get(item, 'course_level', 'courseLevel', 'course_type', 'courseType', 'program_type', 'programType'),
        courseName: get(item, 'course_name', 'courseName', 'program', 'program_name', 'programName', 'course'),
        intake: get(item, 'intake', 'batch', 'academic_year', 'academicYear', 'year'),
        applicationStatus, campus, enquiredCenter, registeredCenter, admittedCenter,
        dateOfEnquiry: dateOfEnquiryFinal, dateOfRegistration: dateOfRegistrationFinal, dateOfAdmission: dateOfAdmissionFinal,
        enquiryDateParsed: parseDate(dateOfEnquiryFinal), registrationDateParsed: parseDate(dateOfRegistrationFinal), admissionDateParsed: parseDate(dateOfAdmissionFinal),
        state: get(item, 'state', 'permanent_state'), city: get(item, 'city', 'permanent_city'),
        district: get(item, 'district', 'permanent_district'), pincode: get(item, 'pincode', 'pin_code', 'zip'),
        address: get(item, 'address', 'permanent_address'), nationality: get(item, 'nationality'),
        religion: get(item, 'religion'), bloodGroup: get(item, 'blood_group', 'bloodGroup'),
        aadhar: get(item, 'aadhar', 'aadhaar', 'aadhar_no', 'aadhaar_no'),
        uploadBatch: batchId, rawData: item
      };

      const cleanRecord = Object.fromEntries(Object.entries(record).filter(([_, v]) => {
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
    const last = await Student.findOne({ uploadBatch: /^meritto_/ }, { createdAt: 1 }).sort({ createdAt: -1 }).lean();
    res.json({ secret: MERITTO_SECRET, webhookPath: '/api/meritto/webhook', totalRecords: count, lastReceived: last ? last.createdAt : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/meritto/export', auth, adminOnly, async (req, res) => {
  try {
    const { mode } = req.query;
    const modeQ = modeCourseQuery(mode);
    const docs = await Student.find({ uploadBatch: /^meritto_/, ...modeQ }, listProjection).lean();
    const rows = docs.map(s => ({
      _id: s._id,
      studentId: s.studentId || '',
      name: s.name || '',
      courseType: s.courseType || '',
      courseName: s.courseName || '',
      status: s.applicationStatus || '',
      campus: displayCampus(s.campus || s.enquiredCenter || s.registeredCenter || s.admittedCenter || ''),
      mobile: s.mobile || '',
      email: s.email || '',
      dateOfEnquiry: s.dateOfEnquiry || '',
      dateOfRegistration: s.dateOfRegistration || '',
      dateOfAdmission: s.dateOfAdmission || '',
      uploadBatch: s.uploadBatch || ''
    }));
    res.json({ total: rows.length, students: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      message: 'Upload error.',
      details:
        error.code === 'LIMIT_FILE_SIZE'
          ? `Each photography file can be up to ${photographyMaxFileSizeMb.toLocaleString()} MB.`
          : error.message
    });
  }

  return res.status(500).json({ error: error.message || 'Unexpected server error.' });
});
const server = app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
server.requestTimeout = 0;
server.timeout = 0;
