# WebRTC 음성 통역 클라이언트

## 개요
- 이 프로젝트는 Socket.IO 시그널링 서버와 통신하며 음성 중심 WebRTC 통화에 음성 인식(STT)과 음성 합성(TTS) 기능을 더한 React/Vite 기반 클라이언트입니다.
- 로컬 마이크 오디오를 가져와 피어 연결을 맺고, 서버로부터 전달받은 텍스트를 음성으로 재생하거나 브라우저에서 인식한 음성을 텍스트로 전송할 수 있습니다.

## 주요 기능
- `Connection` 버튼: STUN(`stun:stun.l.google.com:19302`)을 사용하는 `RTCPeerConnection`을 생성하고 offer를 만들어 소켓으로 전송합니다.
- `Send Text` 버튼: 테스트용 텍스트(`"안녕하세요. 테스트 입니다."`)를 `rtc-text` 이벤트로 보내 서버 측 파이프라인을 점검할 수 있습니다.
- `Start STT` / `Stop STT`: 마이크 입력을 녹음하여 무음 구간을 기준으로 분할한 뒤 Google Speech-to-Text API에 요청하고, 인식 결과를 `rtc-text` 이벤트로 브로드캐스트합니다.
- 수신한 `rtc-text` 이벤트를 Google Text-to-Speech API에 전달하여 오디오로 재생합니다(키가 없으면 미실행).
- 컴포넌트 언마운트 시 소켓/PeerConnection/MediaRecorder 리소스를 정리합니다.

## 기술 스택
- React 18, Vite 5
- Socket.IO Client 3.x
- WebRTC (`RTCPeerConnection`, `getUserMedia`), MediaRecorder, Web Audio API
- Google Cloud Speech-to-Text / Text-to-Speech (클라이언트 직접 호출)

## 설치 및 실행
1. Node.js 18 이상을 권장합니다.
2. 의존성 설치
   - `yarn install` 또는 `npm install`
3. 개발 서버 실행
   - `yarn dev` 또는 `npm run dev`
4. 브라우저에서 출력된 로컬 주소(기본적으로 `http://localhost:5173`)를 열고 마이크 사용 권한을 허용합니다.

## 환경 변수 설정(.env 예시)
```
VITE_GOOGLE_TTS_API_KEY=YOUR_TTS_KEY
VITE_GOOGLE_TTS_LANG=ko-KR
VITE_GOOGLE_TTS_VOICE=ko-KR-Wavenet-A
VITE_GOOGLE_TTS_RATE=1.0
VITE_GOOGLE_TTS_PITCH=0

VITE_GOOGLE_STT_API_KEY=YOUR_STT_KEY
VITE_GOOGLE_STT_LANG=ko-KR
VITE_GOOGLE_STT_DEBOUNCE_MS=2500
VITE_GOOGLE_STT_SILENCE_RMS=0.01
```
- TTS 키가 없으면 `speakText` 함수는 경고만 남기고 재생하지 않습니다.
- `VITE_GOOGLE_STT_DEBOUNCE_MS`: 무음 감지 후 몇 ms가 지나면 음성 구간을 전송할지 결정합니다.
- `VITE_GOOGLE_STT_SILENCE_RMS`: RMS 기준치를 통해 무음을 판별합니다.

## 시그널링 서버 요구사항
- 기본 연결 주소는 `http://localhost:5004`로 하드코딩되어 있습니다.
- 다음 Socket.IO 이벤트를 처리해야 합니다.
  - `join`: `{ roomId }`를 받아 방에 참여시킵니다.
  - `rtc-message`: `{ roomId, event: 'offer'|'answer'|'candidate', data }` 형태의 JSON 문자열을 룸 내 다른 클라이언트에 중계합니다.
  - `rtc-text`: 텍스트를 구독 중인 클라이언트에 전달합니다.
  - 필요 시 `room-full` 이벤트를 전송하면 클라이언트가 상태 메시지로 노출합니다.

## 브라우저 동작 및 주의사항
- 마이크 권한이 없으면 STT가 시작되지 않으므로 최초 접근 시 권한을 허용해야 합니다.
- MediaRecorder를 지원하지 않는 브라우저에서는 STT 기능이 동작하지 않습니다.
- 브라우저에서 직접 Google Cloud API를 호출하기 때문에 API 키가 노출됩니다. 실서비스에서는 백엔드 프록시를 통해 요청하는 것이 안전합니다.
- 자동 재생 정책 때문에 TTS 오디오가 처음 실행되지 않을 수 있으므로 페이지 상호작용(클릭)이 선행되어야 합니다.

## 구조
- `src/WebRTC.jsx`: WebRTC 연결, Socket.IO 이벤트 처리, STT/TTS 트리거, UI 버튼 등을 담당하는 메인 컴포넌트입니다.
- `src/stt.js`: 음성 구간을 감지하고 Google STT API를 호출하는 `STTController` 클래스를 제공합니다.
- `src/tts.js`: Google TTS API를 호출하여 수신한 텍스트를 음성으로 재생합니다.
- `src/main.jsx`: React 엔트리 포인트로 `WebRTC` 컴포넌트를 렌더링합니다.

## 추가 확인 사항
- PeerConnection은 오디오 스트림만 전송하도록 구성되어 있으며, UI 상에는 원격 오디오만 재생됩니다.
