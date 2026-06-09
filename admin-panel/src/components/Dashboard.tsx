import { useRef, useState } from 'react';
import {
  Box,
  Drawer,
  List,
  ListItemButton,
  ListItemText,
  ListItemIcon,
  Typography,
  Button,
  Divider,
  Snackbar,
  Alert,
  CircularProgress,
  Tooltip,
  Chip,
  Tabs,
  Tab,
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import SaveAllIcon from '@mui/icons-material/LibraryAddCheck';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import PersonIcon from '@mui/icons-material/Person';
import TuneIcon from '@mui/icons-material/Tune';
import ForumIcon from '@mui/icons-material/Forum';
import LocalHospitalIcon from '@mui/icons-material/LocalHospital';
import MemoryIcon from '@mui/icons-material/Memory';
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

const DRAWER_WIDTH = 250;

interface Props {
  config: ConfigResponse;
  onLogout: () => void;
  onConfigUpdate: (cfg: ConfigResponse) => void;
}

export function Dashboard({ config, onLogout, onConfigUpdate }: Props) {
  const [activeSection, setActiveSection] = useState(CONFIG_SCHEMA[0].id);
  const [activeTab, setActiveTab] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);

  const pageTitle = activeTab === 0
    ? 'Настройки бота'
    : activeTab === 1
      ? 'Управление личностью'
      : activeTab === 2
        ? 'Чаты бота'
        : activeTab === 3
          ? 'Дневник здоровья'
          : 'Управление памятью';
  const pageCaption = activeTab === 0 || activeTab === 1
    ? 'Изменения применяются после перезапуска контейнера'
    : activeTab === 2
      ? 'Группы, публичный режим и доступ к памяти'
      : activeTab === 3
        ? 'Сохранённые наблюдения и выгрузки'
        : 'Сводка, факты, индексы и ручная правка';

  // Refs to collect values from each section for "Save All"
  const sectionRefs = useRef<Record<string, ConfigSectionHandle | null>>({});

  const showToast = (message: string, severity: 'success' | 'error' | 'info') => {
    setToast({ message, severity });
  };

  const scrollToSection = (id: string) => {
    setActiveSection(id);
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

  const sidebar = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Logo */}
      <Box sx={{ px: 2.5, py: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="h6" color="primary.light" fontWeight={700}>
          🤖 Kira Mind
        </Typography>
        <Typography variant="caption" color="text.disabled">
          Панель управления
        </Typography>
      </Box>

      {/* Tab selector */}
      <Tabs
        value={activeTab}
        onChange={(_, v) => setActiveTab(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{
          borderBottom: '1px solid',
          borderColor: 'divider',
          minHeight: 40,
          '& .MuiTab-root': { minHeight: 40, fontSize: '11px', textTransform: 'none', minWidth: 0, px: 1.5 },
        }}
      >
        <Tab icon={<TuneIcon fontSize="small" />} iconPosition="start" label="Настройки" />
        <Tab icon={<PersonIcon fontSize="small" />} iconPosition="start" label="Личность" />
        <Tab icon={<ForumIcon fontSize="small" />} iconPosition="start" label="Чаты" />
        <Tab icon={<LocalHospitalIcon fontSize="small" />} iconPosition="start" label="Здоровье" />
        <Tab icon={<MemoryIcon fontSize="small" />} iconPosition="start" label="Память" />
      </Tabs>

      {/* Settings navigation (only shown on tab 0) */}
      {activeTab === 0 && (
        <Box sx={{ flexGrow: 1, overflow: 'auto', py: 1 }}>
          <List dense disablePadding>
            {CONFIG_SCHEMA.map((section) => (
              <ListItemButton
                key={section.id}
                selected={activeSection === section.id}
                onClick={() => scrollToSection(section.id)}
                sx={{ mx: 1, borderRadius: 1.5 }}
              >
                <ListItemIcon sx={{ minWidth: 30, fontSize: '15px' }}>
                  {section.icon}
                </ListItemIcon>
                <ListItemText
                  primary={section.title}
                  primaryTypographyProps={{ fontSize: '12px', fontWeight: 500 }}
                />
              </ListItemButton>
            ))}
          </List>
        </Box>
      )}

      {activeTab === 1 && (
        <Box sx={{ flexGrow: 1, overflow: 'auto', py: 1 }}>
          <List dense disablePadding>
            <ListItemButton
              onClick={() => {
                const el = document.getElementById('personality-kira-—-личность-и-характер');
                el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              sx={{ mx: 1, borderRadius: 1.5 }}
            >
              <ListItemText
                primary="🌸 Kira"
                primaryTypographyProps={{ fontSize: '12px', fontWeight: 500 }}
              />
            </ListItemButton>
          </List>
        </Box>
      )}

      {activeTab === 2 && (
        <Box sx={{ flexGrow: 1, overflow: 'auto', py: 1, px: 1.5 }}>
          <Typography variant="caption" color="text.disabled">
            Список чатов бота
          </Typography>
        </Box>
      )}

      {activeTab === 3 && (
        <Box sx={{ flexGrow: 1, overflow: 'auto', py: 1, px: 1.5 }}>
          <Typography variant="caption" color="text.disabled">
            Записи и выгрузки дневника здоровья
          </Typography>
        </Box>
      )}

      {activeTab === 4 && (
        <Box sx={{ flexGrow: 1, overflow: 'auto', py: 1, px: 1.5 }}>
          <Typography variant="caption" color="text.disabled">
            Факты, сводки и индексы памяти
          </Typography>
        </Box>
      )}

      <Divider sx={{ borderColor: 'divider' }} />

      {/* Restart */}
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            mb: 1,
            color: 'text.disabled',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.8,
          }}
        >
          Перезапуск
        </Typography>
        {[{ id: 'kira-mind-bot', label: '🌸 Kira' }].map(({ id, label }) => (
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
              mb: 0.75,
              justifyContent: 'flex-start',
              borderColor: 'divider',
              color: 'text.secondary',
              fontSize: '12px',
              '&:hover': {
                borderColor: 'primary.dark',
                color: 'primary.light',
                bgcolor: '#1e0a3c',
              },
            }}
          >
            {label}
          </Button>
        ))}
      </Box>

      <Divider sx={{ borderColor: 'divider' }} />

      {/* Save All + Logout */}
      <Box sx={{ px: 2, py: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
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
              sx={{ fontWeight: 600, fontSize: '13px' }}
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
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      {/* Sidebar */}
      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
        }}
      >
        {sidebar}
      </Drawer>

      {/* Main content */}
      <Box component="main" sx={{ flexGrow: 1, p: 3, maxWidth: activeTab === 3 || activeTab === 4 ? 1200 : 880, mx: 'auto' }}>
        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            mb: 3,
            pb: 2,
            borderBottom: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Box>
            <Typography variant="h6" fontWeight={700}>
              {pageTitle}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {pageCaption}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <StatusBar />
            <Chip
              label="Production"
              size="small"
              sx={{ bgcolor: '#1a0a0a', color: '#f87171', borderColor: '#7f1d1d', border: '1px solid' }}
            />
          </Box>
        </Box>

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
