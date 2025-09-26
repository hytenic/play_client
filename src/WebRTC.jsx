import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

export default function WebRTC() {
  const myVideoRef = useRef(null);
  const peerVideoRef = useRef(null);

  const pcRef = useRef(null);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const didInitRef = useRef(false);

  // STT state/refs
  const [sttOn, setSttOn] = useState(false);
  const sttOnRef = useRef(false);
  const mediaRecorderRef = useRef(null);
  const sttSegmentChunksRef = useRef([]);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const silenceIntervalRef = useRef(null);
  const lastSpeechTsRef = useRef(0);

  const [roomId, setRoomId] = useState('test');
  const roomRef = useRef('test');

  // --- helpers ---------------------------------------------------------------

  const send = useCallback((message) => {
    const socket = socketRef.current;
    const room = roomRef.current;
    if (!socket || !room) {
      console.warn('[send] skip: no socket or room');
      return;
    }
    const data = { roomId: room, ...message };
    socket.emit('rtc-message', JSON.stringify(data));
  }, []);

  const ensurePeerConnection = useCallback(() => {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      send({ event: 'candidate', data: event.candidate });
    };

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (peerVideoRef.current) {
        peerVideoRef.current.srcObject = remoteStream;
      }
    };

    pcRef.current = pc;
    return pc;
  }, [send]);

  const getMedia = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
        video: true,
      });
      localStreamRef.current = stream;
      if (myVideoRef.current) myVideoRef.current.srcObject = stream;
      return stream;
    } catch (e) {
      console.error('미디어 스트림 에러', e);
      throw e;
    }
  }, []);

  const addLocalTracksOnce = useCallback((pc, stream) => {
    const existingTracks = pc.getSenders().map((s) => s.track).filter(Boolean);
    stream.getTracks().forEach((track) => {
      if (!existingTracks.includes(track)) pc.addTrack(track, stream);
    });
  }, []);

  const emitText = useCallback((text) => {
    const socket = socketRef.current;
    const room = roomRef.current;
    if (!socket || !room || !text) return;
    const payload = { roomId: room, text };
    socket.emit('rtc-text', payload);
    console.log('[rtc-text] recognized & sent:', payload);
  }, []);

  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
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

  // --- Google STT ------------------------------------------------------------

  const recognizeWithGoogle = useCallback(
    async (blob, mimeTypeHint) => {
      try {
        const apiKey = import.meta.env.VITE_GOOGLE_STT_API_KEY;
        const languageCode = import.meta.env.VITE_GOOGLE_STT_LANG || 'ko-KR';
        if (!apiKey) {
          console.warn('[stt] Missing VITE_GOOGLE_STT_API_KEY');
          return;
        }

        // encoding 매핑
        const encoding = mimeTypeHint && mimeTypeHint.includes('webm') ? 'WEBM_OPUS' : 'OGG_OPUS';

        // base64 인코딩
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
                // enableAutomaticPunctuation: true,
                sampleRateHertz: 48000,     // OPUS 표준 샘플레이트
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
          emitText(transcript.trim());
        } else {
          console.log('[stt] No transcript');
          console.log('[DEBUG] STT full response:', JSON.stringify(json, null, 2));
        }
      } catch (e) {
        console.error('[stt] recognize error', e);
      }
    },
    [emitText]
  );

  // --- STT pipeline (MediaRecorder + silence detection) ----------------------

  const startSTT = useCallback(async () => {
    if (sttOnRef.current) return;

    // 무음 감지 파라미터 (테스트에 안정적인 값)
    const debounceMs = Number(import.meta.env.VITE_GOOGLE_STT_DEBOUNCE_MS || 2500);
    const silenceRms = Number(import.meta.env.VITE_GOOGLE_STT_SILENCE_RMS || 0.005);

    const stream = await getMedia();

    // 오디오 트랙 확보
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      window.alert('마이크 트랙을 찾을 수 없습니다.');
      return;
    }
    const audioStream = new MediaStream([audioTracks[0]]);

    // MediaRecorder MIME 고정 (크롬/구글 STT 모두 호환)
    let mimeType = 'audio/webm; codecs=opus';
    if (!('MediaRecorder' in window)) {
      window.alert('이 브라우저는 MediaRecorder를 지원하지 않습니다.');
      return;
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      // 드물게 webm 미지원 브라우저 → ogg로 fallback
      if (MediaRecorder.isTypeSupported('audio/ogg; codecs=opus')) {
        mimeType = 'audio/ogg; codecs=opus';
      } else {
        console.error('[stt] Opus recording not supported by this browser.');
        return;
      }
    }

    const mr = new MediaRecorder(audioStream, { mimeType });
    mediaRecorderRef.current = mr;
    sttSegmentChunksRef.current = [];

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) sttSegmentChunksRef.current.push(e.data);
    };

    // 1초 청크로 안정화
    mr.start(1000);

    // 무음 분석
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(audioStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyserRef.current = analyser;
    source.connect(analyser);

    lastSpeechTsRef.current = Date.now();
    sttOnRef.current = true;
    setSttOn(true);

    const buf = new Uint8Array(analyser.fftSize);
    silenceIntervalRef.current = setInterval(async () => {
      if (!sttOnRef.current) return;

      analyser.getByteTimeDomainData(buf);
      // RMS 계산 (8-bit PCM에서 128=무음 중심)
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128; // -1..1
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      const now = Date.now();

      if (rms > silenceRms) {
        lastSpeechTsRef.current = now; // 말하는 중
      }

      const silentFor = now - lastSpeechTsRef.current;
      if (silentFor >= debounceMs && sttSegmentChunksRef.current.length > 0) {
        // 1️⃣ Blob 먼저 만들어서 현재까지 녹음된 구간을 확정
        const segment = new Blob(sttSegmentChunksRef.current.slice(), { type: mimeType });
        sttSegmentChunksRef.current = [];

        // 2️⃣ Blob 재생(디버그)
        // try {
        //   console.log('[DEBUG] segment type:', segment.type, 'size:', segment.size);
        //   const url = URL.createObjectURL(segment);
        //   const audio = new Audio(url);
        //   audio.play().catch(() => { });
        // } catch { }

        // 3️⃣ STT 호출 (현재까지 녹음된 구간 전송)
        recognizeWithGoogle(segment, mimeType);

        // 4️⃣ 녹음 재시작 (다음 구간을 위한 MediaRecorder 초기화)
        try {
          mr.stop();
          mr.start(1000);
        } catch (e) {
          console.warn('[stt] MediaRecorder restart failed', e);
        }
      }
    }, 150);

    console.log('[stt] started, mime=', mimeType, 'debounceMs=', debounceMs, 'silenceRms=', silenceRms);
  }, [getMedia, recognizeWithGoogle]);

  const stopSTT = useCallback(() => {
    sttOnRef.current = false;
    setSttOn(false);
    try {
      const mr = mediaRecorderRef.current;
      if (mr && mr.state !== 'inactive') {
        try { mr.stop(); } catch { }
      }
      mediaRecorderRef.current = null;
    } catch { }
    try {
      if (silenceIntervalRef.current) clearInterval(silenceIntervalRef.current);
    } catch { }
    silenceIntervalRef.current = null;
    try {
      audioCtxRef.current?.close();
    } catch { }
    audioCtxRef.current = null;
    sttSegmentChunksRef.current = [];
    console.log('[stt] stopped');
  }, []);

  // --- WebRTC signaling ------------------------------------------------------

  const createOffer = useCallback(async () => {
    const pc = ensurePeerConnection();
    const stream = await getMedia();
    addLocalTracksOnce(pc, stream);

    const offer = await pc.createOffer();
    send({ event: 'offer', data: offer });
    await pc.setLocalDescription(offer);
  }, [ensurePeerConnection, getMedia, send, addLocalTracksOnce]);

  const sendTestText = useCallback(() => {
    const socket = socketRef.current;
    const room = roomRef.current;
    if (!socket) {
      console.warn('[rtc-text] skip: no socket');
      return;
    }
    const payload = { roomId: room, text: '안녕하세요. 테스트 입니다.' };
    socket.emit('rtc-text', payload);
    console.log('[rtc-text] sent:', payload);
  }, []);

  const speakText = useCallback(async (text) => {
    if (!text || typeof text !== 'string') return;
    const apiKey = import.meta.env.VITE_GOOGLE_TTS_API_KEY;
    const voiceName = import.meta.env.VITE_GOOGLE_TTS_VOICE || 'en-US-Standard-C';
    const languageCode = import.meta.env.VITE_GOOGLE_TTS_LANG || 'en-US';
    const speakingRate = Number(import.meta.env.VITE_GOOGLE_TTS_RATE || 1.0);
    const pitch = Number(import.meta.env.VITE_GOOGLE_TTS_PITCH || 0);

    if (apiKey) {
      try {
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
        const audio = new Audio(`data:audio/mp3;base64,${audioContent}`);
        await audio.play();
        return;
      } catch (e) {
        console.warn('[tts] Google TTS failed, falling back to SpeechSynthesis', e);
      }
    }

    try {
      if ('speechSynthesis' in window) {
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = languageCode || 'ko-KR';
        window.speechSynthesis.speak(utter);
      } else {
        console.warn('[tts] speechSynthesis not supported');
      }
    } catch (e) {
      console.error('[tts] fallback speech synthesis error', e);
    }
  }, []);

  // --- lifecycle -------------------------------------------------------------

  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    const room = 'test';
    setRoomId(room);
    roomRef.current = room;

    const socket = io('http://localhost:5004');
    socketRef.current = socket;
    socket.emit('join', roomRef.current);

    socket.on('connect', () => console.log('[socket] connected', socket.id));
    socket.on('connect_error', (err) => console.error('[socket] connect_error', err));
    socket.on('error', (err) => console.error('[socket] error', err));

    socket.on('room-full', () => {
      window.alert('입장 인원 초과');
      window.location.reload();
    });

    socket.on('rtc-text', (payload) => {
      try {
        const text = typeof payload === 'string'
          ? payload
          : (payload?.text ?? payload?.message ?? JSON.stringify(payload));
        console.log('[socket] rtc-text:', text);
        speakText(text);
      } catch (e) {
        console.error('[socket] rtc-text handle error', e);
      }
    });

    socket.on('rtc-message', async (message) => {
      console.log('[socket] rtc-message raw:', message);
      try {
        const content = typeof message === 'string' ? JSON.parse(message) : message;
        const pc = ensurePeerConnection();

        if (content.event === 'offer') {
          console.log('[rtc] Receive Offer', content.data);
          await pc.setRemoteDescription(content.data);

          const stream = await getMedia();
          addLocalTracksOnce(pc, stream);

          const answer = await pc.createAnswer();
          console.log('[rtc] Send Answer');
          send({ event: 'answer', data: answer });
          await pc.setLocalDescription(answer);
        } else if (content.event === 'answer') {
          console.log('[rtc] Receive Answer');
          await ensurePeerConnection().setRemoteDescription(content.data);
        } else if (content.event === 'candidate') {
          console.log('[rtc] Receive Candidate');
          try {
            await ensurePeerConnection().addIceCandidate(content.data);
          } catch (err) {
            console.error('Error adding received ICE candidate', err);
          }
        }
      } catch (err) {
        console.error('rtc-message handling error', err);
      }
    });

    return () => {
      try { stopSTT(); } catch { }
      try {
        socket.off('room-full');
        socket.off('rtc-text');
        socket.off('rtc-message');
        socket.disconnect();
      } catch { }

      try {
        if (pcRef.current) {
          pcRef.current.getSenders?.().forEach((s) => {
            try { s.track?.stop(); } catch { }
          });
          pcRef.current.close();
        }
      } catch { }
      pcRef.current = null;

      try {
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
      } catch { }
      localStreamRef.current = null;
    };
  }, [ensurePeerConnection, getMedia, addLocalTracksOnce, speakText, stopSTT]);

  // --- UI --------------------------------------------------------------------

  return (
    <div>
      <h1>실시간 P2P 통신을 해보자</h1>
      <button onClick={createOffer}>Connection</button>
      <button onClick={sendTestText} style={{ marginLeft: 8 }}>Send Text</button>
      <button
        onClick={() => (sttOnRef.current ? stopSTT() : startSTT())}
        style={{ marginLeft: 8 }}
      >
        {sttOn ? 'Stop STT' : 'Start STT'}
      </button>

      <br />
      <div>나</div>
      <video
        ref={myVideoRef}
        playsInline
        autoPlay
        muted
        width={300}
        height={300}
        style={{ background: '#000' }}
      />

      <br />
      <div>상대</div>
      <div style={{ width: 1280, height: 720, margin: 0, padding: 0 }}>
        <video
          ref={peerVideoRef}
          playsInline
          autoPlay
          width={1280}
          height={720}
          style={{ background: '#000' }}
        />
      </div>
    </div>
  );
}
