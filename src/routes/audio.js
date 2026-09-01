import express from 'express';
import db from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { parseRecipeDescription } from '../utils/claude.js';

// NOTE: named import with braces. middleware/auth.js uses `export const
// authMiddleware`. A default import crashes the whole server at startup and
// shows up in the browser as 502s on every endpoint, including login.

const router = express.Router();

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

// Transcription write-back from the worker.
router.patch('/:audioId/transcript', authMiddleware, async (req, res) => {
  try {
    const { audioId } = req.params;
    const { transcript, error_message } = req.body;

    if (error_message) {
      await db.query(
        'UPDATE recipe_audio SET transcribe_error = $1 WHERE id = $2',
        [error_message, audioId]
      );
      return res.json({ message: 'Error recorded' });
    }

    if (typeof transcript !== 'string') {
      return res.status(400).json({ error: 'transcript required' });
    }

    const result = await db.query(
      `UPDATE recipe_audio
          SET transcript = $1, transcribed_at = NOW(), transcribe_error = NULL
        WHERE id = $2
        RETURNING id, recipe_id`,
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

      parsed = await parseRecipeDescription(transcript);

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

    res.json({
      message: 'Transcript saved',
      recipe_id,
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
