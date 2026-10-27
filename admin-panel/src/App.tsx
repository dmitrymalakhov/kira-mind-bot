import { useState, useEffect } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { LoginPage } from './pages/LoginPage';
import { Dashboard } from './components/Dashboard';
import { BrandMark } from './components/BrandMark';
import { AUTH_REQUIRED_EVENT, fetchConfig } from './api';
import type { ConfigResponse } from './types';

type AuthState = 'loading' | 'unauthenticated' | 'authenticated';

export default function App() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [config, setConfig] = useState<ConfigResponse>({});

  useEffect(() => {
    const handleAuthRequired = () => {
      setConfig({});
      setAuth('unauthenticated');
    };

    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
    fetchConfig()
      .then((cfg) => {
        setConfig(cfg);
        setAuth('authenticated');
      })
      .catch(() => setAuth('unauthenticated'));

    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
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
          flexDirection: 'column',
          gap: 3,
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          bgcolor: 'background.default',
        }}
      >
        <BrandMark size={96} />
        <CircularProgress size={24} aria-label="Загрузка Kira Mind" sx={{ color: 'primary.main' }} />
      </Box>
    );
  }

  if (auth === 'unauthenticated') {
    return <LoginPage onLogin={handleLogin} />;
  }

  return <Dashboard config={config} onLogout={handleLogout} onConfigUpdate={handleConfigUpdate} />;
}
