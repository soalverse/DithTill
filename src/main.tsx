import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './ui/App';

// DEV-ONLY: the browser half of the golden parity gate (window.__dithtillParity).
// Dead-code-eliminated from production builds.
if (import.meta.env.DEV) void import('./ui/dev-parity');

// DESKTOP-ONLY: bridge webview JS errors into the app's log file
// (%LOCALAPPDATA%/com.soalverse.dithtill/logs/DithTill.log). Release builds
// have no devtools, so without this a thrown handler is invisible — the
// motion-button report (2026-07-02) had zero evidence to work from.
if ('__TAURI_INTERNALS__' in window) {
  void import('@tauri-apps/plugin-log').then(({ error }) => {
    window.addEventListener('error', (e) =>
      error(`[webview] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`).catch(() => {}),
    );
    window.addEventListener('unhandledrejection', (e) =>
      error(`[webview] unhandled rejection: ${String(e.reason)}`).catch(() => {}),
    );
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
