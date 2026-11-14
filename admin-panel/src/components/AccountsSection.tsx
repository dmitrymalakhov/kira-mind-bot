import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Link, Stack, TextField, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import TelegramIcon from '@mui/icons-material/Telegram';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useAccountDraft } from '../accountEdits';
import {
  connectManagedBot, createManagedAccount, fetchManagedAccounts, fetchManagedPairing,
  renameManagedAccount, deleteManagedAccount, replaceManagedBot,
  type AccountPairing, type ManagedAccount, type ManagedAccountsResponse,
} from '../api';

function requestKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
const STATUS: Record<string, string> = {
  not_connected: 'Бот не подключён', awaiting_telegram: 'Ожидает Start в Telegram', pairing_expired: 'Ссылка истекла',
  waiting: 'Ожидает запуска', starting: 'Запускается', ready: 'Работает', restarting: 'Перезапускается',
  runtime_error: 'Ошибка запуска', invalid_bot_token: 'Токен бота недействителен', bot_in_use: 'Бот запущен другим приложением',
  telegram_unavailable: 'Telegram временно недоступен',
};
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Не удалось связаться с сервером';

export function AccountsSection({ active = true, selectedAccount, onSelect, onAccountsChanged }: {
  active?: boolean; selectedAccount?: string; onSelect?: (id: string) => void; onAccountsChanged?: (accounts: ManagedAccountsResponse) => void;
}) {
  const [data, setData] = useState<ManagedAccountsResponse>();
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [creating, setCreating] = useState(false), [busy, setBusy] = useState(false), [formError, setFormError] = useState('');
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [selected, setSelected] = useState<ManagedAccount | null>(null);
  const [botToken, setBotToken] = useState(''), [pairing, setPairing] = useState<AccountPairing | null>(null);
  const [recovering, setRecovering] = useState(false), [copied, setCopied] = useState(false);
  const createKey = useRef(requestKey()), botKey = useRef(requestKey()), generation = useRef(0);
  const dialogGeneration = useRef(0);
  const pendingReads = useRef(0);
  const [action,setAction]=useState<{kind:'rename'|'replace'|'delete';account:ManagedAccount}|null>(null);
  const [displayName,setDisplayName]=useState(''),[confirmation,setConfirmation]=useState(''),[notice,setNotice]=useState('');
  const [replacement,setReplacement]=useState<ManagedAccount|null>(null);
  const actionKey=useRef(requestKey());
  useAccountDraft(Boolean(creating && (username || password) || selected && botToken || action && !replacement &&
    (confirmation || botToken || action.kind==='rename' && displayName!==(action.account.displayName || action.account.username))));
  const load = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    pendingReads.current++;
    try {
      const result = await fetchManagedAccounts(signal);
      if (current === generation.current && !signal?.aborted) { setData(result); setError(''); onAccountsChanged?.(result); }
    } catch (error) { if (current === generation.current && !signal?.aborted) setError(errorText(error)); }
    finally { pendingReads.current--; if (current === generation.current && !signal?.aborted) setLoading(false); }
  }, [onAccountsChanged]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => { if (!document.hidden && !pendingReads.current) void load(controller.signal); }, 5000);
    return () => { controller.abort(); clearInterval(timer); generation.current++; };
  }, [active, load]);
  useEffect(() => {
    if (!selected || !data) return;
    const fresh = data.accounts.find(account => account.id === selected.id);
    if (fresh) setSelected(fresh);
  }, [data]); // List refreshes never change either form's fields.

  function closeDialog() {
    if (busy) return;
    dialogGeneration.current++; setCreating(false); setSelected(null); setBotToken(''); setPairing(null);
    setUsername(''); setPassword(''); setFormError(''); setCopied(false); setRecovering(false);
  }
  function openAction(kind:'rename'|'replace'|'delete',account:ManagedAccount){
    if(busy)return;
    closeDialog();setAction({kind,account});setDisplayName(account.displayName || account.username);setConfirmation('');setBotToken('');setReplacement(null);setFormError('');actionKey.current=requestKey();
  }
  function closeAction(){if(busy)return;setAction(null);setBotToken('');setConfirmation('');setReplacement(null);setFormError('');}
  async function submitAction(event:React.FormEvent){
    event.preventDefault();if(!action?.account.revision || busy)return;
    setBusy(true);setFormError('');
    try{
      const {account,kind}=action;
      if(kind==='rename'){
        await renameManagedAccount(account.id,displayName.trim(),account.revision!,actionKey.current);
        setAction(null);setNotice('Название аккаунта сохранено. Логин для входа не изменился.');
      }else if(kind==='delete'){
        await deleteManagedAccount(account.id,confirmation,account.revision!,actionKey.current);
        setAction(null);setConfirmation('');setNotice('Удаление начато. Аккаунт отключён; его память, чаты, задачи и файлы удаляются в фоне.');
      }else{
        const result=await replaceManagedBot(account.id,botToken.trim(),confirmation,account.revision!,actionKey.current);
        setBotToken('');setConfirmation('');setReplacement(result.account);setNotice('Telegram-бот заменён. Память, чаты, задачи и владелец сохранены.');
      }
      await load();
    }catch(error){setFormError(errorText(error));}
    finally{setBusy(false);}
  }
  async function openBot(account: ManagedAccount) {
    const current = ++dialogGeneration.current;
    setSelected(account); setFormError(''); setBotToken(''); setPairing(null); setCopied(false); botKey.current = requestKey();
    if (!account.bot || account.bot.connected) return;
    setRecovering(true);
    try {
      const result = await fetchManagedPairing(account.id);
      if (current === dialogGeneration.current) { setSelected(result.account); setPairing(result.pairing); }
    } catch (error) { if (current === dialogGeneration.current) setFormError(errorText(error)); }
    finally { if (current === dialogGeneration.current) setRecovering(false); }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setFormError('');
    try {
      const result = await createManagedAccount(username.trim(), password, createKey.current);
      setCreating(false); setUsername(''); setPassword(''); createKey.current = requestKey();
      await load(); await openBot(result.account);
    } catch (error) { setFormError(errorText(error)); }
    finally { setBusy(false); }
  }
  async function connect(event: React.FormEvent) {
    event.preventDefault(); if (!selected) return;
    setBusy(true); setFormError(''); setCopied(false);
    try {
      const result = await connectManagedBot(selected.id, botToken.trim(), botKey.current);
      setSelected(result.account); setPairing(result.pairing); setBotToken('');
      await load();
    } catch (error) { setFormError(errorText(error)); }
    finally { setBusy(false); }
  }
  const current = selected && data?.accounts.find(account => account.id === selected.id) || selected;
  const limitReached = Boolean(data?.capacity && data.accounts.length >= data.capacity);
  const connected = Boolean(current?.bot?.connected);

  return <Stack spacing={2.5}>
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ sm: 'center' }}>
      <Typography variant="body2" color="text.secondary">Один аккаунт — одна Кира со своей памятью, настройками и Telegram-ботом.</Typography>
      <Stack direction="row" spacing={1} flexShrink={0}>
        <Button startIcon={<RefreshIcon />} onClick={() => void load()} aria-label="Обновить аккаунты">Обновить</Button>
        <Button variant="contained" startIcon={<AddIcon />} disabled={busy || !data?.available || limitReached} onClick={() => {
          setFormError(''); createKey.current = requestKey(); setCreating(true);
        }}>Создать аккаунт</Button>
      </Stack>
    </Stack>
    {error && <Alert severity="error">{error}</Alert>}
    {notice && <Alert severity="success" onClose={()=>setNotice('')}>{notice}</Alert>}
    {loading && <CircularProgress size={26} aria-label="Загрузка аккаунтов" />}
    {data && !data.available && <Alert severity="info">На этом инстансе запущена одна Кира. Для добавления аккаунтов включите режим нескольких аккаунтов при настройке сервера.</Alert>}
    {data?.available && <>
      <Typography variant="body2" color="text.secondary">Аккаунтов: {data.accounts.length} из {data.capacity}. Мобильное приложение не требуется.</Typography>
      {limitReached && <Alert severity="info">Достигнут лимит аккаунтов этого инстанса. Уже созданные аккаунты продолжают работать.</Alert>}
      {data.accounts.length === 0 && <Card variant="outlined"><CardContent>
        <Typography variant="h6">Добавьте первую Киру</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Создайте аккаунт, укажите токен BotFather и подтвердите владельца через Start в Telegram.</Typography>
      </CardContent></Card>}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' }, gap: 2 }}>
        {data.accounts.map(account => <Card key={account.id} variant="outlined" data-account={account.id}><CardContent>
          <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
            <Box sx={{ minWidth: 0 }}><Typography variant="h6" sx={{ overflowWrap: 'anywhere' }}>{account.displayName || account.username}</Typography>
              <Typography variant="caption" color="text.secondary">Логин: {account.username}</Typography>
              <Typography variant="body2" color="text.secondary">{account.runtimeMode === 'api_only' ? 'Кира для приложения' : account.bot ? '@' + account.bot.username : 'Отдельный Telegram-бот'}</Typography></Box>
            <Chip size="small" variant="outlined" color={account.status === 'ready' ? 'success' : account.status === 'pairing_expired' ? 'warning' : 'default'}
              label={account.accountState === 'restricted' ? 'Ограничен' : STATUS[account.status] || 'Требуется проверка'} />
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, overflowWrap: 'anywhere' }}>ID: {account.id}</Typography>
          <Stack direction="row" useFlexGap flexWrap="wrap" spacing={1} sx={{ mt: 2 }}>
            {onSelect && <Button size="small" variant="contained" disabled={selectedAccount === account.id || !(account.bot?.connected || account.runtimeMode === 'api_only')}
              onClick={() => onSelect(account.id)}>{selectedAccount === account.id ? 'Выбран' : 'Управлять'}</Button>}
            {account.canConnectBot && <Button size="small" variant="outlined" startIcon={<TelegramIcon />} onClick={() => void openBot(account)}>
              {account.bot ? 'Продолжить подключение' : 'Подключить бота'}</Button>}
            {account.bot?.connected && <Button size="small" component="a" href={`https://t.me/${account.bot.username}?start=ai_consent`} target="_blank" rel="noopener noreferrer">Открыть бота</Button>}
            <Button size="small" disabled={busy || !account.revision} startIcon={<EditOutlinedIcon/>} onClick={()=>openAction('rename',account)}>Переименовать</Button>
            {account.canReplaceBot && <Button size="small" disabled={busy || !account.revision} startIcon={<TelegramIcon/>} onClick={()=>openAction('replace',account)}>Сменить бота</Button>}
            <Button size="small" color="error" disabled={busy || !account.revision || !account.canDelete} startIcon={<DeleteOutlineIcon/>} onClick={()=>openAction('delete',account)}>Удалить аккаунт</Button>
          </Stack>
          {account.bot?.connected && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Владелец подтверждён. Согласие на AI настраивается командой /ai_consent в личном чате с ботом.</Typography>}
        </CardContent></Card>)}
      </Box>
      <Alert severity="info">Токен BotFather подключает только бота. Личные переписки владельца требуют отдельного подключения. Выберите аккаунт сверху или нажмите «Управлять», чтобы открыть его настройки, память, чаты и задачи.</Alert>
    </>}
    <Dialog open={creating} onClose={closeDialog} fullWidth maxWidth="sm" aria-labelledby="create-account-title">
      <Box component="form" onSubmit={event => void create(event)}>
        <DialogTitle id="create-account-title">Новый аккаунт</DialogTitle>
        <DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2">Сохраните логин и пароль для владельца. После создания можно сразу подключить его Telegram-бота.</Typography>
          {formError && <Alert severity="error">{formError}</Alert>}
          <TextField label="Логин аккаунта" value={username} autoFocus required disabled={busy} autoComplete="off"
            inputProps={{ minLength: 3, maxLength: 40, pattern: '[A-Za-z0-9_]{3,40}' }} helperText="3–40 латинских букв, цифр или _"
            onChange={event => { setUsername(event.target.value); createKey.current = requestKey(); }} />
          <TextField label="Пароль аккаунта" type="password" value={password} required disabled={busy} autoComplete="new-password"
            inputProps={{ minLength: 12, maxLength: 256 }} helperText="Не менее 12 символов"
            onChange={event => { setPassword(event.target.value); createKey.current = requestKey(); }} />
        </Stack></DialogContent>
        <DialogActions><Button disabled={busy} onClick={closeDialog}>Отмена</Button><Button variant="contained" type="submit" disabled={busy || username.trim().length < 3 || password.length < 12}>
          {busy ? 'Создаётся…' : 'Создать и подключить бота'}</Button></DialogActions>
      </Box>
    </Dialog>
    <Dialog open={Boolean(selected)} onClose={closeDialog} fullWidth maxWidth="sm" aria-labelledby="connect-bot-title">
      <Box component="form" onSubmit={event => void connect(event)}>
        <DialogTitle id="connect-bot-title">Telegram-бот · {current?.username}</DialogTitle>
        <DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
          {formError && <Alert severity="error">{formError}</Alert>}
          {recovering && <CircularProgress size={24} aria-label="Проверка подключения" />}
          {connected ? <Alert severity="success">Владелец подтверждён. Кира {current?.status === 'ready' ? 'работает' : 'запускается'}. Откройте бота и настройте согласие на AI командой /ai_consent.</Alert>
            : pairing && Date.parse(pairing.expiresAt) > Date.now() ? <>
              <Alert severity="info">Откройте ссылку в Telegram владельца и нажмите Start. Ссылка подтверждает владельца аккаунта; передавайте её только ему.</Alert>
              <Button variant="contained" component="a" href={pairing.pairingUrl} target="_blank" rel="noopener noreferrer" startIcon={<TelegramIcon />}>Подтвердить в Telegram</Button>
              <Link href={pairing.pairingUrl} target="_blank" rel="noopener noreferrer" sx={{ overflowWrap: 'anywhere', fontSize: 13 }}>{pairing.pairingUrl}</Link>
              <Button onClick={() => {
                if (!navigator.clipboard) { setFormError('Скопируйте ссылку вручную.'); return; }
                void navigator.clipboard.writeText(pairing.pairingUrl).then(() => setCopied(true)).catch(() => setFormError('Скопируйте ссылку вручную.'));
              }}>{copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}</Button>
              <Typography variant="caption" color="text.secondary">Действует до {new Date(pairing.expiresAt).toLocaleString('ru-RU')}. Статус обновляется автоматически.</Typography>
            </> : <>
              <Typography variant="body2">Создайте бота в <Link href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</Link> и вставьте его токен. Если бот уже используется, остановите прежнее приложение и отключите webhook.</Typography>
              {current?.bot && <Alert severity="warning">Для новой ссылки введите токен бота ещё раз.</Alert>}
              <TextField label="Токен BotFather" type="password" value={botToken} required disabled={busy || recovering} autoComplete="off"
                inputProps={{ maxLength: 128 }} onChange={event => { setBotToken(event.target.value); botKey.current = requestKey(); }} />
            </>}
        </Stack></DialogContent>
        <DialogActions><Button disabled={busy} onClick={closeDialog}>Закрыть</Button>
          {!connected && (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) && <Button variant="contained" type="submit" disabled={busy || recovering || !botToken.trim()}>{busy ? 'Подключается…' : 'Получить ссылку подключения'}</Button>}
        </DialogActions>
      </Box>
    </Dialog>
    <Dialog open={Boolean(action)} onClose={closeAction} fullWidth maxWidth="sm" aria-labelledby="account-action-title">
      <Box component="form" onSubmit={event=>void submitAction(event)}>
        <DialogTitle id="account-action-title">{action?.kind==='rename'?'Переименовать аккаунт':action?.kind==='delete'?'Удалить аккаунт навсегда':'Сменить Telegram-бота'}</DialogTitle>
        <DialogContent><Stack spacing={2} sx={{pt:1}}>
          <Typography sx={{overflowWrap:'anywhere'}}>{action?.account.displayName || action?.account.username} · {action?.account.username}</Typography>
          {formError && <Alert severity="error">{formError}</Alert>}
          {action?.kind==='rename'?<TextField label="Название аккаунта" value={displayName} autoFocus required disabled={busy} inputProps={{maxLength:160}}
            helperText="До 80 символов. Логин и данные аккаунта сохраняются." onChange={event=>{setDisplayName(event.target.value);actionKey.current=requestKey();}}/>
          :replacement?<>
            <Alert severity="success">Подключён @{replacement.bot?.username}. Владелец, память, чаты и задачи сохранены.</Alert>
            <Button component="a" variant="contained" href={`https://t.me/${replacement.bot?.username}`} target="_blank" rel="noopener noreferrer">Открыть нового бота</Button>
            <Typography variant="body2">Владелец должен нажать Start у нового бота. Для работы в прежних группах добавьте туда нового бота и выдайте необходимые права.</Typography>
          </>:<>
            {action?.kind==='delete'?<Alert severity="error">Аккаунт будет отключён. Его память, чаты, задачи, настройки и файлы будут безвозвратно удалены. Остальные аккаунты продолжат работать.</Alert>
            :<>
              <Alert severity="info">Новый бот заменит @{action?.account.bot?.username}. UUID аккаунта, владелец, память, чаты и задачи сохранятся. Перезапустится только эта Кира.</Alert>
              <Typography variant="body2">Укажите токен BotFather. Остановите прежнее приложение нового бота и отключите webhook. После замены владелец должен нажать Start, а в группах нужно добавить нового бота.</Typography>
              <TextField label="Токен нового бота" type="password" autoComplete="off" required disabled={busy} value={botToken} inputProps={{maxLength:128}}
                onChange={event=>{setBotToken(event.target.value);actionKey.current=requestKey();}}/>
            </>}
            <TextField label="Логин для подтверждения" value={confirmation} required disabled={busy} autoComplete="off"
              helperText={`Введите ${action?.account.username || ''}`} onChange={event=>{setConfirmation(event.target.value);actionKey.current=requestKey();}}/>
          </>}
        </Stack></DialogContent>
        <DialogActions><Button disabled={busy} onClick={closeAction}>{replacement?'Закрыть':'Отмена'}</Button>
          {!replacement && <Button type="submit" variant="contained" color={action?.kind==='delete'?'error':'primary'}
            disabled={busy || (action?.kind==='rename'?!displayName.trim() || [...displayName.trim()].length>80 || displayName.trim()===(action.account.displayName || action.account.username)
              :confirmation!==action?.account.username || action?.kind==='replace'&&!botToken.trim())}>
            {busy?'Выполняется…':action?.kind==='rename'?'Сохранить название':action?.kind==='delete'?'Удалить навсегда':'Заменить бота'}</Button>}
        </DialogActions>
      </Box>
    </Dialog>
  </Stack>;
}
