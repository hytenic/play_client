export async function speakText(text, options = {}) {
  if (!text || typeof text !== 'string') return;

  const apiKey = options.apiKey ?? import.meta.env.VITE_GOOGLE_TTS_API_KEY;
  const voiceName = options.voiceName ?? import.meta.env.VITE_GOOGLE_TTS_VOICE ?? 'en-US-Standard-C';
  const languageCode = options.languageCode ?? import.meta.env.VITE_GOOGLE_TTS_LANG ?? 'en-US';
  const speakingRate = Number(options.speakingRate ?? import.meta.env.VITE_GOOGLE_TTS_RATE ?? 1.0); // 말하는 속도
  const pitch = Number(options.pitch ?? import.meta.env.VITE_GOOGLE_TTS_PITCH ?? 0); // 목소리 톤

  if (apiKey) {
    try {
      // 구글 tts api 호출
      const res = await fetch(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { text },
            voice: { languageCode, name: voiceName },
            audioConfig: { audioEncoding: 'MP3', speakingRate, pitch },
          }),
        }
      );
      if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
      const json = await res.json();
      const audioContent = json?.audioContent;
      if (!audioContent) throw new Error('No audioContent in TTS response');
      // base64로 인코딩된 음성 데이터를 Audio 객체로 생성하여 재생
      const audio = new Audio(`data:audio/mp3;base64,${audioContent}`);
      await audio.play();
      return;
    } catch (e) {
      console.warn('[tts] Google TTS failed, falling back to SpeechSynthesis', e);
    }
  }
}
