import { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  CardHeader,
  TextField,
  MenuItem,
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
  characterName: '',
  characterGender: 'женский',
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
              select
              label="Род персонажа"
              value={values.characterGender}
              onChange={(e) => onChange('characterGender', e.target.value)}
              fullWidth
              helperText="Используется для согласования ответов, self-memory и событий"
              FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px' } }}
            >
              <MenuItem value="женский">Женский</MenuItem>
              <MenuItem value="мужской">Мужской</MenuItem>
            </TextField>
          </Grid>
          <Grid item xs={12} sm={3}>
            <TextField
              label="Имя ассистента"
              value={values.characterName}
              onChange={(e) => onChange('characterName', e.target.value)}
              fullWidth
              placeholder="например, Эни"
              helperText="Имя персонажа задаётся вручную. Если оставить пустым, используется имя по умолчанию."
              FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px' } }}
            />
          </Grid>
          <Grid item xs={12} sm={3}>
            <TextField
              label="Имя владельца"
              value={values.ownerName}
              onChange={(e) => onChange('ownerName', e.target.value)}
              fullWidth
              placeholder="владелец"
              helperText="Как бот обращается к владельцу"
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
              label="Имя владельца (для обращения)"
              value={values.userName}
              onChange={(e) => onChange('userName', e.target.value)}
              fullWidth
              placeholder="владелец"
            />
          </Grid>
          <Grid item xs={12} sm={3}>
            <TextField
              label="Дата рождения владельца"
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
              placeholder="Ты — ассистент с живым характером..."
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
              placeholder="Краткая биография ассистента..."
              helperText="Описание ассистента: внешность, характер, история"
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
  });
  const [loading, setLoading] = useState(true);
  const [savingKira, setSavingKira] = useState(false);

  useEffect(() => {
    fetchPersonality()
      .then(setData)
      .catch(() => onToast('Не удалось загрузить настройки личности', 'error'))
      .finally(() => setLoading(false));
  }, []);

  const handleChange = (
    profile: 'KiraMindBot',
    key: keyof PersonalityProfile,
    value: string
  ) => {
    setData((prev) => ({
      ...prev,
      [profile]: { ...prev[profile], [key]: value },
    }));
  };

  const handleSave = async () => {
    setSavingKira(true);
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
      setSavingKira(false);
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
        Личность бота
      </Typography>

      <ProfileEditor
        icon="🌸"
        title={`${data.KiraMindBot.characterName.trim() || 'Персонаж'} — Личность и характер`}
        values={data.KiraMindBot}
        onChange={(key, value) => handleChange('KiraMindBot', key, value)}
        onSave={handleSave}
        saving={savingKira}
      />
    </Box>
  );
}
