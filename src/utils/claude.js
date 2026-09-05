import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

const EMPTY = { ingredients: [], steps: [], glossary: [], language_mismatch: null };

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
export const parseRecipeDescription = async (description, expectedLanguage) => {
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
          'TRANSLATE the recipe into natural English — real English, not a transliteration ' +
          'and not a word-for-word rendering. Step instructions should read the way an ' +
          'English cookbook would write them.\n\n' +
          'INGREDIENT NAMES are the one exception. Keep the original word, transliterated ' +
          'into roman script, followed by the English meaning in brackets: ' +
          '"khobrem (grated coconut)", "tikhat pitho (chilli powder)". These are the names ' +
          'the family uses, and some have no clean English equivalent.\n\n' +
          'Inside the steps, use the ORIGINAL name alone, without the bracket — ' +
          '"Fry the khobrem lightly until golden." The bracketed meaning appears only in ' +
          'the ingredient list. An ingredient that is already English needs no bracket.\n\n' +
          'Then list every non-English ingredient name in "glossary" with its English ' +
          'meaning. List each term once.\n\n' +
          'Return ONLY valid JSON with this structure:\n' +
          '{"ingredients": [{"amount": "2", "unit": "cups", "name": "khobrem (grated coconut)"}], ' +
          '"steps": [{"step_number": 1, "instruction": "Fry the khobrem lightly until golden."}], ' +
          '"glossary": [{"term": "khobrem", "meaning": "grated coconut"}], ' +
          '"language_mismatch": null}\n\n' +
          'Convert quantities into standard English measures where the original is clear. ' +
          'If a word is garbled and you cannot identify it, keep it as transliterated and ' +
          'give its meaning as "unclear" rather than guessing a plausible ingredient. ' +
          'Also judge the LANGUAGE. The transcript was produced by a model told to ' +
          'expect a particular language, and the speaker may have used a different one — ' +
          'Hindi and Marathi transcribed by a Konkani model produce plausible-looking ' +
          'Devanagari rather than obvious nonsense. If the text clearly reads as a ' +
          'different language than expected, set "language_mismatch" to the ISO code you ' +
          'think it actually is (hi, mr, kok, gu, kn, ta, te, en and so on). If it matches ' +
          'the expected language, or you are unsure, set it to null. Do not guess from a ' +
          'few shared words — only flag a clear mismatch.\n\n' +
          'If the text contains no recipe, return empty arrays. ' +
          'Never explain, apologize, or write anything outside the JSON object.',
        messages: [
          {
            role: 'user',
            content:
              `The transcript below was produced expecting the language "${expectedLanguage || 'unknown'}".\n\n` +
              `Parse it into ingredients and steps, and judge whether that language was right.\n\n${description}`
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
      glossary: Array.isArray(parsed.glossary) ? parsed.glossary : [],
      language_mismatch:
        typeof parsed.language_mismatch === 'string' && parsed.language_mismatch.trim()
          ? parsed.language_mismatch.trim()
          : null
    };
  } catch (error) {
    console.error('Claude error:', error.response?.data || error.message);
    return EMPTY;
  }
};
