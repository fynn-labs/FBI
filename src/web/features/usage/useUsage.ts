import { useEffect, useState } from 'react';
import type { UsageState } from '@shared/types.js';
import { usageStore } from './usageStore.js';

export function useUsage(): UsageState | null {
  const [s, setS] = useState<UsageState | null>(() => usageStore.getSnapshot());
  useEffect(() => {
    usageStore.ensureStarted();
    return usageStore.onSnapshot(setS);
  }, []);
  return s;
}

export function __resetUsageStoreForTest(): void {
  usageStore._resetForTest();
}
