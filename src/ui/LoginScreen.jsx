import { useRef, useState } from 'react';
import { prepareToken } from '../auth.js';
import ThemeToggle from './ThemeToggle.jsx';
import { useTheme } from './useTheme.js';

/**
 * Layar login token. `onLogin(token)` → Promise<{ ok } | { ok: false, error }>.
 * Token dikosongkan dari state begitu dikirim; field tanpa atribut `name`, jadi tidak pernah
 * ikut ke URL walau form sampai ter-submit secara native.
 */
export default function LoginScreen({ notice, onLogin }) {
  const { theme, toggle } = useTheme();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(notice ?? null);
  const busyRef = useRef(false);
  const inputRef = useRef(null);

  const fail = (text) => {
    setMessage({ kind: 'error', text });
    inputRef.current?.focus();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busyRef.current) return;
    const prepared = prepareToken(token);
    if (!prepared.ok) return fail(prepared.error);

    busyRef.current = true;
    setBusy(true);
    setToken('');
    setMessage(null);
    let result;
    try {
      result = await onLogin(prepared.token);
    } catch {
      result = { ok: false, error: 'Gagal masuk. Coba lagi.' };
    }
    busyRef.current = false;
    // Berhasil: induk mengganti layar ini dengan kantor, tidak perlu update state.
    if (result?.ok) return;
    setBusy(false);
    fail(result?.error || 'Gagal masuk. Coba lagi.');
  };

  const isError = message?.kind === 'error';

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit} aria-labelledby="login-title" aria-busy={busy} noValidate>
        <h1 id="login-title">AI&nbsp;Office</h1>
        <p className="auth-sub">Server ini dilindungi token. Masukkan token akses untuk membuka kantor.</p>

        <label htmlFor="login-token">Token akses</label>
        <input
          id="login-token"
          ref={inputRef}
          className="auth-input"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-invalid={isError}
          aria-describedby="login-msg"
        />
        <p id="login-msg" className={`auth-msg ${message?.kind ?? ''}`} aria-live="polite" aria-atomic="true">
          {message?.text ?? ''}
        </p>

        <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
          {busy ? 'Memeriksa…' : 'Masuk'}
        </button>
        <div className="auth-theme">
          <ThemeToggle theme={theme} onToggle={toggle} />
        </div>
      </form>
    </main>
  );
}
