import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import mime from "mime-types";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadBucketCommand,
  DeleteObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const {
  PORT = "3000",
  HOST = "127.0.0.1",
  AWS_REGION = "us-east-1",
  S3_BUCKET_NAME,
  MAX_FILE_SIZE_MB = "102400"
} = process.env;

if (!S3_BUCKET_NAME) {
  throw new Error("Missing S3_BUCKET_NAME in environment variables.");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, "uploads");

fs.mkdirSync(uploadsDir, { recursive: true });

const s3 = new S3Client({
  region: AWS_REGION,
  followRegionRedirects: true
});
const app = express();

function parseFileSizeLimitMb(value, fallbackMb) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMb;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeOriginal = file.originalname.replace(/[^\w.\-]+/g, "-");
    cb(null, `${Date.now()}-${safeOriginal}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: parseFileSizeLimitMb(MAX_FILE_SIZE_MB, 102400) * 1024 * 1024
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function slugifyBaseName(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "file";
}

function formatBytes(value) {
  if (value === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** index;
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function deriveKind(contentType) {
  if (!contentType) {
    return "file";
  }
  if (contentType.startsWith("image/")) {
    return "image";
  }
  if (contentType.startsWith("video/")) {
    return "video";
  }
  return "file";
}

async function listAllObjects() {
  const objects = [];
  let continuationToken;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET_NAME,
        ContinuationToken: continuationToken
      })
    );

    if (response.Contents) {
      objects.push(...response.Contents);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

app.get("/api/health", async (_req, res) => {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET_NAME }));
    res.json({ ok: true, bucket: S3_BUCKET_NAME, region: AWS_REGION });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Unable to connect to the configured S3 bucket.",
      details: error.message
    });
  }
});

app.get("/api/files", async (_req, res) => {
  try {
    const objects = await listAllObjects();
    const files = await Promise.all(
      objects
        .filter((item) => item.Key)
        .sort((a, b) => new Date(b.LastModified ?? 0) - new Date(a.LastModified ?? 0))
        .map(async (item) => {
          const key = item.Key;
          const contentType = mime.lookup(key) || "application/octet-stream";
          const downloadUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({
              Bucket: S3_BUCKET_NAME,
              Key: key,
              ResponseContentDisposition: `attachment; filename="${path.basename(key)}"`
            }),
            { expiresIn: 60 * 10 }
          );

          return {
            key,
            name: path.basename(key),
            size: item.Size ?? 0,
            sizeLabel: formatBytes(item.Size ?? 0),
            lastModified: item.LastModified,
            kind: deriveKind(contentType),
            contentType,
            publicUrl: null,
            downloadUrl
          };
        })
    );

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

    res.json({
      files,
      summary: {
        totalFiles: files.length,
        totalBytes,
        totalSizeLabel: formatBytes(totalBytes)
      }
    });
  } catch (error) {
    res.status(500).json({
      message: "Unable to load files from S3.",
      details: error.message
    });
  }
});

app.post("/api/upload", upload.array("files"), async (req, res) => {
  const requestedNames = Array.isArray(req.body.names)
    ? req.body.names
    : req.body.names
      ? [req.body.names]
      : [];

  const files = req.files ?? [];

  if (!files.length) {
    return res.status(400).json({ message: "No files were uploaded." });
  }

  try {
    const uploaded = [];

    for (const [index, file] of files.entries()) {
      const customName = requestedNames[index]?.trim();
      const extension = path.extname(file.originalname);
      const safeBaseName = slugifyBaseName(customName || path.basename(file.originalname, extension));
      const key = `library/${safeBaseName}-${randomUUID()}${extension.toLowerCase()}`;

      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET_NAME,
          Key: key,
          Body: fs.createReadStream(file.path),
          ContentType: file.mimetype || "application/octet-stream"
        })
      );

      uploaded.push({
        key,
        name: path.basename(key)
      });

      fs.unlinkSync(file.path);
    }

    return res.status(201).json({
      message: "Files uploaded successfully.",
      uploaded
    });
  } catch (error) {
    for (const file of files) {
      if (file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    }

    return res.status(500).json({
      message: "Upload failed.",
      details: error.message
    });
  }
});

app.delete("/api/files", async (req, res) => {
  const { key } = req.body ?? {};

  if (!key || typeof key !== "string") {
    return res.status(400).json({ message: "A valid file key is required." });
  }

  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key
      })
    );

    return res.json({
      message: "File deleted successfully."
    });
  } catch (error) {
    return res.status(500).json({
      message: "Delete failed.",
      details: error.message
    });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      message: "Upload error.",
      details:
        error.code === "LIMIT_FILE_SIZE"
          ? `Each file can be up to ${parseFileSizeLimitMb(MAX_FILE_SIZE_MB, 102400).toLocaleString()} MB.`
          : error.message
    });
  }

  return res.status(500).json({
    message: "Unexpected server error.",
    details: error.message
  });
});

const server = app.listen(Number(PORT), HOST, () => {
  console.log(`S3 library server running on http://${HOST}:${PORT}`);
});
server.requestTimeout = 0;
server.timeout = 0;
