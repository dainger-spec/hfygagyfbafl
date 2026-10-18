import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Application, Identity } from "@/lib/types";
import { detectLocale, hasSavedLocale, persistLocale, type Locale } from "@/lib/i18n";

const SEED_STORY =
  "якобы продает фтп.\nКлянчит деньги по мелочи 50-100 баксов и включает дурачка, не может выдать, надо еще докинуть или просто игнорит.";

const SEED_AT = Date.UTC(2026, 7, 26, 12, 0, 0);

const seedPublished: Application = {
  id: "EPB-SEED",
  createdAt: SEED_AT,
  publishedAt: SEED_AT,
  status: "published",
  victim: {
    username: "archive_epb",
    telegramId: "1000000001",
    firstName: "Archive",
  },
  scammer: {
    username: "LopataBuild",
    telegramId: "5213159067",
  },
  story: SEED_STORY,
  summary: "якобы продает фтп, клянчит 50-100$ и пропадает.",
  damageAmount: "100",
  damageCurrency: "USD",
  evidence: [],
};

const emptyIdentity: Identity = {
  firstName: "",
  username: "",
  telegramId: "",
};

type BlacklistState = {
  identity: Identity;
  locale: Locale;
  applications: Application[];
  setIdentity: (patch: Partial<Identity>) => void;
  setLocale: (locale: Locale) => void;
  submitApplication: (app: Application) => void;
  publishApplication: (id: string) => void;
  rejectApplication: (id: string) => void;
  resetDemo: () => void;
};

function safeStorage(): Storage {
  try {
    const storage = window.localStorage;
    const key = "__epb__";
    storage.setItem(key, "1");
    storage.removeItem(key);
    return storage;
  } catch {
    return {
      length: 0,
      clear() {},
      getItem() {
        return null;
      },
      key() {
        return null;
      },
      removeItem() {},
      setItem() {},
    };
  }
}

export const useBlacklistStore = create<BlacklistState>()(
  persist(
    (set) => ({
      identity: emptyIdentity,
      locale: "ru",
      applications: [seedPublished],
      setIdentity: (patch) =>
        set((s) => ({ identity: { ...s.identity, ...patch } })),
      setLocale: (locale) => {
        persistLocale(locale);
        set({ locale });
      },
      submitApplication: (app) =>
        set((s) => ({ applications: [app, ...s.applications] })),
      publishApplication: (id) =>
        set((s) => ({
          applications: s.applications.map((a) =>
            a.id === id && a.status === "pending"
              ? { ...a, status: "published" as const, publishedAt: Date.now() }
              : a,
          ),
        })),
      rejectApplication: (id) =>
        set((s) => ({
          applications: s.applications.map((a) =>
            a.id === id && a.status === "pending"
              ? { ...a, status: "rejected" as const, rejectedAt: Date.now() }
              : a,
          ),
        })),
      resetDemo: () =>
        set({
          identity: emptyIdentity,
          locale: detectLocale(),
          applications: [seedPublished],
        }),
    }),
    {
      name: "epb-blacklist",
      storage: createJSONStorage(() => safeStorage()),
      skipHydration: true,
      partialize: (s) => ({
        applications: s.applications,
        locale: s.locale,
      }),
    },
  ),
);

export function rehydrateBlacklistStore() {
  void Promise.resolve(useBlacklistStore.persist.rehydrate()).then(() => {
    if (!hasSavedLocale()) return;
    const stored = useBlacklistStore.getState().locale;
    if (stored === "ru" || stored === "en") persistLocale(stored);
  });
}
