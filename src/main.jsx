import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/vt323';
import '@fontsource/press-start-2p';
import './styles.css';
import { captureKeyFromUrl } from './net.js';
import AuthGate from './ui/AuthGate.jsx';

// Mode lokal: simpan #key=... di sessionStorage lalu hapus dari URL sebelum render apa pun.
captureKeyFromUrl();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
