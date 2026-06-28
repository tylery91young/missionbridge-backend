const sgMail = require('@sendgrid/mail');
const { pool } = require('./db');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * Sends a transactional email and logs the attempt (success or failure)
 * to the database, so Tyler can see what's actually going out and
 * catch problems before a customer has to tell him about them.
 *
 * emailType is a short label like 'welcome', 'drive_link_alert',
 * 'dashboard_recovery' - used to filter the log later.
 */
async function sendEmail(to, subject, text, html, emailType = 'general') {
  try {
    await sgMail.send({
      to,
      from: 'tyler@getmissionbridge.com',
      subject,
      text,
      html,
    });

    await pool.query(
      `INSERT INTO email_log (recipient, email_type, subject, success) VALUES ($1, $2, $3, $4)`,
      [to, emailType, subject, true]
    );
  } catch (err) {
    // Still log the failure - this is exactly the kind of thing
    // Tyler wants visibility into, not just a console error that
    // disappears into Render's logs.
    await pool.query(
      `INSERT INTO email_log (recipient, email_type, subject, success, error_message) VALUES ($1, $2, $3, $4, $5)`,
      [to, emailType, subject, false, err.message || String(err)]
    );
    throw err; // let the caller's existing try/catch still handle it too
  }
}

module.exports = { sendEmail };
