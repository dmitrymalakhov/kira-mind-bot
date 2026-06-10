import { useRef, useState } from 'react';
import {
  Box,
  Paper,
  ListItemButton,
  ListItemIcon,
  Typography,
  Button,
  Divider,
  Snackbar,
  Alert,
  CircularProgress,
  Tooltip,
  Chip,
  IconButton,
  useMediaQuery,
  useTheme,
  alpha,
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import SaveAllIcon from '@mui/icons-material/LibraryAddCheck';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import PersonIcon from '@mui/icons-material/Person';
import TuneIcon from '@mui/icons-material/Tune';
import ForumIcon from '@mui/icons-material/Forum';
import LocalHospitalIcon from '@mui/icons-material/LocalHospital';
import MemoryIcon from '@mui/icons-material/Memory';
import MenuIcon from '@mui/icons-material/Menu';
import KeyIcon from '@mui/icons-material/Key';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import StorageIcon from '@mui/icons-material/Storage';
import PsychologyIcon from '@mui/icons-material/Psychology';
import SmartphoneIcon from '@mui/icons-material/Smartphone';
import SettingsIcon from '@mui/icons-material/Settings';
import EventRepeatIcon from '@mui/icons-material/EventRepeat';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import SparklesIcon from '@mui/icons-material/AutoAwesome';
import NotesIcon from '@mui/icons-material/Notes';
import FlareIcon from '@mui/icons-material/Flare';
import { StatusBar } from './StatusBar';
import { CONFIG_SCHEMA } from '../schema';
import { ConfigSection, type ConfigSectionHandle } from './ConfigSection';
import { ModelSettingsSection } from './ModelSettingsSection';
import { PersonalitySection } from './PersonalitySection';
import { ChatsSection } from './ChatsSection';
import { HealthSection } from './HealthSection';
import { MemorySection } from './MemorySection';
import { saveConfig, fetchConfig, logout, restartService } from '../api';
import type { ConfigResponse, Toast } from '../types';

const DESKTOP_SIDEBAR_WIDTH = 318;

interface Props {
  config: ConfigResponse;
  onLogout: () => void;
  onConfigUpdate: (cfg: ConfigResponse) => void;
}

interface SidebarTabItem {
  id: number;
  label: string;
  caption: string;
  icon: JSX.Element;
}

interface SidebarSectionItem {
  targetId: string;
  shortLabel: string;
  icon: JSX.Element;
  caption: string;
}

interface SidebarSectionGroup {
  title: string;
  items: SidebarSectionItem[];
}

interface SidebarIntroCard {
  icon: JSX.Element;
  label: string;
  caption: string;
  targetId?: string;
}

const SIDEBAR_TABS: SidebarTabItem[] = [
  { id: 0, label: 'Настройки', caption: 'Конфиг и сервисы', icon: <TuneIcon fontSize="small" /> },
  { id: 1, label: 'Личность', caption: 'Характер и тон', icon: <PersonIcon fontSize="small" /> },
  { id: 2, label: 'Чаты', caption: 'Группы и доступ', icon: <ForumIcon fontSize="small" /> },
  { id: 3, label: 'Здоровье', caption: 'Дневник и выгрузки', icon: <LocalHospitalIcon fontSize="small" /> },
  { id: 4, label: 'Память', caption: 'Факты и индексы', icon: <MemoryIcon fontSize="small" /> },
];

const SETTINGS_GROUPS: SidebarSectionGroup[] = [
  {
    title: 'Интеграции',
    items: [
      { targetId: 'api', shortLabel: 'API', icon: <KeyIcon fontSize="small" />, caption: 'API Ключи' },
      { targetId: 'model-presets', shortLabel: 'AI Presets', icon: <FlareIcon fontSize="small" />, caption: 'Пресеты моделей' },
      { targetId: 'elevenlabs', shortLabel: 'Voice', icon: <GraphicEqIcon fontSize="small" />, caption: 'ElevenLabs Voice' },
      { targetId: 'bots', shortLabel: 'Telegram', icon: <SmartToyIcon fontSize="small" />, caption: 'Telegram Боты' },
      { targetId: 'telegram', shortLabel: 'Клиент', icon: <SmartphoneIcon fontSize="small" />, caption: 'Telegram Клиент' },
    ],
  },
  {
    title: 'Инфраструктура',
    items: [
      { targetId: 'db', shortLabel: 'База', icon: <StorageIcon fontSize="small" />, caption: 'База данных' },
      { targetId: 'vector', shortLabel: 'Память', icon: <PsychologyIcon fontSize="small" />, caption: 'Векторная память' },
    ],
  },
  {
    title: 'Поведение',
    items: [
      { targetId: 'general', shortLabel: 'Общие', icon: <SettingsIcon fontSize="small" />, caption: 'Общие настройки' },
      { targetId: 'kira', shortLabel: 'Расписание', icon: <EventRepeatIcon fontSize="small" />, caption: 'Kira — Расписание' },
    ],
  },
];

const SIDEBAR_INTRO_CARDS: Record<number, SidebarIntroCard[]> = {
  0: [],
  1: [
    {
      icon: <SparklesIcon fontSize="small" />,
      label: 'Kira',
      caption: 'Личность, настроение и манера общения',
      targetId: 'personality-kira-—-личность-и-характер',
    },
  ],
  2: [
    {
      icon: <ForumIcon fontSize="small" />,
      label: 'Чаты',
      caption: 'Публичный режим, память и ограничения',
    },
  ],
  3: [
    {
      icon: <LocalHospitalIcon fontSize="small" />,
      label: 'Дневник',
      caption: 'Наблюдения, фильтры и экспорт записей',
    },
  ],
  4: [
    {
      icon: <NotesIcon fontSize="small" />,
      label: 'Память',
      caption: 'Факты, синтетика и ревизия индексов',
    },
  ],
};

export function Dashboard({ config, onLogout, onConfigUpdate }: Props) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [activeSection, setActiveSection] = useState(CONFIG_SCHEMA[0].id);
  const [activeTab, setActiveTab] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  const activeTabMeta = {
    title: activeTab === 0
      ? 'Настройки бота'
      : activeTab === 1
        ? 'Управление личностью'
        : activeTab === 2
          ? 'Чаты бота'
          : activeTab === 3
            ? 'Дневник здоровья'
            : 'Управление памятью',
    caption: activeTab === 0 || activeTab === 1
      ? 'Изменения применяются после перезапуска контейнера'
      : activeTab === 2
        ? 'Группы, публичный режим и доступ к памяти'
        : activeTab === 3
          ? 'Сохранённые наблюдения и выгрузки'
          : 'Сводка, факты, индексы и ручная правка',
    badge: SIDEBAR_TABS.find((item) => item.id === activeTab)?.label ?? 'Раздел',
  };

  // Refs to collect values from each section for "Save All"
  const sectionRefs = useRef<Record<string, ConfigSectionHandle | null>>({});

  const showToast = (message: string, severity: 'success' | 'error' | 'info') => {
    setToast({ message, severity });
  };

  const scrollToSection = (id: string) => {
    setActiveSection(id);
    if (isMobile) {
      setMobileOpen(false);
    }
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleSaveAll = async () => {
    setSavingAll(true);
    try {
      // Collect all pending updates from each section via their exposed ref
      const allUpdates: Record<string, string | null> = {};
      for (const section of CONFIG_SCHEMA) {
        const sectionUpdates = sectionRefs.current[section.id]?.getUpdates() ?? {};
        Object.assign(allUpdates, sectionUpdates);
      }
      Object.assign(allUpdates, sectionRefs.current['model-presets']?.getUpdates() ?? {});
      const result = await saveConfig(allUpdates);
      if (result.success) {
        showToast(result.message || '✅ Все настройки сохранены', 'success');
        const newCfg = await fetchConfig();
        onConfigUpdate(newCfg);
      } else {
        showToast(result.error || 'Ошибка сохранения', 'error');
      }
    } catch {
      showToast('Ошибка соединения', 'error');
    } finally {
      setSavingAll(false);
    }
  };

  const handleRestart = async (service: string) => {
    setRestarting(service);
    try {
      const result = await restartService(service);
      if (result.success) {
        showToast(result.message || `🔄 ${service} перезапускается...`, 'info');
      } else {
        showToast(result.error || 'Ошибка перезапуска', 'error');
      }
    } catch {
      showToast('Ошибка соединения', 'error');
    } finally {
      setRestarting(null);
    }
  };

  const handleLogout = async () => {
    await logout();
    onLogout();
  };

  const selectTab = (value: number) => {
    setActiveTab(value);
    if (isMobile) {
      setMobileOpen(false);
    }
  };

  const handleIntroCardClick = (targetId?: string) => {
    if (isMobile) {
      setMobileOpen(false);
    }
    if (targetId) {
      document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const renderNavCard = ({
    icon,
    label,
    caption,
    selected,
    onClick,
    clickable = true,
  }: {
    icon: JSX.Element;
    label: string;
    caption: string;
    selected: boolean;
    onClick?: () => void;
    clickable?: boolean;
  }) => (
    <ListItemButton
      selected={selected}
      onClick={onClick}
      disabled={!clickable}
      sx={{
        alignItems: 'center',
        gap: 0.875,
        px: 1,
        py: 0.25,
        mb: 0.375,
        minHeight: 28,
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: selected ? alpha(theme.palette.primary.light, 0.45) : 'transparent',
        bgcolor: selected ? alpha(theme.palette.primary.main, 0.18) : 'transparent',
        color: selected ? 'text.primary' : 'text.secondary',
        transition: 'background-color 0.18s ease, border-color 0.18s ease',
        cursor: clickable ? 'pointer' : 'default',
        '&:hover': {
          bgcolor: clickable
            ? selected
              ? alpha(theme.palette.primary.main, 0.24)
              : alpha(theme.palette.common.white, 0.04)
            : 'transparent',
          borderColor: clickable
            ? selected
              ? 'primary.light'
              : alpha(theme.palette.common.white, 0.08)
            : 'transparent',
        },
        '& .MuiListItemIcon-root': {
          minWidth: 0,
          color: selected ? 'primary.light' : 'text.secondary',
        },
        '&.Mui-disabled': {
          opacity: 1,
          color: 'text.secondary',
        },
      }}
    >
      <ListItemIcon sx={{ fontSize: 16 }}>{icon}</ListItemIcon>
      <Box sx={{ minWidth: 0, flexGrow: 1, display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
        <Typography variant="body2" fontWeight={700} sx={{ lineHeight: 1.1, fontSize: '12px' }}>
          {label}
        </Typography>
        <Typography
          variant="caption"
          color={selected ? 'text.primary' : 'text.secondary'}
          sx={{
            opacity: selected ? 0.82 : 0.68,
            fontSize: '10px',
            lineHeight: 1.1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {caption}
        </Typography>
      </Box>
      {clickable ? (
        <ChevronRightIcon sx={{ fontSize: 16, color: selected ? 'primary.light' : 'text.disabled' }} />
      ) : null}
    </ListItemButton>
  );

  const sidebar = (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        bgcolor: 'sidebar.surface',
      }}
    >
      <Box
        sx={{
          flexShrink: 0,
          px: 2.5,
          py: 2.5,
          borderBottom: '1px solid',
          borderColor: 'sidebar.border',
          background:
            'radial-gradient(circle at top left, rgba(82,186,255,0.22), transparent 44%), linear-gradient(180deg, rgba(12,19,37,0.96) 0%, rgba(15,18,30,0.88) 100%)',
        }}
      >
        <Typography variant="h6" color="primary.light" fontWeight={800}>
          Kira Mind
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, mb: 1.25 }}>
          Панель управления ботом
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
          <Chip
            size="small"
            icon={<SparklesIcon sx={{ fontSize: '15px !important' }} />}
            label={activeTabMeta.badge}
            sx={{
              height: 24,
              borderRadius: '12px',
              bgcolor: alpha(theme.palette.primary.main, 0.14),
              color: 'primary.light',
              border: '1px solid',
              borderColor: alpha(theme.palette.primary.light, 0.22),
              fontWeight: 700,
            }}
          />
          <Chip
            size="small"
            label="Production"
            sx={{
              height: 24,
              borderRadius: '12px',
              bgcolor: alpha(theme.palette.common.white, 0.04),
              color: 'text.secondary',
              border: '1px solid',
              borderColor: alpha(theme.palette.common.white, 0.08),
              fontWeight: 600,
            }}
          />
        </Box>
      </Box>

      <Box sx={{ flexShrink: 0, px: 1.5, py: 1.25, borderBottom: '1px solid', borderColor: 'sidebar.border' }}>
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            mb: 0.85,
            color: 'sidebar.label',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 1.1,
          }}
        >
          Разделы
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 0.625,
          }}
        >
          {SIDEBAR_TABS.map((item) => {
            const selected = activeTab === item.id;
            return (
              <ListItemButton
                key={item.id}
                selected={selected}
                onClick={() => selectTab(item.id)}
                sx={{
                  alignItems: 'center',
                  gap: 0.75,
                  px: 1,
                  py: 0.625,
                  minHeight: 44,
                  borderRadius: '14px',
                  border: '1px solid',
                  borderColor: selected ? 'primary.main' : alpha(theme.palette.common.white, 0.08),
                  bgcolor: selected ? alpha(theme.palette.primary.main, 0.16) : alpha(theme.palette.common.white, 0.02),
                  boxShadow: 'none',
                  '&:hover': {
                    bgcolor: selected ? alpha(theme.palette.primary.main, 0.22) : 'sidebar.hover',
                    borderColor: selected ? 'primary.light' : 'primary.main',
                  },
                  '& .MuiListItemIcon-root': {
                    minWidth: 0,
                    color: selected ? 'primary.light' : 'text.secondary',
                  },
                }}
              >
                <ListItemIcon>{item.icon}</ListItemIcon>
                <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                  <Typography
                    variant="body2"
                    fontWeight={700}
                    color={selected ? 'text.primary' : 'text.secondary'}
                    sx={{ lineHeight: 1.1, fontSize: '13px' }}
                  >
                    {item.label}
                  </Typography>
                  <Typography
                    variant="caption"
                    color={selected ? 'text.primary' : 'text.secondary'}
                    sx={{
                      display: 'block',
                      mt: 0.125,
                      opacity: 0.68,
                      fontSize: '10px',
                      lineHeight: 1.1,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {item.caption}
                  </Typography>
                </Box>
              </ListItemButton>
            );
          })}
        </Box>
      </Box>

      <Box
        sx={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          px: 1.5,
          py: 1.1,
        }}
      >
        {activeTab === 0 ? (
          <Box>
            {SETTINGS_GROUPS.map((group) => (
              <Box key={group.title} sx={{ mb: 0.9 }}>
                <Typography
                  variant="caption"
                  sx={{
                    display: 'block',
                    px: 0.25,
                    mb: 0.45,
                    color: 'sidebar.label',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: 0.95,
                    fontSize: '10px',
                  }}
                >
                  {group.title}
                </Typography>
                {group.items.map((item) =>
                  renderNavCard({
                    icon: item.icon,
                    label: item.shortLabel,
                    caption: item.caption,
                    selected: activeSection === item.targetId,
                    onClick: () => scrollToSection(item.targetId),
                  }),
                )}
              </Box>
            ))}
          </Box>
        ) : (
          <Box>
            <Typography
              variant="caption"
              sx={{
                display: 'block',
                px: 0.25,
                mb: 0.45,
                color: 'sidebar.label',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 0.95,
                fontSize: '10px',
              }}
            >
              Обзор
            </Typography>
            {(SIDEBAR_INTRO_CARDS[activeTab] ?? []).map((item) =>
              renderNavCard({
                icon: item.icon,
                label: item.label,
                caption: item.caption,
                selected: false,
                onClick: item.targetId ? () => handleIntroCardClick(item.targetId) : undefined,
                clickable: Boolean(item.targetId),
              }),
            )}
          </Box>
        )}
      </Box>

      <Divider sx={{ flexShrink: 0, borderColor: 'sidebar.border' }} />

      <Box sx={{ flexShrink: 0, px: 2, py: 1.25 }}>
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            mb: 1,
            color: 'sidebar.label',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 1.05,
          }}
        >
          Перезапуск
        </Typography>
        {[{ id: 'kira-mind-bot', label: 'Kira Core' }].map(({ id, label }) => (
          <Button
            key={id}
            fullWidth
            variant="outlined"
            size="small"
            startIcon={
              restarting === id ? (
                <CircularProgress size={12} color="inherit" />
              ) : (
                <RestartAltIcon fontSize="small" />
              )
            }
            disabled={restarting !== null}
            onClick={() => handleRestart(id)}
            sx={{
              mb: 0.5,
              justifyContent: 'flex-start',
              borderColor: 'sidebar.border',
              color: 'text.secondary',
              fontSize: '12px',
              '&:hover': {
                borderColor: 'primary.main',
                color: 'primary.light',
                bgcolor: 'sidebar.hover',
              },
            }}
          >
            {label}
          </Button>
        ))}
      </Box>

      <Divider sx={{ flexShrink: 0, borderColor: 'sidebar.border' }} />

      <Box sx={{ flexShrink: 0, px: 2, py: 1.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {activeTab === 0 && (
          <Tooltip title="Сохранить все изменённые поля сразу">
            <Button
              variant="contained"
              fullWidth
              startIcon={
                savingAll ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <SaveAllIcon fontSize="small" />
                )
              }
              disabled={savingAll}
              onClick={handleSaveAll}
              sx={{
                fontWeight: 700,
                fontSize: '13px',
                py: 1.1,
                borderRadius: '14px',
                boxShadow: '0 16px 30px rgba(35, 118, 255, 0.24)',
                background: 'linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)',
              }}
            >
              Сохранить всё
            </Button>
          </Tooltip>
        )}
        <Button
          variant="text"
          fullWidth
          startIcon={<LogoutIcon fontSize="small" />}
          onClick={handleLogout}
          sx={{ color: 'text.disabled', fontSize: '12px', '&:hover': { color: 'text.secondary' } }}
        >
          Выйти
        </Button>
      </Box>
    </Box>
  );

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: 'background.default',
        background:
          'radial-gradient(circle at top left, rgba(37,99,235,0.14), transparent 24%), radial-gradient(circle at top right, rgba(124,58,237,0.12), transparent 26%), #0b1120',
      }}
    >
      {isMobile && (
        <>
          <Box
            onClick={() => setMobileOpen(false)}
            sx={{
              position: 'fixed',
              inset: 0,
              zIndex: theme.zIndex.drawer,
              opacity: mobileOpen ? 1 : 0,
              pointerEvents: mobileOpen ? 'auto' : 'none',
              transition: 'opacity 180ms ease',
              backdropFilter: 'blur(6px)',
              backgroundColor: 'rgba(3, 7, 18, 0.62)',
            }}
          />
          <Box
            sx={{
              position: 'fixed',
              top: 0,
              left: 0,
              bottom: 0,
              width: '100vw',
              maxWidth: 360,
              zIndex: theme.zIndex.drawer + 1,
              transform: mobileOpen ? 'translateX(0)' : 'translateX(-100%)',
              transition: 'transform 220ms ease',
              borderRight: '1px solid',
              borderColor: 'sidebar.border',
              borderTopRightRadius: '24px',
              borderBottomRightRadius: '24px',
              backgroundImage:
                'radial-gradient(circle at top left, rgba(82,186,255,0.14), transparent 30%), linear-gradient(180deg, rgba(15,23,42,1) 0%, rgba(10,16,28,1) 100%)',
              boxShadow: '0 20px 60px rgba(2, 6, 23, 0.45)',
              overflow: 'hidden',
            }}
          >
            {sidebar}
          </Box>
        </>
      )}

      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: { md: 2.5, lg: 3 },
          px: { xs: 1, sm: 1.5, md: 2 },
          py: { xs: 1, sm: 1.5, md: 2 },
        }}
      >
        {!isMobile && (
          <Box
            component="aside"
            sx={{
              width: DESKTOP_SIDEBAR_WIDTH,
              flexShrink: 0,
              position: 'sticky',
              top: 16,
              height: 'calc(100vh - 32px)',
              borderRadius: '24px',
              border: '1px solid',
              borderColor: 'sidebar.border',
              overflow: 'hidden',
              boxShadow: '0 24px 60px rgba(0, 0, 0, 0.34)',
              backdropFilter: 'blur(12px)',
            }}
          >
            {sidebar}
          </Box>
        )}

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          p: { xs: 1.5, sm: 2, md: 2.5 },
          maxWidth: activeTab === 3 || activeTab === 4 ? 1240 : 980,
          width: '100%',
          mx: isMobile ? 'auto' : 0,
        }}
      >
        {isMobile && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              mb: 2,
              px: 0.5,
              py: 0.75,
              borderBottom: '1px solid',
              borderColor: 'divider',
            }}
          >
            <IconButton onClick={() => setMobileOpen(true)} aria-label="Открыть меню">
              <MenuIcon />
            </IconButton>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle1" fontWeight={700}>
                Kira Mind
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Панель управления
              </Typography>
            </Box>
          </Box>
        )}

        <Paper
          elevation={0}
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: { xs: 'stretch', sm: 'center' },
            justifyContent: 'space-between',
            gap: 1.75,
            mb: 3,
            p: { xs: 1.5, sm: 2, md: 2.25 },
            borderRadius: '24px',
            border: '1px solid',
            borderColor: alpha(theme.palette.common.white, 0.08),
            background:
              'linear-gradient(180deg, rgba(15,23,42,0.92) 0%, rgba(17,24,39,0.84) 100%)',
            boxShadow: '0 18px 42px rgba(2, 6, 23, 0.28)',
          }}
        >
          <Box>
            <Chip
              label={activeTabMeta.badge}
              size="small"
              sx={{
                mb: 1,
                borderRadius: '12px',
                bgcolor: alpha(theme.palette.primary.main, 0.14),
                border: '1px solid',
                borderColor: alpha(theme.palette.primary.light, 0.28),
                color: 'primary.light',
                fontWeight: 700,
              }}
            />
            <Typography variant="h6" fontWeight={800}>
              {activeTabMeta.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 720, mt: 0.5 }}>
              {activeTabMeta.caption}
            </Typography>
          </Box>
          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column', sm: 'row' },
              alignItems: { xs: 'stretch', sm: 'center' },
              gap: 1.5,
            }}
          >
            <StatusBar />
            <Chip
              label="Production"
              size="small"
              sx={{
                height: 26,
                px: 0.25,
                borderRadius: '13px',
                bgcolor: 'rgba(255,255,255,0.035)',
                color: '#dbe7fb',
                borderColor: 'rgba(189, 205, 232, 0.20)',
                border: '1px solid',
                fontWeight: 600,
                letterSpacing: '0.01em',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
              }}
            />
          </Box>
        </Paper>

        {/* Settings tab */}
        {activeTab === 0 && (
          <>
            {CONFIG_SCHEMA.map((section) => (
              <ConfigSection
                key={section.id}
                ref={(el) => {
                  sectionRefs.current[section.id] = el;
                }}
                section={section}
                config={config}
                onUpdate={onConfigUpdate}
                onToast={showToast}
              />
            ))}
            <ModelSettingsSection
              ref={(el) => {
                sectionRefs.current['model-presets'] = el;
              }}
              config={config}
              onUpdate={onConfigUpdate}
              onToast={showToast}
            />
          </>
        )}

        {/* Personality tab */}
        {activeTab === 1 && <PersonalitySection onToast={showToast} />}

        {/* Chats tab */}
        {activeTab === 2 && <ChatsSection />}

        {/* Health tab */}
        {activeTab === 3 && <HealthSection />}

        {/* Memory tab */}
        {activeTab === 4 && <MemorySection onToast={showToast} />}
      </Box>
      </Box>

      {/* Toast */}
      <Snackbar open={toast !== null} autoHideDuration={4500} onClose={() => setToast(null)}>
        <Alert
          onClose={() => setToast(null)}
          severity={toast?.severity ?? 'success'}
          variant="filled"
          sx={{ width: '100%', maxWidth: 380 }}
        >
          {toast?.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
