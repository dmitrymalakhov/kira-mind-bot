import { useEffect, useId } from 'react';
import { activeAdminAccount } from './api';
const drafts = new Set<string>();
export function hasAccountDrafts() { return drafts.size > 0; }
export function clearAccountDrafts() { drafts.clear(); }
export function useAccountDraft(dirty: boolean) {
  const id = useId(), key = `${activeAdminAccount() || 'legacy'}:${id}`;
  useEffect(() => { if (dirty) drafts.add(key); else drafts.delete(key); return () => { drafts.delete(key); }; }, [key, dirty]);
}
