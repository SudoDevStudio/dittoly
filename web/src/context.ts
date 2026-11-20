import { createContext, useContext } from 'react';
import type { Me } from './api';

export const MeContext = createContext<{ me: Me; mode: 'shared' | 'local' } | null>(null);

export function useMe() {
  const v = useContext(MeContext);
  if (!v) throw new Error('useMe outside MeContext');
  return v;
}
