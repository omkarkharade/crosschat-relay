import { useState } from 'react';

import { api } from '../api';
import { errorMessage } from './ui';

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await api.signIn(token.trim());
      onSignedIn();
    } catch (failure: unknown) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <form
        className="signin-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="brand brand-large">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span>Crosschat Relay</span>
        </div>
        <h1>Sign in</h1>
        <p className="muted">
          Paste the admin token. The relay printed it the first time it started, and it's saved in <code>data/api-token</code>.
        </p>
        <label className="field">
          <span>Admin token</span>
          <input type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} required autoFocus />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="button button-primary button-block" disabled={busy || !token.trim()}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small">Your session lasts 7 days and is stored in an HttpOnly cookie, never in the page.</p>
      </form>
    </main>
  );
}
