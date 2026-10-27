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
      main: '#4f8df5',
      light: '#99bfff',
      dark: '#1d4ed8',
      contrastText: '#08111f',
    },
    secondary: {
      main: '#a4b4d0',
    },
    background: {
      default: '#101319',
      paper: '#171c24',
    },
    divider: '#2a313e',
    text: {
      primary: '#edf0f5',
      secondary: '#a3adbd',
    },
    sidebar: {
      surface: '#13171e',
      card: '#171c24',
      hover: '#1c2330',
      border: '#2a313e',
      label: '#a3adbd',
    },
  },
  shape: {
    borderRadius: 10,
  },
  typography: {
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif',
    h6: { fontWeight: 700 },
    subtitle2: { color: '#a3adbd' },
    button: { textTransform: 'none', fontWeight: 600 },
    body2: { lineHeight: 1.6 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        '[hidden]': { display: 'none !important' },
        'html': { colorScheme: 'dark' },
        '*:focus-visible': { outline: '2px solid #99bfff', outlineOffset: 3 },
        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': { animationDuration: '0.01ms !important', transitionDuration: '0.01ms !important', scrollBehavior: 'auto !important' },
        },
      },
    },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiDialog: { styleOverrides: { paper: { backgroundImage: 'none', border: '1px solid #2a313e' } } },
    MuiTab: { styleOverrides: { root: { minHeight: 48, minWidth: 0, padding: '12px 16px', fontSize: 14 } } },
    MuiAccordion: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: { backgroundImage: 'none', border: '1px solid #2a313e', borderRadius: '10px !important', marginBottom: 10, '&:before': { display: 'none' } },
      },
    },
    MuiAccordionSummary: { styleOverrides: { root: { minHeight: 64, '&.Mui-expanded': { minHeight: 64 } }, content: { margin: '16px 0', '&.Mui-expanded': { margin: '16px 0' } } } },
    MuiCardContent: { styleOverrides: { root: { padding: 24, '&:last-child': { paddingBottom: 24 }, '@media (max-width:599px)': { padding: 16, '&:last-child': { paddingBottom: 16 } } } } },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: '1px solid #2a313e',
          boxShadow: 'none',
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: '#12161d',
          '& fieldset': { borderColor: '#394355' },
          '&:hover fieldset': { borderColor: '#63738d' },
        },
        input: {
          '&:-webkit-autofill': {
            WebkitBoxShadow: '0 0 0 100px #12161d inset',
            WebkitTextFillColor: '#edf0f5',
          },
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: '#13171e',
          borderRight: '1px solid #2a313e',
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          '&.Mui-selected': {
            backgroundColor: 'rgba(79, 141, 245, 0.12)',
            '&:hover': { backgroundColor: 'rgba(79, 141, 245, 0.18)' },
          },
        },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          '&.Mui-checked': { color: '#99bfff' },
          '&.Mui-checked + .MuiSwitch-track': { backgroundColor: '#4f8df5' },
        },
      },
    },
    MuiSnackbar: {
      defaultProps: { anchorOrigin: { vertical: 'bottom', horizontal: 'right' } },
    },
  },
});
