import { useState, useEffect } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { LoginPage } from './pages/LoginPage';
import { Dashboard } from './components/Dashboard';
import { fetchConfig } from './api';
import type { ConfigResponse } from './types';

type AuthState = 'loading' | 'unauthenticated' | 'authenticated';

export default function App() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [config, setConfig] = useState<ConfigResponse>({});

  useEffect(() => {
    fetchConfig()
      .then((cfg) => {
        setConfig(cfg);
        setAuth('authenticated');
      })
      .catch(() => setAuth('unauthenticated'));
  }, []);

  const handleLogin = (cfg: ConfigResponse) => {
    setConfig(cfg);
    setAuth('authenticated');
  };

  const handleLogout = () => {
    setConfig({});
    setAuth('unauthenticated');
  };

  const handleConfigUpdate = (cfg: ConfigResponse) => {
    setConfig(cfg);
  };

  if (auth === 'loading') {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          bgcolor: 'background.default',
        }}
      >
        <CircularProgress sx={{ color: 'primary.main' }} />
      </Box>
    );
  }

  if (auth === 'unauthenticated') {
    return <LoginPage onLogin={handleLogin} />;
  }

  return <Dashboard config={config} onLogout={handleLogout} onConfigUpdate={handleConfigUpdate} />;
}
