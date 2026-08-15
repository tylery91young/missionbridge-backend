const { Pool } = require('pg');
const crypto = require('crypto');

// Render will give us a DATABASE_URL environment variable automatically
// once we create a PostgreSQL database and link it to this service.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Creates our table if it doesn't already exist.
// Safe to run every time the server starts.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS emails (
      id SERIAL PRIMARY KEY,
      from_address TEXT NOT NULL,
      subject TEXT,
      body_text TEXT,
      received_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attachments (
      id SERIAL PRIMARY KEY,
      email_id INTEGER REFERENCES emails(id) ON DELETE CASCADE,
      original_name TEXT,
      saved_as TEXT,
      mime_type TEXT,
      size_bytes INTEGER
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS missionaries (
      id SERIAL PRIMARY KEY,
      missionary_email TEXT UNIQUE,
      missionary_name TEXT,
      family_email TEXT NOT NULL,
      family_phone TEXT,
      expected_return_date DATE,
      paid_amount NUMERIC DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Safe to run even if columns already exist - won't error or duplicate
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS paid_amount NUMERIC DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS notes TEXT;
  `);
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS family_phone TEXT;
  `);
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS expected_return_date DATE;
  `);
  // A rough (not exact) date the missionary started/starts serving -
  // lets us know at signup whether Partner Sharing needs the "all
  // photos, not since-a-date" warning right away.
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS mission_start_date DATE;
  `);
  // 'serving', 'not_yet_left', or 'preorder' - tracks which signup
  // path a family used, mainly for admin visibility.
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS mission_status TEXT;
  `);
  // For mid-mission signups specifically - the missionary already has
  // an established weekly email habit to change, unlike someone who
  // signs up before leaving. Tracks a couple of gentle nudges to the
  // family if nothing's been captured yet after a real chance to happen.
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS no_updates_nudge_count INTEGER DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS last_no_updates_nudge_at TIMESTAMPTZ;
  `);
  // Separate from the family nudge above - these go directly to the
  // missionary, on a slower 2-week cadence, capped at 2, in case the
  // family-side nudges alone aren't enough to get the address added.
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS missionary_nudge_count INTEGER DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS last_missionary_nudge_at TIMESTAMPTZ;
  `);
  // For preorder rows still waiting on a mission call - a slow,
  // patient check-in, since getting a call is out of their control
  // and nagging too often would just be annoying.
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS preorder_nudge_count INTEGER DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS last_preorder_nudge_at TIMESTAMPTZ;
  `);
  // Preorder rows are created with no missionary_email yet. This
  // token lets the family complete signup later via a private link
  // without needing to log in or remember anything else.
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS completion_token TEXT UNIQUE;
  `);
  // Existing databases were created before missionary_email was
  // nullable - relax the constraint so preorder rows can be inserted
  // without one. Safe to run repeatedly.
  await pool.query(`
    ALTER TABLE missionaries ALTER COLUMN missionary_email DROP NOT NULL;
  `);
  // End-of-mission checklist: a private token-based page lets the
  // family confirm photos are backed up, everything's downloaded,
  // and they're ready for the account to be wound down. Deletion is
  // deliberately NOT automated - deletion_requested_at just flags it
  // for manual review, so a real person always makes the final call.
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS checklist_token TEXT UNIQUE;
  `);
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS checklist_photos_confirmed BOOLEAN DEFAULT FALSE;
  `);
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS checklist_downloads_confirmed BOOLEAN DEFAULT FALSE;
  `);
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS checklist_deletion_confirmed BOOLEAN DEFAULT FALSE;
  `);
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;
  `);
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS last_reentry_email_sent_at TIMESTAMPTZ;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      joined_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenditures (
      id SERIAL PRIMARY KEY,
      description TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      category TEXT,
      spent_at DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Tracks every transactional email we send, so Tyler can see what
  // went out, to whom, and whether it succeeded - for proactive
  // error detection rather than finding out from an upset customer.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_log (
      id SERIAL PRIMARY KEY,
      recipient TEXT NOT NULL,
      email_type TEXT NOT NULL,
      subject TEXT,
      success BOOLEAN NOT NULL,
      error_message TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // "success" only tells us whether SendGrid accepted the send
  // request - it does NOT mean the email was actually delivered.
  // Bounces happen asynchronously afterward. These columns let a
  // SendGrid Event Webhook update the real outcome once it's known.
  await pool.query(`
    ALTER TABLE email_log ADD COLUMN IF NOT EXISTS sg_message_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE email_log ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'sent';
  `);
  await pool.query(`
    ALTER TABLE email_log ADD COLUMN IF NOT EXISTS delivery_detail TEXT;
  `);
  await pool.query(`
    ALTER TABLE email_log ADD COLUMN IF NOT EXISTS delivery_updated_at TIMESTAMPTZ;
  `);
  await pool.query(`
    ALTER TABLE email_log ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
  `);
  await pool.query(`
    ALTER TABLE email_log ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ;
  `);
  await pool.query(`
    ALTER TABLE email_log ADD COLUMN IF NOT EXISTS send_channel TEXT DEFAULT 'sendgrid';
  `);
  // Independent of SendGrid's own message ID - a token we generate
  // ourselves and embed directly in an email's content, so we can
  // track opens/clicks on Gmail-relayed mail too, which has no
  // built-in delivery or engagement webhook the way SendGrid does.
  await pool.query(`
    ALTER TABLE email_log ADD COLUMN IF NOT EXISTS tracking_token TEXT UNIQUE;
  `);
  await pool.query(`
    ALTER TABLE email_log ADD COLUMN IF NOT EXISTS click_confirmed_at TIMESTAMPTZ;
  `);

  // Tracks every time a dashboard is loaded, so Tyler can see real
  // engagement - not just "did they sign up" but "are they actually
  // checking it."
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_views (
      id SERIAL PRIMARY KEY,
      missionary_email TEXT NOT NULL,
      viewed_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Lets us "kick" a customer without permanently destroying their data -
  // their archive just stops being accessible, but nothing is deleted.
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS is_removed BOOLEAN DEFAULT FALSE;
  `);

  // Lets a family turn off downloads for anyone they share the link with,
  // while still letting them view everything beautifully.
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS allow_downloads BOOLEAN DEFAULT TRUE;
  `);

  // Lets a customer (or admin) soft-delete individual items.
  // Soft-deleted = hidden from view, not actually destroyed, so a
  // mistake or a warning-click can still be undone if needed.
  await pool.query(`
    ALTER TABLE emails ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
  `);
  await pool.query(`
    ALTER TABLE emails ADD COLUMN IF NOT EXISTS has_drive_link BOOLEAN DEFAULT FALSE;
  `);
  await pool.query(`
    ALTER TABLE emails ADD COLUMN IF NOT EXISTS detected_issue_type TEXT;
  `);
  await pool.query(`
    ALTER TABLE emails ADD COLUMN IF NOT EXISTS is_mostly_link BOOLEAN DEFAULT FALSE;
  `);
  await pool.query(`
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
  `);

  // The exact, parsed sender address (as opposed to from_address, which
  // stores the raw "Name <email>" header). Queries used to match a
  // missionary's emails via LIKE '%email%' against from_address, which
  // meant one missionary's address being a substring of another's
  // (e.g. smith@x.com inside johnsmith@x.com) could leak emails
  // between accounts. This column lets every lookup use an exact
  // match instead.
  await pool.query(`
    ALTER TABLE emails ADD COLUMN IF NOT EXISTS sender_email TEXT;
  `);
  // Backfill existing rows using the same parsing logic the inbound
  // webhook uses at insert time. Safe to run every boot - only
  // touches rows that don't have it yet.
  await pool.query(`
    UPDATE emails
    SET sender_email = LOWER(TRIM(COALESCE(substring(from_address from '<([^>]+)>'), from_address)))
    WHERE sender_email IS NULL;
  `);

  // A private, unguessable dashboard identifier so links don't have to
  // be the missionary's actual email address (which is guessable by
  // anyone the missionary has ever given it to). New signups get one
  // immediately; existing rows are backfilled below. The old
  // email-based dashboard route keeps working for links already sent.
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS dashboard_token TEXT UNIQUE;
  `);
  const needsDashboardToken = await pool.query(
    `SELECT id FROM missionaries WHERE dashboard_token IS NULL`
  );
  for (const row of needsDashboardToken.rows) {
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(`UPDATE missionaries SET dashboard_token = $1 WHERE id = $2`, [token, row.id]);
  }

  // Operation Wildfire: each paying customer gets a personal referral
  // code (their last name, deduped) tied to a real Stripe Promotion
  // Code. Only generated after payment confirms (see server.js), so
  // this column just needs to exist - nothing to backfill here.
  await pool.query(`
    ALTER TABLE missionaries ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
  `);

  // Tracks each $10 earned when someone signs up using another
  // customer's referral code. Payout stays manual (PayPal) at this
  // scale - paid_out just lets the admin panel show what's still owed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_credits (
      id SERIAL PRIMARY KEY,
      owner_missionary_id INTEGER REFERENCES missionaries(id) ON DELETE CASCADE,
      referred_missionary_id INTEGER REFERENCES missionaries(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL DEFAULT 10,
      paid_out BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('Database tables ready.');
}

module.exports = { pool, initDb };
