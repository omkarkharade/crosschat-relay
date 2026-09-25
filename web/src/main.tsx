import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

async function start() {
  // Vite replaces MODE at build time, so production builds drop the demo entirely.
  if (import.meta.env.MODE === 'demo') {
    const { installDemo } = await import('./demo');
    installDemo();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
