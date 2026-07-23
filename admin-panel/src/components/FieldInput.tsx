import { useEffect, useRef, useState } from 'react';
import {
  TextField,
  Switch,
  FormControlLabel,
  Typography,
  Box,
  IconButton,
  InputAdornment,
  Tooltip,
  MenuItem,
} from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import type { FieldDef } from '../types';
import { DurationInput } from './DurationInput';

interface Props {
  field: FieldDef;
  value: string;
  onChange: (key: string, value: string) => void;
  displayValue?: string;
}

export function FieldInput({ field, value, onChange, displayValue }: Props) {
  const [showPassword, setShowPassword] = useState(false);
  const [showDerivedValue, setShowDerivedValue] = useState(true);
  // Store original masked value so we can restore it if user focuses then blurs without typing
  const originalMasked = useRef('');

  const isMasked = value.includes('••••');
  const usesDerivedValue = !isMasked && value === '' && !!displayValue && showDerivedValue;
  const resolvedValue = usesDerivedValue ? displayValue : value;

  useEffect(() => {
    if (value !== '') {
      setShowDerivedValue(false);
      return;
    }
    setShowDerivedValue(true);
  }, [value, displayValue]);

  if (field.type === 'toggle') {
    return (
      <Box sx={{ py: 0.5 }}>
        <FormControlLabel
          control={
            <Switch
              checked={value === 'true'}
              onChange={(e) => onChange(field.key, e.target.checked ? 'true' : 'false')}
              color="primary"
            />
          }
          label={
            <Box>
              <Typography variant="body2" fontWeight={500}>
                {field.label}
              </Typography>
              {field.hint && (
                <Typography variant="caption" color="text.secondary" display="block">
                  {field.hint}
                </Typography>
              )}
            </Box>
          }
          labelPlacement="start"
          sx={{
            ml: 0,
            justifyContent: 'space-between',
            width: '100%',
            '.MuiFormControlLabel-label': { flex: 1 },
          }}
        />
      </Box>
    );
  }

  if (field.type === 'duration') {
    return (
      <DurationInput
        label={field.label}
        hint={field.hint}
        valueMs={value}
        onChange={(ms) => onChange(field.key, ms)}
      />
    );
  }

  if (field.type === 'select') {
    const allowedValues = new Set((field.options ?? []).map((option) => option.value));
    const hasUnsupportedValue = Boolean(resolvedValue) && !allowedValues.has(resolvedValue);
    const helperText = hasUnsupportedValue
      ? `${field.hint ? `${field.hint} ` : ''}Текущее значение больше недоступно в списке. Выбери поддерживаемую временную зону, если хочешь его изменить.`
      : field.hint;

    return (
      <TextField
        select
        label={field.label}
        value={hasUnsupportedValue ? resolvedValue : (resolvedValue || field.placeholder || '')}
        onChange={(e) => onChange(field.key, e.target.value)}
        fullWidth
        helperText={helperText || ' '}
        FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px', minHeight: '16px', lineHeight: 1.35 } }}
      >
        {hasUnsupportedValue && (
          <MenuItem value={resolvedValue} disabled>
            {resolvedValue} (недоступно)
          </MenuItem>
        )}
        {(field.options ?? []).map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </TextField>
    );
  }

  if (field.type === 'textarea') {
    return (
      <Box sx={{ gridColumn: '1 / -1' }}>
        <TextField
          label={field.label}
          value={resolvedValue}
          onChange={(e) => onChange(field.key, e.target.value)}
          fullWidth
          multiline
          rows={field.key.includes('PERSONA') || field.key.includes('BIOGRAPHY') ? 5 : 3}
          placeholder={field.placeholder}
          required={field.required}
          helperText={field.hint || ' '}
          inputProps={{ style: { fontFamily: 'monospace', fontSize: '12px', lineHeight: 1.6 } }}
          FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px', minHeight: '16px', lineHeight: 1.35 } }}
        />
      </Box>
    );
  }

  const isPassword = field.type === 'password';

  return (
    <TextField
      label={
        field.required ? (
          <span>
            {field.label} <span style={{ color: '#f472b6' }}>*</span>
          </span>
        ) : (
          field.label
        )
      }
      type={isPassword && !showPassword ? 'password' : 'text'}
      value={isMasked ? value : resolvedValue}
      onChange={(e) => {
        originalMasked.current = ''; // user started typing, don't restore
        setShowDerivedValue(false);
        onChange(field.key, e.target.value);
      }}
      onFocus={() => {
        if (isMasked) {
          originalMasked.current = value; // save before clearing
          onChange(field.key, '');
          return;
        }
        if (usesDerivedValue) {
          setShowDerivedValue(false);
        }
      }}
      onBlur={(e) => {
        // If user focused a masked field but typed nothing → restore original masked display
        if (originalMasked.current && e.target.value === '') {
          onChange(field.key, originalMasked.current);
          originalMasked.current = '';
        }
        if (!isMasked && e.target.value === '') {
          setShowDerivedValue(true);
        }
      }}
      inputMode={field.type === 'number' ? 'numeric' : undefined}
      fullWidth
      placeholder={isMasked ? '(оставьте пустым чтобы не менять)' : field.placeholder}
      helperText={field.hint || ' '}
      FormHelperTextProps={{ sx: { color: 'text.disabled', fontSize: '11px', minHeight: '16px', lineHeight: 1.35 } }}
      InputProps={
        isPassword
          ? {
              endAdornment: (
                <InputAdornment position="end">
                  <Tooltip title={showPassword ? 'Скрыть' : 'Показать'}>
                    <IconButton
                      onClick={() => setShowPassword((p) => !p)}
                      edge="end"
                      size="small"
                      sx={{ color: 'text.disabled' }}
                    >
                      {showPassword ? (
                        <VisibilityOffIcon fontSize="small" />
                      ) : (
                        <VisibilityIcon fontSize="small" />
                      )}
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ),
            }
          : undefined
      }
    />
  );
}
