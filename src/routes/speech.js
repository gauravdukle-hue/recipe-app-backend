import express from 'express';
import speech from '@google-cloud/speech';

const router = express.Router();
const client = new speech.SpeechClient({
  apiKey: process.env.GOOGLE_SPEECH_API_KEY
});

router.post('/transcribe', async (req, res) => {
  try {
    const { audioContent, languageCode = 'en-US' } = req.body;

    if (!audioContent) {
      return res.status(400).json({ error: 'audioContent required' });
    }

    const request = {
      audio: {
        content: audioContent.split(',')[1] || audioContent // Remove data:audio/webm;base64, prefix if present
      },
      config: {
        encoding: 'WEBM_OPUS',
        languageCode: languageCode,
        model: 'latest_long'
      }
    };

    const [response] = await client.recognize(request);
    const transcript = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');

    res.json({ transcript });
  } catch (error) {
    console.error('Speech transcription error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
