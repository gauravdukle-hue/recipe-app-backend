import express from 'express';
import db from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { parseRecipeDescription } from '../utils/claude.js';

const router = express.Router();

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { title, description, cuisine_tag } = req.body;
    const user_id = req.user.user_id;

    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description required' });
    }

    // Create the recipe row FIRST. Parsing is enrichment, not a gate — a
    // recipe that Claude can't parse (audio-only, unusual phrasing) must
    // still save, or the recording has nothing to attach to.
    const recipeResult = await db.query(
      'INSERT INTO recipes (owner_id, title, description, cuisine_tag) VALUES ($1, $2, $3, $4) RETURNING id, title',
      [user_id, title, description, cuisine_tag]
    );

    const recipe_id = recipeResult.rows[0].id;

    const parsed = await parseRecipeDescription(description);

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

    res.status(201).json({
      recipe_id,
      title: recipeResult.rows[0].title,
      ingredients: parsed.ingredients,
      steps: parsed.steps,
      message: 'Recipe created successfully'
    });
  } catch (error) {
    console.error('Create recipe error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/', authMiddleware, async (req, res) => {
  try {
    const { view = 'all', search } = req.query;
    const user_id = req.user.user_id;

    let query = `
      SELECT r.id, r.title, r.cuisine_tag, r.owner_id, u.name as owner_name, r.created_at,
             (SELECT COUNT(*) FROM ingredients WHERE recipe_id = r.id) as ingredient_count,
             (SELECT COUNT(*) FROM steps WHERE recipe_id = r.id) as step_count
      FROM recipes r JOIN users u ON r.owner_id = u.id WHERE r.deleted_at IS NULL
    `;
    const params = [];

    if (view === 'mine') {
      query += ' AND r.owner_id = $1';
      params.push(user_id);
    } else if (view === 'shared') {
      query += ' AND r.id IN (SELECT recipe_id FROM recipe_shares WHERE shared_with_user_id = $1)';
      params.push(user_id);
    }

    if (search) {
      query += ` AND (r.title ILIKE $${params.length + 1} OR r.cuisine_tag ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    query += ' ORDER BY r.created_at DESC';
    const result = await db.query(query, params);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Get recipes error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.user.user_id;

    const recipeResult = await db.query(
      'SELECT r.*, u.name as owner_name FROM recipes r JOIN users u ON r.owner_id = u.id WHERE r.id = $1 AND r.deleted_at IS NULL',
      [id]
    );

    if (recipeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    const recipe = recipeResult.rows[0];
    const ingredientsResult = await db.query('SELECT * FROM ingredients WHERE recipe_id = $1 ORDER BY id', [id]);
    const stepsResult = await db.query('SELECT * FROM steps WHERE recipe_id = $1 ORDER BY step_number', [id]);

    res.status(200).json({
      ...recipe,
      ingredients: ingredientsResult.rows,
      steps: stepsResult.rows,
      can_edit: recipe.owner_id === user_id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, cuisine_tag } = req.body;
    const user_id = req.user.user_id;

    const checkResult = await db.query('SELECT owner_id FROM recipes WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) return res.status(404).json({ error: 'Recipe not found' });
    if (checkResult.rows[0].owner_id !== user_id) return res.status(403).json({ error: 'Unauthorized' });

    const before = await db.query('SELECT description FROM recipes WHERE id = $1', [id]);
    const descriptionChanged = (before.rows[0]?.description || '') !== (description || '');

    await db.query('UPDATE recipes SET title = $1, description = $2, cuisine_tag = $3 WHERE id = $4',
      [title, description, cuisine_tag, id]);

    // Correcting a transcript is the main reason to edit, so the ingredients
    // and steps have to be re-read from the new text — otherwise fixing a
    // mangled ingredient name changes nothing anyone can see.
    let parsed = { ingredients: [], steps: [] };

    if (descriptionChanged && description && description.trim()) {
      parsed = await parseRecipeDescription(description);

      await db.query('UPDATE recipes SET glossary = $1 WHERE id = $2',
        [JSON.stringify(parsed.glossary || []), id]);

      await db.query('DELETE FROM ingredients WHERE recipe_id = $1', [id]);
      await db.query('DELETE FROM steps WHERE recipe_id = $1', [id]);

      for (const ing of parsed.ingredients) {
        const amount = (ing.amount && ing.amount.toString().trim()) ? parseFloat(ing.amount) : null;
        await db.query(
          'INSERT INTO ingredients (recipe_id, name, amount, unit) VALUES ($1, $2, $3, $4)',
          [id, ing.name || 'Unknown', Number.isNaN(amount) ? null : amount, ing.unit || '']
        );
      }

      for (let i = 0; i < parsed.steps.length; i++) {
        await db.query(
          'INSERT INTO steps (recipe_id, step_number, instruction) VALUES ($1, $2, $3)',
          [id, i + 1, parsed.steps[i].instruction || parsed.steps[i]]
        );
      }
    }

    res.status(200).json({
      message: 'Recipe updated',
      reparsed: descriptionChanged,
      ingredients: parsed.ingredients.length,
      steps: parsed.steps.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.user.user_id;

    const checkResult = await db.query('SELECT owner_id FROM recipes WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) return res.status(404).json({ error: 'Recipe not found' });
    if (checkResult.rows[0].owner_id !== user_id) return res.status(403).json({ error: 'Unauthorized' });

    await db.query('UPDATE recipes SET deleted_at = NOW() WHERE id = $1', [id]);
    res.status(200).json({ message: 'Recipe deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Sharing -------------------------------------------------------------

async function assertOwner(recipe_id, user_id) {
  const r = await db.query('SELECT owner_id FROM recipes WHERE id = $1', [recipe_id]);
  if (r.rows.length === 0) return 'missing';
  return r.rows[0].owner_id === user_id ? 'ok' : 'forbidden';
}

router.get('/:id/shares', authMiddleware, async (req, res) => {
  try {
    const status = await assertOwner(req.params.id, req.user.user_id);
    if (status === 'missing') return res.status(404).json({ error: 'Recipe not found' });
    if (status === 'forbidden') return res.status(403).json({ error: 'Not your recipe' });

    const result = await db.query(
      `SELECT u.id, u.name, u.email
         FROM recipe_shares s JOIN users u ON u.id = s.shared_with_user_id
        WHERE s.recipe_id = $1
        ORDER BY u.name`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Share list failed:', error);
    res.status(500).json({ error: 'Could not load sharing' });
  }
});

router.post('/:id/shares', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const email = (req.body.email || '').trim().toLowerCase();

    const status = await assertOwner(id, req.user.user_id);
    if (status === 'missing') return res.status(404).json({ error: 'Recipe not found' });
    if (status === 'forbidden') return res.status(403).json({ error: 'Not your recipe' });

    if (!email) return res.status(400).json({ error: 'An email is needed' });

    const person = await db.query('SELECT id, name FROM users WHERE lower(email) = $1', [email]);
    if (person.rows.length === 0) {
      // Saying so is necessary here — otherwise the owner has no way to know
      // why nothing happened. They need to sign in once before being shared with.
      return res.status(404).json({ error: 'No account with that email yet. Ask them to sign in once first.' });
    }

    if (person.rows[0].id === req.user.user_id) {
      return res.status(400).json({ error: 'This is already your recipe' });
    }

    await db.query(
      `INSERT INTO recipe_shares (recipe_id, shared_with_user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [id, person.rows[0].id]
    );

    res.status(201).json({ message: 'Shared', name: person.rows[0].name });
  } catch (error) {
    console.error('Share failed:', error);
    res.status(500).json({ error: 'Could not share this recipe' });
  }
});

router.delete('/:id/shares/:userId', authMiddleware, async (req, res) => {
  try {
    const status = await assertOwner(req.params.id, req.user.user_id);
    if (status === 'missing') return res.status(404).json({ error: 'Recipe not found' });
    if (status === 'forbidden') return res.status(403).json({ error: 'Not your recipe' });

    await db.query(
      'DELETE FROM recipe_shares WHERE recipe_id = $1 AND shared_with_user_id = $2',
      [req.params.id, req.params.userId]
    );
    res.json({ message: 'Sharing removed' });
  } catch (error) {
    console.error('Unshare failed:', error);
    res.status(500).json({ error: 'Could not update sharing' });
  }
});

const REACTIONS = ['like', 'love'];

// Counts for a recipe, plus which ones this user has already given.
async function reactionSummary(recipe_id, user_id) {
  const counts = await db.query(
    `SELECT reaction, COUNT(*)::int AS count
       FROM recipe_reactions WHERE recipe_id = $1 GROUP BY reaction`,
    [recipe_id]
  );
  const mine = await db.query(
    'SELECT reaction FROM recipe_reactions WHERE recipe_id = $1 AND user_id = $2',
    [recipe_id, user_id]
  );

  const summary = { like: 0, love: 0, mine: [] };
  counts.rows.forEach((r) => { summary[r.reaction] = r.count; });
  summary.mine = mine.rows.map((r) => r.reaction);
  return summary;
}

router.get('/:id/reactions', authMiddleware, async (req, res) => {
  try {
    res.json(await reactionSummary(req.params.id, req.user.user_id));
  } catch (error) {
    console.error('Reaction fetch failed:', error);
    res.status(500).json({ error: 'Could not load reactions' });
  }
});

// Toggle. Clicking an existing reaction removes it, so the UNIQUE constraint
// on (recipe_id, user_id, reaction) is never hit twice by the same person.
router.post('/:id/reactions', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { reaction } = req.body;
    const user_id = req.user.user_id;

    if (!REACTIONS.includes(reaction)) {
      return res.status(400).json({ error: 'Unknown reaction' });
    }

    const existing = await db.query(
      'SELECT id FROM recipe_reactions WHERE recipe_id = $1 AND user_id = $2 AND reaction = $3',
      [id, user_id, reaction]
    );

    if (existing.rows.length > 0) {
      await db.query('DELETE FROM recipe_reactions WHERE id = $1', [existing.rows[0].id]);
    } else {
      await db.query(
        `INSERT INTO recipe_reactions (recipe_id, user_id, reaction) VALUES ($1, $2, $3)
         ON CONFLICT (recipe_id, user_id, reaction) DO NOTHING`,
        [id, user_id, reaction]
      );
    }

    res.json(await reactionSummary(id, user_id));
  } catch (error) {
    console.error('Reaction toggle failed:', error);
    res.status(500).json({ error: 'Could not save reaction' });
  }
});

router.post('/:id/photos', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { photo_data, caption } = req.body;
    const user_id = req.user.user_id;

    const checkResult = await db.query('SELECT owner_id FROM recipes WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) return res.status(404).json({ error: 'Recipe not found' });
    if (checkResult.rows[0].owner_id !== user_id) return res.status(403).json({ error: 'Unauthorized' });

    const result = await db.query('INSERT INTO photos (recipe_id, photo_data, caption) VALUES ($1, $2, $3) RETURNING id',
      [id, photo_data, caption]);
    res.status(201).json({ photo_id: result.rows[0].id, message: 'Photo uploaded' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/photos', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT * FROM photos WHERE recipe_id = $1 ORDER BY created_at DESC', [id]);
    res.status(200).json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
