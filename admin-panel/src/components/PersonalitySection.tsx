import { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  CardHeader,
  TextField,
  Button,
  CircularProgress,
  Grid,
  Typography,
  Alert,
  Divider,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import { fetchPersonality, savePersonality } from '../api';
import type { PersonalityConfig, PersonalityProfile } from '../types';

const EMPTY_PROFILE: PersonalityProfile = {
  persona: '',
  communicationStyle: '',
  biography: '',
  ownerName: '',
  ownerUsername: '',
  userName: '',
  userBirthDate: '',
  moodVariants: '',
  defaultMood: '',
  proactiveMessageHint: '',
};

interface ProfileEditorProps {
  botKey: 'KiraMindBot' | 'SergeyBrainBot';
  icon: string;
  title: string;
  values: PersonalityProfile;
  onChange: (key: keyof PersonalityProfile, value: string) => void;
  onSave: () => void;
  saving: boolean;
}

function ProfileEditor({ icon, title, values, onChange, onSave, saving }: ProfileEditorProps) {
  return (
    <Card id={`personality-${title.toLowerCase().replace(/\s+/g, '-')}`} sx={{ mb: 2 }}>
      <CardHeader
        title={`${icon} ${title}`}
        titleTypographyProps={{ variant: 'subtitle1', fontWeight: 600, color: 'secondary.main' }}
        action={
          <Button
            variant="outlined"
            size="small"
            startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon fontSize="small" />}
            onClick={onSave}
            disabled={saving}
            sx={{
              borderColor: 'divider',
              color: 'text.secondary',
              '&:hover': { borderColor: 'primary.main', color: 'primary.light' },
            }}
          >
            Сохранить
          </Button>
        }
        sx={{ pb: 0 }}
      />
      <CardContent>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={3}>
            <TextField
              label="Имя владельца"
              value={values.ownerName}
              onChange={(e) => onChange('ownerName', e.target.value)}
              fullWidth
              placeholder="Дмитрий"
              helperText="Как бот обращается к пользователю"
              FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px' } }}
            />
          </Grid>
          <Grid item xs={12} sm={3}>
            <TextField
              label="Никнейм владельца (Telegram)"
              value={values.ownerUsername}
              onChange={(e) => onChange('ownerUsername', e.target.value)}
              fullWidth
              placeholder="dmitrii"
              helperText="Без @. Для распознавания тегов в публичных группах."
              FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px' } }}
            />
          </Grid>
          <Grid item xs={12} sm={3}>
            <TextField
              label="Имя пользователя (для обращения)"
              value={values.userName}
              onChange={(e) => onChange('userName', e.target.value)}
              fullWidth
              placeholder="Дмитрий"
            />
          </Grid>
          <Grid item xs={12} sm={3}>
            <TextField
              label="Дата рождения пользователя"
              value={values.userBirthDate}
              onChange={(e) => onChange('userBirthDate', e.target.value)}
              fullWidth
              placeholder="16.07.1988"
              helperText="Формат: ДД.ММ.ГГГГ"
              FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px' } }}
            />
          </Grid>
        </Grid>

        <Divider sx={{ my: 2.5, borderColor: 'divider' }} />

        <Grid container spacing={2}>
          <Grid item xs={12}>
            <TextField
              label="Личность / системный промпт"
              value={values.persona}
              onChange={(e) => onChange('persona', e.target.value)}
              fullWidth
              multiline
              rows={5}
              placeholder="Ты — Кира, заботливая женщина-ассистент с живым характером..."
              helperText="Основной системный промпт, определяющий характер бота"
              inputProps={{ style: { fontFamily: 'monospace', fontSize: '12px', lineHeight: 1.6 } }}
              FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px' } }}
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              label="Стиль общения"
              value={values.communicationStyle}
              onChange={(e) => onChange('communicationStyle', e.target.value)}
              fullWidth
              multiline
              rows={3}
              placeholder="Естественный, живой тон: от тёплого и дружеского до уставшего..."
              helperText="Описание тона и стиля коммуникации"
              inputProps={{ style: { fontFamily: 'monospace', fontSize: '12px', lineHeight: 1.6 } }}
              FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px' } }}
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              label="Биография"
              value={values.biography}
              onChange={(e) => onChange('biography', e.target.value)}
              fullWidth
              multiline
              rows={4}
              placeholder="Ты — Кира, молодая красивая и спортивная женщина..."
              helperText="Описание персонажа: внешность, характер, история"
              inputProps={{ style: { fontFamily: 'monospace', fontSize: '12px', lineHeight: 1.6 } }}
              FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px' } }}
            />
          </Grid>
          <Grid item xs={12} sm={8}>
            <TextField
              label="Варианты настроения"
              value={values.moodVariants}
              onChange={(e) => onChange('moodVariants', e.target.value)}
              fullWidth
              multiline
              rows={3}
              placeholder={'спокойное\nуставшее\nзадумчивое\nвоодушевлённое'}
              helperText="По одному на строке. Случайно выбирается если не задано фиксированное."
              inputProps={{ style: { fontFamily: 'monospace', fontSize: '12px', lineHeight: 1.6 } }}
              FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px' } }}
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              label="Фиксированное настроение"
              value={values.defaultMood}
              onChange={(e) => onChange('defaultMood', e.target.value)}
              fullWidth
              placeholder="нейтральное"
              helperText="Оставьте пустым чтобы выбирать случайно из вариантов выше."
              FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px' } }}
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              label="Подсказка для проактивных сообщений"
              value={values.proactiveMessageHint}
              onChange={(e) => onChange('proactiveMessageHint', e.target.value)}
              fullWidth
              placeholder="как будто ты сама написала первой"
              helperText="Фраза, описывающая от чьего лица бот пишет первым. Влияет на тон инициативных сообщений."
              FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px' } }}
            />
          </Grid>
        </Grid>
      </CardContent>
    </Card>
  );
}

interface Props {
  onToast: (message: string, severity: 'success' | 'error') => void;
}

export function PersonalitySection({ onToast }: Props) {
  const [data, setData] = useState<PersonalityConfig>({
    KiraMindBot: { ...EMPTY_PROFILE },
    SergeyBrainBot: { ...EMPTY_PROFILE },
  });
  const [loading, setLoading] = useState(true);
  const [savingKira, setSavingKira] = useState(false);
  const [savingSergey, setSavingSergey] = useState(false);

  useEffect(() => {
    fetchPersonality()
      .then(setData)
      .catch(() => onToast('Не удалось загрузить настройки личности', 'error'))
      .finally(() => setLoading(false));
  }, []);

  const handleChange = (
    profile: 'KiraMindBot' | 'SergeyBrainBot',
    key: keyof PersonalityProfile,
    value: string
  ) => {
    setData((prev) => ({
      ...prev,
      [profile]: { ...prev[profile], [key]: value },
    }));
  };

  const handleSave = async (profile: 'KiraMindBot' | 'SergeyBrainBot') => {
    const setSaving = profile === 'KiraMindBot' ? setSavingKira : setSavingSergey;
    setSaving(true);
    try {
      const result = await savePersonality(data);
      if (result.success) {
        onToast(result.message || '✅ Личность сохранена. Перезапустите бота.', 'success');
      } else {
        onToast(result.error || 'Ошибка сохранения', 'error');
      }
    } catch {
      onToast('Ошибка соединения', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Alert
        severity="info"
        sx={{ mb: 2, bgcolor: '#0a1628', border: '1px solid #1e3a5f', color: '#93c5fd', fontSize: '13px' }}
      >
        Изменения применяются после перезапуска бота. Пустые поля используют значения из кода.
      </Alert>

      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 1.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8 }}>
        Личность ботов
      </Typography>

      <ProfileEditor
        botKey="KiraMindBot"
        icon="🌸"
        title="Kira — Личность и характер"
        values={data.KiraMindBot}
        onChange={(key, value) => handleChange('KiraMindBot', key, value)}
        onSave={() => handleSave('KiraMindBot')}
        saving={savingKira}
      />
      <ProfileEditor
        botKey="SergeyBrainBot"
        icon="🧑‍💼"
        title="Sergey — Личность и характер"
        values={data.SergeyBrainBot}
        onChange={(key, value) => handleChange('SergeyBrainBot', key, value)}
        onSave={() => handleSave('SergeyBrainBot')}
        saving={savingSergey}
      />
    </Box>
  );
}
