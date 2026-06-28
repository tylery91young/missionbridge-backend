const { Pool } = require('pg');

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
      missionary_email TEXT NOT NULL UNIQUE,
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

  console.log('Database tables ready.');
}

module.exports = { pool, initDb };
