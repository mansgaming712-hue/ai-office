import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/vt323';
import '@fontsource/press-start-2p';
import './styles.css';
import AuthGate from './ui/AuthGate.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
