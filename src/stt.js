export class STTController {
  constructor({ getMedia, emitText, onDebugLog } = {}) {
    this.getMedia = getMedia; // async () => MediaStream
    this.emitText = emitText; // (text: string) => void
    this.onDebugLog = onDebugLog; // optional debug logger

    this.mediaRecorder = null;
    this.chunks = [];
    this.audioCtx = null;
    this.analyser = null;
    this.intervalId = null;
    this.lastSpeechTs = 0;
    this.running = false;
    this.mimeType = 'audio/webm; codecs=opus';
  }

  log(...args) {
    if (this.onDebugLog) {
      try { this.onDebugLog(...args); } catch { }
    } else {
      console.log(...args);
    }
  }

  async start() {
    if (this.running) return;

    const debounceMs = Number(import.meta.env.VITE_GOOGLE_STT_DEBOUNCE_MS || 2500);
    const silenceRms = Number(import.meta.env.VITE_GOOGLE_STT_SILENCE_RMS || 0.005);

    const stream = await this.getMedia();

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      window.alert('마이크 트랙을 찾을 수 없습니다.');
      return;
    }
    const audioStream = new MediaStream([audioTracks[0]]);

    let mimeType = 'audio/webm; codecs=opus';
    if (!('MediaRecorder' in window)) {
      window.alert('이 브라우저는 MediaRecorder를 지원하지 않습니다.');
      return;
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      if (MediaRecorder.isTypeSupported('audio/ogg; codecs=opus')) {
        mimeType = 'audio/ogg; codecs=opus';
      } else {
        console.error('[stt] Opus recording not supported by this browser.');
        return;
      }
    }
    this.mimeType = mimeType;

    const mr = new MediaRecorder(audioStream, { mimeType });
    this.mediaRecorder = mr;
    this.chunks = [];

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };

    mr.start(1000);

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.audioCtx = audioCtx;
    const source = audioCtx.createMediaStreamSource(audioStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    this.analyser = analyser;
    source.connect(analyser);

    this.lastSpeechTs = Date.now();
    this.running = true;

    const buf = new Uint8Array(analyser.fftSize);
    this.intervalId = setInterval(async () => {
      if (!this.running) return;

      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128; // -1..1
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      const now = Date.now();

      if (rms > silenceRms) {
        this.lastSpeechTs = now;
      }

      const silentFor = now - this.lastSpeechTs;
      if (silentFor >= debounceMs && this.chunks.length > 0) {
        const segment = new Blob(this.chunks.slice(), { type: mimeType });
        this.chunks = [];

        this.recognizeWithGoogle(segment, mimeType);

        try {
          mr.stop();
          mr.start(1000);
        } catch (e) {
          console.warn('[stt] MediaRecorder restart failed', e);
        }
      }
    }, 150);

    this.log('[stt] started, mime=', mimeType, 'debounceMs=', debounceMs, 'silenceRms=', silenceRms);
  }

  stop() {
    this.running = false;
    try {
      const mr = this.mediaRecorder;
      if (mr && mr.state !== 'inactive') {
        try { mr.stop(); } catch { }
      }
      this.mediaRecorder = null;
    } catch { }
    try {
      if (this.intervalId) clearInterval(this.intervalId);
    } catch { }
    this.intervalId = null;
    try {
      this.audioCtx?.close();
    } catch { }
    this.audioCtx = null;
    this.chunks = [];
    this.log('[stt] stopped');
  }

  async recognizeWithGoogle(blob, mimeTypeHint) {
    try {
      const apiKey = import.meta.env.VITE_GOOGLE_STT_API_KEY;
      const languageCode = import.meta.env.VITE_GOOGLE_STT_LANG || 'ko-KR';
      if (!apiKey) {
        console.warn('[stt] Missing VITE_GOOGLE_STT_API_KEY');
        return;
      }

      const encoding = mimeTypeHint && String(mimeTypeHint).includes('webm') ? 'WEBM_OPUS' : 'OGG_OPUS';
      const content = await blobToBase64(blob);

      const res = await fetch(
        `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            config: {
              encoding,                   // 'WEBM_OPUS'
              languageCode,               // 'ko-KR'
              enableAutomaticPunctuation: false,
              sampleRateHertz: 48000,
              audioChannelCount: 1,
            },
            audio: { content },
          }),
        }
      );

      if (!res.ok) {
        console.error('[stt] recognize HTTP error', res.status, await res.text());
        return;
      }

      const json = await res.json();
      const transcript = json?.results?.[0]?.alternatives?.[0]?.transcript;

      if (transcript && transcript.trim()) {
        this.emitText(transcript.trim());
      } else {
        console.log('[stt] No transcript');
        console.log('[DEBUG] STT full response:', JSON.stringify(json, null, 2));
      }
    } catch (e) {
      console.error('[stt] recognize error', e);
    }
  }
}

export const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onloadend = () => {
    try {
      const dataUrl = reader.result; // data:...;base64,XXXX
      const base64 = String(dataUrl).split(',')[1];
      resolve(base64);
    } catch (e) {
      reject(e);
    }
  };
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});
