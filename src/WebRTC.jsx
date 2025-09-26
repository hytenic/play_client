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
      try {
        socket.off('room-full');
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
  }, [ensurePeerConnection, getMedia, addLocalTracksOnce]);

  return (
    <div>
      <h1>실시간 P2P 통신을 해보자</h1>
      <button onClick={createOffer}>Connection</button>
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
