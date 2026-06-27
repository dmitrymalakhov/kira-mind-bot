import { createTheme } from '@mui/material/styles';

interface SidebarPalette {
  surface: string;
  card: string;
  hover: string;
  border: string;
  label: string;
}

declare module '@mui/material/styles' {
  interface Palette {
    sidebar: SidebarPalette;
  }

  interface PaletteOptions {
    sidebar?: SidebarPalette;
  }
}

export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#2563eb',
      light: '#7dd3fc',
      dark: '#1d4ed8',
      contrastText: '#fff',
    },
    secondary: {
      main: '#8b5cf6',
    },
    background: {
      default: '#0b1120',
      paper: '#111827',
    },
    divider: '#243047',
    text: {
      primary: '#e5eefb',
      secondary: '#93a4bd',
    },
    sidebar: {
      surface: '#0f172a',
      card: '#111c34',
      hover: '#16223e',
      border: '#263552',
      label: '#8395b5',
    },
  },
  shape: {
    borderRadius: 14,
  },
  typography: {
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif',
    h6: { fontWeight: 700 },
    subtitle2: { color: '#93a4bd' },
  },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: '1px solid #243047',
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: '#0a1222',
          '& fieldset': { borderColor: '#243047' },
          '&:hover fieldset': { borderColor: '#31507d' },
        },
        input: {
          '&:-webkit-autofill': {
            WebkitBoxShadow: '0 0 0 100px #0a1222 inset',
            WebkitTextFillColor: '#e5eefb',
          },
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: '#0f172a',
          borderRight: '1px solid #263552',
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          '&.Mui-selected': {
            backgroundColor: 'rgba(37, 99, 235, 0.14)',
            borderLeft: '2px solid #2563eb',
            '&:hover': { backgroundColor: 'rgba(37, 99, 235, 0.2)' },
          },
        },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          '&.Mui-checked': { color: '#7dd3fc' },
          '&.Mui-checked + .MuiSwitch-track': { backgroundColor: '#2563eb' },
        },
      },
    },
    MuiSnackbar: {
      defaultProps: { anchorOrigin: { vertical: 'bottom', horizontal: 'right' } },
    },
  },
});
