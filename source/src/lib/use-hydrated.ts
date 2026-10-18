import { useEffect, useState } from "react";
import { rehydrateBlacklistStore, useBlacklistStore } from "@/lib/store";

export function useHydrated() {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const finish = () => setHydrated(true);
    const unsub = useBlacklistStore.persist.onFinishHydration(finish);
    rehydrateBlacklistStore();
    if (useBlacklistStore.persist.hasHydrated()) finish();
    return unsub;
  }, []);

  return hydrated;
}
