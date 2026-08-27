export type Currency = "EUR" | "USD" | "USDT" | "RUB";

export type ApplicationStatus = "pending" | "published" | "rejected";

export type EvidenceItem = {
  id: string;
  kind: "image" | "video";
  name: string;
  size: number;
  mime: string;
  dataUrl: string;
  storageKey?: string;
};

export type PersonRef = {
  username: string;
  telegramId: string;
  firstName?: string;
};

export type Application = {
  id: string;
  createdAt: number;
  status: ApplicationStatus;
  victim: PersonRef;
  scammer: PersonRef;
  scammers?: PersonRef[];
  story: string;
  damageAmount: string;
  damageCurrency: Currency;
  evidence: EvidenceItem[];
  publishedAt?: number;
  rejectedAt?: number;
};

export function scammerAccounts(app: Pick<Application, "scammer" | "scammers">): PersonRef[] {
  if (app.scammers?.length) return app.scammers.filter((s) => s.username || s.telegramId);
  return app.scammer?.username || app.scammer?.telegramId ? [app.scammer] : [];
}

export type Identity = {
  firstName: string;
  username: string;
  telegramId: string;
};

export type ComplaintHistoryItem = {
  id: string;
  scammerUsername: string;
  scammerId: string;
  amount: string;
  currency: string;
  status: ApplicationStatus;
  createdAt: number;
};

export type ChatId = "bot" | "arbiters" | "channel";
