import { Box } from '@mui/material';
/** One approved emblem for navigation, sign-in and loading, on either surface. */
export function BrandMark({ size = 48 }: { size?: number }) {
  return <Box component="img" src="/brand/kira-mark-128.png"
    srcSet="/brand/kira-mark-128.png 128w, /brand/kira-mark-512.png 512w"
    sizes={`${size}px`} width={size} height={size} alt="" aria-hidden="true"
    decoding="async" draggable={false}
    sx={{ display: 'block', width: size, height: size, flexShrink: 0, objectFit: 'contain' }} />;
}
