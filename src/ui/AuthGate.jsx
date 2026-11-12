import { useCallback, useEffect, useReducer } from 'react';
import { authReducer, initialAuthState, resolveLogin, shouldReconnect } from '../auth.js';
import { getSession, postLogin, postLogout } from '../net.js';
import App from './App.jsx';
import LoginScreen from './LoginScreen.jsx';
import { OfficeSkeleton, PixelSpinner } from './Skeleton.jsx';
import { useTheme } from './useTheme.js';

/**
 * Gerbang sesi: cek GET /api/session, lalu tampilkan layar login atau kantor.
 * Mode lokal (authRequired false) langsung ke kantor tanpa perubahan yang terlihat.
 */
export default function AuthGate() {
  const [state, dispatch] = useReducer(authReducer, initialAuthState);
  useTheme(); // memastikan tema terpasang di semua layar (login, memuat, kantor)
  const { phase, epoch, authRequired, notice } = state;

  useEffect(() => {
    let active = true;
    getSession().then((session) => {
      if (active) dispatch({ type: 'session-checked', session });
    });
    return () => {
      active = false;
    };
  }, []);

  // Stabil selama satu sesi kantor (epoch tetap), jadi tidak memicu reconnect saat render ulang.
  const recheckSession = useCallback(async () => {
    const session = await getSession();
    dispatch({ type: 'session-rechecked', session, epoch });
    return shouldReconnect(session);
  }, [epoch]);

  const login = useCallback(async (token) => {
    const result = await postLogin(token);
    if (!result.ok) return result;
    const session = await getSession();
    const outcome = resolveLogin(result, session);
    if (outcome.ok) dispatch({ type: 'login-succeeded', session });
    return outcome;
  }, []);

  const logout = useCallback(async () => {
    const result = await postLogout();
    dispatch({ type: 'logged-out', result });
  }, []);

  if (phase === 'login') return <LoginScreen notice={notice} onLogin={login} />;
  if (phase === 'app') {
    return <App key={epoch} authRequired={authRequired} onRecheckSession={recheckSession} onLogout={logout} />;
  }
  return (
    <main className="auth-screen">
      <div className="auth-loading">
        <OfficeSkeleton />
        <p role="status">
          <PixelSpinner /> Memeriksa sesi…
        </p>
      </div>
    </main>
  );
}
