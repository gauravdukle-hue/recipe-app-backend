import db from '../config/db.js';

// Standalone and idempotent. Does NOT run schema.sql, which has drifted from
// the live database (photos is declared with image_url there but the app uses
// photo_data, and several CREATE INDEX statements lack IF NOT EXISTS).
// Safe to run more than once.

const SQL = `
CREATE TABLE IF NOT EXISTS recipe_audio (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  audio_data TEXT NOT NULL,
  duration_seconds NUMERIC(8,2),
  sample_rate INT DEFAULT 16000,
  language VARCHAR(20) DEFAULT 'gom',
  transcript TEXT,
  transcribed_at TIMESTAMP,
  transcribe_error TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recipe_audio_recipe_id ON recipe_audio(recipe_id);
CREATE INDEX IF NOT EXISTS idx_recipe_audio_pending ON recipe_audio(created_at) WHERE transcribed_at IS NULL;
`;

async function run() {
  try {
    console.log('Creating recipe_audio table...');
    await db.query(SQL);

    const check = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'recipe_audio' ORDER BY ordinal_position`
    );
    console.log('recipe_audio columns:');
    check.rows.forEach((r) => console.log(`  ${r.column_name} (${r.data_type})`));
    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

run();
