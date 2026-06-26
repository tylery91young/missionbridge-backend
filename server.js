const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { pool, initDb } = require('./db');
const { uploadToR2, getSignedFileUrl, r2 } = require('./r2');

const app = express();
const upload = multer({ dest: '/tmp/uploads/' });

// Some email clients send a generic mimetype instead of the real one.
// This fills in the correct type based on file extension as a backup.
function resolveMimeType(originalMimeType, filename) {
  if (originalMimeType && originalMimeType !== 'application/octet-stream') {
    return originalMimeType;
  }
  const ext = path.extname(filename).toLowerCase();
  const knownTypes = {
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.heic': 'image/heic',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
  };
  return knownTypes[ext] || originalMimeType || 'application/octet-stream';
}

// Allow requests from the landing page domain specifically
app.use(cors({
  origin: ['https://getmissionbridge.com', 'https://www.getmissionbridge.com']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check - so we can confirm the server is alive
app.get('/', (req, res) => {
  res.send('Mission Bridge backend is running.');
});

// This is the URL SendGrid's Inbound Parse POSTs to
// every time an email arrives at parse.getmissionbridge.com
app.post('/webhook', upload.any(), async (req, res) => {
  try {
    const from = req.body.from || 'unknown sender';
    const subject = req.body.subject || '(no subject)';
    const text = req.body.text || req.body.html || '(no message body)';

    // The "from" field looks like 'Tyler Young <tyler@email.com>' -
    // pull out just the bare email address so we can match it.
    const emailMatch = from.match(/<(.+?)>/);
    const cleanFromAddress = (emailMatch ? emailMatch[1] : from).toLowerCase().trim();

    // Look up which missionary this email belongs to, if registered
    const missionaryLookup = await pool.query(
      `SELECT * FROM missionaries WHERE missionary_email = $1`,
      [cleanFromAddress]
    );
    const missionary = missionaryLookup.rows[0] || null;

    if (!missionary) {
      console.log(`Warning: received email from unregistered address: ${cleanFromAddress}`);
    }

    // Save the email itself to the database
    const result = await pool.query(
      `INSERT INTO emails (from_address, subject, body_text) VALUES ($1, $2, $3) RETURNING id`,
      [from, subject, text]
    );
    const emailId = result.rows[0].id;

    // Upload each attachment to R2 (permanent storage), then save
    // its info - including the real R2 key - to the database.
    const files = req.files || [];
    for (const file of files) {
      // Use a unique key so files never collide, but keep the
      // original extension so it's still viewable/downloadable correctly.
      const r2Key = `email-${emailId}/${Date.now()}-${file.originalname}`;
      const correctMimeType = resolveMimeType(file.mimetype, file.originalname);

      await uploadToR2(file.path, r2Key, correctMimeType);

      // Clean up the temp file now that it's safely in R2
      fs.unlinkSync(file.path);

      await pool.query(
        `INSERT INTO attachments (email_id, original_name, saved_as, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5)`,
        [emailId, file.originalname, r2Key, correctMimeType, file.size]
      );
    }

    console.log(`Saved email #${emailId} from ${from}: "${subject}" with ${files.length} attachment(s)`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error processing inbound email:', err);
    res.status(500).send('Error processing email');
  }
});

// Dashboard data: one missionary's full archive, organized by date,
// with each attachment categorized (photo/audio/other) and given
// a temporary secure URL so the browser can actually display it.
// Lets a family find their dashboard link again if they lost it -
// search by either the missionary's email or their own family email.
app.get('/find-dashboard', async (req, res) => {
  try {
    const searchEmail = (req.query.email || '').toLowerCase().trim();
    if (!searchEmail) {
      return res.status(400).json({ error: 'Please provide an email address' });
    }

    const result = await pool.query(
      `SELECT * FROM missionaries WHERE missionary_email = $1 OR family_email = $1`,
      [searchEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No account found with that email.' });
    }

    const matches = result.rows.map(m => ({
      missionaryName: m.missionary_name,
      missionaryEmail: m.missionary_email,
      isRemoved: m.is_removed || false,
    }));

    res.json({ matches });
  } catch (err) {
    console.error('Error finding dashboard:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/dashboard/:missionaryEmail', async (req, res) => {
  try {
    const missionaryEmail = req.params.missionaryEmail.toLowerCase().trim();

    const missionaryResult = await pool.query(
      `SELECT * FROM missionaries WHERE missionary_email = $1`,
      [missionaryEmail]
    );
    const missionary = missionaryResult.rows[0] || null;

    if (missionary && missionary.is_removed) {
      return res.status(403).json({ error: 'This account is no longer active.' });
    }

    const emails = await pool.query(
      `SELECT * FROM emails WHERE LOWER(from_address) LIKE '%' || $1 || '%' AND is_deleted = FALSE ORDER BY received_at DESC`,
      [missionaryEmail]
    );
    const emailIds = emails.rows.map(e => e.id);
    const attachments = emailIds.length
      ? await pool.query(`SELECT * FROM attachments WHERE email_id = ANY($1) AND is_deleted = FALSE`, [emailIds])
      : { rows: [] };

    // Build each email "moment" with its attachments categorized and
    // given a real, temporary viewable URL.
    const moments = await Promise.all(
      emails.rows.map(async (email) => {
        const emailAttachments = attachments.rows.filter(a => a.email_id === email.id);

        const withUrls = await Promise.all(
          emailAttachments.map(async (a) => {
            const url = await getSignedFileUrl(a.saved_as);
            const ext = a.original_name.split('.').pop().toLowerCase();

            let category = 'other';
            if (a.mime_type.startsWith('image/')) category = 'photo';
            else if (a.mime_type.startsWith('audio/')) category = 'audio';
            else if (a.mime_type.startsWith('video/')) category = 'video';
            // Fallback: some old records or unusual email clients send a
            // generic mimetype - use the file extension as backup.
            else if (['jpg','jpeg','png','heic','gif','webp'].includes(ext)) category = 'photo';
            else if (['m4a','mp3','wav','aac','ogg'].includes(ext)) category = 'audio';
            else if (['mp4','mov'].includes(ext)) category = 'video';

            return { ...a, url, category };
          })
        );

        return {
          id: email.id,
          subject: email.subject,
          text: email.body_text,
          receivedAt: email.received_at,
          photos: withUrls.filter(a => a.category === 'photo'),
          audio: withUrls.filter(a => a.category === 'audio'),
          videos: withUrls.filter(a => a.category === 'video'),
          other: withUrls.filter(a => a.category === 'other'),
        };
      })
    );

    res.json({
      missionary,
      totalMoments: moments.length,
      totalPhotos: moments.reduce((sum, m) => sum + m.photos.length, 0),
      totalAudio: moments.reduce((sum, m) => sum + m.audio.length, 0),
      moments,
    });
  } catch (err) {
    console.error('Error building dashboard data:', err);
    res.status(500).json({ error: 'Error fetching dashboard data' });
  }
});

// Lets the family turn downloads on/off for anyone they share their link with
app.post('/dashboard/:missionaryEmail/permissions', async (req, res) => {
  try {
    const missionaryEmail = req.params.missionaryEmail.toLowerCase().trim();
    const { allowDownloads } = req.body;

    await pool.query(
      `UPDATE missionaries SET allow_downloads = $1 WHERE missionary_email = $2`,
      [allowDownloads, missionaryEmail]
    );

    res.json({ success: true, allowDownloads });
  } catch (err) {
    console.error('Error updating permissions:', err);
    res.status(500).json({ error: 'Error updating permissions' });
  }
});

const archiver = require('archiver');
const { GetObjectCommand } = require('@aws-sdk/client-s3');

// Download everything (or just photos, or just emails) as a zip file.
// Usage: /download/:missionaryEmail?type=all|photos|emails
app.get('/download/:missionaryEmail', async (req, res) => {
  try {
    const missionaryEmail = req.params.missionaryEmail.toLowerCase().trim();
    const type = req.query.type || 'all'; // all | photos | emails

    const emails = await pool.query(
      `SELECT * FROM emails WHERE LOWER(from_address) LIKE '%' || $1 || '%' ORDER BY received_at ASC`,
      [missionaryEmail]
    );
    const emailIds = emails.rows.map(e => e.id);
    const attachments = emailIds.length
      ? await pool.query(`SELECT * FROM attachments WHERE email_id = ANY($1)`, [emailIds])
      : { rows: [] };

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="mission-bridge-${type}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    // Include a text file of all emails, unless they only want photos
    if (type === 'all' || type === 'emails') {
      const emailText = emails.rows
        .map(e => `Subject: ${e.subject}\nDate: ${e.received_at}\n\n${e.body_text}\n\n${'='.repeat(40)}\n`)
        .join('\n');
      archive.append(emailText, { name: 'all-emails.txt' });
    }

    // Include the actual photo/audio files, unless they only want emails
    if (type === 'all' || type === 'photos') {
      for (const att of attachments.rows) {
        // Skip non-photo files if specifically asked for "photos" only
        if (type === 'photos' && !att.mime_type.startsWith('image/')) continue;

        const fileResponse = await r2.send(
          new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: att.saved_as })
        );
        archive.append(fileResponse.Body, { name: att.original_name });
      }
    }

    archive.finalize();
  } catch (err) {
    console.error('Error creating download:', err);
    res.status(500).send('Error creating download');
  }
});

// Get a specific missionary's archive by their email address
app.get('/archive/:missionaryEmail', async (req, res) => {
  try {
    const missionaryEmail = req.params.missionaryEmail.toLowerCase().trim();

    const emails = await pool.query(
      `SELECT * FROM emails WHERE LOWER(from_address) LIKE '%' || $1 || '%' ORDER BY received_at DESC`,
      [missionaryEmail]
    );
    const emailIds = emails.rows.map(e => e.id);
    const attachments = emailIds.length
      ? await pool.query(`SELECT * FROM attachments WHERE email_id = ANY($1)`, [emailIds])
      : { rows: [] };

    const withAttachments = emails.rows.map(email => ({
      ...email,
      attachments: attachments.rows.filter(a => a.email_id === email.id)
    }));

    res.json(withAttachments);
  } catch (err) {
    console.error('Error fetching missionary archive:', err);
    res.status(500).send('Error fetching archive');
  }
});

// Simple viewer endpoint so you can check what's been captured
app.get('/archive', async (req, res) => {
  try {
    const emails = await pool.query(`SELECT * FROM emails ORDER BY received_at DESC`);
    const attachments = await pool.query(`SELECT * FROM attachments`);

    const withAttachments = emails.rows.map(email => ({
      ...email,
      attachments: attachments.rows.filter(a => a.email_id === email.id)
    }));

    res.json(withAttachments);
  } catch (err) {
    console.error('Error fetching archive:', err);
    res.status(500).send('Error fetching archive');
  }
});

// Sign up a missionary: links their sending email to the family's email
app.post('/signup', async (req, res) => {
  try {
    const { missionaryEmail, missionaryName, familyEmail, familyPhone, expectedReturnDate } = req.body;
    if (!missionaryEmail || !familyEmail) {
      return res.status(400).json({ error: 'Missionary email and family email are both required' });
    }

    const result = await pool.query(
      `INSERT INTO missionaries (missionary_email, missionary_name, family_email, family_phone, expected_return_date)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (missionary_email) DO UPDATE SET
         family_email = $3, missionary_name = $2, family_phone = $4, expected_return_date = $5
       RETURNING *`,
      [
        missionaryEmail.toLowerCase().trim(),
        missionaryName || null,
        familyEmail.toLowerCase().trim(),
        familyPhone || null,
        expectedReturnDate || null
      ]
    );

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error signing up missionary:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Waitlist signup endpoint - the landing page form will POST here
app.post('/waitlist', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    await pool.query(
      `INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [email]
    );

    res.status(200).json({ message: 'Added to waitlist', email });
  } catch (err) {
    console.error('Error adding to waitlist:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Quick way to check waitlist signups
app.get('/waitlist', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM waitlist ORDER BY joined_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching waitlist:', err);
    res.status(500).send('Error fetching waitlist');
  }
});

// Simple admin protection - requires a secret key in the request.
// Not bank-grade security, but keeps random people from finding this.
function requireAdminKey(req, res, next) {
  const providedKey = req.query.key || req.headers['x-admin-key'];
  if (providedKey !== process.env.ADMIN_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Admin overview: total customers, total storage, system health
app.get('/admin/overview', requireAdminKey, async (req, res) => {
  try {
    const missionaryCount = await pool.query(`SELECT COUNT(*) FROM missionaries WHERE is_removed = FALSE`);
    const totalRevenue = await pool.query(`SELECT COALESCE(SUM(paid_amount), 0) as total FROM missionaries`);
    const totalExpenditures = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM expenditures`);
    const totalAttachmentSize = await pool.query(`SELECT COALESCE(SUM(size_bytes), 0) as total FROM attachments WHERE is_deleted = FALSE`);
    const totalEmails = await pool.query(`SELECT COUNT(*) FROM emails WHERE is_deleted = FALSE`);
    const waitlistCount = await pool.query(`SELECT COUNT(*) FROM waitlist`);

    const storageBytes = parseInt(totalAttachmentSize.rows[0].total, 10);
    const storageGB = (storageBytes / (1024 ** 3)).toFixed(3);
    const freeLimitGB = 10; // Cloudflare R2 free tier
    const percentOfFreeUsed = ((storageBytes / (1024 ** 3)) / freeLimitGB * 100).toFixed(2);

    // Quick health checks
    let dbHealthy = true;
    try {
      await pool.query('SELECT 1');
    } catch {
      dbHealthy = false;
    }

    res.json({
      totalCustomers: parseInt(missionaryCount.rows[0].count, 10),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      totalExpenditures: parseFloat(totalExpenditures.rows[0].total),
      netProfit: parseFloat(totalRevenue.rows[0].total) - parseFloat(totalExpenditures.rows[0].total),
      totalEmailsCaptured: parseInt(totalEmails.rows[0].count, 10),
      waitlistSignups: parseInt(waitlistCount.rows[0].count, 10),
      storage: {
        usedBytes: storageBytes,
        usedGB: parseFloat(storageGB),
        freeLimitGB,
        percentOfFreeUsed: parseFloat(percentOfFreeUsed),
      },
      systemHealth: {
        database: dbHealthy ? 'ok' : 'error',
        server: 'ok',
        checkedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('Error building admin overview:', err);
    res.status(500).json({ error: 'Error fetching admin overview' });
  }
});

// Admin customer list: everyone signed up, with their usage stats
app.get('/admin/customers', requireAdminKey, async (req, res) => {
  try {
    const missionaries = await pool.query(`SELECT * FROM missionaries ORDER BY created_at DESC`);

    const customers = await Promise.all(
      missionaries.rows.map(async (m) => {
        const emails = await pool.query(
          `SELECT id FROM emails WHERE LOWER(from_address) LIKE '%' || $1 || '%'`,
          [m.missionary_email]
        );
        const emailIds = emails.rows.map(e => e.id);

        const storage = emailIds.length
          ? await pool.query(
              `SELECT COALESCE(SUM(size_bytes), 0) as total FROM attachments WHERE email_id = ANY($1)`,
              [emailIds]
            )
          : { rows: [{ total: 0 }] };

        const storageBytes = parseInt(storage.rows[0].total, 10);
        const daysSinceSignup = Math.floor((Date.now() - new Date(m.created_at)) / (1000 * 60 * 60 * 24));

        return {
          id: m.id,
          missionaryName: m.missionary_name,
          missionaryEmail: m.missionary_email,
          familyEmail: m.family_email,
          familyPhone: m.family_phone,
          isRemoved: m.is_removed || false,
          expectedReturnDate: m.expected_return_date,
          paidAmount: parseFloat(m.paid_amount || 0),
          notes: m.notes,
          signedUpAt: m.created_at,
          daysSinceSignup,
          totalUpdatesReceived: emailIds.length,
          storageUsedMB: parseFloat((storageBytes / (1024 ** 2)).toFixed(2)),
        };
      })
    );

    res.json(customers);
  } catch (err) {
    console.error('Error building customer list:', err);
    res.status(500).json({ error: 'Error fetching customers' });
  }
});

// Admin: update a customer's paid amount or notes
app.post('/admin/customers/:id', requireAdminKey, async (req, res) => {
  try {
    const { paidAmount, notes } = req.body;
    await pool.query(
      `UPDATE missionaries SET paid_amount = COALESCE($1, paid_amount), notes = COALESCE($2, notes) WHERE id = $3`,
      [paidAmount, notes, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating customer:', err);
    res.status(500).json({ error: 'Error updating customer' });
  }
});

// Kick a customer - this is reversible (is_removed flag), nothing is deleted.
// Their dashboard becomes inaccessible, but their data stays safe in case
// it was a mistake or they come back.
app.post('/admin/customers/:id/kick', requireAdminKey, async (req, res) => {
  try {
    await pool.query(`UPDATE missionaries SET is_removed = TRUE WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error kicking customer:', err);
    res.status(500).json({ error: 'Error kicking customer' });
  }
});

// Reverse a kick, in case it was a mistake
app.post('/admin/customers/:id/restore', requireAdminKey, async (req, res) => {
  try {
    await pool.query(`UPDATE missionaries SET is_removed = FALSE WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error restoring customer:', err);
    res.status(500).json({ error: 'Error restoring customer' });
  }
});

// Expenditure tracking - log a business cost
app.post('/admin/expenditures', requireAdminKey, async (req, res) => {
  try {
    const { description, amount, category, spentAt } = req.body;
    if (!description || amount === undefined) {
      return res.status(400).json({ error: 'Description and amount are required' });
    }
    const result = await pool.query(
      `INSERT INTO expenditures (description, amount, category, spent_at)
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE)) RETURNING *`,
      [description, amount, category || null, spentAt || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error adding expenditure:', err);
    res.status(500).json({ error: 'Error adding expenditure' });
  }
});

app.get('/admin/expenditures', requireAdminKey, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM expenditures ORDER BY spent_at DESC`);
    const total = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM expenditures`);
    res.json({ expenditures: result.rows, total: parseFloat(total.rows[0].total) });
  } catch (err) {
    console.error('Error fetching expenditures:', err);
    res.status(500).json({ error: 'Error fetching expenditures' });
  }
});

app.delete('/admin/expenditures/:id', requireAdminKey, async (req, res) => {
  try {
    await pool.query(`DELETE FROM expenditures WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting expenditure:', err);
    res.status(500).json({ error: 'Error deleting expenditure' });
  }
});

// Customer-facing: soft-delete an individual email/update (and its attachments)
app.delete('/dashboard/email/:emailId', async (req, res) => {
  try {
    await pool.query(`UPDATE emails SET is_deleted = TRUE WHERE id = $1`, [req.params.emailId]);
    await pool.query(`UPDATE attachments SET is_deleted = TRUE WHERE email_id = $1`, [req.params.emailId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting email:', err);
    res.status(500).json({ error: 'Error deleting item' });
  }
});

// Customer-facing: soft-delete a single attachment (e.g. just one photo)
app.delete('/dashboard/attachment/:attachmentId', async (req, res) => {
  try {
    await pool.query(`UPDATE attachments SET is_deleted = TRUE WHERE id = $1`, [req.params.attachmentId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting attachment:', err);
    res.status(500).json({ error: 'Error deleting item' });
  }
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Mission Bridge backend listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
