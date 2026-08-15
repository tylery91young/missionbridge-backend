const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const Stripe = require('stripe');
const { pool, initDb } = require('./db');
const { uploadToR2, getSignedFileUrl, deleteFromR2, r2 } = require('./r2');
const { sendEmail, sendEmailViaGmail } = require('./mailer');

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Real, honest scarcity: the first FOUNDING_SPOTS_CAP customers who
// actually pay get the founding rate. Once that many have genuinely
// paid, price automatically switches to the standard rate for everyone
// after - not a fake countdown, an actual enforced cutover based on
// real signups. Adjust the cap here as needed; nothing else changes.
const FOUNDING_SPOTS_CAP = 25;
const FOUNDING_PRICE_CENTS = 5000; // $50
const STANDARD_PRICE_CENTS = 7500; // $75

async function getFoundingStatus() {
  const result = await pool.query(
    `SELECT COUNT(*) FROM missionaries WHERE paid_amount >= $1`,
    [FOUNDING_PRICE_CENTS / 100]
  );
  const spotsClaimed = parseInt(result.rows[0].count, 10);
  const spotsRemaining = Math.max(0, FOUNDING_SPOTS_CAP - spotsClaimed);
  return {
    cap: FOUNDING_SPOTS_CAP,
    spotsClaimed,
    spotsRemaining,
    isFoundingRateActive: spotsRemaining > 0,
    currentPriceCents: spotsRemaining > 0 ? FOUNDING_PRICE_CENTS : STANDARD_PRICE_CENTS,
  };
}

const app = express();
const upload = multer({ dest: '/tmp/uploads/' });

// Render sits in front of this as a reverse proxy - without this,
// req.ip would reflect Render's proxy rather than the real visitor,
// which would make per-IP rate limiting below useless (everyone would
// share the same "IP").
app.set('trust proxy', true);

// Lightweight in-memory rate limiter - no new dependency needed for a
// single-instance server like this one. Tracks request timestamps per
// IP in a sliding window; would need a shared store (Redis) only if
// this ever ran as multiple instances behind a load balancer.
const rateLimitBuckets = new Map();
function rateLimit({ windowMs, max, message }) {
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const recent = (rateLimitBuckets.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: message || 'Too many requests, please try again shortly.' });
    }
    recent.push(now);
    rateLimitBuckets.set(key, recent);
    next();
  };
}
// Periodic sweep so IPs that stop making requests don't sit in memory
// forever - not load-bearing, just housekeeping at this scale.
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of rateLimitBuckets) {
    const recent = times.filter(t => now - t < 15 * 60 * 1000);
    if (recent.length === 0) rateLimitBuckets.delete(key);
    else rateLimitBuckets.set(key, recent);
  }
}, 60 * 60 * 1000);

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

// ---- Operation Wildfire: referral program ----
// Each paying customer gets a personal code (their last name, deduped
// on collision) tied to a real Stripe Promotion Code, so anyone who
// uses it gets $10 off and the code's owner earns $10 when they do.
// Everything here is best-effort and wrapped by the caller - a
// failure to create a referral code should never block a real
// payment or the onboarding emails that follow it.

let referralCouponIdCache = null;
// The $10-off coupon is shared across every customer's personal code -
// Stripe lets many Promotion Codes point at one Coupon. Created once,
// lazily, then reused.
async function getOrCreateReferralCoupon() {
  if (referralCouponIdCache) return referralCouponIdCache;
  const existing = await stripe.coupons.list({ limit: 100 });
  const found = existing.data.find(c => c.metadata?.purpose === 'referral_program');
  if (found) {
    referralCouponIdCache = found.id;
    return found.id;
  }
  const coupon = await stripe.coupons.create({
    amount_off: 1000,
    currency: 'usd',
    duration: 'once',
    name: 'Referral - $10 off',
    metadata: { purpose: 'referral_program' },
  });
  referralCouponIdCache = coupon.id;
  return coupon.id;
}

function sanitizeReferralCodeBase(missionaryName, familyEmail) {
  const lastName = (missionaryName || '').trim().split(/\s+/).pop() || '';
  const base = lastName || (familyEmail || '').split('@')[0] || 'FRIEND';
  const cleaned = base.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned || 'FRIEND';
}

// Generates this missionary's own referral code (if they don't have
// one yet) and a real Stripe Promotion Code behind it. Only called
// after payment confirms. Safe to call again for someone who already
// has a code - it's a no-op.
async function ensureReferralCode(missionary) {
  if (!stripe || missionary.referral_code) return missionary.referral_code || null;

  const base = sanitizeReferralCodeBase(missionary.missionary_name, missionary.family_email);
  const couponId = await getOrCreateReferralCoupon();

  let code = base;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? base : `${base}${attempt + 1}`;
    const clash = await pool.query(`SELECT id FROM missionaries WHERE referral_code = $1`, [candidate]);
    if (clash.rows.length === 0) {
      code = candidate;
      break;
    }
  }

  await stripe.promotionCodes.create({
    coupon: couponId,
    code,
    metadata: { referrerMissionaryId: String(missionary.id) },
  });

  await pool.query(`UPDATE missionaries SET referral_code = $1 WHERE id = $2`, [code, missionary.id]);
  return code;
}

// Checks whether a completed Stripe Checkout Session used a referral
// promotion code, and if so, credits $10 to whichever of our
// customers owns that code. Never credits someone for referring
// themselves (structurally shouldn't happen, since a code doesn't
// exist until after its owner has already paid, but checked anyway).
async function recordReferralIfUsed(sessionId, newMissionaryId) {
  if (!stripe) return;
  try {
    const fullSession = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['discounts.promotion_code'],
    });
    const usedCode = fullSession.discounts?.[0]?.promotion_code?.code;
    if (!usedCode) return;

    const ownerResult = await pool.query(
      `SELECT id FROM missionaries WHERE referral_code = $1`,
      [usedCode]
    );
    const ownerId = ownerResult.rows[0]?.id;
    if (!ownerId || ownerId === newMissionaryId) return;

    await pool.query(
      `INSERT INTO referral_credits (owner_missionary_id, referred_missionary_id, amount) VALUES ($1, $2, 10)`,
      [ownerId, newMissionaryId]
    );
    console.log(`Referral credit: missionary #${ownerId} earned $10 for referring missionary #${newMissionaryId}`);
  } catch (err) {
    console.error('Error checking/recording referral credit:', err.message);
  }
}

// ---- System health checks ----
// Checks every real external dependency this app actually relies on,
// not just "is the database reachable." Used by both the admin
// panel's live view and the periodic alert check below, so there's
// exactly one definition of "healthy" instead of two that could drift
// apart.
async function runSystemHealthChecks() {
  const checks = {};

  try {
    await pool.query('SELECT 1');
    checks.database = { ok: true, label: 'Database' };
  } catch (err) {
    checks.database = { ok: false, label: 'Database', detail: err.message };
  }

  if (stripe) {
    try {
      await stripe.balance.retrieve();
      checks.stripe = { ok: true, label: 'Stripe' };
    } catch (err) {
      checks.stripe = { ok: false, label: 'Stripe', detail: err.message };
    }
  } else {
    checks.stripe = { ok: false, label: 'Stripe', detail: 'Not configured (missing STRIPE_SECRET_KEY)' };
  }

  if (process.env.R2_BUCKET_NAME) {
    try {
      await r2.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, MaxKeys: 1 }));
      checks.storage = { ok: true, label: 'File storage (R2)' };
    } catch (err) {
      checks.storage = { ok: false, label: 'File storage (R2)', detail: err.message };
    }
  } else {
    checks.storage = { ok: false, label: 'File storage (R2)', detail: 'Not configured (missing R2_BUCKET_NAME)' };
  }

  checks.emailConfigured = process.env.SENDGRID_API_KEY
    ? { ok: true, label: 'Email sending (SendGrid)' }
    : { ok: false, label: 'Email sending (SendGrid)', detail: 'Not configured (missing SENDGRID_API_KEY)' };

  // Real delivery signal, not just "is the key present" - catches
  // things like the missionary-account SendGrid rejection this
  // already ran into once for real (see mailer.js). Only flags a
  // problem when there's meaningful volume and most of it is failing,
  // so one bounced email out of one send doesn't cry wolf.
  try {
    const recent = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE success = FALSE OR delivery_status IN ('bounce','dropped','blocked')) as failures,
        COUNT(*) as total
      FROM email_log WHERE sent_at > NOW() - INTERVAL '24 hours'
    `);
    const failures = parseInt(recent.rows[0].failures, 10);
    const total = parseInt(recent.rows[0].total, 10);
    const failing = total >= 3 && (failures / total) > 0.5;
    checks.emailDelivery = {
      ok: !failing,
      label: 'Email delivery (last 24h)',
      detail: `${failures}/${total} failed`,
    };
  } catch (err) {
    checks.emailDelivery = { ok: false, label: 'Email delivery (last 24h)', detail: err.message };
  }

  const allOk = Object.values(checks).every(c => c.ok);
  return { allOk, checks, checkedAt: new Date().toISOString() };
}

// Sends to Tyler directly (not logged as a customer-facing email
// type) - tries SendGrid first, falls back to the Gmail relay if that
// fails, same resilience pattern already used for missionary emails,
// so a single provider outage doesn't also take out the alert telling
// him about it.
async function alertTyler(subject, text) {
  const to = 'tyleryoung1796@gmail.com';
  const html = `<p>${text.replace(/\n/g, '<br>')}</p>`;
  try {
    await sendEmail(to, subject, text, html, 'system_alert');
  } catch (sgErr) {
    console.error('Alert email via SendGrid failed, trying Gmail relay:', sgErr.message);
    try {
      await sendEmailViaGmail(to, subject, text, html, 'system_alert');
    } catch (gmailErr) {
      console.error('Alert email via Gmail relay ALSO failed - Tyler was not notified:', gmailErr.message);
    }
  }
}

// Runs on a timer (see the bottom of this file). Only emails on a
// state *change* - the moment something breaks, and the moment
// everything's healthy again - not on every single check while a
// known problem is still being worked on, so this doesn't spam an
// inbox with the same failure every 15 minutes.
let lastSystemHealthOk = true;
async function checkSystemHealthAndAlert() {
  try {
    const { allOk, checks } = await runSystemHealthChecks();

    if (!allOk && lastSystemHealthOk) {
      const problems = Object.values(checks)
        .filter(c => !c.ok)
        .map(c => `- ${c.label}: ${c.detail || 'failing'}`)
        .join('\n');
      await alertTyler(
        'Mission Bridge Archive: system health problem detected',
        `One or more systems just failed a health check:\n\n${problems}\n\nCheck the admin panel for full details.`
      );
      console.log('System health alert sent:', problems);
    } else if (allOk && !lastSystemHealthOk) {
      await alertTyler(
        'Mission Bridge Archive: systems back to normal',
        `Everything passed the health check again as of ${new Date().toLocaleString()}.`
      );
      console.log('System health recovery notice sent.');
    }

    lastSystemHealthOk = allOk;
  } catch (err) {
    console.error('Error running system health check:', err);
  }
}

// Stripe requires the raw, unparsed request body to verify a webhook's
// signature - this MUST be defined before app.use(express.json()) below,
// since that would otherwise parse the body first and break verification.
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('Stripe webhook hit but STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).send('Stripe not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const missionaryId = session.metadata?.missionaryId;
    const isNewSignup = session.metadata?.isNewSignup === 'true';
    const amountPaid = session.amount_total ? session.amount_total / 100 : 0;

    if (missionaryId) {
      try {
        const result = await pool.query(
          `UPDATE missionaries SET paid_amount = $1 WHERE id = $2 RETURNING *`,
          [amountPaid, missionaryId]
        );
        console.log(`Payment confirmed via Stripe: $${amountPaid} for missionary #${missionaryId}`);

        let referralCode = null;
        if (result.rows[0]) {
          const m = result.rows[0];
          // Every real paying customer gets their own referral code
          // going forward, and this checkout itself might have used
          // someone else's - both best-effort, never block payment
          // confirmation or onboarding on either.
          try {
            await recordReferralIfUsed(session.id, m.id);
          } catch (refErr) {
            console.error(`Error recording referral for missionary #${missionaryId}:`, refErr.message);
          }
          try {
            referralCode = await ensureReferralCode(m);
          } catch (codeErr) {
            console.error(`Error creating referral code for missionary #${missionaryId}:`, codeErr.message);
          }
        }

        // For a brand-new signup (not an existing free customer being
        // asked to pay via the admin payment-link tool), onboarding
        // emails only go out now, once payment is actually confirmed -
        // not at form-submit time. Someone who fills out the form and
        // abandons checkout shouldn't get full setup instructions for
        // something they never paid for.
        if (isNewSignup && result.rows[0]) {
          const m = result.rows[0];
          try {
            await sendSignupEmails({
              missionaryEmail: m.missionary_email,
              missionaryName: m.missionary_name,
              familyEmail: m.family_email,
              missionStartDate: m.mission_start_date,
              missionStatus: m.mission_status,
              dashboardToken: m.dashboard_token,
              referralCode
            });
            console.log(`Sent onboarding emails after confirmed payment for missionary #${missionaryId}`);
          } catch (mailErr) {
            console.error(`Error sending post-payment onboarding emails for missionary #${missionaryId}:`, mailErr);
          }
        }
      } catch (err) {
        console.error(`Error updating paid_amount for missionary #${missionaryId}:`, err);
      }
    } else {
      console.error('Stripe checkout.session.completed had no missionaryId in metadata:', session.id);
    }
  }

  res.json({ received: true });
});

// Verifies SendGrid's Event Webhook signature (ECDSA over the raw
// timestamp+body), per their documented Signed Event Webhook scheme.
// Only called when SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY is configured -
// see the route below for what happens when it isn't.
function verifySendGridEventSignature(publicKeyBase64, payload, signature, timestamp) {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const verifier = crypto.createVerify('SHA256');
    verifier.update(timestamp + payload);
    verifier.end();
    return verifier.verify(publicKey, Buffer.from(signature, 'base64'));
  } catch (err) {
    console.error('Error verifying SendGrid event webhook signature:', err.message);
    return false;
  }
}

// Receives real delivery outcomes from SendGrid's Event Webhook
// (bounces, drops, deliveries) - separate from our own inbound
// /webhook for missionary emails. This is what actually tells us
// when something we sent didn't land, instead of only knowing that
// SendGrid initially accepted the send request.
//
// Registered here (before express.json(), like /webhook/stripe above)
// and using express.raw() for the same reason: signature verification
// needs the untouched raw body bytes, not the already-parsed object.
//
// SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY is optional - if it's not set
// (i.e. SendGrid's "Signed Event Webhook" feature hasn't been turned
// on yet in their dashboard), verification is skipped entirely and
// this behaves exactly as it did before. Nothing breaks either way;
// it just isn't protected against spoofed events until that's set up.
app.post('/webhook/sendgrid-events', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');

    if (process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY) {
      const signature = req.headers['x-twilio-email-event-webhook-signature'];
      const timestamp = req.headers['x-twilio-email-event-webhook-timestamp'];
      const isValid = signature && timestamp && verifySendGridEventSignature(
        process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY, rawBody, signature, timestamp
      );
      if (!isValid) {
        console.warn('Rejected SendGrid event webhook: missing or invalid signature');
        return res.status(401).send('Unauthorized');
      }
    }

    let events;
    try {
      events = JSON.parse(rawBody);
    } catch (parseErr) {
      console.error('Error parsing SendGrid event webhook body:', parseErr.message);
      return res.status(400).send('Invalid JSON');
    }
    events = Array.isArray(events) ? events : [];

    console.log(`SendGrid event webhook hit: received ${events.length} event(s)`);
    const deliveryTypes = ['bounce', 'dropped', 'delivered', 'blocked', 'deferred'];
    const engagementTypes = ['open', 'click'];

    for (const event of events) {
      if (!event.sg_message_id) {
        console.log(`SendGrid event received with no sg_message_id: ${event.event}`);
        continue;
      }

      if (deliveryTypes.includes(event.event)) {
        const detail = event.reason || event.response || null;
        // SendGrid's webhook message ID sometimes has extra characters
        // appended beyond the ID we captured at send time, so match on
        // our stored ID being a prefix of the incoming one.
        const result = await pool.query(
          `UPDATE email_log
           SET delivery_status = $1, delivery_detail = $2, delivery_updated_at = NOW()
           WHERE $3 LIKE sg_message_id || '%' AND sg_message_id IS NOT NULL`,
          [event.event, detail, event.sg_message_id]
        );
        console.log(`SendGrid event "${event.event}" for message_id ${event.sg_message_id}: matched ${result.rowCount} row(s)`);
      } else if (engagementTypes.includes(event.event)) {
        // Kept in their own columns rather than delivery_status, so an
        // "opened" event can never overwrite a meaningful outcome like
        // "bounced" that arrived earlier.
        const column = event.event === 'open' ? 'opened_at' : 'clicked_at';
        const result = await pool.query(
          `UPDATE email_log
           SET ${column} = COALESCE(${column}, NOW())
           WHERE $1 LIKE sg_message_id || '%' AND sg_message_id IS NOT NULL`,
          [event.sg_message_id]
        );
        console.log(`SendGrid event "${event.event}" for message_id ${event.sg_message_id}: matched ${result.rowCount} row(s)`);
      } else {
        console.log(`SendGrid event type not handled: ${event.event}`);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error processing SendGrid event webhook:', err);
    res.status(500).send('Error processing events');
  }
});

// Allow requests from the landing page domain specifically
app.use(cors({
  origin: ['https://getmissionbridge.com', 'https://www.getmissionbridge.com']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check - so we can confirm the server is alive
app.get('/', (req, res) => {
  res.send('Mission Bridge Archive backend is running.');
});

// This is the URL SendGrid's Inbound Parse POSTs to
// every time an email arrives at parse.getmissionbridge.com
app.post('/webhook', upload.any(), async (req, res) => {
  try {
    // Optional shared-secret check: SendGrid's Inbound Parse doesn't
    // sign requests the way the Event Webhook does, so this is the
    // available mitigation - only takes effect once INBOUND_PARSE_SECRET
    // is set AND SendGrid's Inbound Parse destination URL is updated to
    // append ?secret=<the same value>. Until both of those are done,
    // this is skipped and nothing changes.
    if (process.env.INBOUND_PARSE_SECRET && req.query.secret !== process.env.INBOUND_PARSE_SECRET) {
      console.warn('Rejected inbound webhook request with missing/incorrect secret');
      return res.status(401).send('Unauthorized');
    }

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

    // Save the email itself to the database. sender_email is the
    // exact, parsed address (cleanFromAddress) - used for exact-match
    // lookups everywhere instead of a LIKE '%...%' against the raw
    // from_address header, which could match a different missionary
    // whose address happened to be a substring of another's.
    const result = await pool.query(
      `INSERT INTO emails (from_address, sender_email, subject, body_text, has_drive_link, detected_issue_type, is_mostly_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [from, cleanFromAddress, subject, text, hasAnyUnparseableLink, detectedIssueType, isMostlyJustALink]
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

    // Every 3rd email from a missionary, send the family a quick,
    // passive "here's what we've saved so far" digest. No login or
    // checking-in required on their end, just a running reassurance
    // that things are actually being captured.
    if (missionary) {
      try {
        const countResult = await pool.query(
          `SELECT id FROM emails WHERE sender_email = $1 AND is_deleted = FALSE`,
          [missionary.missionary_email]
        );
        const allEmailIds = countResult.rows.map(r => r.id);
        const totalEmails = allEmailIds.length;

        if (totalEmails > 0 && totalEmails % 3 === 0) {
          const attachmentCounts = await pool.query(
            `SELECT
               COUNT(*) FILTER (WHERE mime_type LIKE 'image/%') as photos,
               COUNT(*) FILTER (WHERE mime_type LIKE 'audio/%') as voice_memos
             FROM attachments WHERE email_id = ANY($1) AND is_deleted = FALSE`,
            [allEmailIds]
          );
          const photoCount = parseInt(attachmentCounts.rows[0].photos, 10) || 0;
          const voiceCount = parseInt(attachmentCounts.rows[0].voice_memos, 10) || 0;
          const dashboardUrl = missionary.dashboard_token
            ? `https://getmissionbridge.com/dashboard.html?token=${encodeURIComponent(missionary.dashboard_token)}`
            : `https://getmissionbridge.com/dashboard.html?email=${encodeURIComponent(missionary.missionary_email)}`;
          const name = missionary.missionary_name || 'your missionary';

          await sendEmail(
            missionary.family_email,
            `${totalEmails} updates from ${name}, all saved`,
            `Quick update: we've now saved ${totalEmails} emails from ${name}, including ${photoCount} photo${photoCount === 1 ? '' : 's'} and ${voiceCount} voice memo${voiceCount === 1 ? '' : 's'}.\n\n` +
            `Nothing for you to do, just wanted you to know it's all there and accounted for. You can look anytime: ${dashboardUrl}`,
            `<p>Quick update: we've now saved <strong>${totalEmails} emails</strong> from ${name}, including <strong>${photoCount} photo${photoCount === 1 ? '' : 's'}</strong> and <strong>${voiceCount} voice memo${voiceCount === 1 ? '' : 's'}</strong>.</p>` +
            `<p>Nothing for you to do, just wanted you to know it's all there and accounted for. You can look anytime:</p>` +
            `<p><a href="${dashboardUrl}">${dashboardUrl}</a></p>`,
            'progress_digest'
          );
        }
      } catch (digestErr) {
        console.error('Error sending progress digest email:', digestErr);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error processing inbound email:', err);
    res.status(500).send('Error processing email');
  }
});

// A 1x1 transparent GIF, returned for every open-pixel hit regardless
// of whether the token matched anything - never error out on this,
// since a broken image is a worse experience than a silent miss.
const TRACKING_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7',
  'base64'
);

// Fired by the invisible tracking pixel embedded in Gmail-relayed
// emails - our substitute for SendGrid's own open-tracking, which
// doesn't exist for mail sent through a personal Gmail account.
app.get('/track/open/:token', async (req, res) => {
  try {
    await pool.query(
      `UPDATE email_log SET opened_at = COALESCE(opened_at, NOW()) WHERE tracking_token = $1`,
      [req.params.token]
    );
  } catch (err) {
    console.error('Error recording tracked open:', err);
  }
  res.set('Content-Type', 'image/gif');
  res.send(TRACKING_PIXEL);
});

// Fired by the visible "I got this, we're all set" link - a much
// more reliable positive signal than the pixel alone, since many
// email clients block remote images by default until a user
// explicitly chooses to load them.
app.get('/track/confirm/:token', async (req, res) => {
  try {
    await pool.query(
      `UPDATE email_log SET click_confirmed_at = NOW(), opened_at = COALESCE(opened_at, NOW()) WHERE tracking_token = $1`,
      [req.params.token]
    );
  } catch (err) {
    console.error('Error recording tracked confirm click:', err);
  }
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Thanks!</title>
    <style>body{font-family:sans-serif;background:#F7F3EC;color:#2B3A4A;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px;}</style>
    </head><body><div><h2>Thanks, you're all set!</h2><p>Nothing else to do on your end.</p></div></body></html>`);
});


// For security, we email the link rather than displaying it directly,
// so only someone with real access to that inbox can get in.
app.post('/find-dashboard', rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many attempts. Please try again in a few minutes.' }), async (req, res) => {
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
        const dashboardUrl = m.dashboard_token
          ? `https://getmissionbridge.com/dashboard.html?token=${encodeURIComponent(m.dashboard_token)}`
          : `https://getmissionbridge.com/dashboard.html?email=${encodeURIComponent(m.missionary_email)}`;
        const name = m.missionary_name || 'your missionary';

        await sendEmail(
          searchEmail,
          'Your Mission Bridge Archive dashboard link',
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

// Public: fetch checklist state for the end-of-mission page.
// Token-based rather than login-based, same pattern as the preorder
// completion flow - no account system, just a private link.
app.get('/checklist/:token', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM missionaries WHERE checklist_token = $1`,
      [req.params.token]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'This link is invalid or has expired.' });
    }
    const m = result.rows[0];
    res.json({
      missionaryName: m.missionary_name,
      dashboardUrl: m.dashboard_token
        ? `https://getmissionbridge.com/dashboard.html?token=${encodeURIComponent(m.dashboard_token)}`
        : `https://getmissionbridge.com/dashboard.html?email=${encodeURIComponent(m.missionary_email)}`,
      photoGuideUrl: 'https://getmissionbridge.com/photo-guide.html',
      checklistPhotosConfirmed: m.checklist_photos_confirmed,
      checklistDownloadsConfirmed: m.checklist_downloads_confirmed,
      checklistDeletionConfirmed: m.checklist_deletion_confirmed
    });
  } catch (err) {
    console.error('Error fetching checklist:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Public: check off one item on the end-of-mission checklist.
// Deletion is intentionally never automated here - checking this box
// just timestamps a request for manual review, so a real person
// always makes the final call before anything is actually removed.
app.post('/checklist/:token', async (req, res) => {
  try {
    const { item } = req.body;
    const columnMap = {
      photos: 'checklist_photos_confirmed',
      downloads: 'checklist_downloads_confirmed',
      deletion: 'checklist_deletion_confirmed'
    };
    const column = columnMap[item];
    if (!column) {
      return res.status(400).json({ error: 'Unknown checklist item' });
    }

    const extraSet = item === 'deletion' ? ', deletion_requested_at = NOW()' : '';
    const result = await pool.query(
      `UPDATE missionaries SET ${column} = TRUE${extraSet} WHERE checklist_token = $1 RETURNING *`,
      [req.params.token]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'This link is invalid or has expired.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating checklist:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Shared by both dashboard routes below (the legacy email-based one
// and the newer token-based one) so the actual data-building logic
// only lives in one place.
async function buildDashboardPayload(missionaryEmail, { logView }) {
  const missionaryResult = await pool.query(
    `SELECT * FROM missionaries WHERE missionary_email = $1`,
    [missionaryEmail]
  );
  const missionary = missionaryResult.rows[0] || null;

  if (missionary && missionary.is_removed) {
    return { removed: true };
  }

  // Log this view for engagement tracking - don't let a logging
  // failure ever break the actual dashboard load. Skipped entirely
  // when opened from the admin panel's preview link (adminPreview
  // query param), so Tyler checking on a customer doesn't get
  // counted as real family engagement.
  if (logView) {
    try {
      await pool.query(
        `INSERT INTO dashboard_views (missionary_email) VALUES ($1)`,
        [missionaryEmail]
      );
    } catch (logErr) {
      console.error('Error logging dashboard view:', logErr);
    }
  }

  const emails = await pool.query(
    `SELECT * FROM emails WHERE sender_email = $1 AND is_deleted = FALSE ORDER BY received_at DESC`,
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

  return {
    missionary,
    totalMoments: moments.length,
    totalPhotos: moments.reduce((sum, m) => sum + m.photos.length, 0),
    totalAudio: moments.reduce((sum, m) => sum + m.audio.length, 0),
    moments,
  };
}

// Legacy route - still uses the missionary's actual email address as
// the identifier. Kept working indefinitely so links already sent in
// real emails never break. New signups get a dashboard_token instead
// (see /dashboard/by-token below), which isn't guessable the way an
// email address is.
app.get('/dashboard/:missionaryEmail', async (req, res) => {
  try {
    const missionaryEmail = req.params.missionaryEmail.toLowerCase().trim();
    const payload = await buildDashboardPayload(missionaryEmail, { logView: req.query.adminPreview !== '1' });
    if (payload.removed) {
      return res.status(403).json({ error: 'This account is no longer active.' });
    }
    res.json(payload);
  } catch (err) {
    console.error('Error building dashboard data:', err);
    res.status(500).json({ error: 'Error fetching dashboard data' });
  }
});

// New, private way to reach a dashboard - a random token instead of
// the missionary's real email address.
app.get('/dashboard/by-token/:token', async (req, res) => {
  try {
    const tokenResult = await pool.query(
      `SELECT missionary_email FROM missionaries WHERE dashboard_token = $1`,
      [req.params.token]
    );
    const missionaryEmail = tokenResult.rows[0]?.missionary_email;
    if (!missionaryEmail) {
      return res.status(404).json({ error: 'This dashboard link is invalid.' });
    }
    const payload = await buildDashboardPayload(missionaryEmail.toLowerCase().trim(), { logView: req.query.adminPreview !== '1' });
    if (payload.removed) {
      return res.status(403).json({ error: 'This account is no longer active.' });
    }
    res.json(payload);
  } catch (err) {
    console.error('Error building dashboard data (by token):', err);
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
const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// Download everything (or just photos, or just emails) as a zip file.
// Usage: /download/:missionaryEmail?type=all|photos|emails
app.get('/download/:missionaryEmail', async (req, res) => {
  try {
    const missionaryEmail = req.params.missionaryEmail.toLowerCase().trim();
    const type = req.query.type || 'all'; // all | photos | emails

    const emails = await pool.query(
      `SELECT * FROM emails WHERE sender_email = $1 ORDER BY received_at ASC`,
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
      `SELECT * FROM emails WHERE sender_email = $1 ORDER BY received_at DESC`,
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

// Admin-only viewer endpoint so Tyler can check what's been captured
// across every customer. Used to have no auth at all - anyone who
// found this URL could read every family's private emails.
app.get('/archive', requireAdminKey, async (req, res) => {
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
// Public: real founding-rate status, used by the homepage to show
// genuine scarcity (spots actually claimed, not a fake countdown).
app.get('/founding-status', async (req, res) => {
  try {
    const status = await getFoundingStatus();
    res.json(status);
  } catch (err) {
    console.error('Error fetching founding status:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/signup', rateLimit({ windowMs: 15 * 60 * 1000, max: 8, message: 'Too many attempts. Please try again in a few minutes.' }), async (req, res) => {
  try {
    const { missionaryEmail, missionaryName, familyEmail, familyPhone, expectedReturnDate, missionStartDate, missionStatus, isPreorder } = req.body;

    // Preorder path: family doesn't have the missionary's info yet.
    // We reserve a spot with just their own contact info and a private
    // token they can use later to fill in the rest.
    if (isPreorder) {
      if (!familyEmail) {
        return res.status(400).json({ error: 'Your email is required' });
      }
      const cleanFamilyEmail = familyEmail.toLowerCase().trim();
      const token = crypto.randomBytes(24).toString('hex');
      const dashboardToken = crypto.randomBytes(24).toString('hex');

      const result = await pool.query(
        `INSERT INTO missionaries (family_email, family_phone, mission_status, completion_token, dashboard_token)
         VALUES ($1, $2, 'preorder', $3, $4)
         RETURNING *`,
        [cleanFamilyEmail, familyPhone || null, token, dashboardToken]
      );

      res.status(200).json(result.rows[0]);

      const completeUrl = `https://getmissionbridge.com/complete-signup.html?token=${token}`;
      try {
        await sendEmail(
          cleanFamilyEmail,
          "You're on the list - here's your setup link for later",
          `Thanks for reserving your spot with Mission Bridge Archive!\n\n` +
          `Once you have your missionary's mission call and email address, just come back to this link to finish setting things up - it takes about a minute:\n\n` +
          `${completeUrl}\n\n` +
          `We'll keep your spot reserved either way. Save this email so you don't lose the link.\n\n` +
          `Questions in the meantime? Email tyler@getmissionbridge.com anytime.`,
          `<p>Thanks for reserving your spot with Mission Bridge Archive!</p>` +
          `<p>Once you have your missionary's mission call and email address, just come back to this link to finish setting things up - it takes about a minute:</p>` +
          `<p><a href="${completeUrl}">${completeUrl}</a></p>` +
          `<p>We'll keep your spot reserved either way. Save this email so you don't lose the link.</p>` +
          `<p>Questions in the meantime? Email <a href="mailto:tyler@getmissionbridge.com">tyler@getmissionbridge.com</a> anytime.</p>`,
          'preorder_confirmation'
        );
      } catch (mailErr) {
        console.error('Error sending preorder confirmation email:', mailErr);
      }
      return;
    }

    if (!missionaryEmail || !familyEmail) {
      return res.status(400).json({ error: 'Missionary email and family email are both required' });
    }

    const cleanMissionaryEmailForCheck = missionaryEmail.toLowerCase().trim();

    // Guard against hijacking an already-paid account: without this,
    // anyone who knew (or guessed) a missionary's address could
    // resubmit the signup form with their own family_email and the
    // ON CONFLICT below would silently redirect that family's
    // dashboard-recovery and onboarding emails to the attacker.
    // Unpaid/incomplete rows can still be freely resubmitted (e.g.
    // someone retrying after an abandoned checkout).
    const existingMissionary = await pool.query(
      `SELECT id, paid_amount FROM missionaries WHERE missionary_email = $1`,
      [cleanMissionaryEmailForCheck]
    );
    if (existingMissionary.rows[0] && parseFloat(existingMissionary.rows[0].paid_amount || 0) > 0) {
      return res.status(409).json({ error: 'This missionary already has an active account. If this is your family and you need help, please contact us.' });
    }

    const result = await pool.query(
      `INSERT INTO missionaries (missionary_email, missionary_name, family_email, family_phone, expected_return_date, mission_start_date, mission_status, dashboard_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (missionary_email) DO UPDATE SET
         family_email = $3, missionary_name = $2, family_phone = $4, expected_return_date = $5,
         mission_start_date = $6, mission_status = $7,
         dashboard_token = COALESCE(missionaries.dashboard_token, $8)
       RETURNING *`,
      [
        missionaryEmail.toLowerCase().trim(),
        missionaryName || null,
        familyEmail.toLowerCase().trim(),
        familyPhone || null,
        expectedReturnDate || null,
        missionStartDate || null,
        missionStatus || null,
        crypto.randomBytes(24).toString('hex')
      ]
    );

    const m = result.rows[0];

    // If Stripe isn't configured yet (e.g. still finishing setup),
    // fall back to the old free-signup behavior rather than break
    // signup entirely.
    if (!stripe) {
      res.status(200).json(m);
      await sendSignupEmails({
        missionaryEmail: m.missionary_email, missionaryName: m.missionary_name, familyEmail: m.family_email,
        missionStartDate: m.mission_start_date, missionStatus: m.mission_status, dashboardToken: m.dashboard_token
      });
      return;
    }

    const params = new URLSearchParams({ email: m.missionary_email });
    if (m.missionary_name) params.set('name', m.missionary_name);
    if (m.dashboard_token) params.set('token', m.dashboard_token);

    const { currentPriceCents } = await getFoundingStatus();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: m.family_email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'The Bridge',
            description: m.missionary_name ? `${m.missionary_name}'s mission archive · Mission Bridge Archive` : 'Mission archive access · Mission Bridge Archive',
          },
          unit_amount: currentPriceCents,
        },
        quantity: 1,
      }],
      allow_promotion_codes: true,
      custom_text: {
        submit: {
          message: `We know $${(currentPriceCents / 100).toFixed(0)} can be a real stretch for missionary families. That's part of why there's a referral program waiting in your welcome email after this - share your code, and it can end up paying for itself, or more.`,
        },
      },
      metadata: { missionaryId: String(m.id), isNewSignup: 'true' },
      success_url: `https://getmissionbridge.com/welcome.html?${params.toString()}`,
      cancel_url: 'https://getmissionbridge.com/',
    });

    res.status(200).json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('Error signing up missionary:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Complete a preorder signup once the family has the missionary's
// actual info - fills in the row found by the private token.
app.post('/signup/complete', async (req, res) => {
  try {
    const { token, missionaryEmail, missionaryName, expectedReturnDate, missionStartDate, missionStatus } = req.body;
    if (!token || !missionaryEmail) {
      return res.status(400).json({ error: 'Token and missionary email are both required' });
    }

    const result = await pool.query(
      `UPDATE missionaries
       SET missionary_email = $1, missionary_name = $2, expected_return_date = $3,
           mission_start_date = $4, mission_status = $5, completion_token = NULL
       WHERE completion_token = $6 AND missionary_email IS NULL
       RETURNING *`,
      [
        missionaryEmail.toLowerCase().trim(),
        missionaryName || null,
        expectedReturnDate || null,
        missionStartDate || null,
        missionStatus || 'serving',
        token
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'This link has already been used or is invalid' });
    }

    const row = result.rows[0];

    if (!stripe) {
      res.status(200).json(row);
      await sendSignupEmails({
        missionaryEmail: row.missionary_email, missionaryName: row.missionary_name, familyEmail: row.family_email,
        missionStartDate: row.mission_start_date, missionStatus: row.mission_status, dashboardToken: row.dashboard_token
      });
      return;
    }

    const params = new URLSearchParams({ email: row.missionary_email });
    if (row.missionary_name) params.set('name', row.missionary_name);
    if (row.dashboard_token) params.set('token', row.dashboard_token);

    const { currentPriceCents } = await getFoundingStatus();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: row.family_email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'The Bridge',
            description: row.missionary_name ? `${row.missionary_name}'s mission archive · Mission Bridge Archive` : 'Mission archive access · Mission Bridge Archive',
          },
          unit_amount: currentPriceCents,
        },
        quantity: 1,
      }],
      allow_promotion_codes: true,
      custom_text: {
        submit: {
          message: `We know $${(currentPriceCents / 100).toFixed(0)} can be a real stretch for missionary families. That's part of why there's a referral program waiting in your welcome email after this - share your code, and it can end up paying for itself, or more.`,
        },
      },
      metadata: { missionaryId: String(row.id), isNewSignup: 'true' },
      success_url: `https://getmissionbridge.com/welcome.html?${params.toString()}`,
      cancel_url: 'https://getmissionbridge.com/',
    });

    res.status(200).json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('Error completing preorder signup:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Sends the standard pair of onboarding emails (family + missionary),
// shared by both the regular signup path and the preorder-completion
// path so the wording only lives in one place.
// Missionary-facing emails specifically try Gmail first, since that's
// a proven channel some institutional mail systems reject SendGrid's
// shared infrastructure for. Falls back to SendGrid automatically if
// the GMAIL_USER/GMAIL_APP_PASSWORD env vars haven't been set yet, so
// nothing breaks before that's configured.
async function sendMissionaryEmail(to, subject, text, html, emailType, trackingToken = null) {
  try {
    await sendEmailViaGmail(to, subject, text, html, emailType, trackingToken);
  } catch (gmailErr) {
    console.error(`Gmail send failed for ${to}, falling back to SendGrid:`, gmailErr.message);
    await sendEmail(to, subject, text, html, emailType, trackingToken);
  }
}

async function sendSignupEmails({ missionaryEmail, missionaryName, familyEmail, missionStartDate, missionStatus, dashboardToken, referralCode, targets = ['family', 'missionary'] }) {
  const cleanMissionaryEmail = missionaryEmail.toLowerCase().trim();
  const cleanFamilyEmail = familyEmail.toLowerCase().trim();
  // Prefer the private token link (not guessable the way an email
  // address is) - falls back to the email-based link only if a token
  // somehow isn't set yet, so onboarding never breaks either way.
  const dashboardUrl = dashboardToken
    ? `https://getmissionbridge.com/dashboard.html?token=${encodeURIComponent(dashboardToken)}`
    : `https://getmissionbridge.com/dashboard.html?email=${encodeURIComponent(cleanMissionaryEmail)}`;
  const guideUrl = 'https://getmissionbridge.com/photo-guide.html';
  const firstName = (missionaryName || '').trim().split(' ')[0];

  // If they're already out serving (not a brand-new signup right as
  // they leave), the single highest-value tip is making sure Partner
  // Sharing is set to catch photos from before signup too, not just
  // going forward. Worth a dedicated line rather than burying it.
  const midMissionNote = missionStatus === 'serving'
    ? `\n\nOne more thing, since they're already out serving: when you set up Partner Sharing in the guide above, make sure it's set to share ALL photos, not just "since a specific date" - otherwise anything from before today never gets backed up.`
    : '';
  const midMissionNoteHtml = missionStatus === 'serving'
    ? `<p><strong>One more thing,</strong> since they're already out serving: when you set up Partner Sharing in the guide above, make sure it's set to share <strong>all photos</strong>, not just "since a specific date" - otherwise anything from before today never gets backed up.</p>`
    : '';

  // Operation Wildfire: only included if a code actually got created
  // (best-effort, so a Stripe hiccup here should never hold up the
  // rest of onboarding).
  const referralNote = referralCode
    ? `\n\nOne more thing: you've got your own referral code — ${referralCode}. Share it with other missionary families you know. Anyone who uses it at signup gets $10 off, and you earn $10 every time someone does — enough referrals and this pays for itself, then starts paying you. We send payouts via PayPal once you've earned some.`
    : '';
  const referralNoteHtml = referralCode
    ? `<p><strong>One more thing:</strong> you've got your own referral code — <strong>${referralCode}</strong>. Share it with other missionary families you know. Anyone who uses it at signup gets $10 off, and you earn $10 every time someone does — enough referrals and this pays for itself, then starts paying you. We send payouts via PayPal once you've earned some.</p>`
    : '';

  // 1. Welcome email to the family, with the actual instructions -
  // not just a friendly note. This is the thing they'll still have
  // in their inbox after they close the signup tab.
  if (targets.includes('family')) {
  try {
    await sendEmail(
      cleanFamilyEmail,
      'Welcome to Mission Bridge Archive - here\'s what to do next',
      `Hi! I'm Tyler, the person behind Mission Bridge Archive. Thanks so much for giving this a try.\n\n` +
      `Here's exactly what happens next:\n\n` +
      `1. Tell your missionary to add this address to their regular email list: archive@parse.getmissionbridge.com. ` +
      `Any time they send their update home (with that address included), everything they write, plus any photos or voice memos they attach, gets saved automatically. Nothing else for them to do.\n\n` +
      `Best to tell them yourself directly, since some missionary email accounts don't reliably receive automated messages from us.\n\n` +
      `2. Your dashboard: ${dashboardUrl}\n` +
      `Save this link somewhere you'll remember, like your bookmarks bar or a note on your phone. There's no password. This exact link is the only way anyone sees your missionary's dashboard, so keep it private and only share it with people you trust.\n\n` +
      `3. Set up Google Photos Partner Sharing too: ${guideUrl}\n` +
      `Mission Bridge Archive saves everything they email home, but their phone holds a lot more photos than they'll ever email. Partner Sharing is the most foolproof way to catch everything else, and it's much easier to set up now than to fix it after the fact.${midMissionNote}${referralNote}\n\n` +
      `4. If anything looks off, an update doesn't show up, or you just have a question, email me anytime at tyler@getmissionbridge.com. I'd genuinely rather hear from you than have you wonder.\n\n` +
      `I built this because I wanted families to have one less thing to worry about during a mission. I hope it gives you some peace of mind.`,
      `<p>Hi! I'm Tyler, the person behind Mission Bridge Archive.</p>` +
      `<p>Thanks so much for giving this a try.</p>` +
      `<p><strong>Here's exactly what happens next:</strong></p>` +
      `<p><strong>1. Tell your missionary to add this address to their regular email list:</strong><br>` +
      `<code>archive@parse.getmissionbridge.com</code><br>` +
      `Any time they send their update home (with that address included), everything they write, plus any photos or voice memos they attach, gets saved automatically. Nothing else for them to do.</p>` +
      `<p>Best to tell them yourself directly, since some missionary email accounts don't reliably receive automated messages from us.</p>` +
      `<p><strong>2. Your dashboard:</strong><br>` +
      `<a href="${dashboardUrl}">${dashboardUrl}</a><br>` +
      `Save this link somewhere you'll remember, like your bookmarks bar or a note on your phone. There's no password. This exact link is the only way anyone sees your missionary's dashboard, so keep it private and only share it with people you trust.</p>` +
      `<p><strong>3. Set up Google Photos Partner Sharing too:</strong><br>` +
      `<a href="${guideUrl}">${guideUrl}</a><br>` +
      `Mission Bridge Archive saves everything they email home, but their phone holds a lot more photos than they'll ever email. Partner Sharing is the most foolproof way to catch everything else, and it's much easier to set up now than to fix it after the fact.</p>` +
      midMissionNoteHtml +
      referralNoteHtml +
      `<p><strong>4. If anything looks off,</strong> an update doesn't show up, or you just have a question, email me anytime at <a href="mailto:tyler@getmissionbridge.com">tyler@getmissionbridge.com</a>. I'd genuinely rather hear from you than have you wonder.</p>` +
      `<p>I built this because I wanted families to have one less thing to worry about during a mission. I hope it gives you some peace of mind.</p>`,
      'welcome'
    );
  } catch (mailErr) {
    console.error('Error sending welcome email:', mailErr);
  }
  }

  // 2. Short, simple email to the missionary themselves - they've
  // never heard of this before now. Includes the Partner Sharing
  // steps directly in the email rather than just linking out, since
  // this is a one-time setup they're more likely to actually do if
  // it's right in front of them.
  if (targets.includes('missionary')) {
  try {
    const trackingToken = crypto.randomBytes(16).toString('hex');
    const confirmUrl = `https://missionbridge-backend.onrender.com/track/confirm/${trackingToken}`;
    const pixelUrl = `https://missionbridge-backend.onrender.com/track/open/${trackingToken}`;

    await sendMissionaryEmail(
      cleanMissionaryEmail,
      'Your family set this up to save your emails home',
      `Hi${firstName ? ' ' + firstName : ''},\n\n` +
      `Your family signed up for Mission Bridge Archive, which automatically saves your emails, photos, and voice memos so nothing gets lost while you're serving. There's nothing for you to pay or set up beyond the one step below.\n\n` +
      `All you need to do: add this address to your regular email list, the same way you'd add anyone else you send your update to:\n\n` +
      `archive@parse.getmissionbridge.com\n\n` +
      `That's it for emails. Any time you email your update home with that address included, your message and anything you attach gets saved automatically. No app to download, nothing else to set up.\n\n` +
      `One more thing worth doing now, while you're already reading this: your phone holds a lot more photos than you'll ever email home. Google Photos has a free feature called Partner Sharing that backs those up automatically too. It only takes a minute:\n\n` +
      `1. Open Google Photos on your phone\n` +
      `2. Tap your profile picture (top right), then Partner Sharing\n` +
      `3. Tap Get Started and choose to share with your family's Google account email\n` +
      `4. When prompted, turn on "Auto save" - this is the setting that actually matters. Without it, photos are only shared, not copied.\n\n` +
      `Once that's on, everything's covered without you thinking about it again.\n\n` +
      `If you got this and everything makes sense, tap this link so we know it reached you: ${confirmUrl}\n\n` +
      `Questions? Your family can reach out to tyler@getmissionbridge.com anytime.`,
      `<p>Hi${firstName ? ' ' + firstName : ''},</p>` +
      `<p>Your family signed up for Mission Bridge Archive, which automatically saves your emails, photos, and voice memos so nothing gets lost while you're serving. There's nothing for you to pay or set up beyond the one step below.</p>` +
      `<p><strong>All you need to do:</strong> add this address to your regular email list, the same way you'd add anyone else you send your update to:</p>` +
      `<p><code>archive@parse.getmissionbridge.com</code></p>` +
      `<p>That's it for emails. Any time you email your update home with that address included, your message and anything you attach gets saved automatically. No app to download, nothing else to set up.</p>` +
      `<p><strong>One more thing worth doing now,</strong> while you're already reading this: your phone holds a lot more photos than you'll ever email home. Google Photos has a free feature called Partner Sharing that backs those up automatically too. It only takes a minute:</p>` +
      `<ol>` +
      `<li>Open Google Photos on your phone</li>` +
      `<li>Tap your profile picture (top right), then Partner Sharing</li>` +
      `<li>Tap Get Started and choose to share with your family's Google account email</li>` +
      `<li>When prompted, turn on <strong>"Auto save"</strong>. This is the setting that actually matters. Without it, photos are only shared, not copied.</li>` +
      `</ol>` +
      `<p>Once that's on, everything's covered without you thinking about it again.</p>` +
      `<p style="margin-top:20px;"><a href="${confirmUrl}" style="background:#C8745C;color:#F7F3EC;text-decoration:none;padding:12px 22px;border-radius:100px;font-weight:700;display:inline-block;">I got this, we're all set →</a></p>` +
      `<p>Questions? Your family can reach out to <a href="mailto:tyler@getmissionbridge.com">tyler@getmissionbridge.com</a> anytime.</p>` +
      `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="">`,
      'missionary_welcome',
      trackingToken
    );
  } catch (mailErr) {
    console.error('Error sending missionary welcome email:', mailErr);
  }
  }
}

// Waitlist signup endpoint - the landing page form will POST here
app.post('/waitlist', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Please try again in a few minutes.' }), async (req, res) => {
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

// Quick way to check waitlist signups (admin-only - used to have no auth,
// exposing everyone's email who joined the waitlist to anyone with the URL)
app.get('/waitlist', requireAdminKey, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM waitlist ORDER BY joined_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching waitlist:', err);
    res.status(500).send('Error fetching waitlist');
  }
});

// Resolves which missionary a customer-facing request is acting on
// behalf of, from either their email or their private dashboard token
// (whichever the caller has). There's no real account/session system
// here - this is the "proof of ownership" check for actions like
// deleting an item, matched against the actual database record by the
// caller, never just trusted at face value.
async function resolveRequestedMissionaryEmail(req) {
  const rawEmail = (req.query.missionaryEmail || req.body?.missionaryEmail || '').toLowerCase().trim();
  if (rawEmail) return rawEmail;

  const token = req.query.token || req.query.dashboardToken || req.body?.token;
  if (token) {
    const result = await pool.query(
      `SELECT missionary_email FROM missionaries WHERE dashboard_token = $1`,
      [token]
    );
    if (result.rows[0]?.missionary_email) {
      return result.rows[0].missionary_email.toLowerCase().trim();
    }
  }
  return null;
}

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
    const paidCustomerCount = await pool.query(`SELECT COUNT(*) FROM missionaries WHERE paid_amount > 0`);
    const totalExpenditures = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM expenditures`);
    const totalAttachmentSize = await pool.query(`SELECT COALESCE(SUM(size_bytes), 0) as total FROM attachments WHERE is_deleted = FALSE`);
    const totalEmails = await pool.query(`SELECT COUNT(*) FROM emails WHERE is_deleted = FALSE`);
    const waitlistCount = await pool.query(`SELECT COUNT(*) FROM waitlist`);

    const storageBytes = parseInt(totalAttachmentSize.rows[0].total, 10);
    const storageGB = (storageBytes / (1024 ** 3)).toFixed(3);
    const freeLimitGB = 10; // Cloudflare R2 free tier
    const percentOfFreeUsed = ((storageBytes / (1024 ** 3)) / freeLimitGB * 100).toFixed(2);

    const health = await runSystemHealthChecks();

    // Estimated, not exact - Stripe's real per-transaction fee isn't
    // stored anywhere (would need pulling each charge's balance
    // transaction from the Stripe API), so this approximates the
    // standard 2.9% + $0.30 rate against actual paid transactions,
    // just so "net profit" isn't quietly overstated.
    const revenueTotal = parseFloat(totalRevenue.rows[0].total);
    const paidCount = parseInt(paidCustomerCount.rows[0].count, 10);
    const estimatedStripeFees = paidCount > 0 ? (revenueTotal * 0.029) + (paidCount * 0.30) : 0;

    res.json({
      totalCustomers: parseInt(missionaryCount.rows[0].count, 10),
      totalRevenue: revenueTotal,
      totalExpenditures: parseFloat(totalExpenditures.rows[0].total),
      netProfit: revenueTotal - parseFloat(totalExpenditures.rows[0].total),
      estimatedStripeFees: parseFloat(estimatedStripeFees.toFixed(2)),
      netProfitAfterFees: parseFloat((revenueTotal - parseFloat(totalExpenditures.rows[0].total) - estimatedStripeFees).toFixed(2)),
      totalEmailsCaptured: parseInt(totalEmails.rows[0].count, 10),
      waitlistSignups: parseInt(waitlistCount.rows[0].count, 10),
      storage: {
        usedBytes: storageBytes,
        usedGB: parseFloat(storageGB),
        freeLimitGB,
        percentOfFreeUsed: parseFloat(percentOfFreeUsed),
      },
      systemHealth: {
        allOk: health.allOk,
        checks: health.checks,
        checkedAt: health.checkedAt,
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
          `SELECT id FROM emails WHERE sender_email = $1`,
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
          deletionRequestedAt: m.deletion_requested_at,
          missionStartDate: m.mission_start_date,
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
    const { paidAmount, notes, missionaryEmail, familyEmail } = req.body;
    await pool.query(
      `UPDATE missionaries SET
         paid_amount = COALESCE($1, paid_amount),
         notes = COALESCE($2, notes),
         missionary_email = COALESCE(NULLIF($3, ''), missionary_email),
         family_email = COALESCE(NULLIF($4, ''), family_email)
       WHERE id = $5`,
      [paidAmount, notes, missionaryEmail ? missionaryEmail.toLowerCase().trim() : null, familyEmail ? familyEmail.toLowerCase().trim() : null, req.params.id]
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

// Manually resend the onboarding email(s) for an existing customer,
// using today's live template rather than whatever was actually sent
// at signup time (we don't store historical email bodies). Useful for
// testing deliverability fixes or re-sending after a bounce, without
// re-running the whole signup form.
app.post('/admin/customers/:id/resend', requireAdminKey, async (req, res) => {
  try {
    const { target } = req.body; // 'family', 'missionary', or 'both'
    const result = await pool.query(`SELECT * FROM missionaries WHERE id = $1`, [req.params.id]);
    const m = result.rows[0];
    if (!m) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    if (!m.missionary_email) {
      return res.status(400).json({ error: 'No missionary email on file yet (still a preorder)' });
    }

    const targets = target === 'both' ? ['family', 'missionary'] : [target];
    res.json({ success: true });

    await sendSignupEmails({
      missionaryEmail: m.missionary_email,
      missionaryName: m.missionary_name,
      familyEmail: m.family_email,
      missionStartDate: m.mission_start_date,
      missionStatus: m.mission_status,
      dashboardToken: m.dashboard_token,
      targets
    });
  } catch (err) {
    console.error('Error resending onboarding email:', err);
    res.status(500).json({ error: 'Error resending email' });
  }
});

// Generates a one-off Stripe Checkout link for a specific customer at
// whatever amount Tyler chooses (e.g. $50 for founding customers, $75
// standard) - built around actual current operating mode (personal,
// curated outreach) rather than a generic public "buy now" flow.
// missionaryId is embedded in the session's metadata, which is how
// the webhook above knows which customer record to mark paid.
app.post('/admin/customers/:id/create-payment-link', requireAdminKey, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe is not configured yet - missing STRIPE_SECRET_KEY' });
    }
    const { amount } = req.body; // dollars, e.g. 50 or 75
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'A valid dollar amount is required' });
    }

    const result = await pool.query(`SELECT * FROM missionaries WHERE id = $1`, [req.params.id]);
    const m = result.rows[0];
    if (!m) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: m.family_email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'The Bridge',
            description: m.missionary_name ? `${m.missionary_name}'s mission archive · Mission Bridge Archive` : 'Mission archive access · Mission Bridge Archive',
          },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      }],
      metadata: { missionaryId: String(m.id) },
      success_url: 'https://getmissionbridge.com/payment-success.html',
      cancel_url: 'https://getmissionbridge.com/',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Error creating Stripe payment link:', err);
    res.status(500).json({ error: 'Error creating payment link' });
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

// Real, irreversible deletion - everything gone: R2 files, emails,
// attachments, dashboard view history, and the customer record
// itself. Deliberately separate from "kick," which is reversible and
// leaves data intact. Requires the exact missionary or family email
// to be typed as confirmation, checked here on the server too, not
// just in the admin UI, so this can't be triggered by a stray click
// or a replayed request.
app.post('/admin/customers/:id/delete-forever', requireAdminKey, async (req, res) => {
  try {
    const { confirmEmail } = req.body;
    const result = await pool.query(`SELECT * FROM missionaries WHERE id = $1`, [req.params.id]);
    const m = result.rows[0];
    if (!m) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const validConfirmations = [m.missionary_email, m.family_email].filter(Boolean).map(e => e.toLowerCase());
    if (!confirmEmail || !validConfirmations.includes(confirmEmail.toLowerCase().trim())) {
      return res.status(400).json({ error: 'Confirmation email did not match - nothing was deleted' });
    }

    // Delete the actual files from R2 first - best effort per file,
    // one failure shouldn't block the rest of the cleanup.
    if (m.missionary_email) {
      const attachmentsResult = await pool.query(
        `SELECT a.saved_as FROM attachments a
         JOIN emails e ON a.email_id = e.id
         WHERE e.sender_email = $1`,
        [m.missionary_email]
      );
      for (const row of attachmentsResult.rows) {
        try {
          await deleteFromR2(row.saved_as);
        } catch (err) {
          console.error(`Error deleting R2 file ${row.saved_as}:`, err.message);
        }
      }

      // Attachments cascade-delete automatically when their parent
      // email row is removed.
      await pool.query(
        `DELETE FROM emails WHERE sender_email = $1`,
        [m.missionary_email]
      );
      await pool.query(`DELETE FROM dashboard_views WHERE LOWER(missionary_email) = $1`, [m.missionary_email.toLowerCase()]);
    }

    await pool.query(`DELETE FROM missionaries WHERE id = $1`, [req.params.id]);

    console.log(`Permanently deleted customer #${req.params.id} (${m.missionary_email || m.family_email}) after confirmed request`);
    res.json({ success: true });
  } catch (err) {
    console.error('Error permanently deleting customer:', err);
    res.status(500).json({ error: 'Error deleting customer' });
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
      `SELECT COUNT(*) FROM email_log WHERE success = FALSE OR delivery_status IN ('bounce', 'dropped', 'blocked')`
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

// Operation Wildfire admin view: who's owed a referral payout, and
// how much. Payout itself stays manual (PayPal) - this just makes it
// visible instead of requiring a database query to check.
app.get('/admin/referrals', requireAdminKey, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        rc.id, rc.amount, rc.paid_out, rc.created_at,
        owner.id as owner_id, owner.missionary_name as owner_name, owner.family_email as owner_family_email, owner.referral_code,
        referred.missionary_name as referred_name
      FROM referral_credits rc
      JOIN missionaries owner ON rc.owner_missionary_id = owner.id
      JOIN missionaries referred ON rc.referred_missionary_id = referred.id
      ORDER BY rc.created_at DESC
    `);
    const totalOwed = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM referral_credits WHERE paid_out = FALSE`
    );
    res.json({
      credits: result.rows,
      totalOwed: parseFloat(totalOwed.rows[0].total),
    });
  } catch (err) {
    console.error('Error fetching referral credits:', err);
    res.status(500).json({ error: 'Error fetching referral credits' });
  }
});

app.post('/admin/referrals/:id/mark-paid', requireAdminKey, async (req, res) => {
  try {
    await pool.query(`UPDATE referral_credits SET paid_out = TRUE WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error marking referral credit paid:', err);
    res.status(500).json({ error: 'Error marking referral credit paid' });
  }
});

// Customer-facing: soft-delete an individual email/update (and its attachments).
// Requires proof of ownership (the missionary's email or their dashboard
// token) matched against the actual record - previously this had no
// check at all, meaning anyone who could guess a sequential ID could
// delete any customer's data.
app.delete('/dashboard/email/:emailId', async (req, res) => {
  try {
    const owner = await resolveRequestedMissionaryEmail(req);
    if (!owner) {
      return res.status(400).json({ error: 'missionaryEmail or token is required' });
    }
    const check = await pool.query(
      `SELECT id FROM emails WHERE id = $1 AND sender_email = $2`,
      [req.params.emailId, owner]
    );
    if (check.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to delete this item' });
    }
    await pool.query(`UPDATE emails SET is_deleted = TRUE WHERE id = $1`, [req.params.emailId]);
    await pool.query(`UPDATE attachments SET is_deleted = TRUE WHERE email_id = $1`, [req.params.emailId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting email:', err);
    res.status(500).json({ error: 'Error deleting item' });
  }
});

// Customer-facing: soft-delete a single attachment (e.g. just one photo).
// Same ownership check as above, joined through to the parent email.
app.delete('/dashboard/attachment/:attachmentId', async (req, res) => {
  try {
    const owner = await resolveRequestedMissionaryEmail(req);
    if (!owner) {
      return res.status(400).json({ error: 'missionaryEmail or token is required' });
    }
    const check = await pool.query(
      `SELECT a.id FROM attachments a JOIN emails e ON a.email_id = e.id WHERE a.id = $1 AND e.sender_email = $2`,
      [req.params.attachmentId, owner]
    );
    if (check.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to delete this item' });
    }
    await pool.query(`UPDATE attachments SET is_deleted = TRUE WHERE id = $1`, [req.params.attachmentId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting attachment:', err);
    res.status(500).json({ error: 'Error deleting item' });
  }
});

// Once a day, check for missionaries whose expected return date is
// coming up in roughly 25-35 days, and send the family a reminder
// pointing them to the Photo Rescue Guide if we haven't already.
// The 10-day window (rather than checking for exactly 30 days out)
// means a missionary won't be missed if this only runs once daily.
async function checkAndSendPhotoGuides() {
  try {
    const result = await pool.query(`
      SELECT m.* FROM missionaries m
      WHERE m.is_removed = FALSE
        AND m.expected_return_date IS NOT NULL
        AND m.expected_return_date BETWEEN CURRENT_DATE + INTERVAL '25 days' AND CURRENT_DATE + INTERVAL '35 days'
        AND NOT EXISTS (
          SELECT 1 FROM email_log e
          WHERE e.recipient = m.family_email AND e.email_type = 'photo_guide_reminder'
        )
    `);

    for (const m of result.rows) {
      const firstName = (m.missionary_name || '').trim().split(' ')[0] || 'your missionary';
      const guideUrl = 'https://getmissionbridge.com/photo-guide.html';
      try {
        await sendEmail(
          m.family_email,
          `A quick reminder before ${firstName} comes home`,
          `Hi! With ${firstName} coming home in about a month, now's the perfect time to make sure their photos are backed up too - not just what they've emailed home.\n\n` +
          `We put together a short guide covering the most common mistake families make (Google Photos Partner Sharing not actually saving anything) and a simple backup checklist for the last few weeks: ${guideUrl}\n\n` +
          `Takes about 10 minutes to check, and it's much easier to fix now than to discover a problem after they're already home.\n\n` +
          `Questions? Just reply to this email.`,
          `<p>Hi! With ${firstName} coming home in about a month, now's the perfect time to make sure their photos are backed up too - not just what they've emailed home.</p>` +
          `<p>We put together a short guide covering the most common mistake families make (Google Photos Partner Sharing not actually saving anything) and a simple backup checklist for the last few weeks:</p>` +
          `<p><a href="${guideUrl}">${guideUrl}</a></p>` +
          `<p>Takes about 10 minutes to check, and it's much easier to fix now than to discover a problem after they're already home.</p>` +
          `<p>Questions? Just reply to this email.</p>`,
          'photo_guide_reminder'
        );
        console.log(`Sent photo rescue guide reminder to ${m.family_email}`);
      } catch (err) {
        console.error(`Error sending photo guide reminder to ${m.family_email}:`, err);
      }
    }
  } catch (err) {
    console.error('Error checking for photo guide reminders:', err);
  }
}

// Once a day, check for missionaries whose expected return date
// passed at least a week ago and who haven't finished the
// end-of-mission checklist yet. Sends a warm "welcome home" email
// the first time, then a lighter weekly nudge after that, to both
// the family and the missionary, until all three checklist items
// are confirmed.
async function checkAndSendEndOfMissionEmails() {
  try {
    const result = await pool.query(`
      SELECT m.* FROM missionaries m
      WHERE m.is_removed = FALSE
        AND m.expected_return_date IS NOT NULL
        AND m.expected_return_date <= CURRENT_DATE - INTERVAL '7 days'
        AND m.missionary_email IS NOT NULL
        AND NOT (m.checklist_photos_confirmed AND m.checklist_downloads_confirmed AND m.checklist_deletion_confirmed)
        AND (m.last_reentry_email_sent_at IS NULL OR m.last_reentry_email_sent_at < NOW() - INTERVAL '7 days')
    `);

    for (const m of result.rows) {
      const firstName = (m.missionary_name || '').trim().split(' ')[0] || 'your missionary';
      const isFirstSend = !m.last_reentry_email_sent_at;

      // Generate a checklist token the first time we need one.
      let token = m.checklist_token;
      if (!token) {
        token = crypto.randomBytes(24).toString('hex');
        await pool.query(`UPDATE missionaries SET checklist_token = $1 WHERE id = $2`, [token, m.id]);
      }
      const checklistUrl = `https://getmissionbridge.com/checklist.html?token=${token}`;

      const familySubject = isFirstSend
        ? `Welcome home, ${firstName}! A few things to wrap up`
        : `Still a few things left on ${firstName}'s end-of-mission checklist`;
      const familyText = isFirstSend
        ? `Welcome home! Now that ${firstName}'s mission is wrapping up, there are a few things worth doing before we eventually wind down their Mission Bridge Archive account:\n\n` +
          `1. Double check Google Photos Partner Sharing actually captured everything (a quick guide is linked in the checklist below)\n` +
          `2. Download anything from the archive you want to keep for good\n` +
          `3. Confirm you're ready for us to close things out\n\n` +
          `We put all three into one simple checklist: ${checklistUrl}\n\n` +
          `No rush, and nothing gets deleted until you've confirmed you're ready.`
        : `Just a friendly nudge, since a few items are still unchecked on ${firstName}'s end-of-mission checklist: ${checklistUrl}\n\n` +
          `We'll keep checking in about once a week until everything's confirmed. No rush, just don't want anything to slip through the cracks.`;
      const familyHtml = isFirstSend
        ? `<p>Welcome home! Now that ${firstName}'s mission is wrapping up, there are a few things worth doing before we eventually wind down their Mission Bridge Archive account:</p>` +
          `<ol><li>Double check Google Photos Partner Sharing actually captured everything (a quick guide is linked in the checklist below)</li>` +
          `<li>Download anything from the archive you want to keep for good</li>` +
          `<li>Confirm you're ready for us to close things out</li></ol>` +
          `<p>We put all three into one simple checklist: <a href="${checklistUrl}">${checklistUrl}</a></p>` +
          `<p>No rush, and nothing gets deleted until you've confirmed you're ready.</p>`
        : `<p>Just a friendly nudge, since a few items are still unchecked on ${firstName}'s end-of-mission checklist: <a href="${checklistUrl}">${checklistUrl}</a></p>` +
          `<p>We'll keep checking in about once a week until everything's confirmed. No rush, just don't want anything to slip through the cracks.</p>`;

      try {
        await sendEmail(m.family_email, familySubject, familyText, familyHtml, 'reentry_checklist');
      } catch (err) {
        console.error(`Error sending reentry checklist email to family ${m.family_email}:`, err);
      }

      const missionarySubject = isFirstSend
        ? `Welcome home! Wrapping up your Mission Bridge Archive account`
        : `A few things left on your end-of-mission checklist`;
      const missionaryText = isFirstSend
        ? `Welcome home! Your family has a simple checklist to work through before your Mission Bridge Archive account eventually gets wound down, including making sure your photos are backed up and everything's downloaded: ${checklistUrl}\n\n` +
          `No rush at all.`
        : `Just a nudge that a few items are still open on the end-of-mission checklist your family's working through: ${checklistUrl}`;
      const missionaryHtml = isFirstSend
        ? `<p>Welcome home! Your family has a simple checklist to work through before your Mission Bridge Archive account eventually gets wound down, including making sure your photos are backed up and everything's downloaded: <a href="${checklistUrl}">${checklistUrl}</a></p><p>No rush at all.</p>`
        : `<p>Just a nudge that a few items are still open on the end-of-mission checklist your family's working through: <a href="${checklistUrl}">${checklistUrl}</a></p>`;

      try {
        await sendMissionaryEmail(m.missionary_email, missionarySubject, missionaryText, missionaryHtml, 'reentry_checklist');
      } catch (err) {
        console.error(`Error sending reentry checklist email to missionary ${m.missionary_email}:`, err);
      }

      await pool.query(`UPDATE missionaries SET last_reentry_email_sent_at = NOW() WHERE id = $1`, [m.id]);
      console.log(`Sent ${isFirstSend ? 'welcome home' : 'weekly reminder'} reentry checklist email for missionary #${m.id}`);
    }
  } catch (err) {
    console.error('Error checking for end-of-mission checklist emails:', err);
  }
}

// Once a day, check for anyone who should realistically be out
// serving by now - based on mission_start_date, not the mission_status
// field, which is only ever set once at signup and never updates
// itself. A family who signs up months before their missionary
// leaves picks "hasn't left yet," and that status stays frozen
// forever even after the missionary actually departs - checking the
// start date instead catches that case correctly. Missionaries only
// email once a week on their P-day, so this only fires after enough
// time for at least one real cycle - this isn't about first-week
// silence, which is completely normal, it's about genuinely nothing
// happening after a fair chance. Sends up to two nudges to the
// family (~10 days after their start date, then ~20), then stops -
// if it's still not working after that, it needs a real
// conversation, not another automated email.
async function checkAndSendNoUpdatesNudge() {
  try {
    const result = await pool.query(`
      SELECT m.* FROM missionaries m
      WHERE m.is_removed = FALSE
        AND m.mission_status != 'preorder'
        AND m.missionary_email IS NOT NULL
        AND m.mission_start_date IS NOT NULL
        AND m.mission_start_date <= CURRENT_DATE
        AND m.no_updates_nudge_count < 2
        AND NOT EXISTS (
          SELECT 1 FROM emails e WHERE e.sender_email = LOWER(m.missionary_email)
        )
        AND (
          (m.last_no_updates_nudge_at IS NULL AND m.mission_start_date <= CURRENT_DATE - INTERVAL '10 days')
          OR (m.last_no_updates_nudge_at IS NOT NULL AND m.last_no_updates_nudge_at <= NOW() - INTERVAL '10 days')
        )
    `);

    for (const m of result.rows) {
      const firstName = (m.missionary_name || '').trim().split(' ')[0] || 'your missionary';
      try {
        await sendEmail(
          m.family_email,
          `Haven't seen an update from ${firstName} yet`,
          `Hi! We haven't captured any emails from ${firstName} yet since you signed up.\n\n` +
          `This is usually just a quick fix: missionaries only get to email once a week (their "P-day"), and it's easy to forget to add a new address in a rushed, shared-computer window. Worth double-checking with them that they've added this exact address to who they send their weekly update to:\n\n` +
          `archive@parse.getmissionbridge.com\n\n` +
          `If they already have and it's still not showing up, just reply and we'll figure out what's going on.`,
          `<p>Hi! We haven't captured any emails from ${firstName} yet since you signed up.</p>` +
          `<p>This is usually just a quick fix: missionaries only get to email once a week (their "P-day"), and it's easy to forget to add a new address in a rushed, shared-computer window. Worth double-checking with them that they've added this exact address to who they send their weekly update to:</p>` +
          `<p><code>archive@parse.getmissionbridge.com</code></p>` +
          `<p>If they already have and it's still not showing up, just reply and we'll figure out what's going on.</p>`,
          'no_updates_nudge'
        );
      } catch (err) {
        console.error(`Error sending no-updates nudge to ${m.family_email}:`, err);
      }

      await pool.query(
        `UPDATE missionaries SET no_updates_nudge_count = no_updates_nudge_count + 1, last_no_updates_nudge_at = NOW() WHERE id = $1`,
        [m.id]
      );
      console.log(`Sent no-updates nudge #${m.no_updates_nudge_count + 1} for missionary #${m.id}`);
    }
  } catch (err) {
    console.error('Error checking for no-updates nudges:', err);
  }
}

// Same idea as the family nudge above, but sent directly to the
// missionary instead - on a slower 2-week cadence, capped at 2,
// routed through the Gmail-first path since this is missionary-facing.
// Short and low-friction on purpose: no reply expected, just the one
// action needed, matching what actually got a response on Facebook.
async function checkAndSendMissionaryNudge() {
  try {
    const result = await pool.query(`
      SELECT m.* FROM missionaries m
      WHERE m.is_removed = FALSE
        AND m.mission_status != 'preorder'
        AND m.missionary_email IS NOT NULL
        AND m.mission_start_date IS NOT NULL
        AND m.mission_start_date <= CURRENT_DATE
        AND m.missionary_nudge_count < 2
        AND NOT EXISTS (
          SELECT 1 FROM emails e WHERE e.sender_email = LOWER(m.missionary_email)
        )
        AND (
          (m.last_missionary_nudge_at IS NULL AND m.mission_start_date <= CURRENT_DATE - INTERVAL '14 days')
          OR (m.last_missionary_nudge_at IS NOT NULL AND m.last_missionary_nudge_at <= NOW() - INTERVAL '14 days')
        )
    `);

    for (const m of result.rows) {
      const firstName = (m.missionary_name || '').trim().split(' ')[0] || '';
      try {
        const trackingToken = crypto.randomBytes(16).toString('hex');
        const pixelUrl = `https://missionbridge-backend.onrender.com/track/open/${trackingToken}`;

        await sendMissionaryEmail(
          m.missionary_email,
          'Quick reminder - one email address to add',
          `Hi${firstName ? ' ' + firstName : ''}, quick reminder in case the first email got buried: ` +
          `add archive@parse.getmissionbridge.com to your list next time you email home. That's the only thing needed. No reply necessary.`,
          `<p>Hi${firstName ? ' ' + firstName : ''}, quick reminder in case the first email got buried: ` +
          `add <code>archive@parse.getmissionbridge.com</code> to your list next time you email home. That's the only thing needed. No reply necessary.</p>` +
          `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="">`,
          'missionary_nudge',
          trackingToken
        );
      } catch (err) {
        console.error(`Error sending missionary nudge to ${m.missionary_email}:`, err);
      }

      await pool.query(
        `UPDATE missionaries SET missionary_nudge_count = missionary_nudge_count + 1, last_missionary_nudge_at = NOW() WHERE id = $1`,
        [m.id]
      );
      console.log(`Sent missionary nudge #${m.missionary_nudge_count + 1} for missionary #${m.id}`);
    }
  } catch (err) {
    console.error('Error checking for missionary nudges:', err);
  }
}

// For preorder rows still waiting on a mission call - patient,
// low-frequency check-ins (every 30 days, capped at 3, so ~3 months)
// since getting a call is out of anyone's control and this isn't
// something to nag about on a short cycle.
async function checkAndSendPreorderNudge() {
  try {
    const result = await pool.query(`
      SELECT m.* FROM missionaries m
      WHERE m.is_removed = FALSE
        AND m.mission_status = 'preorder'
        AND m.missionary_email IS NULL
        AND m.completion_token IS NOT NULL
        AND m.preorder_nudge_count < 3
        AND (
          (m.last_preorder_nudge_at IS NULL AND m.created_at <= NOW() - INTERVAL '30 days')
          OR (m.last_preorder_nudge_at IS NOT NULL AND m.last_preorder_nudge_at <= NOW() - INTERVAL '30 days')
        )
    `);

    for (const m of result.rows) {
      const completeUrl = `https://getmissionbridge.com/complete-signup.html?token=${m.completion_token}`;
      try {
        await sendEmail(
          m.family_email,
          'Got your missionary\'s call yet?',
          `Hi! Just checking in, you reserved your spot with Mission Bridge Archive a while back before having your missionary's mission call and email.\n\n` +
          `If you have their info now, finish setting up here, takes about a minute: ${completeUrl}\n\n` +
          `If not yet, no rush at all, we'll check in again in a few weeks. Your spot's still reserved either way.`,
          `<p>Hi! Just checking in, you reserved your spot with Mission Bridge Archive a while back before having your missionary's mission call and email.</p>` +
          `<p>If you have their info now, finish setting up here, takes about a minute:</p>` +
          `<p><a href="${completeUrl}">${completeUrl}</a></p>` +
          `<p>If not yet, no rush at all, we'll check in again in a few weeks. Your spot's still reserved either way.</p>`,
          'preorder_nudge'
        );
      } catch (err) {
        console.error(`Error sending preorder nudge to ${m.family_email}:`, err);
      }

      await pool.query(
        `UPDATE missionaries SET preorder_nudge_count = preorder_nudge_count + 1, last_preorder_nudge_at = NOW() WHERE id = $1`,
        [m.id]
      );
      console.log(`Sent preorder nudge #${m.preorder_nudge_count + 1} for missionary #${m.id}`);
    }
  } catch (err) {
    console.error('Error checking for preorder nudges:', err);
  }
}

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Mission Bridge Archive backend listening on port ${PORT}`);
    });

    // Run shortly after startup (don't block server boot on it), then
    // once every 24 hours from then on.
    setTimeout(checkAndSendPhotoGuides, 30 * 1000);
    setInterval(checkAndSendPhotoGuides, 24 * 60 * 60 * 1000);
    setTimeout(checkAndSendEndOfMissionEmails, 45 * 1000);
    setInterval(checkAndSendEndOfMissionEmails, 24 * 60 * 60 * 1000);
    setTimeout(checkAndSendNoUpdatesNudge, 60 * 1000);
    setInterval(checkAndSendNoUpdatesNudge, 24 * 60 * 60 * 1000);
    setTimeout(checkAndSendMissionaryNudge, 75 * 1000);
    setInterval(checkAndSendMissionaryNudge, 24 * 60 * 60 * 1000);
    setTimeout(checkAndSendPreorderNudge, 90 * 1000);
    setInterval(checkAndSendPreorderNudge, 24 * 60 * 60 * 1000);
    setTimeout(checkSystemHealthAndAlert, 20 * 1000);
    setInterval(checkSystemHealthAndAlert, 15 * 60 * 1000);
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
