export class STTController {
  constructor({ getMedia, emitText } = {}) {
    this.getMedia = getMedia;
    this.emitText = emitText;

    this.mediaRecorder = null;
    this.chunks = [];
    this.audioCtx = null;
    this.analyser = null;
    this.intervalId = null;
    this.lastSpeechTs = 0;
    this.running = false;
    this.mimeType = 'audio/webm; codecs=opus';
  }


  async start() {
    if (this.running) return;

    const debounceMs = Number(import.meta.env.VITE_GOOGLE_STT_DEBOUNCE_MS || 2500);
    const silenceRms = Number(import.meta.env.VITE_GOOGLE_STT_SILENCE_RMS || 0.01);

    const stream = await this.getMedia(); // 마이크로 들어온 오디오 스트림 가져오기

    const audioTracks = stream.getAudioTracks(); // 오디오 트랙 가져오기
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

    const mr = new MediaRecorder(audioStream, { mimeType }); // 오디오를 기록할 레코더 생성
    this.mediaRecorder = mr;
    this.chunks = [];

    mr.ondataavailable = (e) => { // 오디오를 chunk 크기별로 chunks에 추가하는 함수 할당
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };

    mr.start(1000); // 오디오를 1초마다 chunk를 생성

    // 오디오에서 음성과 무음을 판단하기 위한 AudioContext 생성
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
      // 150ms마다 소리가 나는지 확인하고, 환경변수로 선언한  debounceMs보다 소리가 지속되지 않으면
      // chunks를 하나의 blob으로 변환하여 recognizeWithGoogle 함수를 호출하여 STT를 수행
      if (!this.running) return;

      analyser.getByteTimeDomainData(buf); // 오디오 데이터를 가져옴
      let sumSq = 0;
      // 0~255 사이의 음성 샘플이 buf에 존재
      // 중앙값(128, 무음)을 기준으로 -1 ~ 1 사이의 값으로 정규화
      // 소리 값을 제곱하여 절대값 기준의 세기를 계산 후 제곱근을 구해 평균 진폭 계산
      // 평균 진폭이 silenceRms보다 큰지 비교하여 말하는 상태인지 무음(말을 멈춘 상태인지)인지 판단
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
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

    console.log('[stt] started, mime=', mimeType, 'debounceMs=', debounceMs, 'silenceRms=', silenceRms);
  }

  stop() {
    this.running = false;
    try {
      // 오디오 레코더 종료
      const mr = this.mediaRecorder;
      if (mr && mr.state !== 'inactive') {
        mr.stop()
      }
      this.mediaRecorder = null;
    } catch (e) {
      console.error('[stt] MediaRecorder stop error', e);
    }
    try {
      if (this.intervalId) clearInterval(this.intervalId);
    } catch (e) {
      console.error('[stt] clearInterval error', e);
    }
    this.intervalId = null;
    try {
      this.audioCtx?.close();
    } catch (e) {
      console.error('[stt] AudioContext close error', e);
    }
    this.audioCtx = null;
    this.chunks = [];
    console.log('[stt] stopped');
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
      const content = await blobToBase64(blob); // 오디오 blob을 api로 전달하기 위해 base64로 인코딩

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
      console.log()
      if (!res.ok) {
        console.error('[stt] recognize HTTP error', res.status, await res.text());
        return;
      }

      const json = await res.json();
      const transcript = json?.results?.[0]?.alternatives?.[0]?.transcript; // 인식된 텍스트

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
      const dataUrl = reader.result;
      const base64 = String(dataUrl).split(',')[1];
      resolve(base64);
    } catch (e) {
      reject(e);
    }
  };
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});
