import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, MenuItem, Stack, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { checkMcpConnection, deleteMcpConnection, fetchMcpConnections, saveMcpConnection, type McpConnection, type McpConnectionSettings, type McpEffect, type McpProbeResult, type McpServerSettings } from '../api';

export interface McpSettingsHandle { save(): Promise<void> }
interface Props {
  onToast(message: string, severity: 'success' | 'error'): void;
  onDirtyChange(id: string, dirty: boolean): void;
  disabled?: boolean;
}
interface SecretRow { key: string; value: string | null; retained?: boolean }
interface ToolRow { name: string; effect: McpEffect | 'off' }
interface Editor {
  id: string; creating: boolean; description: string; transport: McpServerSettings['transport']; url: string;
  headers: SecretRow[]; env: SecretRow[]; command: string; args: string; fixedArguments: string; timeoutMs: number;
  oauth: boolean; tokenUrl: string; clientId: string; clientSecret: string | null; clientSecretRetained: boolean; scope: string; audience: string;
  tools: ToolRow[];
}
const secretRows = (values: Record<string, string | null> = {}): SecretRow[] => Object.entries(values).map(([key, value]) => ({ key, value, retained: value === null }));
function editConnection({ id, config }: McpConnection, creating = false): Editor {
  return { id, creating, description: config.description, transport: config.transport, url: config.url ?? '',
    headers: secretRows(config.headers), env: secretRows(config.env), command: config.command ?? '',
    args: JSON.stringify(config.args ?? [], null, 2), fixedArguments: JSON.stringify(config.fixedArguments ?? {}, null, 2), timeoutMs: config.timeoutMs,
    oauth: Boolean(config.oauth), tokenUrl: config.oauth?.tokenUrl ?? '', clientId: config.oauth?.clientId ?? '',
    clientSecret: config.oauth?.clientSecret ?? (config.oauth ? null : ''), clientSecretRetained: config.oauth?.clientSecret === null, scope: config.oauth?.scope ?? '', audience: config.oauth?.audience ?? '',
    tools: Object.entries(config.tools).map(([name, effect]) => ({ name, effect })) };
}
function secretValues(rows: SecretRow[]) {
  const keys = rows.map(row => row.key.trim());
  if (keys.some(key => !key) || new Set(keys).size !== keys.length) throw new Error('Укажи уникальные непустые имена заголовков и переменных.');
  return Object.fromEntries(rows.map((row, index) => [keys[index], row.value]));
}
function connectionDraft(editor: Editor): McpServerSettings {
  let args: unknown; let fixed: unknown;
  try { fixed = JSON.parse(editor.fixedArguments); args = editor.transport === 'stdio' ? JSON.parse(editor.args) : undefined; }
  catch { throw new Error('Проверь JSON в аргументах подключения.'); }
  if (!fixed || typeof fixed !== 'object' || Array.isArray(fixed)) throw new Error('Фиксированные аргументы должны быть JSON-объектом.');
  if (editor.transport === 'stdio' && (!Array.isArray(args) || args.some(value => typeof value !== 'string'))) throw new Error('Аргументы команды должны быть JSON-массивом строк.');
  const enabled = editor.tools.filter(tool => tool.effect !== 'off');
  if (enabled.some(tool => !tool.name.trim()) || new Set(enabled.map(tool => tool.name.trim())).size !== enabled.length) throw new Error('Укажи уникальные имена разрешённых инструментов.');
  return { description: editor.description, transport: editor.transport, timeoutMs: editor.timeoutMs,
    tools: Object.fromEntries(enabled.map(tool => [tool.name.trim(), tool.effect as McpEffect])), fixedArguments: fixed as Record<string, unknown>,
    ...(editor.transport === 'stdio' ? { command: editor.command.trim(), args: args as string[], env: secretValues(editor.env) }
      : { url: editor.url.trim(), headers: secretValues(editor.headers), ...(editor.oauth ? { oauth: {
        tokenUrl: editor.tokenUrl.trim(), clientId: editor.clientId.trim(), clientSecret: editor.clientSecret,
        ...(editor.scope ? { scope: editor.scope } : {}), ...(editor.audience ? { audience: editor.audience } : {}),
      } } : {}) }) };
}

function SecretFields({ rows, label, disabled, onChange }: { rows: SecretRow[]; label: string; disabled: boolean; onChange(rows: SecretRow[]): void }) {
  return <Stack spacing={1.5}>
    <Typography variant="subtitle2">{label}</Typography>
    {rows.map((row, index) => <Stack key={index} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="flex-start">
      <TextField label="Имя" value={row.key} disabled={disabled} fullWidth onChange={event => onChange(rows.map((item, i) => i === index ? { key: event.target.value, value: item.value === null ? '' : item.value, retained: false } : item))} />
      <TextField label="Значение" type="password" value={row.value ?? ''} disabled={disabled} fullWidth autoComplete="new-password"
        placeholder={row.value === null ? 'Сохранено на сервере' : ''} helperText={row.value === null ? 'Пустое поле сохраняет секрет.' : undefined}
        onChange={event => onChange(rows.map((item, i) => i === index ? { ...item, value: event.target.value || (row.retained ? null : '') } : item))} />
      <IconButton aria-label={`Удалить ${row.key || 'поле'}`} disabled={disabled} onClick={() => onChange(rows.filter((_, i) => i !== index))}><DeleteOutlineIcon /></IconButton>
    </Stack>)}
    <Button startIcon={<AddIcon />} disabled={disabled} onClick={() => onChange([...rows, { key: '', value: '' }])} sx={{ alignSelf: 'flex-start' }}>Добавить поле</Button>
  </Stack>;
}

export const McpSettingsSection = forwardRef<McpSettingsHandle, Props>(function McpSettingsSection({ onToast, onDirtyChange, disabled = false }, ref) {
  const [saved, setSaved] = useState<McpConnectionSettings | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [baseline, setBaseline] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<McpProbeResult | null>(null);
  const [disconnect, setDisconnect] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const dirty = Boolean(editor && (editor.creating || JSON.stringify(editor) !== baseline));
  const locked = busy || disabled;
  useEffect(() => { onDirtyChange('mcp', dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { void load(); }, []);
  const editorOpen = Boolean(editor);
  useEffect(() => { if (editorOpen) editorRef.current?.scrollIntoView({ block: 'start' }); }, [editorOpen]);

  function closeEditor() { setEditor(null); setBaseline(''); setChecked(null); }
  async function load() {
    setBusy(true); setError('');
    try { setSaved(await fetchMcpConnections()); closeEditor(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось загрузить MCP'); }
    finally { setBusy(false); }
  }
  function open(connection: McpConnection, creating = false) {
    const next = editConnection(connection, creating);
    setEditor(next); setBaseline(JSON.stringify(next)); setError(''); setChecked(null);
  }
  function change(patch: Partial<Editor>) {
    setEditor(previous => previous ? { ...previous, ...patch } : previous);
    if (Object.keys(patch).some(key => !['tools', 'description', 'fixedArguments'].includes(key))) setChecked(null);
  }
  function addTemplate(template: McpConnection) {
    let id = template.id === 'custom' ? '' : template.id;
    for (let suffix = 2; saved?.servers.some(server => server.id === id); suffix++) id = `${template.id}-${suffix}`;
    open({ ...template, id }, true);
  }
  function draft() { return { revision: saved!.revision, config: connectionDraft(editor!) }; }
  async function save() {
    if (!dirty || !saved || !editor) return;
    if (busy) throw new Error('Дождись завершения операции MCP перед сохранением.');
    setBusy(true); setError('');
    try { setSaved(await saveMcpConnection(editor.id.trim(), draft(), editor.creating)); closeEditor(); }
    catch (failure) { const message = failure instanceof Error ? failure.message : 'Не удалось сохранить MCP'; setError(message); throw new Error(message); }
    finally { setBusy(false); }
  }
  useImperativeHandle(ref, () => ({ save }));
  async function check() {
    if (!saved || !editor) return;
    setBusy(true); setError(''); setChecked(null);
    try {
      const result = await checkMcpConnection(editor.id.trim(), draft());
      setChecked(result);
      // Discovery does not grant permission. Even readOnlyHint cannot choose an effect.
      const known = new Set(editor.tools.map(tool => tool.name));
      setEditor({ ...editor, tools: [...editor.tools, ...result.tools.filter(tool => !known.has(tool.name)).map(tool => ({ name: tool.name, effect: 'off' as const }))] });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Проверка не пройдена'); }
    finally { setBusy(false); }
  }
  async function remove() {
    setDisconnect(false);
    if (!saved || !editor) return;
    setBusy(true); setError('');
    try { setSaved(await deleteMcpConnection(editor.id, saved.revision)); closeEditor(); onToast('MCP отключён в Кире', 'success'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось отключить MCP'); }
    finally { setBusy(false); }
  }
  let moneyMakerOrigin = '';
  try {
    const parsed = new URL(editor?.url ?? '');
    if (editor?.id === 'money-maker' && ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) moneyMakerOrigin = parsed.origin;
  } catch { /* The URL is validated by the server on check/save. */ }

  return <Card><CardContent><Stack spacing={2.5}>
    <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'flex-start', sm: 'center' }} spacing={1.5}>
      <Box sx={{ flex: 1 }}><Typography variant="h6" component="h3">MCP-серверы</Typography>
        <Typography variant="body2" color="text.secondary">Подключай внешние данные и инструменты к Кире. Каждый сервер настраивается отдельно.</Typography></Box>
      {saved && <Chip size="small" variant="outlined" label={`Подключено: ${saved.servers.length} / 16`} />}
      {busy && <CircularProgress size={20} />}
    </Stack>
    {error && <Alert severity="error" action={<Button color="inherit" disabled={locked} onClick={() => { void load(); }}>{dirty ? 'Сбросить и обновить' : 'Обновить'}</Button>}>{error}</Alert>}
    {saved?.servers.map(server => <Box key={server.id} sx={{ border: '1px solid', borderColor: editor?.id === server.id && !editor.creating ? 'primary.main' : 'divider', borderRadius: 2, p: 2 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}><Typography fontWeight={600}>{server.id}</Typography>
          <Typography variant="body2" color="text.secondary" title={server.config.description} sx={{ overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{server.config.description || 'MCP-сервер'}</Typography>
          <Typography variant="caption" color="text.secondary">{server.config.transport === 'http' ? 'Streamable HTTP' : server.config.transport === 'stdio' ? 'Локальный процесс · stdio' : 'POST JSON-RPC'} · Разрешено инструментов: {Object.keys(server.config.tools).length}</Typography></Box>
        <Chip label="Настроено" size="small" color="success" variant="outlined" />
        <Button disabled={locked || dirty} onClick={() => open(server)}>Настроить</Button>
      </Stack>
    </Box>)}
    {saved && !saved.servers.length && <Typography color="text.secondary">Пока нет подключённых MCP. Добавь свой сервер или выбери готовый шаблон.</Typography>}
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
      {saved?.templates.map(template => <Button key={template.id} variant={template.id === 'custom' ? 'contained' : 'outlined'} startIcon={<AddIcon />}
        disabled={locked || dirty || saved.servers.length >= 16} onClick={() => addTemplate(template)}>
        {template.id === 'custom' ? 'Добавить MCP' : template.name}
      </Button>)}
    </Stack>
    {editor && <Box ref={editorRef} sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 2.5, scrollMarginTop: 24 }}><Stack spacing={2.5}>
      <Typography variant="h6" component="h4">{editor.creating ? 'Новое подключение' : `Настройки ${editor.id}`}</Typography>
      <TextField label="ID сервера" value={editor.id} disabled={locked || !editor.creating} fullWidth onChange={event => change({ id: event.target.value })} helperText="Уникальное короткое имя латиницей, например notes или money-maker." />
      <TextField label="Описание для Киры" value={editor.description} disabled={locked} fullWidth multiline minRows={2} onChange={event => change({ description: event.target.value })} helperText="Какие данные и действия даёт сервер. По описанию Кира выбирает подходящее подключение." />
      <TextField select label="Транспорт" value={editor.transport} disabled={locked} fullWidth onChange={event => change({ transport: event.target.value as Editor['transport'] })}>
        <MenuItem value="http">Streamable HTTP</MenuItem><MenuItem value="jsonrpc">POST JSON-RPC</MenuItem><MenuItem value="stdio">Локальный процесс (stdio)</MenuItem>
      </TextField>
      {editor.transport === 'stdio' ? <>
        <TextField label="Команда" value={editor.command} disabled={locked} fullWidth onChange={event => change({ command: event.target.value })} placeholder="/usr/local/bin/my-mcp-server" helperText="Путь внутри окружения Киры и админки. Команда запускается без shell." />
        <TextField label="Аргументы команды · JSON" value={editor.args} disabled={locked} fullWidth multiline minRows={2} onChange={event => change({ args: event.target.value })} helperText={'Массив строк, например ["--port", "3000"]. Секреты передавай через переменные окружения.'} />
        <SecretFields rows={editor.env} label="Переменные окружения" disabled={locked} onChange={env => change({ env })} />
      </> : <>
        <TextField label="Адрес MCP" value={editor.url} disabled={locked} fullWidth onChange={event => change({ url: event.target.value })} placeholder="https://example.com/mcp" helperText="HTTPS; HTTP допустим для локального сервера. При смене адреса введи секреты заново." />
        <SecretFields rows={editor.headers} label="Заголовки авторизации" disabled={locked} onChange={headers => change({ headers })} />
        <Typography variant="caption" color="text.secondary">Для Bearer-токена добавь заголовок Authorization со значением Bearer &lt;токен&gt;. Для сервера без авторизации оставь список пустым.</Typography>
        <Accordion disableGutters><AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography>OAuth client credentials</Typography></AccordionSummary><AccordionDetails><Stack spacing={2}>
          <TextField select label="OAuth" value={editor.oauth ? 'on' : 'off'} disabled={locked} onChange={event => change({ oauth: event.target.value === 'on' })}><MenuItem value="off">Не используется</MenuItem><MenuItem value="on">Client credentials</MenuItem></TextField>
          {editor.oauth && <>
            <TextField label="Token URL" value={editor.tokenUrl} disabled={locked} onChange={event => change({ tokenUrl: event.target.value })} />
            <TextField label="Client ID" value={editor.clientId} disabled={locked} onChange={event => change({ clientId: event.target.value })} />
            <TextField label="Client secret" type="password" value={editor.clientSecret ?? ''} placeholder={editor.clientSecret === null ? 'Сохранено на сервере' : ''} disabled={locked} autoComplete="new-password" onChange={event => change({ clientSecret: event.target.value || (editor.clientSecretRetained ? null : '') })} />
            <TextField label="Scope (необязательно)" value={editor.scope} disabled={locked} onChange={event => change({ scope: event.target.value })} />
            <TextField label="Audience (необязательно)" value={editor.audience} disabled={locked} onChange={event => change({ audience: event.target.value })} />
            <Typography variant="caption" color="text.secondary">При OAuth удали заголовок Authorization. Интерактивный вход в аккаунт не используется.</Typography>
          </>}
        </Stack></AccordionDetails></Accordion>
      </>}
      {checked && <Alert severity={checked.truncated ? 'warning' : 'success'}>Связь подтверждена. Найдено инструментов: {checked.toolCount}.{checked.resources ? ' Доступны ресурсы MCP.' : ''}{checked.truncated ? ' Каталог показан частично; разрешённые имена можно добавить вручную.' : ''} Новые инструменты выключены, пока ты не выберешь доступ.</Alert>}
      <Box><Typography variant="subtitle1">Доступ к инструментам</Typography>
        <Typography variant="body2" color="text.secondary">Проверь связь, чтобы загрузить каталог. Чтение выполняется по запросу; действие требует подтверждения в диалоге.</Typography></Box>
      {editor.tools.map((tool, index) => <Box key={index}><Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="flex-start">
        <TextField label="Инструмент" value={tool.name} disabled={locked} fullWidth onChange={event => change({ tools: editor.tools.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} />
        <TextField select label="Доступ" value={tool.effect} disabled={locked} sx={{ minWidth: { xs: '100%', sm: 220 } }} onChange={event => change({ tools: editor.tools.map((item, i) => i === index ? { ...item, effect: event.target.value as ToolRow['effect'] } : item) })}>
          <MenuItem value="off">Выключен</MenuItem><MenuItem value="read">Чтение</MenuItem><MenuItem value="external">Действие с подтверждением</MenuItem>
        </TextField>
        <IconButton aria-label={`Убрать ${tool.name || 'инструмент'}`} disabled={locked} onClick={() => change({ tools: editor.tools.filter((_, i) => i !== index) })}><DeleteOutlineIcon /></IconButton>
      </Stack>{checked?.tools.find(item => item.name === tool.name)?.description && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, overflowWrap: 'anywhere' }}>{checked.tools.find(item => item.name === tool.name)!.description}</Typography>}</Box>)}
      <Button startIcon={<AddIcon />} disabled={locked} onClick={() => change({ tools: [...editor.tools, { name: '', effect: 'off' }] })} sx={{ alignSelf: 'flex-start' }}>Добавить инструмент вручную</Button>
      <Accordion disableGutters><AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography>Дополнительные параметры</Typography></AccordionSummary><AccordionDetails><Stack spacing={2}>
        <TextField label="Таймаут, мс" type="number" value={editor.timeoutMs} disabled={locked} inputProps={{ min: 100, max: 60000 }} onChange={event => change({ timeoutMs: Number(event.target.value) })} />
        <TextField label="Фиксированные аргументы · JSON" value={editor.fixedArguments} disabled={locked} multiline minRows={3} fullWidth onChange={event => change({ fixedArguments: event.target.value })} helperText="Передаются каждому инструменту. Модель не может их переопределить." />
      </Stack></AccordionDetails></Accordion>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        <Button variant="contained" disabled={!dirty || locked} onClick={() => { void save().then(() => onToast('Подключение MCP сохранено', 'success')).catch(() => {}); }}>Сохранить подключение</Button>
        <Button variant="outlined" disabled={locked || !editor.id.trim()} onClick={() => { void check(); }}>Проверить связь</Button>
        <Button disabled={locked} onClick={() => { closeEditor(); setError(''); }}>Отмена</Button>
        {moneyMakerOrigin && <Button component="a" href={`${moneyMakerOrigin}/account-settings#mcp-tokens`} target="_blank" rel="noopener noreferrer" endIcon={<OpenInNewIcon />}>Токены Money Maker</Button>}
        {!editor.creating && <Button color="error" disabled={locked} onClick={() => setDisconnect(true)}>Отключить</Button>}
      </Stack>
    </Stack></Box>}
    <Typography variant="caption" color="text.secondary">Настройки применяются без перезапуска. Секреты хранятся на сервере. Отключение удаляет подключение из Киры; токен отзывается у его поставщика.</Typography>
  </Stack></CardContent>
    <Dialog open={disconnect} onClose={() => setDisconnect(false)}>
      <DialogTitle>Отключить {editor?.id}?</DialogTitle>
      <DialogContent>Кира удалит это подключение и его сохранённые секреты. Остальные MCP продолжат работать.</DialogContent>
      <DialogActions><Button onClick={() => setDisconnect(false)}>Отмена</Button><Button color="error" onClick={() => { void remove(); }}>Отключить</Button></DialogActions>
    </Dialog>
  </Card>;
});
