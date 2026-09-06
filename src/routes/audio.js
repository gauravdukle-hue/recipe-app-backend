import express from 'express';
import db from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { parseRecipeDescription } from '../utils/claude.js';

// NOTE: named import with braces. middleware/auth.js uses `export const
// authMiddleware`. A default import crashes the whole server at startup and
// shows up in the browser as 502s on every endpoint, including login.

const router = express.Router();

// Nudge the transcription worker over Railway's private network so an upload
// is picked up at once instead of waiting for its next poll. Fire and forget:
// the worker polls anyway, so a failed ping only costs a little latency.
function wakeWorker() {
  const url = process.env.WORKER_URL;
  if (!url) return;
  fetch(`${url.replace(/\/$/, '')}/wake`, {
    method: 'POST',
    signal: AbortSignal.timeout(3000)
  }).catch(() => {});
}

// Upload a recording for a recipe.
router.post('/:recipeId', authMiddleware, async (req, res) => {
  try {
    const { recipeId } = req.params;
    const { audio_data, duration_seconds, sample_rate, language } = req.body;
    const user_id = req.user.user_id;

    if (!audio_data) {
      return res.status(400).json({ error: 'audio_data required' });
    }

    const owner = await db.query('SELECT id FROM recipes WHERE id = $1', [recipeId]);
    if (owner.rows.length === 0) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    const result = await db.query(
      `INSERT INTO recipe_audio
         (recipe_id, user_id, audio_data, duration_seconds, sample_rate, language)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, duration_seconds, created_at`,
      [
        recipeId,
        user_id,
        audio_data,
        duration_seconds || null,
        sample_rate || 16000,
        language || 'gom'
      ]
    );

    wakeWorker();

    res.status(201).json({
      audio_id: result.rows[0].id,
      duration_seconds: result.rows[0].duration_seconds,
      message: 'Recording uploaded'
    });
  } catch (err) {
    console.error('Audio upload failed:', err);
    res.status(500).json({ error: 'Failed to save recording' });
  }
});

// Metadata for a recipe's recordings. Deliberately excludes audio_data so the
// recipe detail screen doesn't pull megabytes it isn't going to play.
router.get('/:recipeId', authMiddleware, async (req, res) => {
  try {
    const { recipeId } = req.params;
    const result = await db.query(
      `SELECT id, duration_seconds, sample_rate, language, transcript,
              transcribed_at, created_at
         FROM recipe_audio
        WHERE recipe_id = $1
        ORDER BY created_at DESC`,
      [recipeId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Audio list failed:', err);
    res.status(500).json({ error: 'Failed to load recordings' });
  }
});

// The actual bytes, base64. Used for playback and by the transcription worker.
router.get('/file/:audioId', authMiddleware, async (req, res) => {
  try {
    const { audioId } = req.params;
    const result = await db.query(
      'SELECT id, audio_data, sample_rate, language FROM recipe_audio WHERE id = $1',
      [audioId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Recording not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Audio fetch failed:', err);
    res.status(500).json({ error: 'Failed to load recording' });
  }
});

// Everything awaiting transcription. The Mac Mini worker polls this.
router.get('/queue/pending', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT a.id, a.recipe_id, a.duration_seconds, a.language, a.created_at,
              r.title
         FROM recipe_audio a
         JOIN recipes r ON r.id = a.recipe_id
        WHERE a.transcribed_at IS NULL
        ORDER BY a.created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Pending queue failed:', err);
    res.status(500).json({ error: 'Failed to load queue' });
  }
});

// Put a recording back in the queue. This exists so nobody has to open a
// database console to unstick a recipe — which is what the alternative was.
router.post('/:audioId/retry', authMiddleware, async (req, res) => {
  try {
    const { audioId } = req.params;
    const owner = await db.query(
      `SELECT r.owner_id FROM recipe_audio a JOIN recipes r ON r.id = a.recipe_id
        WHERE a.id = $1`,
      [audioId]
    );
    if (owner.rows.length === 0) return res.status(404).json({ error: 'Recording not found' });
    if (owner.rows[0].owner_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Not your recipe' });
    }

    const { language } = req.body;

    await db.query(
      `UPDATE recipe_audio
          SET transcribed_at = NULL,
              transcribe_error = NULL,
              transcribe_attempts = 0,
              language_retried = FALSE,
              language = COALESCE($1, language)
        WHERE id = $2`,
      [language || null, audioId]
    );

    res.json({ message: 'Queued again' });
  } catch (error) {
    console.error('Retry failed:', error);
    res.status(500).json({ error: 'Could not queue that recording' });
  }
});

// Transcription write-back from the worker.
router.patch('/:audioId/transcript', authMiddleware, async (req, res) => {
  try {
    const { audioId } = req.params;
    const { transcript, error_message, language_used } = req.body;

    if (error_message) {
      // "final" means the worker got no text at all. That looked like a
      // permanent wrong-language failure, but it also happens intermittently —
      // the same recording came back empty once and transcribed fine on the
      // next run. So give it a few goes before calling it done, or a hiccup
      // becomes a recipe that needs unsticking by hand.
      if (req.body.final) {
        const bumped = await db.query(
          `UPDATE recipe_audio
              SET transcribe_attempts = COALESCE(transcribe_attempts, 0) + 1,
                  transcribe_error = $1
            WHERE id = $2
            RETURNING transcribe_attempts`,
          [error_message, audioId]
        );

        const attempts = bumped.rows[0]?.transcribe_attempts || 1;
        const MAX_ATTEMPTS = 3;

        if (attempts >= MAX_ATTEMPTS) {
          await db.query(
            `UPDATE recipe_audio
                SET transcribed_at = NOW(),
                    transcribe_error = $1
              WHERE id = $2`,
            [`${error_message} (tried ${attempts} times)`, audioId]
          );
          return res.json({ message: 'Given up', attempts });
        }

        // Left pending, so the next poll picks it up again.
        return res.json({ message: 'Will retry', attempts });
      }

      await db.query(
        'UPDATE recipe_audio SET transcribe_error = $1 WHERE id = $2',
        [error_message, audioId]
      );
      return res.json({ message: 'Error recorded' });
    }

    if (typeof transcript !== 'string') {
      return res.status(400).json({ error: 'transcript required' });
    }

    if (language_used) {
      await db.query('UPDATE recipe_audio SET language = $1 WHERE id = $2', [language_used, audioId]);
    }

    const result = await db.query(
      `UPDATE recipe_audio
          SET transcript = $1, transcribed_at = NOW(), transcribe_error = NULL
        WHERE id = $2
        RETURNING id, recipe_id, language, language_retried`,
      [transcript, audioId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    const recipe_id = result.rows[0].recipe_id;

    // The transcript is now the recipe's description, replacing the
    // placeholder written when the recording was saved. Only overwrite a
    // placeholder — never clobber text someone actually typed or corrected.
    const existing = await db.query(
      'SELECT description FROM recipes WHERE id = $1',
      [recipe_id]
    );
    const current = existing.rows[0]?.description || '';
    const isPlaceholder = !current.trim() || /transcription pending/i.test(current);

    let parsed = { ingredients: [], steps: [] };

    if (isPlaceholder && transcript.trim()) {
      await db.query('UPDATE recipes SET description = $1 WHERE id = $2', [transcript, recipe_id]);

      // Re-parsing is safe to repeat: clear any prior rows first so a second
      // transcription doesn't duplicate every ingredient.
      await db.query('DELETE FROM ingredients WHERE recipe_id = $1', [recipe_id]);
      await db.query('DELETE FROM steps WHERE recipe_id = $1', [recipe_id]);

      parsed = await parseRecipeDescription(transcript, result.rows[0].language);

      await db.query('UPDATE recipes SET glossary = $1 WHERE id = $2',
        [JSON.stringify(parsed.glossary || []), recipe_id]);

      for (const ing of parsed.ingredients) {
        const amount = (ing.amount && ing.amount.toString().trim()) ? parseFloat(ing.amount) : null;
        await db.query(
          'INSERT INTO ingredients (recipe_id, name, amount, unit) VALUES ($1, $2, $3, $4)',
          [recipe_id, ing.name || 'Unknown', Number.isNaN(amount) ? null : amount, ing.unit || '']
        );
      }

      for (let i = 0; i < parsed.steps.length; i++) {
        await db.query(
          'INSERT INTO steps (recipe_id, step_number, instruction) VALUES ($1, $2, $3)',
          [recipe_id, i + 1, parsed.steps[i].instruction || parsed.steps[i]]
        );
      }
    }

    // Hindi spoken into a Konkani model produces plausible Devanagari rather
    // than an empty result, so there is no failure to catch — only Claude
    // reading the text can tell. One retry, tracked by a flag, so a model that
    // keeps disagreeing can't put this in a loop.
    const row = result.rows[0];
    const mismatch = parsed.language_mismatch;
    let requeued = false;

    if (mismatch && mismatch !== row.language && !row.language_retried) {
      await db.query(
        `UPDATE recipe_audio
            SET language = $1, transcribed_at = NULL, language_retried = TRUE
          WHERE id = $2`,
        [mismatch, audioId]
      );
      requeued = true;
      console.log(`Audio ${audioId}: looks like ${mismatch}, not ${row.language} — re-queued`);
    }

    res.json({
      message: 'Transcript saved',
      recipe_id,
      requeued_as: requeued ? mismatch : null,
      parsed_ingredients: parsed.ingredients.length,
      parsed_steps: parsed.steps.length,
      description_updated: isPlaceholder
    });
  } catch (err) {
    console.error('Transcript write failed:', err);
    res.status(500).json({ error: 'Failed to save transcript' });
  }
});

export default router;
