import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

export const parseRecipeDescription = async (description) => {
  try {
    if (!CLAUDE_API_KEY) {
      throw new Error('CLAUDE_API_KEY not set in .env');
    }

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-8',
        max_tokens: 1024,
        system: 'You are a recipe parsing assistant. Extract ingredients and steps from a recipe description. Return ONLY valid JSON with this structure: {"ingredients": [{"amount": "2", "unit": "lbs", "name": "white fish"}], "steps": [{"step_number": 1, "instruction": "Clean the fish"}]}',
        messages: [
          {
            role: 'user',
            content: `Parse this recipe into ingredients and steps:\n\n${description}`
          }
        ]
      },
      {
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const content = response.data.content[0].text;
    const parsed = JSON.parse(content);
    return parsed;
  } catch (error) {
    console.error('Claude error:', error.response?.data || error.message);
    throw new Error('Failed to parse recipe: ' + error.message);
  }
};
