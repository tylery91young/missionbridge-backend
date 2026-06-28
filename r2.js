const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');

// R2 is S3-compatible, so we use the standard AWS S3 client,
// just pointed at Cloudflare's endpoint instead of AWS's.
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME;

/**
 * Uploads a file from local temp storage to R2, permanently.
 * Returns the key (filename) it was saved under in the bucket.
 */
async function uploadToR2(localFilePath, destinationKey, mimeType) {
  const fileContent = fs.readFileSync(localFilePath);

  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: destinationKey,
      Body: fileContent,
      ContentType: mimeType,
    })
  );

  return destinationKey;
}

/**
 * Generates a temporary, secure URL so the dashboard can display
 * a photo or play an audio file directly from R2.
 * URL expires after 1 hour for security - the dashboard re-requests
 * a fresh one each time the page loads.
 */
async function getSignedFileUrl(key) {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });
  return await getSignedUrl(r2, command, { expiresIn: 3600 });
}

module.exports = { uploadToR2, getSignedFileUrl, r2 };
