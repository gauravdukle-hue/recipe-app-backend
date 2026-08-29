import express from 'express';
import db from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { parseRecipeDescription } from '../utils/claude.js';

const router = express.Router();

// POST /recipes - Create recipe with Claude parsing
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { title, description, cuisine_tag } = req.body;
    const user_id = req.user.user_id;

    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description required' });
    }

    // Parse with Claude
    const parsed = await parseRecipeDescription(description);

    // Insert recipe
    const recipeResult = await db.query(
      'INSERT INTO recipes (owner_id, title, description, cuisine_tag) VALUES ($1, $2, $3, $4) RETURNING id, title',
      [user_id, title, description, cuisine_tag]
    );

    const recipe_id = recipeResult.rows[0].id;

    // Insert ingredients
    for (const ing of parsed.ingredients) {
      await db.query(
        'INSERT INTO ingredients (recipe_id, name, amount, unit) VALUES ($1, $2, $3, $4)',
        [recipe_id, ing.name, ing.amount, ing.unit]
      );
    }

    // Insert steps
    for (let i = 0; i < parsed.steps.length; i++) {
      await db.query(
        'INSERT INTO steps (recipe_id, step_number, instruction) VALUES ($1, $2, $3)',
        [recipe_id, i + 1, parsed.steps[i].instruction]
      );
    }

    res.status(201).json({
      recipe_id,
      title: recipeResult.rows[0].title,
      ingredients: parsed.ingredients,
      steps: parsed.steps,
      message: 'Recipe created and parsed successfully'
    });
  } catch (error) {
    console.error('Create recipe error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// GET /recipes - List all recipes with filtering
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { view = 'all', search } = req.query;
    const user_id = req.user.user_id;

    let query = `
      SELECT 
        r.id,
        r.title,
        r.cuisine_tag,
        r.owner_id,
        u.name as owner_name,
        r.created_at,
        (SELECT COUNT(*) FROM ingredients WHERE recipe_id = r.id) as ingredient_count,
        (SELECT COUNT(*) FROM steps WHERE recipe_id = r.id) as step_count
      FROM recipes r 
      JOIN users u ON r.owner_id = u.id 
      WHERE r.deleted_at IS NULL
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

// GET /recipes/:id - Get single recipe with details
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
    const can_edit = recipe.owner_id === user_id;

    const ingredientsResult = await db.query(
      'SELECT * FROM ingredients WHERE recipe_id = $1 ORDER BY id',
      [id]
    );

    const stepsResult = await db.query(
      'SELECT * FROM steps WHERE recipe_id = $1 ORDER BY step_number',
      [id]
    );

    res.status(200).json({
      ...recipe,
      ingredients: ingredientsResult.rows,
      steps: stepsResult.rows,
      can_edit
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /recipes/:id - Update recipe (owner only)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, cuisine_tag } = req.body;
    const user_id = req.user.user_id;

    const checkResult = await db.query(
      'SELECT owner_id FROM recipes WHERE id = $1',
      [id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    if (checkResult.rows[0].owner_id !== user_id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await db.query(
      'UPDATE recipes SET title = $1, description = $2, cuisine_tag = $3 WHERE id = $4',
      [title, description, cuisine_tag, id]
    );

    res.status(200).json({ message: 'Recipe updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /recipes/:id - Soft delete (owner only)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.user.user_id;

    const checkResult = await db.query(
      'SELECT owner_id FROM recipes WHERE id = $1',
      [id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    if (checkResult.rows[0].owner_id !== user_id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await db.query(
      'UPDATE recipes SET deleted_at = NOW() WHERE id = $1',
      [id]
    );

    res.status(200).json({ message: 'Recipe deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /recipes/:id/photos
router.post('/:id/photos', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { photo_data, caption } = req.body;
    const user_id = req.user.user_id;

    const checkResult = await db.query(
      'SELECT owner_id FROM recipes WHERE id = $1',
      [id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    if (checkResult.rows[0].owner_id !== user_id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const result = await db.query(
      'INSERT INTO photos (recipe_id, photo_data, caption) VALUES ($1, $2, $3) RETURNING id',
      [id, photo_data, caption]
    );

    res.status(201).json({ photo_id: result.rows[0].id, message: 'Photo uploaded' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /recipes/:id/photos
router.get('/:id/photos', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT * FROM photos WHERE recipe_id = $1 ORDER BY created_at DESC',
      [id]
    );
    res.status(200).json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
