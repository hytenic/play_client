import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { speakText } from './tts';
import { STTController } from './stt';

export default function WebRTC() {
  const myVideoRef = useRef(null);
  const peerAudioRef = useRef(null);

  const pcRef = useRef(null);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const didInitRef = useRef(false);
  const connectionStartRef = useRef(null);
  const socketConnectStartRef = useRef(null);

  // STT state/refs
  const [sttOn, setSttOn] = useState(false);
  const sttOnRef = useRef(false);
  const sttControllerRef = useRef(null);

  const [roomId, setRoomId] = useState('test');
  const roomRef = useRef('test');
  const [statusMsg, setStatusMsg] = useState('');

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
      if (peerAudioRef.current) {
        peerAudioRef.current.srcObject = remoteStream;
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
        video: false,
        audio: true,
        // video: true,
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

  // base64 유틸은 stt 모듈 내부에서 사용됨

  // --- STT (분리된 모듈 사용) -------------------------------------------------

  const startSTT = useCallback(async () => {
    if (sttOnRef.current) return;
    if (!sttControllerRef.current) {
      sttControllerRef.current = new STTController({
        getMedia,
        emitText,
        onDebugLog: (...args) => console.log('[STT]', ...args),
      });
    }
    await sttControllerRef.current.start();
    sttOnRef.current = true;
    setSttOn(true);
  }, [getMedia, emitText]);

  const stopSTT = useCallback(() => {
    try {
      sttControllerRef.current?.stop();
    } catch {}
    sttOnRef.current = false;
    setSttOn(false);
  }, []);

  // --- WebRTC signaling ------------------------------------------------------

  const createOffer = useCallback(async () => {
    const pc = ensurePeerConnection();
    const start = performance.now();
    connectionStartRef.current = start;
    socketConnectStartRef.current = start;
    const socket = socketRef.current;
    if (socket && !socket.connected) socket.connect();
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

  // speakText는 tts 모듈에서 import하여 사용

  // --- lifecycle -------------------------------------------------------------

  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    const room = 'test';
    setRoomId(room);
    roomRef.current = room;

    const socket = io('http://localhost:5004', { autoConnect: false });
    socketRef.current = socket;

    socket.on('connect', () => {
      const now = performance.now();
      let msg = `[socket] connected ${socket.id ?? ''}`.trim();
      if (socketConnectStartRef.current != null) {
        const elapsedMs = Math.round(now - socketConnectStartRef.current);
        msg += ` (+${elapsedMs}ms)`;
        setStatusMsg(`소켓 연결 완료! 버튼 클릭 후 ${elapsedMs}ms 경과`);
        socketConnectStartRef.current = null;
      } else {
        setStatusMsg('소켓 연결 완료!');
      }
      console.log(msg);
      socket.emit('join', roomRef.current);
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
      <button onClick={createOffer}>Connection</button>
      <button onClick={sendTestText} style={{ marginLeft: 8 }}>Send Text</button>
      <button
        onClick={() => (sttOnRef.current ? stopSTT() : startSTT())}
        style={{ marginLeft: 8 }}
      >
        {sttOn ? 'Stop STT' : 'Start STT'}
      </button>

      {statusMsg && (
        <div
          style={{
            marginTop: 8,
            padding: '6px 10px',
            background: '#f0f9ff',
            border: '1px solid #bae6fd',
            borderRadius: 6,
            color: '#0369a1',
            display: 'inline-block',
          }}
        >
          {statusMsg}
        </div>
      )}

      <br />
      <audio
        ref={peerAudioRef}
        autoPlay
        controls
      />
    </div>
  );
}
