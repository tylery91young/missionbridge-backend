const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { pool, initDb } = require('./db');
const { uploadToR2, getSignedFileUrl, r2 } = require('./r2');
const { sendEmail } = require('./mailer');

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

    // Detect specifically what kind of unparseable content this email
    // might contain, so the dashboard can tell the family exactly what
    // happened instead of a generic "something went wrong."
    const drivePattern = /(https?:\/\/drive\.google\.com\/\S+)/gi;
    const photosPattern = /(https?:\/\/photos\.(?:app\.goo\.gl|google\.com)\/\S+)/gi;

    const driveLinksFound = text.match(drivePattern) || [];
    const photosLinksFound = text.match(photosPattern) || [];

    const hasDriveLink = driveLinksFound.length > 0;
    const hasPhotosLink = photosLinksFound.length > 0;
    const hasAnyUnparseableLink = hasDriveLink || hasPhotosLink;

    // A rough check for "this email is basically just a link, no
    // real written update" - useful to flag separately since it
    // suggests the missionary relied entirely on a link this time.
    const textWithoutLinks = text
      .replace(drivePattern, '')
      .replace(photosPattern, '')
      .trim();
    const isMostlyJustALink = hasAnyUnparseableLink && textWithoutLinks.length < 40;

    let detectedIssueType = null;
    if (hasPhotosLink && hasDriveLink) detectedIssueType = 'drive_and_photos_link';
    else if (hasPhotosLink) detectedIssueType = 'photos_album_link';
    else if (hasDriveLink) detectedIssueType = 'drive_file_link';

    // Save the email itself to the database
    const result = await pool.query(
      `INSERT INTO emails (from_address, subject, body_text, has_drive_link, detected_issue_type, is_mostly_link)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [from, subject, text, hasAnyUnparseableLink, detectedIssueType, isMostlyJustALink]
    );
    const emailId = result.rows[0].id;

    // If we found a link we can't access, alert the family right away
    // so they can save it themselves in time.
    if (hasAnyUnparseableLink && missionary) {
      const exampleLink = driveLinksFound[0] || photosLinksFound[0];
      const linkTypeLabel = hasPhotosLink ? 'Google Photos' : 'Google Drive';

      try {
        await sendEmail(
          missionary.family_email,
          'We found a link we can\'t save automatically',
          `Hi! Your missionary's latest email included a ${linkTypeLabel} link that we can't access as a third party. The best way to save it is to open the email yourself and download it directly. For future emails, ask your missionary to attach photos as regular files instead of sharing a link, so we can save them automatically. The link we found: ${exampleLink}`,
          `<p>Hi!</p><p>Your missionary's latest email included a ${linkTypeLabel} link that we can't access as a third party.</p><p>The best way to save it is to open the email yourself and download it directly.</p><p>For future emails, ask your missionary to attach photos as regular files instead of sharing a link, so we can save them automatically.</p><p>The link we found: <a href="${exampleLink}">${exampleLink}</a></p>`,
          'drive_link_alert'
        );
      } catch (mailErr) {
        console.error('Error sending Drive link alert email:', mailErr);
      }
    }

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

// Lets a family recover their dashboard link if they lost it.
// For security, we email the link rather than displaying it directly,
// so only someone with real access to that inbox can get in.
app.post('/find-dashboard', async (req, res) => {
  try {
    const searchEmail = (req.body.email || '').toLowerCase().trim();
    if (!searchEmail) {
      return res.status(400).json({ error: 'Please provide an email address' });
    }

    const result = await pool.query(
      `SELECT * FROM missionaries WHERE (missionary_email = $1 OR family_email = $1) AND is_removed = FALSE`,
      [searchEmail]
    );

    // Always send the same response whether or not we found something,
    // so this endpoint can't be used to check which emails are in our system.
    if (result.rows.length > 0) {
      for (const m of result.rows) {
        const dashboardUrl = `https://getmissionbridge.com/dashboard.html?email=${encodeURIComponent(m.missionary_email)}`;
        const name = m.missionary_name || 'your missionary';

        await sendEmail(
          searchEmail,
          'Your Mission Bridge dashboard link',
          `Here's your dashboard link for ${name}: ${dashboardUrl}`,
          `<p>Here's your dashboard link for <strong>${name}</strong>:</p><p><a href="${dashboardUrl}">${dashboardUrl}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`,
          'dashboard_recovery'
        );
      }
    }

    res.json({ message: "If we found an account with that email, we've sent the link. Check your inbox." });
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

    // Log this view for engagement tracking - don't let a logging
    // failure ever break the actual dashboard load.
    try {
      await pool.query(
        `INSERT INTO dashboard_views (missionary_email) VALUES ($1)`,
        [missionaryEmail]
      );
    } catch (logErr) {
      console.error('Error logging dashboard view:', logErr);
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
          hasDriveLink: email.has_drive_link || false,
          detectedIssueType: email.detected_issue_type || null,
          isMostlyLink: email.is_mostly_link || false,
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

    // Send the welcome email after responding - don't make the
    // family wait on this, and don't fail signup if email sending hiccups.
    try {
      await sendEmail(
        familyEmail.toLowerCase().trim(),
        'Welcome to Mission Bridge',
        `Hi! I'm Tyler, the person behind Mission Bridge. Thanks so much for giving this a try. My email is tyler@getmissionbridge.com, reach out anytime if anything seems off or confusing, I'd genuinely rather hear from you than have you wonder. I built this because I wanted families to have one less thing to worry about during a mission. I hope it gives you some peace of mind.`,
        `<p>Hi! I'm Tyler, the person behind Mission Bridge.</p><p>Thanks so much for giving this a try.</p><p>My email is <a href="mailto:tyler@getmissionbridge.com">tyler@getmissionbridge.com</a>, reach out anytime if anything seems off or confusing. I'd genuinely rather hear from you than have you wonder.</p><p>I built this because I wanted families to have one less thing to worry about during a mission. I hope it gives you some peace of mind.</p>`,
        'welcome'
      );
    } catch (mailErr) {
      console.error('Error sending welcome email:', mailErr);
    }
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

// Admin: see every email that's gone out, success or failure, most recent first
app.get('/admin/email-log', requireAdminKey, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM email_log ORDER BY sent_at DESC LIMIT 200`
    );
    const failureCount = await pool.query(
      `SELECT COUNT(*) FROM email_log WHERE success = FALSE`
    );
    res.json({
      emails: result.rows,
      totalFailures: parseInt(failureCount.rows[0].count, 10),
    });
  } catch (err) {
    console.error('Error fetching email log:', err);
    res.status(500).json({ error: 'Error fetching email log' });
  }
});

// Admin: see dashboard view activity per missionary, so Tyler can tell
// who's actually checking in versus who signed up and disappeared
app.get('/admin/dashboard-activity', requireAdminKey, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        missionary_email,
        COUNT(*) as total_views,
        MAX(viewed_at) as last_viewed
      FROM dashboard_views
      GROUP BY missionary_email
      ORDER BY last_viewed DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching dashboard activity:', err);
    res.status(500).json({ error: 'Error fetching dashboard activity' });
  }
});

// Admin: see every email where we detected an unparseable link
// (Drive, Photos, etc) - useful for spotting patterns across customers,
// like "lots of people are hitting this," not just one-off alerts.
app.get('/admin/detected-issues', requireAdminKey, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, from_address, subject, detected_issue_type, is_mostly_link, received_at
      FROM emails
      WHERE detected_issue_type IS NOT NULL
      ORDER BY received_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching detected issues:', err);
    res.status(500).json({ error: 'Error fetching detected issues' });
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
