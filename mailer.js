const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');
const { pool } = require('./db');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

let gmailTransporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  gmailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

/**
 * Sends a transactional email and logs the attempt (success or failure)
 * to the database, so Tyler can see what's actually going out and
 * catch problems before a customer has to tell him about them.
 *
 * emailType is a short label like 'welcome', 'drive_link_alert',
 * 'dashboard_recovery' - used to filter the log later.
 */
async function sendEmail(to, subject, text, html, emailType = 'general', trackingToken = null) {
  try {
    const response = await sgMail.send({
      to,
      from: { email: 'tyler@getmissionbridge.com', name: 'Mission Bridge Archive' },
      subject,
      text,
      html,
    });

    // SendGrid returns the message ID in a response header - this is
    // the same ID shown in their Activity Feed, and it's what lets us
    // match up a later bounce/delivered webhook event to this exact
    // email. It's sometimes wrapped in angle brackets, so strip those.
    const rawMessageId = response?.[0]?.headers?.['x-message-id'] || null;
    const sgMessageId = rawMessageId ? rawMessageId.replace(/[<>]/g, '') : null;

    await pool.query(
      `INSERT INTO email_log (recipient, email_type, subject, success, sg_message_id, send_channel, tracking_token) VALUES ($1, $2, $3, $4, $5, 'sendgrid', $6)`,
      [to, emailType, subject, true, sgMessageId, trackingToken]
    );
  } catch (err) {
    // Still log the failure - this is exactly the kind of thing
    // Tyler wants visibility into, not just a console error that
    // disappears into Render's logs.
    await pool.query(
      `INSERT INTO email_log (recipient, email_type, subject, success, error_message, send_channel, tracking_token) VALUES ($1, $2, $3, $4, $5, 'sendgrid', $6)`,
      [to, emailType, subject, false, err.message || String(err), trackingToken]
    );
    throw err; // let the caller's existing try/catch still handle it too
  }
}

/**
 * Sends an email through a real Gmail account instead of SendGrid's
 * shared sending infrastructure. This exists specifically for
 * institutionally-managed inboxes (like missionary email accounts)
 * that reject mail from bulk-sending platforms even when properly
 * authenticated. A personal Gmail account has a completely different
 * reputation profile, and Tyler's own Gmail is a proven channel that
 * already reaches these accounts.
 *
 * Requires GMAIL_USER and GMAIL_APP_PASSWORD environment variables -
 * an actual Gmail account with 2-Step Verification enabled and an
 * App Password generated for this specifically (a regular Gmail
 * password will not work here).
 *
 * Unlike SendGrid, a hard rejection here throws immediately at send
 * time rather than arriving later as an async bounce event, so we
 * find out right away whether it worked. Delivery/open tracking
 * doesn't exist for Gmail SMTP the way it does for SendGrid, so
 * trackingToken (an open pixel + click-confirm link embedded in the
 * email itself) is how we get any visibility at all here.
 */
async function sendEmailViaGmail(to, subject, text, html, emailType = 'general', trackingToken = null) {
  if (!gmailTransporter) {
    const err = new Error('Gmail relay not configured - missing GMAIL_USER or GMAIL_APP_PASSWORD');
    await pool.query(
      `INSERT INTO email_log (recipient, email_type, subject, success, error_message, send_channel, tracking_token) VALUES ($1, $2, $3, $4, $5, 'gmail', $6)`,
      [to, emailType, subject, false, err.message, trackingToken]
    );
    throw err;
  }

  try {
    await gmailTransporter.sendMail({
      from: `"Mission Bridge Archive" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      text,
      html,
    });

    await pool.query(
      `INSERT INTO email_log (recipient, email_type, subject, success, delivery_status, send_channel, tracking_token) VALUES ($1, $2, $3, $4, 'delivered', 'gmail', $5)`,
      [to, emailType, subject, true, trackingToken]
    );
  } catch (err) {
    await pool.query(
      `INSERT INTO email_log (recipient, email_type, subject, success, error_message, send_channel, tracking_token) VALUES ($1, $2, $3, $4, $5, 'gmail', $6)`,
      [to, emailType, subject, false, err.message || String(err), trackingToken]
    );
    throw err;
  }
}

module.exports = { sendEmail, sendEmailViaGmail };
