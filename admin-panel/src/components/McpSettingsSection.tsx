import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Alert, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { checkMcpConnection, deleteMcpConnection, fetchMcpConnection, saveMcpConnection, type McpConnectionSettings } from '../api';

export interface McpSettingsHandle { save(): Promise<void> }
interface Props {
  onToast(message: string, severity: 'success' | 'error'): void;
  onDirtyChange(id: string, dirty: boolean): void;
  disabled?: boolean;
}

export const McpSettingsSection = forwardRef<McpSettingsHandle, Props>(function McpSettingsSection({ onToast, onDirtyChange, disabled = false }, ref) {
  const [saved, setSaved] = useState<McpConnectionSettings | null>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<number | null>(null);
  const [disconnect, setDisconnect] = useState(false);
  const dirty = Boolean(saved && (url !== saved.url || token));
  useEffect(() => { onDirtyChange('mcp', dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { void load(); }, []);

  function accept(next: McpConnectionSettings) { setSaved(next); setUrl(next.url); setToken(''); setChecked(null); }
  async function load() {
    setBusy(true); setError('');
    try { accept(await fetchMcpConnection()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось загрузить MCP'); }
    finally { setBusy(false); }
  }
  const draft = () => ({ revision: saved!.revision, url: url.trim(), ...(token ? { token: token.trim() } : {}) });
  async function save() {
    if (!dirty || !saved) return;
    setBusy(true); setError('');
    try { accept(await saveMcpConnection(draft())); }
    catch (failure) { const message = failure instanceof Error ? failure.message : 'Не удалось сохранить MCP'; setError(message); throw new Error(message); }
    finally { setBusy(false); }
  }
  useImperativeHandle(ref, () => ({ save }));
  async function check() {
    if (!saved) return;
    setBusy(true); setError(''); setChecked(null);
    try { const result = await checkMcpConnection(draft()); setChecked(result.toolCount); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Проверка не пройдена'); }
    finally { setBusy(false); }
  }
  async function remove() {
    setDisconnect(false);
    if (!saved) return;
    setBusy(true); setError('');
    try { accept(await deleteMcpConnection(saved.revision)); onToast('Money Maker отключён в Кире', 'success'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось отключить MCP'); }
    finally { setBusy(false); }
  }
  let origin = '';
  try { const parsed = new URL(url); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) origin = parsed.origin; } catch {}
  return <Card><CardContent><Stack spacing={2.5}>
    <Stack direction="row" alignItems="center" spacing={1.5}>
      <Typography variant="h6" component="h3" sx={{ flex: 1 }}>Money Maker · MCP</Typography>
      {saved && <Chip size="small" color={saved.configured ? 'success' : 'default'} variant="outlined" label={saved.configured ? 'Настроено' : 'Не подключено'} />}
      {busy && <CircularProgress size={20} />}
    </Stack>
    <Typography variant="body2" color="text.secondary">Новости, отчётность и аналитика Money Maker в диалоге с Кирой. В Money Maker выпусти отдельный токен MCP и вставь его сюда.</Typography>
    {error && <Alert severity="error" action={<Button color="inherit" disabled={busy || disabled} onClick={() => { void load(); }}>Обновить</Button>}>{error}</Alert>}
    {checked !== null && <Alert severity="success">Доступ подтверждён. Доступно инструментов: {checked}.</Alert>}
    <TextField label="Адрес MCP Money Maker" value={url} onChange={event => { setUrl(event.target.value); setChecked(null); }} disabled={busy || disabled || !saved}
      placeholder="https://example.com/api/stocks/money-maker/mcp" fullWidth helperText="Полный адрес подключения из настроек MCP в Money Maker." />
    <TextField label={saved?.tokenConfigured ? 'Заменить токен MCP' : 'Токен MCP'} type="password" value={token} disabled={busy || disabled || !saved}
      onChange={event => { setToken(event.target.value); setChecked(null); }} autoComplete="new-password" fullWidth
      placeholder={saved?.tokenConfigured ? 'Токен сохранён' : 'Вставь выпущенный токен'} helperText={saved?.tokenConfigured ? 'Пустое поле сохраняет действующий токен.' : 'Токен хранится на сервере и не возвращается в браузер.'} />
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
      <Button variant="contained" disabled={!dirty || busy || disabled} onClick={() => { void save().then(() => onToast('Подключение MCP сохранено', 'success')).catch(() => {}); }}>Сохранить подключение</Button>
      <Button variant="outlined" disabled={!saved || busy || disabled || !url || !token && !saved.tokenConfigured} onClick={() => { void check(); }}>Проверить связь</Button>
      {origin && <Button component="a" href={`${origin}/account-settings#mcp-tokens`} target="_blank" rel="noopener noreferrer" endIcon={<OpenInNewIcon />}>Управлять токенами</Button>}
      {saved?.configured && <Button color="error" disabled={busy || disabled} onClick={() => setDisconnect(true)}>Отключить</Button>}
    </Stack>
    <Typography variant="caption" color="text.secondary">Изменения MCP применяются без перезапуска. Отозвать токен и посмотреть его срок действия можно в Money Maker.</Typography>
  </Stack></CardContent>
    <Dialog open={disconnect} onClose={() => setDisconnect(false)}>
      <DialogTitle>Отключить Money Maker?</DialogTitle>
      <DialogContent>Кира удалит сохранённое подключение и токен. Чтобы отозвать сам токен, открой управление MCP в Money Maker.</DialogContent>
      <DialogActions><Button onClick={() => setDisconnect(false)}>Отмена</Button><Button color="error" onClick={() => { void remove(); }}>Отключить</Button></DialogActions>
    </Dialog>
  </Card>;
});
