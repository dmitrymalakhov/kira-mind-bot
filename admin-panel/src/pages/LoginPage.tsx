import { useState } from 'react';
import { Box, TextField, Button, Typography, Alert, CircularProgress, Stack } from '@mui/material';
import { BrandMark } from '../components/BrandMark';
import { login, fetchConfig } from '../api';
import type { ConfigResponse } from '../types';
interface Props { onLogin: (config: ConfigResponse) => void }
export function LoginPage({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault(); setLoading(true); setError('');
    try {
      const result = await login(username, password);
      if (result.success) onLogin(await fetchConfig()); else setError(result.error || 'Неверный логин или пароль');
    } catch { setError('Ошибка соединения'); } finally { setLoading(false); }
  };
  return <Box sx={{ minHeight: '100dvh', display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
    <Stack sx={{ display: { xs: 'none', md: 'flex' }, bgcolor: '#1C2823', color: '#F1F5EE', p: 7, justifyContent: 'space-between', position: 'relative', overflow: 'hidden' }}>
      <Stack direction="row" spacing={1.5} alignItems="center"><BrandMark /><Typography sx={{ fontSize: 19, letterSpacing: '.13em' }}>KIRA MIND</Typography></Stack>
      <Box sx={{ position: 'relative', zIndex: 1, maxWidth: 500 }}><Typography variant="overline" sx={{ color: '#ADC3A7' }}>Личное пространство</Typography>
        <Typography sx={{ fontSize: { md: 42, lg: 58 }, letterSpacing: '-.045em', lineHeight: 1.12, mt: 2 }}>Ваша Кира.<br />Всё под контролем.</Typography>
        <Typography sx={{ color: '#ADBCAF', mt: 3, maxWidth: 330, fontSize: 15, lineHeight: 1.8 }}>Модели, память и характер —<br />в одном спокойном пространстве.</Typography></Box>
      <Typography variant="caption" sx={{ color: '#8FA092' }}>Kira Mind / Панель управления</Typography>
      <Box aria-hidden="true" sx={{ position: 'absolute', width: 560, height: 560, right: -260, bottom: -260, border: '1px solid #5E7854', borderRadius: '50%', '&:before, &:after': { content: '""', position: 'absolute', inset: 45, border: '1px solid #42583D', borderRadius: '50%' }, '&:after': { inset: 100 } }} />
    </Stack>
    <Stack sx={{ p: { xs: 3, md: 6 }, minHeight: '100dvh', justifyContent: 'center', alignItems: 'center' }}>
      <Box sx={{ width: '100%', maxWidth: 360 }}>
        <Box sx={{ display: { md: 'none' }, mb: 4 }}><BrandMark size={46} /></Box>
        <Typography variant="overline" color="text.secondary">Kira Mind</Typography><Typography variant="h4" component="h1" sx={{ mt: 1, mb: 1 }}>Добро пожаловать</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>Войдите, чтобы настроить свою Киру.</Typography>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Box component="form" onSubmit={handleSubmit}><Stack spacing={2.5}>
          <TextField label="Логин" value={username} onChange={event => setUsername(event.target.value)} fullWidth required autoFocus autoComplete="username" />
          <TextField label="Пароль" type="password" value={password} onChange={event => setPassword(event.target.value)} fullWidth required autoComplete="current-password" />
          <Button type="submit" variant="contained" fullWidth disabled={loading} sx={{ minHeight: 46 }}>{loading ? <CircularProgress size={22} color="inherit" /> : 'Войти в пространство'}</Button>
        </Stack></Box>
      </Box>
    </Stack>
  </Box>;
}
