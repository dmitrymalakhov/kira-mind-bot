import { Box } from '@mui/material';
export function BrandMark({ size = 40 }: { size?: number }) {
  return <Box aria-hidden="true" sx={{ width: size, height: size, flexShrink: 0, borderRadius: '30%', display: 'grid', placeItems: 'center', bgcolor: '#D8E9CD', color: '#28513D' }}>
    <svg width={size * .68} height={size * .68} viewBox="0 0 40 40" fill="none">
      <path d="M20 3C20 13 13 20 3 20C13 20 20 27 20 37C20 27 27 20 37 20C27 20 20 13 20 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="20" cy="20" r="5.5" fill="currentColor" /><circle cx="31.5" cy="8.5" r="2" fill="currentColor" />
    </svg>
  </Box>;
}
