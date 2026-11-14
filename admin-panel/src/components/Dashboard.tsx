import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Chip, FormControl, InputLabel, Select,
  CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText,
  DialogTitle, Divider, Drawer, IconButton, ListItemButton, ListItemIcon,
  Menu, MenuItem, Snackbar, Stack, Tab, Tabs, Tooltip, Typography,
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import SaveIcon from '@mui/icons-material/Save';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import TuneIcon from '@mui/icons-material/Tune';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import MenuIcon from '@mui/icons-material/Menu';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import EventRepeatIcon from '@mui/icons-material/EventRepeat';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import { BrandMark } from './BrandMark';
import { StatusBar } from './StatusBar';
import { CONFIG_SCHEMA, KEY_SECTIONS } from '../schema';
import { ConfigSection, type ConfigSectionHandle } from './ConfigSection';
import { ModelSettingsSection } from './ModelSettingsSection';
import { BudgetSettingsSection } from './BudgetSettingsSection';
import { PersonalitySection } from './PersonalitySection';
import { ChatsSection } from './ChatsSection';
import { HealthSection } from './HealthSection';
import { MemorySection } from './MemorySection';
import { MonitoringSection } from './MonitoringSection';
import { ProductAnalyticsSection } from './ProductAnalyticsSection';
import { RecurringTasksSection } from './RecurringTasksSection';
import { AccountsSection } from './AccountsSection';
import { McpSettingsSection, type McpSettingsHandle } from './McpSettingsSection';
import { saveConfig, fetchConfig, logout, restartService, configRevision, adminMutationPending, ACCOUNT_REQUESTS_EVENT, type ManagedAccountsResponse } from '../api';
import { hasAccountDrafts, clearAccountDrafts } from '../accountEdits';
import type { ConfigResponse, Toast } from '../types';

const SIDEBAR_WIDTH = 304;
const SIDEBAR_COMPACT_WIDTH = 88;
const SIDEBAR_STORAGE_KEY = 'kira.admin.sidebar.collapsed.v1';
const NAVIGATION = [
  { id: 'settings', label: 'Настройки', icon: <TuneIcon />, caption: 'Модель, самостоятельность и подключения Киры.' },
  { id: 'accounts', label: 'Аккаунты и боты', icon: <GroupOutlinedIcon />, caption: 'Отдельные Киры и Telegram-боты на одном инстансе.' },
  { id: 'personality', label: 'Личность', icon: <PersonOutlineIcon />, caption: 'Характер, история и внешность Киры.' },
  { id: 'chats', label: 'Чаты', icon: <ForumOutlinedIcon />, caption: 'Группы, публичный режим и доступ к памяти.' },
  { id: 'memory', label: 'Память', icon: <PsychologyOutlinedIcon />, caption: 'Сохранённые факты, связи и поиск.' },
  { id: 'tasks', label: 'Задачи', icon: <EventRepeatIcon />, caption: 'Регулярные запросы и расписание запусков.' },
  { id: 'health', label: 'Здоровье', icon: <FavoriteBorderIcon />, caption: 'Дневник наблюдений и экспорт записей.' },
  { id: 'monitoring', label: 'Мониторинг', icon: <MonitorHeartOutlinedIcon />, caption: 'Состояние сервисов, использование AI и ошибки.' },
  { id: 'analytics', label: 'Аналитика', icon: <InsightsOutlinedIcon />, caption: 'Польза, удержание, качество результатов и цели продукта.' },
] as const;
export type Page = typeof NAVIGATION[number]['id'];

const SETTINGS_TABS = [
  { id: 'model', label: 'Модели', caption: 'Настройте, как Кира думает, отвечает и создаёт.' },
  { id: 'background', label: 'Самостоятельность', caption: 'Фоновые функции и контроль расхода AI.' },
  { id: 'connections', label: 'Подключения', caption: 'Ваши ключи и доступ к внешним сервисам.' },
  { id: 'system', label: 'Система', caption: 'Окружение и технические параметры установки.' },
] as const;
export type SettingsTab = typeof SETTINGS_TABS[number]['id'];
const SECTION_DESCRIPTIONS: Record<string, string> = {
  api: 'Ключи провайдеров и адреса API',
  elevenlabs: 'Голос и озвучивание сообщений',
  bots: 'Токен Telegram-бота',
  telegram: 'Подключение личного аккаунта',
  db: 'Подключение к PostgreSQL',
  vector: 'Хранилище и параметры поиска',
  general: 'Владелец, часовой пояс и лимиты',
  kira: 'Время активности и интервалы',
};

interface Props {
  config: ConfigResponse;
  onLogout: () => void;
  onConfigUpdate: (cfg: ConfigResponse) => void;
  accounts?: ManagedAccountsResponse;
  selectedAccount?: string;
  onAccountSelect?: (id: string) => void;
  onAccountsChanged?: (accounts: ManagedAccountsResponse) => void;
  scopeLoading?: boolean;
  scopeError?: string;
  onScopeRetry?: () => void;
  initialPage?: Page;
  onPageChange?: (page: Page) => void;
  initialSettingsTab?: SettingsTab;
  onSettingsTabChange?: (tab: SettingsTab) => void;
}

export function Dashboard({ config, onLogout, onConfigUpdate, accounts, selectedAccount, onAccountSelect, onAccountsChanged,
  scopeLoading = false, scopeError = '', onScopeRetry, initialPage = 'settings', onPageChange,
  initialSettingsTab = 'model', onSettingsTabChange }: Props) {
  const instanceOnly = selectedAccount === 'instance';
  const firstPage = instanceOnly && !['settings', 'accounts', 'monitoring', 'analytics'].includes(initialPage) ? 'settings' : initialPage;
  const firstTab = instanceOnly && !['connections', 'system'].includes(initialSettingsTab) ? 'connections' : initialSettingsTab;
  const [page, setPage] = useState<Page>(firstPage);
  const [accountsVisited, setAccountsVisited] = useState(firstPage === 'accounts');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(firstTab);
  const [visitedTabs, setVisitedTabs] = useState<Set<SettingsTab>>(() => new Set([firstTab]));
  const [switchTarget, setSwitchTarget] = useState<string>();
  const [mutationPending, setMutationPending] = useState(adminMutationPending());
  const scopeBlocked = scopeLoading || Boolean(scopeError);
  const selected = accounts?.accounts.find(account => account.id === selectedAccount);
  useEffect(() => {
    const update = () => setMutationPending(adminMutationPending());
    window.addEventListener(ACCOUNT_REQUESTS_EVENT, update);
    return () => window.removeEventListener(ACCOUNT_REQUESTS_EVENT, update);
  }, []);
  const [configDialog, setConfigDialog] = useState<string | null>(null);
  const [visitedDialogs, setVisitedDialogs] = useState<Set<string>>(() => new Set());
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true'; }
    catch { return false; }
  });
  const [serviceMenu, setServiceMenu] = useState<HTMLElement | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [dirtySections, setDirtySections] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<Toast | null>(null);
  const sectionRefs = useRef<Record<string, ConfigSectionHandle | null>>({});
  const mcpRef = useRef<McpSettingsHandle>(null);
  const pendingCount = Object.values(dirtySections).filter(Boolean).length;
  const currentPage = NAVIGATION.find(item => item.id === page)!;
  const currentSettings = SETTINGS_TABS.find(item => item.id === settingsTab)!;
  const showToast = useCallback((message: string, severity: Toast['severity']) => setToast({ message, severity }), []);
  const sidebarWidth = sidebarCollapsed ? SIDEBAR_COMPACT_WIDTH : SIDEBAR_WIDTH;
  const markDirty = useCallback((id: string, dirty: boolean) => {
    setDirtySections(previous => previous[id] === dirty ? previous : { ...previous, [id]: dirty });
  }, []);

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed)); }
    catch { /* Navigation still works when browser storage is unavailable. */ }
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!pendingCount) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [pendingCount]);

  function selectPage(next: Page) {
    if (next === 'accounts') setAccountsVisited(true);
    setPage(next);
    onPageChange?.(next);
    setMobileOpen(false);
    window.scrollTo({ top: 0 });
  }

  function selectSettings(next: SettingsTab) {
    setSettingsTab(next);
    onSettingsTabChange?.(next);
    setVisitedTabs(previous => new Set([...previous, next]));
    window.scrollTo({ top: 0 });
  }

  function openConfig(id: string) {
    setVisitedDialogs(previous => new Set([...previous, id]));
    setConfigDialog(id);
  }

  function completeSwitch(id: string) {
    if (adminMutationPending()) return;
    clearAccountDrafts(); setSwitchTarget(undefined); onAccountSelect?.(id);
  }
  function requestSwitch(id: string) {
    if (id === selectedAccount || adminMutationPending()) return;
    if (pendingCount || hasAccountDrafts()) setSwitchTarget(id);
    else completeSwitch(id);
  }

  async function handleSaveAll() {
    setSavingAll(true);
    try {
      const updates = Object.assign({}, ...Object.values(sectionRefs.current).map(section => section?.getUpdates() ?? {}));
      const result = await saveConfig(updates, configRevision(config));
      if (!result.success) throw new Error(result.error || 'Ошибка сохранения');
      const saved = await fetchConfig();
      Object.values(sectionRefs.current).forEach(section => section?.acceptSaved(saved, updates));
      onConfigUpdate(saved);
      await mcpRef.current?.save();
      showToast(dirtySections.mcp ? 'Изменения сохранены' : result.message || 'Изменения сохранены', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Ошибка соединения', 'error');
    } finally { setSavingAll(false); }
  }

  async function handleRestart() {
    setRestartOpen(false);
    setRestarting(true);
    try {
      const result = await restartService('kira-mind-bot');
      showToast(result.message || result.error || (result.success ? 'Бот перезапускается' : 'Ошибка перезапуска'), result.success ? 'info' : 'error');
    } catch { showToast('Ошибка соединения', 'error'); }
    finally { setRestarting(false); }
  }

  const renderNavigation = (compact: boolean, mobile = false) => (
    <Stack sx={{ height: '100%', bgcolor: 'sidebar.surface' }}>
      <Stack direction="row" alignItems="center" justifyContent={compact ? 'center' : 'flex-start'} spacing={compact ? 0 : 1.5}
        sx={{ px: compact ? 1.5 : 2.5, minHeight: 128, flexShrink: 0, position: 'relative' }}>
        <BrandMark size={compact ? 56 : 88} />
        {!compact && <Box><Typography sx={{ color: '#F1F5EE', fontSize: 27, fontWeight: 500, letterSpacing: '-.035em', whiteSpace: 'nowrap' }}>Kira <Box component="span" sx={{ fontWeight: 400, color: '#ADC0AF' }}>Mind</Box></Typography>
          <Typography sx={{ color: '#A5B4AA', fontSize: 10, letterSpacing: '.04em', mt: .5 }}>ПАНЕЛЬ УПРАВЛЕНИЯ</Typography></Box>}
        {mobile && <IconButton aria-label="Закрыть меню" onClick={() => setMobileOpen(false)} size="small" sx={{ position: 'absolute', top: 10, right: 10, color: '#AFBDB2' }}><CloseIcon fontSize="small" /></IconButton>}
      </Stack>
      <Box component="nav" id={mobile ? 'mobile-navigation' : 'desktop-navigation'} aria-label="Основная навигация" sx={{ px: compact ? 2 : 2.5, flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {NAVIGATION.map(item => (
          <Box key={item.id}>
            {['settings', 'personality', 'monitoring'].includes(item.id) && <Box sx={{ height: 24, display: 'flex', alignItems: 'center', justifyContent: compact ? 'center' : 'flex-start', px: compact ? 0 : 1.75, mt: item.id === 'settings' ? 0 : 1 }}>
              {compact ? <Box aria-hidden="true" sx={{ width: 22, borderTop: '1px solid', borderColor: 'sidebar.border' }} /> : <Typography variant="overline" sx={{ color: '#A5B4AA' }}>{item.id === 'settings' ? 'Управление' : item.id === 'monitoring' ? 'Система' : 'Пространство'}</Typography>}
            </Box>}
            <Tooltip title={compact ? item.label + (item.id === 'settings' && pendingCount > 0 ? ' · Есть несохранённые изменения' : '') : ''} placement="right" arrow>
              <ListItemButton disabled={instanceOnly && !['settings', 'accounts', 'monitoring', 'analytics'].includes(item.id)} selected={page === item.id} onClick={() => selectPage(item.id)} aria-label={item.label} aria-current={page === item.id ? 'page' : undefined}
                sx={{ minHeight: 52, px: compact ? 0 : 1.75, mb: .5, gap: 1.75, position: 'relative', justifyContent: compact ? 'center' : 'flex-start', color: '#BBC8BE', '&:hover': { bgcolor: 'sidebar.hover', color: '#F1F5EE' }, '&.Mui-selected': { bgcolor: '#D8E9CD', color: '#284331', '&:hover': { bgcolor: '#DFEED5' } } }}>
                <ListItemIcon sx={{ minWidth: 0, color: 'inherit', '& svg': { fontSize: 24 } }}>{item.icon}</ListItemIcon>
                {!compact && <Typography fontSize={15} fontWeight={page === item.id ? 600 : 400}>{item.label}</Typography>}
                {item.id === 'settings' && pendingCount > 0 && <Box component="span" aria-label="Есть несохранённые изменения" sx={{ position: 'absolute', right: compact ? 8 : 16, top: compact ? 10 : 23, width: 6, height: 6, borderRadius: '50%', bgcolor: 'warning.main' }} />}
              </ListItemButton>
            </Tooltip>
          </Box>
        ))}
      </Box>
      <Stack sx={{ mx: compact ? 2 : 2.5, py: 1, borderTop: '1px solid', borderColor: 'sidebar.border', flexShrink: 0 }}>
        <Stack direction="row" justifyContent={compact ? 'center' : 'space-between'} alignItems="center">
          {!compact && <Typography variant="caption" sx={{ color: '#A5B4AA' }}>Управление сервисом</Typography>}
          <Tooltip title="Действия сервиса" placement="right">
            <IconButton sx={{ color: '#BBC8BE', minHeight: 44, minWidth: 44 }} aria-label="Действия сервиса" aria-haspopup="menu" aria-controls={serviceMenu ? 'service-menu' : undefined} aria-expanded={Boolean(serviceMenu)} onClick={event => setServiceMenu(event.currentTarget)}>
              {restarting ? <CircularProgress size={20} /> : <MoreHorizIcon />}
            </IconButton>
          </Tooltip>
        </Stack>
        {!mobile && <Tooltip title={compact ? 'Развернуть меню' : ''} placement="right" arrow>
          <Button onClick={() => setSidebarCollapsed(value => !value)} aria-label={compact ? 'Развернуть меню' : 'Свернуть меню'} aria-expanded={!compact} aria-controls="desktop-navigation"
            sx={{ mt: .5, minWidth: 0, minHeight: 44, px: compact ? 0 : 1.5, gap: 1.5, justifyContent: compact ? 'center' : 'flex-start', color: '#BBC8BE', fontWeight: 400, '&:hover': { bgcolor: 'sidebar.hover', color: '#F1F5EE' } }}>
            {compact ? <ChevronRightIcon /> : <ChevronLeftIcon />}{!compact && 'Свернуть меню'}
          </Button>
        </Tooltip>}
      </Stack>
    </Stack>
  );

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', bgcolor: 'background.default' }}>
      <Box component="aside" sx={{ display: { xs: 'none', md: 'block' }, width: sidebarWidth, flexShrink: 0, transition: 'width 180ms ease' }}>
        <Box sx={{ position: 'fixed', inset: '0 auto 0 0', width: sidebarWidth, transition: 'width 180ms ease', borderRight: '1px solid', borderColor: 'divider' }}>{renderNavigation(sidebarCollapsed)}</Box>
      </Box>
      <Drawer open={mobileOpen} onClose={() => setMobileOpen(false)} sx={{ display: { md: 'none' }, '& .MuiDrawer-paper': { width: SIDEBAR_WIDTH, maxWidth: '88vw' } }}>{renderNavigation(false, true)}</Drawer>
      <Box component="main" id="main-content" sx={{ flex: 1, minWidth: 0, px: { xs: 2, sm: 4, lg: 5 }, py: 3, maxWidth: 1440, mx: 'auto' }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" sx={{ mb: 3, gap: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <IconButton aria-label="Открыть меню" onClick={() => setMobileOpen(true)} sx={{ display: { md: 'none' } }}><MenuIcon /></IconButton>
            <Typography variant="caption" color="text.secondary">Kira Mind <Box component="span" sx={{ mx: 1.5, color: '#BCC6B9' }}>/</Box> {currentPage.label}</Typography>
          </Stack>
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0 }}>
            {accounts?.available && <FormControl size="small" sx={{ minWidth: { xs: 0, sm: 230 }, width: { xs: '100%', sm: 'auto' }, maxWidth: { sm: 320 } }}>
              <InputLabel id="account-selector-label">Аккаунт</InputLabel>
              <Select labelId="account-selector-label" label="Аккаунт" value={selectedAccount || ''} disabled={mutationPending} onChange={event => requestSwitch(event.target.value)}>
                {selectedAccount && selectedAccount !== 'instance' && !selected && <MenuItem value={selectedAccount}>Недоступный аккаунт</MenuItem>}
                {accounts.accounts.map(account => <MenuItem key={account.id} value={account.id}>{account.displayName || account.username}{account.bot ? ` · @${account.bot.username}` : ''}</MenuItem>)}
                <MenuItem value="instance">Инстанс · общие подключения</MenuItem>
              </Select>
            </FormControl>}
            {!scopeBlocked && <StatusBar />}
          </Stack>
        </Stack>
        <Stack component="header" direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2} sx={{ mb: 2.5 }}>
          <Box><Typography variant="h4" component="h1">{page === 'settings' ? currentSettings.label : currentPage.label}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: .75 }}>{page === 'settings' ? currentSettings.caption : currentPage.caption}</Typography></Box>
        </Stack>

        {accounts?.available && <Alert severity="info" sx={{ mb: 2, overflowWrap: 'anywhere' }}>{instanceOnly
          ? 'Общие подключения и инфраструктура инстанса. Выберите аккаунт для управления его Кирой.'
          : `Выбрана Кира: ${selected?.displayName || selected?.username || selectedAccount}. Настройки, память, чаты и задачи относятся к этому аккаунту.`}</Alert>}
        {scopeLoading && <CircularProgress size={26} aria-label="Загрузка выбранного аккаунта" />}
        {scopeError && <Alert severity="error" action={<Button color="inherit" onClick={onScopeRetry}>Повторить</Button>}>{scopeError}</Alert>}
        {/* Keep visited settings mounted so navigation preserves pending edits. */}
        {!scopeBlocked && <>
        <Box hidden={page !== 'settings'}>
          <Tabs value={settingsTab} onChange={(_, next: SettingsTab) => selectSettings(next)} variant="scrollable" scrollButtons={false} aria-label="Разделы настроек" sx={{ mb: 2.5, bgcolor: '#EAEDE5', p: .5, borderRadius: 1.75, width: 'fit-content', maxWidth: '100%' }}>
            {SETTINGS_TABS.filter(item => !instanceOnly || ['connections', 'system'].includes(item.id)).map(item => <Tab key={item.id} id={`settings-tab-${item.id}`} value={item.id} sx={{ px: { xs: 1.25, sm: 2.25 }, fontSize: { xs: 12, sm: 13 } }} label={item.id === 'background' ? <><Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>Самостоятельность</Box><Box component="span" sx={{ display: { xs: 'inline', sm: 'none' } }}>Фон</Box></> : item.label} aria-controls={`settings-panel-${item.id}`} />)}
          </Tabs>
          {pendingCount > 0 && (
            <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" spacing={1} sx={{ mb: 2, p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
              <Typography variant="body2">Есть несохранённые изменения.</Typography>
              <Button variant="contained" size="small" disabled={savingAll} onClick={() => void handleSaveAll()} startIcon={savingAll ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />} sx={{ flexShrink: 0 }}>Сохранить изменения</Button>
            </Stack>
          )}
          {SETTINGS_TABS.filter(item => !instanceOnly || ['connections', 'system'].includes(item.id)).map(item => (
            <Box key={item.id} role="tabpanel" id={`settings-panel-${item.id}`} aria-labelledby={`settings-tab-${item.id}`} hidden={settingsTab !== item.id}>
              {visitedTabs.has(item.id) && <>
                {item.id === 'model' && <>
                  <ModelSettingsSection ref={element => { sectionRefs.current['local-models'] = element; }} config={config} onUpdate={onConfigUpdate} onToast={showToast} onDirtyChange={markDirty} />

                </>}
                {item.id === 'background' && <BudgetSettingsSection onToast={showToast} />}
                {item.id === 'connections' && <Stack spacing={2}>
                  <Typography variant="body2" color="text.secondary">Ключи хранятся на сервере. Для ключей AI и Telegram требуется пересоздание контейнеров; настройки MCP применяются сразу.</Typography>
                  {!instanceOnly && <McpSettingsSection ref={mcpRef} disabled={savingAll} onToast={showToast} onDirtyChange={markDirty} />}
                  {KEY_SECTIONS.filter(section => section.fields.some(field => config[field.key] && !config[field.key].readOnly)).map(section => <ConfigSection key={section.id} inline
                    ref={element => { sectionRefs.current[section.id] = element; }} section={section} config={config} onUpdate={onConfigUpdate} onToast={showToast} onDirtyChange={markDirty} />)}
                </Stack>}
                {(item.id === 'system') && <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
                  {CONFIG_SCHEMA.filter(section => section.fields.some(field => config[field.key] && !config[field.key].readOnly)).map(section => (
                    <ListItemButton key={section.id} onClick={() => openConfig(section.id)} aria-haspopup="dialog" sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper', gap: 2, alignItems: 'center', minHeight: 100 }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Stack direction="row" alignItems="center" spacing={1}>
                          <Typography variant="body2" fontWeight={600}>{section.title}</Typography>
                          {dirtySections[section.id] && <Chip size="small" color="warning" variant="outlined" label="Изменено" />}
                        </Stack>
                        <Typography variant="caption" color="text.secondary">{SECTION_DESCRIPTIONS[section.id]}</Typography>
                      </Box>
                      <EditOutlinedIcon sx={{ fontSize: 19, color: 'text.secondary' }} />
                    </ListItemButton>
                  ))}
                </Box>}
              </>}
            </Box>
          ))}
        </Box>
        {CONFIG_SCHEMA.filter(section => visitedDialogs.has(section.id)).map(section => <ConfigSection
          key={section.id} ref={element => { sectionRefs.current[section.id] = element; }}
          section={section} config={config} onUpdate={onConfigUpdate} onToast={showToast}
          onDirtyChange={markDirty} open={configDialog === section.id} onClose={() => setConfigDialog(null)}
        />)}
        {page === 'personality' && <PersonalitySection onToast={showToast} />}
        {page === 'chats' && <ChatsSection />}
        {page === 'health' && <HealthSection />}
        {page === 'memory' && <MemorySection onToast={showToast} />}
        {page === 'monitoring' && <>
          <Stack component="nav" aria-label="Разделы мониторинга" direction="row" flexWrap="wrap" gap={0.5} sx={{ mb: 2 }}>
            {[
              ['monitor-overview', 'Обзор'], ['monitor-deps', 'Сервисы'],
              ['monitor-ai-usage', 'Расходы AI'], ['monitor-chains', 'Маршруты'],
              ['monitor-failures', 'Ошибки'],
            ].map(([id, label]) => <Button key={id} size="small" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })}>{label}</Button>)}
          </Stack>
          <MonitoringSection />
        </>}
        {page === 'tasks' && <RecurringTasksSection />}
        {page === 'analytics' && <ProductAnalyticsSection />}
        </>}
        {accountsVisited && <Box hidden={page !== 'accounts'}><AccountsSection active={page === 'accounts'} selectedAccount={selectedAccount}
          onAccountsChanged={onAccountsChanged} onSelect={onAccountSelect ? id => { selectPage('settings'); requestSwitch(id); } : undefined} /></Box>}
      </Box>
      <Menu id="service-menu" anchorEl={serviceMenu} open={Boolean(serviceMenu)} onClose={() => setServiceMenu(null)}>
        <MenuItem disabled={restarting || scopeBlocked || instanceOnly} onClick={() => { setServiceMenu(null); setRestartOpen(true); }}><ListItemIcon><RestartAltIcon fontSize="small" /></ListItemIcon>Перезапустить бота</MenuItem>
        <Divider />
        <MenuItem onClick={() => { setServiceMenu(null); void logout().then(onLogout).catch(() => showToast('Не удалось выйти. Повторите попытку.', 'error')); }}><ListItemIcon><LogoutIcon fontSize="small" /></ListItemIcon>Выйти</MenuItem>
      </Menu>
      <Dialog open={Boolean(switchTarget)} onClose={() => setSwitchTarget(undefined)} aria-labelledby="switch-account-title">
        <DialogTitle id="switch-account-title">Есть несохранённые изменения</DialogTitle>
        <DialogContent><DialogContentText>При переключении аккаунта эти правки будут потеряны. Сохраните их или подтвердите переключение.</DialogContentText></DialogContent>
        <DialogActions><Button onClick={() => setSwitchTarget(undefined)}>Остаться</Button><Button disabled={mutationPending} onClick={() => switchTarget && completeSwitch(switchTarget)}>Отбросить и переключить</Button></DialogActions>
      </Dialog>
      <Dialog open={restartOpen} onClose={() => setRestartOpen(false)} aria-labelledby="restart-title">
        <DialogTitle id="restart-title">Перезапустить бота?</DialogTitle>
        <DialogContent><DialogContentText>Во время перезапуска Кира ненадолго перестанет отвечать. Несохранённые настройки не применятся.</DialogContentText></DialogContent>
        <DialogActions><Button onClick={() => setRestartOpen(false)}>Отмена</Button><Button variant="contained" onClick={() => void handleRestart()}>Перезапустить</Button></DialogActions>
      </Dialog>
      <Snackbar open={toast !== null} autoHideDuration={4500} onClose={() => setToast(null)}><Alert onClose={() => setToast(null)} severity={toast?.severity ?? 'success'} variant="filled" sx={{ maxWidth: 420 }}>{toast?.message}</Alert></Snackbar>
    </Box>
  );
}
