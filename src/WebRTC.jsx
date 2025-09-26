import React, { useCallback, useEffect, useRef, useState } from 'react';
// Requires: npm i socket.io-client
import { io } from 'socket.io-client';

/**
 * WebRTC demo component matching the original HTML’s behavior.
 * - Prompts for Room ID on mount
 * - Connects to Socket.IO signaling server at http://localhost:5004
 * - "Connection" button sends the initial offer
 * - Shows local ("나") and remote ("상대") videos
 */
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

  const [roomId, setRoomId] = useState('');
  const roomRef = useRef('');

  // Init PeerConnection
  const ensurePeerConnection = useCallback(() => {
    if (pcRef.current) return pcRef.current;
    const iceServerConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
      ],
    };
    const pc = new RTCPeerConnection(iceServerConfig);

    // Send local ICE candidates via signaling
    pc.onicecandidate = (event) => {
      if (!event.candidate) return; // ignore null end-of-candidates
      send({
        event: 'candidate',
        data: event.candidate,
      });
    };

    // Remote track handler (modern replacement for deprecated addstream)
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (peerVideoRef.current) {
        peerVideoRef.current.srcObject = remoteStream;
      }
    };

    // Backward compatibility: handle legacy addstream if fired
    pc.addEventListener('addstream', (e) => {
      if (peerVideoRef.current) {
        peerVideoRef.current.srcObject = e.stream;
      }
    });

    pcRef.current = pc;
    return pc;
  }, []);

  // Get user media and attach to local video
  const getMedia = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      localStreamRef.current = stream;
      if (myVideoRef.current) {
        myVideoRef.current.srcObject = stream;
      }
      return stream;
    } catch (e) {
      console.error('미디어 스트림 에러', e);
      throw e;
    }
  }, []);

  // Emit recognized text to room
  const emitText = useCallback((text) => {
    const socket = socketRef.current;
    const room = roomRef.current;
    if (!socket || !room || !text) return;
    const payload = { roomId: room, text };
    socket.emit('rtc-text', payload);
    console.log('[rtc-text] recognized & sent:', payload);
  }, []);

  // Convert Blob to base64 string
  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      try {
        const dataUrl = reader.result; // data:...;base64,XXXX
        const base64 = String(dataUrl).split(',')[1];
        resolve(base64);
      } catch (e) { reject(e); }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  // Send audio blob to Google STT and emit transcript
  const recognizeWithGoogle = useCallback(async (blob, mimeTypeHint) => {
    try {
      const apiKey = import.meta.env.VITE_GOOGLE_STT_API_KEY;
      const languageCode = import.meta.env.VITE_GOOGLE_STT_LANG || 'ko-KR';
      if (!apiKey) {
        console.warn('[stt] Missing VITE_GOOGLE_STT_API_KEY');
        return;
      }

      // Map mime to Google encoding
      let encoding = 'OGG_OPUS';
      if (mimeTypeHint && mimeTypeHint.includes('webm')) encoding = 'WEBM_OPUS';

      // 샘플레이트/채널 명시 (Opus 기본 48000Hz, mono)
      const sampleRate = Math.round((audioCtxRef.current?.sampleRate) || 48000);
      const audioChannelCount = 1;

      const content = await blobToBase64(blob);
      const res = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}` , {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            encoding,
            languageCode,
            enableAutomaticPunctuation: true,
            sampleRateHertz: sampleRate,
            audioChannelCount,
          },
          audio: { content },
        }),
      });
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
      }
    } catch (e) {
      console.error('[stt] recognize error', e);
    }
  }, [emitText]);

  // Start STT: record mic, detect silence, send segments to STT
  const startSTT = useCallback(async () => {
    if (sttOnRef.current) return;
    const debounceMs = Number(import.meta.env.VITE_GOOGLE_STT_DEBOUNCE_MS || 800);
    const silenceRms = Number(import.meta.env.VITE_GOOGLE_STT_SILENCE_RMS || 0.02);
    const stream = await getMedia();

    // Build audio-only stream for recording/analyser
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      window.alert('마이크 트랙을 찾을 수 없습니다.');
      return;
    }
    const audioStream = new MediaStream([audioTracks[0]]);

    // Choose mime type
    let mimeType = 'audio/ogg; codecs=opus';
    if (!('MediaRecorder' in window)) {
      window.alert('이 브라우저는 MediaRecorder를 지원하지 않습니다.');
      return;
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      if (MediaRecorder.isTypeSupported('audio/webm; codecs=opus')) {
        mimeType = 'audio/webm; codecs=opus';
      } else {
        console.warn('[stt] Opus recording not supported');
        mimeType = '';
      }
    }

    const mr = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
    mediaRecorderRef.current = mr;
    sttSegmentChunksRef.current = [];

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        sttSegmentChunksRef.current.push(e.data);
      }
    };

    mr.start(250); // small chunks to bound segment size

    // Setup analyser for silence detection
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
      // Compute RMS where 128 is silence in 8-bit PCM
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128; // -1..1
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      const now = Date.now();
      if (rms > silenceRms) {
        lastSpeechTsRef.current = now;
      }
      const silentFor = now - lastSpeechTsRef.current;
      if (silentFor >= debounceMs && sttSegmentChunksRef.current.length > 0) {
        // Finalize segment and send to STT
        const segment = new Blob(sttSegmentChunksRef.current.slice(), { type: mimeType || 'audio/ogg; codecs=opus' });
        sttSegmentChunksRef.current = [];
        recognizeWithGoogle(segment, mimeType);
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
        try { mr.stop(); } catch {}
      }
      mediaRecorderRef.current = null;
    } catch {}
    try {
      if (silenceIntervalRef.current) clearInterval(silenceIntervalRef.current);
    } catch {}
    silenceIntervalRef.current = null;
    try {
      audioCtxRef.current?.close();
    } catch {}
    audioCtxRef.current = null;
    sttSegmentChunksRef.current = [];
    console.log('[stt] stopped');
  }, []);


  // Add local tracks only once per track
  const addLocalTracksOnce = useCallback((pc, stream) => {
    const existingTracks = pc.getSenders().map((s) => s.track).filter(Boolean);
    stream.getTracks().forEach((track) => {
      if (!existingTracks.includes(track)) {
        pc.addTrack(track, stream);
      }
    });
  }, []);

  // Socket send helper
  const send = useCallback((message) => {
    const socket = socketRef.current;
    const room = roomRef.current;
    if (!socket || !room) {
      console.warn('[send] skip: no socket or room');
      return;
    }
    const data = {
      roomId: room,
      ...message,
    };
    socket.emit('rtc-message', JSON.stringify(data));
  }, []);

  // Handle offer creation (button click)
  const createOffer = useCallback(async () => {
    const pc = ensurePeerConnection();
    const stream = await getMedia();
    addLocalTracksOnce(pc, stream);

    const offer = await pc.createOffer();
    // Send offer via signaling
    send({ event: 'offer', data: offer });
    // Set local description (triggers ICE gathering)
    await pc.setLocalDescription(offer);
    // console.log('Send Offer');
  }, [ensurePeerConnection, getMedia, send, addLocalTracksOnce]);

  // Emit simple text over socket (rtc-text)
  const sendTestText = useCallback(() => {
    const socket = socketRef.current;
    const room = roomRef.current;
    if (!socket) {
      console.warn('[rtc-text] skip: no socket');
      return;
    }
    try {
      // Include roomId so server can broadcast to the room
      const payload = { roomId: room, text: '안녕하세요. 테스트 입니다.' };
      socket.emit('rtc-text', payload);
      console.log('[rtc-text] sent:', payload);
    } catch (e) {
      console.error('[rtc-text] emit error', e);
    }
  }, []);

  // Google TTS: synthesize and play received text
  const speakText = useCallback(async (text) => {
    if (!text || typeof text !== 'string') return;
    const apiKey = import.meta.env.VITE_GOOGLE_TTS_API_KEY;
    const voiceName = import.meta.env.VITE_GOOGLE_TTS_VOICE || 'ko-KR-Standard-A';
    const languageCode = import.meta.env.VITE_GOOGLE_TTS_LANG || 'ko-KR';
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

  // Setup lifecycle: prompt room, connect socket, bind handlers
  useEffect(() => {
    if (didInitRef.current) return; // guard against dev re-mounts/HMR
    didInitRef.current = true;
    // Prompt for room on mount (mimic original behavior)
    const room = window.prompt('Room ID를 입력하세요! (상대방과 연결할 때 같은 Room이어야 함!) : ');
    if (!room || room.trim().length === 0) {
      window.location.reload();
      return;
    }
    setRoomId(room.trim());
    roomRef.current = room.trim();

    const socket = io('http://localhost:5004');
    socketRef.current = socket;
    socket.emit('join', roomRef.current);

    // Debug socket connection state
    socket.on('connect', () => {
      console.log('[socket] connected', socket.id);
    });
    socket.on('connect_error', (err) => {
      console.error('[socket] connect_error', err);
    });
    socket.on('error', (err) => {
      console.error('[socket] error', err);
    });

    socket.on('room-full', () => {
      window.alert('입장 인원 초과');
      window.location.reload();
    });

    // Receive plain text messages
    socket.on('rtc-text', (payload) => {
      try {
        const text = typeof payload === 'string'
          ? payload
          : (payload?.text ?? payload?.message ?? JSON.stringify(payload));
        console.log('[socket] rtc-text:', text);
        // Speak received text
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
          const offer = content.data;
          await pc.setRemoteDescription(offer);

          const stream = await getMedia();
          addLocalTracksOnce(pc, stream);

          const answer = await pc.createAnswer();
          // Send answer back
          console.log('[rtc] Send Answer');
          send({ event: 'answer', data: answer });
          await pc.setLocalDescription(answer);
        } else if (content.event === 'answer') {
          console.log('[rtc] Receive Answer');
          await ensurePeerConnection().setRemoteDescription(content.data);
        } else if (content.event === 'candidate') {
          console.log('[rtc] Receive Candidate');
          try {
            // Mirror original behavior: pass through even if null
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
      // Cleanup
      try { stopSTT(); } catch {}
      try {
        socket.off('room-full');
        socket.off('rtc-text');
        socket.off('rtc-message');
        socket.disconnect();
      } catch {}

      try {
        if (pcRef.current) {
          pcRef.current.getSenders?.().forEach((s) => {
            try { s.track?.stop(); } catch {}
          });
          pcRef.current.close();
        }
      } catch {}
      pcRef.current = null;

      try {
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
      } catch {}
      localStreamRef.current = null;
    };
  }, [ensurePeerConnection, getMedia, addLocalTracksOnce, speakText]);

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
