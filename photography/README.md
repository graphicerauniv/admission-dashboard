# Studio Vault

Studio Vault is a lightweight team workspace for Amazon S3. It gives your team one webpage where they can:

- upload photos and videos
- choose a custom name for each upload
- browse the full file library
- download any file later
- see total storage used in the bucket

## 1. Install

```bash
npm install
```

## 2. Configure S3

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required settings:

- `S3_BUCKET_NAME`: the S3 bucket to use
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: credentials with permission to list, read, and upload objects

Optional settings:

- `PORT`: local server port, defaults to `3000`
- `HOST`: local bind address, defaults to `127.0.0.1`
- `MAX_FILE_SIZE_MB`: max upload size per file, defaults to `102400` for 100 GB uploads

If you do not set `AWS_REGION`, the app starts with `us-east-1` and the AWS SDK follows S3 region redirects automatically. That lets you keep setup minimal, although setting the exact bucket region is still the most reliable option.

## 3. Run

```bash
npm run dev
```

Open `http://localhost:3000`

## IAM Permissions

The AWS credentials used by this app should be allowed to:

- `s3:ListBucket`
- `s3:GetObject`
- `s3:PutObject`
- `s3:DeleteObject`

## Notes

- Uploaded files are stored in the bucket under the `library/` prefix.
- To avoid filename collisions, the app adds a unique ID to each uploaded file.
- Downloads are served using short-lived signed URLs.
- The browser supports selecting multiple files in one batch and shows live progress while each file uploads.
