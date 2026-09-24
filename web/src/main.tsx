/**
 * Entry point.
 *
 * Deliberately thin: no analytics, no third-party script, no font CDN. The CSP
 * the server sends (`script-src 'self'` + nonce) means anything injected here
 * would have to be same-origin anyway, and the bundle stays auditable.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
