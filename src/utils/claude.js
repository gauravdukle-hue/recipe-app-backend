import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

const EMPTY = { ingredients: [], steps: [], glossary: [] };

// Placeholder written by the frontend when a recipe is recorded but not yet
// typed or transcribed. There is nothing to parse, so don't spend an API call
// discovering that.
const isPlaceholder = (text) =>
  !text || !text.trim() || /transcription pending/i.test(text);

// Claude sometimes wraps JSON in markdown fences or adds a sentence before it.
// Pull out the outermost object rather than trusting the whole reply.
const extractJson = (raw) => {
  if (!raw) return null;
  let text = raw.trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

/**
 * Best effort. Returns { ingredients, steps } and never throws — a recipe that
 * Claude can't parse should still save with its description and audio intact.
 */
export const parseRecipeDescription = async (description) => {
  if (isPlaceholder(description)) return EMPTY;

  if (!CLAUDE_API_KEY) {
    console.error('CLAUDE_API_KEY not set — saving recipe unparsed');
    return EMPTY;
  }

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-8',
        max_tokens: 2048,
        system:
          'You are a recipe parsing assistant for a Goan family cookbook. Input may be in ' +
          'English, or in Konkani or Marathi written in Devanagari, and may come from ' +
          'imperfect speech recognition.\n\n' +
          'Write ingredient names and step instructions in ROMAN SCRIPT. Do not translate ' +
          'the cooking language into English: transliterate it, keeping the original words ' +
          '(khobrem, kando, tikhat pitho, sanna). Keep the speaker\'s own phrasing and word ' +
          'order. Text already in English stays as it is.\n\n' +
          'Then list every non-English term you used in "glossary", with a short English ' +
          'meaning, so a reader who does not know the language can follow the recipe. ' +
          'List each term once.\n\n' +
          'Return ONLY valid JSON with this structure:\n' +
          '{"ingredients": [{"amount": "2", "unit": "cups", "name": "khobrem"}], ' +
          '"steps": [{"step_number": 1, "instruction": "Khobrem thodem fry korpachem."}], ' +
          '"glossary": [{"term": "khobrem", "meaning": "grated coconut"}]}\n\n' +
          'If a word is garbled and you cannot identify it, keep it as transliterated and ' +
          'give its meaning as "unclear" rather than guessing a plausible ingredient. ' +
          'If the text contains no recipe, return empty arrays. ' +
          'Never explain, apologize, or write anything outside the JSON object.',
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
        },
        timeout: 30000
      }
    );

    const content = response.data?.content?.[0]?.text;
    const parsed = extractJson(content);

    if (!parsed) {
      console.error('Claude returned unparseable output:', String(content).slice(0, 200));
      return EMPTY;
    }

    return {
      ingredients: Array.isArray(parsed.ingredients) ? parsed.ingredients : [],
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      glossary: Array.isArray(parsed.glossary) ? parsed.glossary : []
    };
  } catch (error) {
    console.error('Claude error:', error.response?.data || error.message);
    return EMPTY;
  }
};
