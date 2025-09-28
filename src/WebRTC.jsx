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
    }); // 구글 STUN 서버를 사용하여 rtc connection 생성

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      send({ event: 'candidate', data: event.candidate }); // candidate를 socket으로 전송
    };

    pc.ontrack = (event) => {
      // 수신한 오디오 스트림 데이터를 peerAudioRef.current에 할당
      // audio 태그가 peerAudioRef를 참조하여 오디오 재생
      const [remoteStream] = event.streams;
      if (peerAudioRef.current) {
        peerAudioRef.current.srcObject = remoteStream;
      }
    };

    pcRef.current = pc;
    return pc;
  }, [send]);

  const getMedia = useCallback(async () => {
    // 로컬 미디어 스트림 가져오기. 사용자의 오디오를 입력받아 스트림 생성
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
        // audio: true,
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
    // 로컬 오디오 트랙 추가
    const existingTracks = pc.getSenders().map((s) => s.track).filter(Boolean);
    stream.getTracks().forEach((track) => {
      if (!existingTracks.includes(track)) pc.addTrack(track, stream);
    });
  }, []);

  const emitText = useCallback((text) => {
    // STT 결과를 소켓으로 전송(테스트시 하드코딩된 텍스트를 전송)
    const socket = socketRef.current;
    const room = roomRef.current;
    if (!socket || !room || !text) return;
    const payload = { roomId: room, text };
    socket.emit('rtc-text', payload);
    console.log('[rtc-text] recognized & sent:', payload);
  }, []);

  // --- STT -------------------------------------------------

  const startSTT = useCallback(async () => {
    // STT 시작
    if (sttOnRef.current) return;
    if (!sttControllerRef.current) {
      sttControllerRef.current = new STTController({
        getMedia,
        emitText,
      });
    }
    await sttControllerRef.current.start();
    sttOnRef.current = true;
    setSttOn(true);
  }, [getMedia, emitText]);

  const stopSTT = useCallback(() => {
    // STT 종료
    try {
      sttControllerRef.current?.stop();
    } catch (e) {
      console.error('[stt] stop error', e);
    }
    sttOnRef.current = false;
    setSttOn(false);
  }, []);

  // --- WebRTC signaling ------------------------------------------------------

  const createOffer = useCallback(async () => {
    // peerConnection 및 rtc 연결을 위한 offer 생성
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
    // 테스트용 텍스트를 소켓으로 전송
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


  // --- lifecycle -------------------------------------------------------------

  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    const room = 'test'; // 테스트 용도로 소켓 통신을 위한 room 고정
    setRoomId(room);
    roomRef.current = room;

    const socket = io('http://localhost:5004', { autoConnect: false });
    socketRef.current = socket; // 렌더링과 무관하게 소켓 연결되도록 Ref에 할당

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
        speakText(text); // tts로 통역된 내용을 소리로 출력
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
          // 수신한 offer를 peerConnection에 설정
          await pc.setRemoteDescription(content.data);

          // 로컬 오디오 정보를 가져와서 peerConnection에 연결
          const stream = await getMedia();
          addLocalTracksOnce(pc, stream);

          const answer = await pc.createAnswer();
          console.log('[rtc] Send Answer');
          send({ event: 'answer', data: answer });
          await pc.setLocalDescription(answer);
        } else if (content.event === 'answer') {
          console.log('[rtc] Receive Answer');
          // 수신한 answer를 peerConnection에 설정
          await ensurePeerConnection().setRemoteDescription(content.data);
        } else if (content.event === 'candidate') {
          console.log('[rtc] Receive Candidate');
          try {
            // 수신한 candidate를 peerConnection에 추가
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
      // 컴포넌트 unmount시 소켓 및 stt 종료
      stopSTT();
      try {
        socket.off('rtc-text');
        socket.off('rtc-message');
        socket.disconnect();
      } catch (e) {
        console.error('[socket] disconnect error', e);
      }

      // peerConnection 종료
      try {
        if (pcRef.current) {
          pcRef.current.getSenders?.().forEach((s) => {
            try { s.track?.stop(); } catch { }
          });
          pcRef.current.close();
        }
      } catch (e) {
        console.error('[pc] close error', e);
      }
      pcRef.current = null;

      // 로컬 오디오 트랙 종료
      try {
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
      } catch (e) {
        console.error('[localStream] stop error', e);
      }
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
