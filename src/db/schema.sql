-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255),
  auth_provider VARCHAR(50) DEFAULT 'email',
  profile_picture_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- Recipes table
CREATE TABLE IF NOT EXISTS recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  cuisine_tag VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

CREATE INDEX idx_recipes_owner_id ON recipes(owner_id);
CREATE INDEX idx_recipes_created_at ON recipes(created_at DESC);

-- Ingredients table
CREATE TABLE IF NOT EXISTS ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  amount VARCHAR(50),
  unit VARCHAR(50),
  name VARCHAR(255) NOT NULL,
  sort_order INT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ingredients_recipe_id ON ingredients(recipe_id);

-- Steps table
CREATE TABLE IF NOT EXISTS steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  step_number INT NOT NULL,
  instruction TEXT NOT NULL,
  duration_minutes INT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_steps_recipe_id ON steps(recipe_id);

-- Photos table
CREATE TABLE IF NOT EXISTS photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  image_url TEXT NOT NULL,
  uploaded_at TIMESTAMP DEFAULT NOW(),
  is_primary BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_photos_recipe_id ON photos(recipe_id);

-- Recipe shares table
CREATE TABLE IF NOT EXISTS recipe_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id),
  shared_with_user_id UUID NOT NULL REFERENCES users(id),
  permission_level VARCHAR(50) DEFAULT 'view',
  shared_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(recipe_id, shared_with_user_id)
);

CREATE INDEX idx_recipe_shares_recipe_id ON recipe_shares(recipe_id);
CREATE INDEX idx_recipe_shares_shared_with ON recipe_shares(shared_with_user_id);

-- Recipe notes table
CREATE TABLE IF NOT EXISTS recipe_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  note_text TEXT NOT NULL,
  is_edit_suggestion BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_recipe_notes_recipe_id ON recipe_notes(recipe_id);
CREATE INDEX idx_recipe_notes_user_id ON recipe_notes(user_id);
