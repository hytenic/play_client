import React from 'react';
import { createRoot } from 'react-dom/client';
import WebRTC from './WebRTC.jsx';

const rootEl = document.getElementById('root');
const root = createRoot(rootEl);
root.render(<WebRTC />);
