import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#7c3aed',
      light: '#a78bfa',
      dark: '#5b21b6',
      contrastText: '#fff',
    },
    secondary: {
      main: '#c4b5fd',
    },
    background: {
      default: '#0f0f1a',
      paper: '#1a1a2e',
    },
    divider: '#2d2d50',
    text: {
      primary: '#e2e8f0',
      secondary: '#94a3b8',
    },
  },
  shape: {
    borderRadius: 10,
  },
  typography: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    h6: { fontWeight: 700 },
    subtitle2: { color: '#94a3b8' },
  },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: '1px solid #2d2d50',
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: '#0d0d1a',
          '& fieldset': { borderColor: '#2d2d50' },
          '&:hover fieldset': { borderColor: '#4c4c7a' },
        },
        input: {
          '&:-webkit-autofill': {
            WebkitBoxShadow: '0 0 0 100px #0d0d1a inset',
            WebkitTextFillColor: '#e2e8f0',
          },
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: '#1a1a2e',
          borderRight: '1px solid #2d2d50',
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          margin: '1px 8px',
          '&.Mui-selected': {
            backgroundColor: '#2d1f5e',
            borderLeft: '2px solid #7c3aed',
            '&:hover': { backgroundColor: '#3b2970' },
          },
        },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          '&.Mui-checked': { color: '#a78bfa' },
          '&.Mui-checked + .MuiSwitch-track': { backgroundColor: '#5b21b6' },
        },
      },
    },
    MuiSnackbar: {
      defaultProps: { anchorOrigin: { vertical: 'bottom', horizontal: 'right' } },
    },
  },
});
