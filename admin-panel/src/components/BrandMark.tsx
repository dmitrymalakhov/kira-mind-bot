import { Box } from '@mui/material';
/** One approved emblem for navigation, sign-in and loading, on either surface. */
export function BrandMark({ size = 48 }: { size?: number }) {
  const base = typeof window !== 'undefined' && window.location.pathname.startsWith('/operator/') ? '/operator/' : '/';
  return <Box component="img" src={`${base}brand/kira-mark-128.png`}
    srcSet={`${base}brand/kira-mark-128.png 128w, ${base}brand/kira-mark-512.png 512w`}
    sizes={`${size}px`} width={size} height={size} alt="" aria-hidden="true"
    decoding="async" draggable={false}
    sx={{ display: 'block', width: size, height: size, flexShrink: 0, objectFit: 'contain' }} />;
}
