import { useState, useEffect } from 'react';
import {
  Box,
  TextField,
  Select,
  MenuItem,
  Typography,
  FormControl,
} from '@mui/material';

type Unit = 'min' | 'h' | 'd';

const UNITS: { value: Unit; label: string; ms: number }[] = [
  { value: 'min', label: 'мин', ms: 60_000 },
  { value: 'h', label: 'ч', ms: 3_600_000 },
  { value: 'd', label: 'дн', ms: 86_400_000 },
];

function msToBest(ms: number): { amount: number; unit: Unit } {
  const n = Number(ms);
  if (!n) return { amount: 24, unit: 'h' };
  if (n % 86_400_000 === 0) return { amount: n / 86_400_000, unit: 'd' };
  if (n % 3_600_000 === 0) return { amount: n / 3_600_000, unit: 'h' };
  return { amount: n / 60_000, unit: 'min' };
}

interface Props {
  label: string;
  hint?: string;
  valueMs: string;
  onChange: (ms: string) => void;
}

export function DurationInput({ label, hint, valueMs, onChange }: Props) {
  const init = msToBest(Number(valueMs));
  const [amount, setAmount] = useState(String(init.amount));
  const [unit, setUnit] = useState<Unit>(init.unit);

  // Sync when parent resets (e.g. after Save)
  useEffect(() => {
    const parsed = msToBest(Number(valueMs));
    setAmount(String(parsed.amount));
    setUnit(parsed.unit);
  }, [valueMs]);

  const emit = (a: string, u: Unit) => {
    const ms = Number(a) * UNITS.find((x) => x.value === u)!.ms;
    onChange(isNaN(ms) || ms <= 0 ? valueMs : String(ms));
  };

  return (
    <Box>
      <Typography
        variant="caption"
        sx={{ display: 'block', mb: 0.75, color: 'text.secondary', fontWeight: 500 }}
      >
        {label}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
        <TextField
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            emit(e.target.value, unit);
          }}
          type="number"
          inputProps={{ min: 1, style: { textAlign: 'right' } }}
          sx={{ width: 90 }}
          size="small"
        />
        <FormControl size="small" sx={{ minWidth: 72 }}>
          <Select
            value={unit}
            onChange={(e) => {
              const u = e.target.value as Unit;
              setUnit(u);
              emit(amount, u);
            }}
            sx={{ bgcolor: '#0d0d1a', '& fieldset': { borderColor: '#252540' } }}
          >
            {UNITS.map((u) => (
              <MenuItem key={u.value} value={u.value}>{u.label}</MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>
      {hint && (
        <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: 'block', fontSize: '11px' }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}
