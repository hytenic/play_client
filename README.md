WebRTC React Component

This repo includes a React component (`src/WebRTC.jsx`) that replicates the provided plain HTML WebRTC + Socket.IO example.

What it does
- Prompts for a Room ID on mount (same as the original page)
- Connects to a Socket.IO signaling server at `http://localhost:5004`
- "Connection" button sends the initial offer
- Shows local (나) and remote (상대) video streams
- Receives `rtc-text` and plays it via Google TTS (if configured) or browser SpeechSynthesis

Usage
1. Install dependencies:
   - `npm install`
2. Start the Vite dev server:
   - `npm run dev`
3. Open the shown local URL in your browser (e.g. http://localhost:5173).
4. Ensure your signaling server is running at `http://localhost:5004` and handles the following events:
   - `join` (room join)
   - `rtc-message` (broadcasts JSON messages with `event` = `offer` | `answer` | `candidate`)
   - Optional: emits `room-full` when the room is full

Notes
- The component uses modern `ontrack` for remote stream, and still listens to legacy `addstream` for compatibility.
- Local video is muted to prevent feedback.
- STUN server is `stun:stun.l.google.com:19302`.

Google TTS (optional)
- Set `VITE_GOOGLE_TTS_API_KEY` in `.env` to use Google Cloud Text-to-Speech.
- Optional overrides: `VITE_GOOGLE_TTS_LANG`, `VITE_GOOGLE_TTS_VOICE`, `VITE_GOOGLE_TTS_RATE`, `VITE_GOOGLE_TTS_PITCH`.
- Without an API key, the app falls back to the browser's `speechSynthesis` API.
- Browsers may block autoplay; ensure you've interacted with the page (clicked) before TTS playback occurs.
