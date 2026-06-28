import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { Login } from './components/Login';
import { HealthCheckProvider } from './contexts/HealthCheckContext';
import { getToken } from './lib/auth.ts';

// Gates the app behind a token when the server requires one. Probes /api/config
// with whatever token we have: 200 => proceed, 401 => show the login form.
// A server with no tokens configured returns 200 unauthenticated, so auth-free
// setups skip the form entirely.
function Root() {
  const [state, setState] = useState<'checking' | 'authed' | 'login'>('checking');

  useEffect(() => {
    const token = getToken();
    fetch('/api/config', token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
      .then((res) => setState(res.status === 401 ? 'login' : 'authed'))
      .catch(() => setState('authed')); // server unreachable: let the app surface the error
  }, []);

  if (state === 'checking') return null;
  if (state === 'login') return <Login onAuthenticated={() => window.location.reload()} />;
  return (
    <HealthCheckProvider>
      <App />
    </HealthCheckProvider>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
