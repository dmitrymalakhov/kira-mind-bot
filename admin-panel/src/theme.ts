import { createTheme } from '@mui/material/styles';

interface SidebarPalette { surface: string; card: string; hover: string; border: string; label: string }
declare module '@mui/material/styles' {
  interface Palette { sidebar: SidebarPalette }
  interface PaletteOptions { sidebar?: SidebarPalette }
}

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#285D4A', light: '#39755E', dark: '#173E30', contrastText: '#FFFFFF' },
    secondary: { main: '#796583' },
    success: { main: '#29735B', light: '#44866E', dark: '#185441' },
    warning: { main: '#956019', light: '#A77735', dark: '#79501F' },
    error: { main: '#B14D4D' },
    info: { main: '#3D6E82' },
    background: { default: '#F5F5F0', paper: '#FFFFFF' },
    divider: '#E4E7DF',
    text: { primary: '#242E29', secondary: '#68736C', disabled: '#69766C' },
    sidebar: { surface: '#1C2823', card: '#24352D', hover: '#2A3B32', border: '#34443B', label: '#A5B4AA' },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: '"Avenir Next", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif',
    fontSize: 14,
    h4: { fontSize: '2rem', fontWeight: 650, letterSpacing: '-0.04em' },
    h5: { fontWeight: 650, letterSpacing: '-0.035em' },
    h6: { fontSize: '1.2rem', fontWeight: 650, letterSpacing: '-0.025em' },
    subtitle1: { fontWeight: 600 },
    button: { textTransform: 'none', fontWeight: 600, letterSpacing: 0 },
    body1: { lineHeight: 1.6 }, body2: { lineHeight: 1.6 },
    caption: { lineHeight: 1.6 }, overline: { fontSize: 10, fontWeight: 700, letterSpacing: '0.13em', lineHeight: 1.6 },
  },
  components: {
    MuiCssBaseline: { styleOverrides: {
      '[hidden]': { display: 'none !important' },
      html: { colorScheme: 'light' }, body: { background: '#F5F5F0' },
      '*:focus-visible': { outline: '2px solid #39755E', outlineOffset: 3 },
      '::selection': { background: '#DCEBDB', color: '#173E30' },
      '@media (prefers-reduced-motion: reduce)': {
        '*, *::before, *::after': { animationDuration: '0.01ms !important', transitionDuration: '0.01ms !important', scrollBehavior: 'auto !important' },
      },
    } },
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: {
      root: { borderRadius: 10, minHeight: 38, padding: '8px 16px' },
      outlined: { borderColor: '#D9DFD5', color: '#344D3E' },
    } },
    MuiIconButton: { styleOverrides: { root: { borderRadius: 10 } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiCard: { styleOverrides: { root: { borderRadius: 18, backgroundImage: 'none', border: '1px solid #E4E7DF', boxShadow: '0 3px 18px rgba(31,45,35,.025)' } } },
    MuiCardContent: { styleOverrides: { root: { padding: 28, '&:last-child': { paddingBottom: 28 }, '@media (max-width:599px)': { padding: 20, '&:last-child': { paddingBottom: 20 } } } } },
    MuiDialog: { styleOverrides: { paper: { border: '1px solid #E4E7DF', borderRadius: 20, boxShadow: '0 24px 90px #12231F25' } } },
    MuiDialogTitle: { styleOverrides: { root: { padding: '24px 28px 18px', fontWeight: 650 } } },
    MuiDialogContent: { styleOverrides: { root: { padding: 28 } } },
    MuiDialogActions: { styleOverrides: { root: { padding: '16px 28px', gap: 8 } } },
    MuiBackdrop: { styleOverrides: { root: { backgroundColor: 'rgba(20,36,27,.32)', backdropFilter: 'blur(4px)' } } },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiOutlinedInput: { styleOverrides: {
      root: { backgroundColor: '#FAFBF8', borderRadius: 10, fontSize: 14, '& fieldset': { borderColor: '#DDE3D8' }, '&:hover fieldset': { borderColor: '#A4B4A7' }, '&.Mui-focused': { backgroundColor: '#FFFFFF' } },
      input: { '&:-webkit-autofill': { WebkitBoxShadow: '0 0 0 100px #FAFBF8 inset', WebkitTextFillColor: '#242E29' } },
    } },
    MuiInputLabel: { styleOverrides: { root: { fontSize: 14 } } },
    MuiFormHelperText: { styleOverrides: { root: { fontSize: 11.5, marginLeft: 2, marginTop: 6 } } },
    MuiTabs: { styleOverrides: { root: { minHeight: 44 }, indicator: { display: 'none' } } },
    MuiTab: { styleOverrides: { root: { minHeight: 42, minWidth: 0, padding: '10px 18px', borderRadius: 10, fontSize: 13, '&.Mui-selected': { backgroundColor: '#FFFFFF', color: '#244C38', boxShadow: '0 1px 4px #1D302010' } } } },
    MuiAccordion: { defaultProps: { elevation: 0 }, styleOverrides: { root: { backgroundImage: 'none', border: '1px solid #E4E7DF', borderRadius: '12px !important', marginBottom: 10, '&:before': { display: 'none' }, '&.Mui-expanded': { margin: '0 0 10px' } } } },
    MuiAccordionSummary: { styleOverrides: { root: { minHeight: 50, '&.Mui-expanded': { minHeight: 50 } }, content: { margin: '12px 0', '&.Mui-expanded': { margin: '12px 0' } } } },
    MuiAlert: { defaultProps: { variant: 'standard' }, styleOverrides: { root: { borderRadius: 12, fontSize: 13, border: '1px solid transparent' }, standardInfo: { backgroundColor: '#EEF4F4', color: '#365C68' }, standardSuccess: { backgroundColor: '#EAF3EA', color: '#2C624A' }, standardWarning: { backgroundColor: '#FBF4E7', color: '#7F5C25' }, standardError: { backgroundColor: '#FBEFEC', color: '#974B43' } } },
    MuiChip: { styleOverrides: { root: { borderRadius: 7, fontSize: 11, fontWeight: 600 } } },
    MuiSwitch: { styleOverrides: { root: { padding: 9 }, track: { borderRadius: 12, backgroundColor: '#859184' }, switchBase: { '&.Mui-checked': { color: '#285D4A' }, '&.Mui-checked + .MuiSwitch-track': { backgroundColor: '#8DB7A0', opacity: 0.65 } } } },
    MuiDrawer: { styleOverrides: { paper: { backgroundColor: '#1C2823', borderRight: '1px solid #34443B' } } },
    MuiListItemButton: { styleOverrides: { root: { borderRadius: 10 } } },
    MuiTableCell: { styleOverrides: { root: { borderColor: '#E4E7DF', fontSize: 13 }, head: { fontSize: 11, color: '#68736C', fontWeight: 700, backgroundColor: '#F7F8F4' } } },
    MuiTooltip: { styleOverrides: { tooltip: { backgroundColor: '#25382C', fontSize: 12, padding: '8px 12px', borderRadius: 8 } } },
    MuiToggleButtonGroup: { styleOverrides: { root: { borderRadius: 11, backgroundColor: '#F0F2EC', padding: 4 }, grouped: { border: 0, borderRadius: '8px !important', margin: 0 } } },
    MuiToggleButton: { styleOverrides: { root: { textTransform: 'none', fontWeight: 600, padding: '9px 18px', '&.Mui-selected': { backgroundColor: '#FFFFFF', color: '#285D4A', boxShadow: '0 1px 5px #24352610', '&:hover': { backgroundColor: '#FFFFFF' } } } } },
    MuiSnackbar: { defaultProps: { anchorOrigin: { vertical: 'bottom', horizontal: 'right' } } },
  },
});
