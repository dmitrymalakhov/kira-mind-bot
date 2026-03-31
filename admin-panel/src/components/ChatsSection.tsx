import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  IconButton,
  Tooltip,
  Switch,
  Collapse,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Divider,
  TextField,
  Button,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import { fetchChats, setChatPublicMode, setChatAllowedDomains, setChatForbiddenTopics } from '../api';
import type { ChatInfo } from '../types';

const CHAT_TYPE_LABEL: Record<string, string> = {
  private: 'Личный',
  group: 'Группа',
  supergroup: 'Супергруппа',
  channel: 'Канал',
};

const CHAT_TYPE_COLOR: Record<string, 'default' | 'primary' | 'secondary' | 'success' | 'warning'> = {
  private: 'primary',
  group: 'success',
  supergroup: 'success',
  channel: 'warning',
};

const ALL_DOMAINS: { key: string; label: string; description: string }[] = [
  { key: 'work',          label: 'Работа',           description: 'Карьера, проекты, задачи' },
  { key: 'hobbies',       label: 'Хобби',            description: 'Увлечения, спорт, творчество' },
  { key: 'travel',        label: 'Путешествия',       description: 'Поездки, отпуск' },
  { key: 'entertainment', label: 'Развлечения',       description: 'Фильмы, книги, игры' },
  { key: 'education',     label: 'Образование',       description: 'Курсы, навыки' },
  { key: 'social',        label: 'Социальная жизнь',  description: 'Друзья, события' },
  { key: 'home',          label: 'Дом и быт',         description: 'Дом, ремонт' },
  { key: 'general',       label: 'Общее',             description: 'Разные темы' },
  { key: 'personal',      label: 'Личное',            description: 'Цели, планы (осторожно!)' },
  { key: 'family',        label: 'Семья',             description: 'Родственники, дети (осторожно!)' },
  { key: 'health',        label: 'Здоровье',          description: 'Медицина, симптомы (осторожно!)' },
  { key: 'finance',       label: 'Финансы',           description: 'Деньги, бюджет (осторожно!)' },
];

// Domains that contain sensitive info — shown with warning color
const SENSITIVE_DOMAINS = new Set(['personal', 'family', 'health', 'finance']);

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function DomainRow({ chat, onUpdate }: { chat: ChatInfo; onUpdate: (updated: ChatInfo) => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [topicsText, setTopicsText] = useState(chat.forbiddenTopics ?? '');
  const [topicsSaving, setTopicsSaving] = useState(false);

  const isGroup = chat.chatType === 'group' || chat.chatType === 'supergroup';
  const showDomains = isGroup && chat.publicMode;

  const handleDomainToggle = async (domainKey: string) => {
    const current = chat.allowedDomains ?? [];
    const next = current.includes(domainKey)
      ? current.filter(d => d !== domainKey)
      : [...current, domainKey];
    setSaving(true);
    try {
      await setChatAllowedDomains(chat.chatId, next);
      onUpdate({ ...chat, allowedDomains: next });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <TableRow hover>
        <TableCell>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {showDomains && (
              <IconButton size="small" onClick={() => setOpen(o => !o)} sx={{ p: 0.25 }}>
                {open ? <KeyboardArrowUpIcon fontSize="small" /> : <KeyboardArrowDownIcon fontSize="small" />}
              </IconButton>
            )}
            <Box>
              <Typography variant="body2" fontWeight={500}>{chat.title}</Typography>
              {chat.username && (
                <Typography variant="caption" color="text.secondary">@{chat.username}</Typography>
              )}
            </Box>
          </Box>
        </TableCell>
        <TableCell>
          <Chip
            label={CHAT_TYPE_LABEL[chat.chatType] ?? chat.chatType}
            size="small"
            color={CHAT_TYPE_COLOR[chat.chatType] ?? 'default'}
            variant="outlined"
            sx={{ fontSize: '11px' }}
          />
        </TableCell>
        <TableCell>
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
            {chat.chatId}
          </Typography>
        </TableCell>
        <TableCell>
          <Typography variant="caption" color="text.secondary">
            {chat.profile === 'KiraMindBot' ? '🌸 Kira' : '🧑‍💼 Sergey'}
          </Typography>
        </TableCell>
        <TableCell>
          <Typography variant="caption" color="text.secondary">
            {formatDate(chat.lastSeenAt)}
          </Typography>
        </TableCell>
        <TableCell align="center">
          {isGroup ? (
            <Tooltip title={chat.publicMode ? 'Выключить публичный режим' : 'Включить публичный режим'}>
              <span>
                <Switch
                  size="small"
                  checked={chat.publicMode}
                  onChange={async () => {
                    await setChatPublicMode(chat.chatId, !chat.publicMode);
                    onUpdate({ ...chat, publicMode: !chat.publicMode });
                  }}
                  color="success"
                />
              </span>
            </Tooltip>
          ) : (
            <Typography variant="caption" color="text.disabled">—</Typography>
          )}
        </TableCell>
      </TableRow>

      {showDomains && (
        <TableRow>
          <TableCell colSpan={6} sx={{ py: 0, bgcolor: 'action.hover' }}>
            <Collapse in={open} timeout="auto" unmountOnExit>
              <Box sx={{ px: 3, py: 2 }}>
                <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  Домены памяти для подписчиков
                </Typography>
                <Typography variant="caption" color="text.disabled" display="block" sx={{ mb: 1.5 }}>
                  Выбранные домены бот будет использовать для ответов публичным пользователям. Домены с пометкой «осторожно» содержат личные данные.
                </Typography>
                <FormGroup row sx={{ gap: 0 }}>
                  {ALL_DOMAINS.map(domain => (
                    <FormControlLabel
                      key={domain.key}
                      sx={{ width: '50%', m: 0, mb: 0.5 }}
                      control={
                        <Checkbox
                          size="small"
                          disabled={saving}
                          checked={(chat.allowedDomains ?? []).includes(domain.key)}
                          onChange={() => handleDomainToggle(domain.key)}
                          color={SENSITIVE_DOMAINS.has(domain.key) ? 'warning' : 'primary'}
                        />
                      }
                      label={
                        <Box>
                          <Typography variant="body2" sx={{ fontSize: '12px', lineHeight: 1.2 }}>
                            {domain.label}
                          </Typography>
                          <Typography variant="caption" color="text.disabled" sx={{ fontSize: '10px' }}>
                            {domain.description}
                          </Typography>
                        </Box>
                      }
                    />
                  ))}
                </FormGroup>
                {(chat.allowedDomains ?? []).length === 0 && (
                  <Typography variant="caption" color="text.disabled" sx={{ mt: 1, display: 'block' }}>
                    Домены не выбраны — бот отвечает без доступа к памяти.
                  </Typography>
                )}

                <Divider sx={{ my: 2 }} />

                <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  Запрещённые темы
                </Typography>
                <Typography variant="caption" color="text.disabled" display="block" sx={{ mb: 1.5 }}>
                  Перечислите темы, которые бот не будет обсуждать с подписчиками. Каждая тема с новой строки или через запятую.
                </Typography>
                <TextField
                  multiline
                  minRows={3}
                  maxRows={8}
                  fullWidth
                  size="small"
                  placeholder={'политика\nрелигия\nличная жизнь владельца'}
                  value={topicsText}
                  onChange={e => setTopicsText(e.target.value)}
                  sx={{ mb: 1.5, '& .MuiInputBase-root': { fontSize: '13px' } }}
                />
                <Button
                  size="small"
                  variant="outlined"
                  disabled={topicsSaving || topicsText === (chat.forbiddenTopics ?? '')}
                  onClick={async () => {
                    setTopicsSaving(true);
                    try {
                      await setChatForbiddenTopics(chat.chatId, topicsText);
                      onUpdate({ ...chat, forbiddenTopics: topicsText });
                    } finally {
                      setTopicsSaving(false);
                    }
                  }}
                  sx={{ fontSize: '12px' }}
                >
                  {topicsSaving ? 'Сохранение...' : 'Сохранить'}
                </Button>
              </Box>
              <Divider />
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function ChatsSection() {
  const [chats, setChats] = useState<ChatInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchChats();
      setChats(data.map(c => ({ ...c, allowedDomains: c.allowedDomains ?? [] })));
    } catch {
      setError('Не удалось загрузить список чатов');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleUpdate = (updated: ChatInfo) => {
    setChats(prev => prev.map(c => c.chatId === updated.chatId ? updated : c));
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Box>
          <Typography variant="h6" fontWeight={600}>Чаты бота</Typography>
          <Typography variant="caption" color="text.secondary">
            Управление публичным режимом и доступом к памяти для подписчиков групп
          </Typography>
        </Box>
        <Tooltip title="Обновить">
          <span>
            <IconButton onClick={load} disabled={loading} size="small">
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress size={32} />
        </Box>
      ) : chats.length === 0 ? (
        <Alert severity="info">
          Список пуст. Бот появится здесь после первого взаимодействия в любом чате.
        </Alert>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ bgcolor: 'background.paper' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px' }}>Название</TableCell>
                <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px' }}>Тип</TableCell>
                <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px' }}>ID</TableCell>
                <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px' }}>Профиль</TableCell>
                <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px' }}>Последний раз</TableCell>
                <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px' }} align="center">
                  Публичный режим
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {chats.map(chat => (
                <DomainRow key={chat.chatId} chat={chat} onUpdate={handleUpdate} />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
