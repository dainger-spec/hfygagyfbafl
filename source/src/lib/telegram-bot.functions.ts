import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { t } from "@/lib/i18n";

export const getTelegramStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { getBotStatus } = await import("@/lib/telegram-bot.server");
  return getBotStatus();
});

export const resolveTelegramHandle = createServerFn({ method: "POST" })
  .validator(z.object({ input: z.string().min(1).max(200), initData: z.string().max(4096).optional() }))
  .handler(async ({ data }) => {
    const { resolveHandleServer, verifyTelegramInitData } = await import("@/lib/telegram-bot.server");
    const authed = verifyTelegramInitData(data.initData || "");
    if (!authed) return { username: "", id: "", source: "unresolved" as const };
    return resolveHandleServer(data.input, authed.id);
  });

const evidenceSchema = z.object({
  id: z.string().max(40),
  kind: z.enum(["image", "video"]),
  name: z.string().max(200),
  size: z.number().nonnegative().max(2_147_483_647),
  mime: z.string().max(80),
  dataUrl: z.string().max(80).optional().default(""),
  storageKey: z.string().max(80).optional(),
});

const personSchema = z.object({
  username: z.string().max(64),
  telegramId: z.string().max(20),
  firstName: z.string().max(64).optional(),
});

const applicationSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  status: z.enum(["pending", "published", "rejected"]),
  victim: personSchema,
  scammer: personSchema,
  scammers: z.array(personSchema).max(8).optional(),
  story: z.string().min(1).max(5000),
  summary: z.string().min(10).max(800),
  damageAmount: z.string().max(32),
  damageCurrency: z.enum(["EUR", "USD", "USDT", "RUB"]),
  evidence: z.array(evidenceSchema).max(30),
  initData: z.string().max(16384).optional(),
  locale: z.enum(["ru", "en"]).optional(),
});

export const submitToTelegram = createServerFn({ method: "POST" })
  .validator(applicationSchema)
  .handler(async ({ data }) => {
    const bot = await import("@/lib/telegram-bot.server");
    const locale = data.locale === "en" ? "en" : "ru";
    const authed = bot.verifyTelegramInitData(data.initData || "");
    if (!authed) {
      return { ok: false as const, error: t(locale, "errOpenBot") };
    }
    // Every complaint ends with a captcha (solved via getCaptcha/solveCaptcha).
    if (!bot.hasSubmitPass(authed.id)) return { ok: false as const, error: "captcha" };
    bot.saveUserLocaleServer(authed.id, locale);
    const app = {
      id: data.id,
      createdAt: data.createdAt,
      status: data.status,
      victim: {
        username: authed.username || "",
        telegramId: authed.id,
      },
      scammer: data.scammer,
      scammers: data.scammers,
      story: data.story,
      summary: data.summary,
      damageAmount: data.damageAmount,
      damageCurrency: data.damageCurrency,
      evidence: data.evidence,
    };
    const res = await bot.sendApplicationToArbiters(app);
    if (res.ok) bot.consumeSubmitPass(authed.id);
    return res;
  });

export const configureTelegram = createServerFn({ method: "POST" })
  .validator(z.object({ origin: z.string().max(300) }))
  .handler(async ({ data }) => {
    const { configureFromOrigin } = await import("@/lib/telegram-bot.server");
    return configureFromOrigin(data.origin);
  });

export const getMyComplaints = createServerFn({ method: "POST" })
  .validator(z.object({ telegramId: z.string().min(1).max(20), initData: z.string().max(4096).optional() }))
  .handler(async ({ data }) => {
    const { listComplaintsForUser, verifyTelegramInitData } = await import("@/lib/telegram-bot.server");
    const authed = verifyTelegramInitData(data.initData || "");
    if (!authed) return [];
    return listComplaintsForUser(authed.id);
  });

export const saveUserLocale = createServerFn({ method: "POST" })
  .validator(z.object({ initData: z.string().max(16384), locale: z.enum(["ru", "en"]) }))
  .handler(async ({ data }) => {
    const { verifyTelegramInitData, saveUserLocaleServer } = await import("@/lib/telegram-bot.server");
    const authed = verifyTelegramInitData(data.initData);
    if (!authed) return { ok: false as const };
    saveUserLocaleServer(authed.id, data.locale);
    return { ok: true as const };
  });

export const checkCounterparty = createServerFn({ method: "POST" })
  .validator(z.object({ input: z.string().min(1).max(200), initData: z.string().max(16384), platform: z.string().max(24).optional() }))
  .handler(async ({ data }) => {
    const bot = await import("@/lib/telegram-bot.server");
    const gate = bot.allowCheck(data.initData);
    if (!gate.ok) return { ok: false as const, error: gate.error };
    // Frequent checks need a solved captcha first (see getCaptcha/solveCaptcha).
    if (bot.captchaRequired(gate.userId)) return { ok: false as const, error: "captcha" };
    const result = await bot.checkCounterparty(data.input);
    const who = bot.verifyTelegramInitData(data.initData);
    bot.logSearch({ id: gate.userId, username: who?.username, first_name: who?.firstName }, data.input, result, "app", data.platform);
    return { ok: true as const, result };
  });

export const getCheckSources = createServerFn({ method: "POST" })
  .validator(z.object({ initData: z.string().max(16384) }))
  .handler(async ({ data }) => {
    const bot = await import("@/lib/telegram-bot.server");
    if (!bot.verifyTelegramInitData(data.initData)) return { ok: false as const, sources: [] };
    return { ok: true as const, sources: bot.checkSources() };
  });

export const getFeatures = createServerFn({ method: "GET" }).handler(async () => {
  const { featuresEnabled } = await import("@/lib/telegram-bot.server");
  return featuresEnabled();
});

export const getBanners = createServerFn({ method: "GET" }).handler(async () => {
  const { listBanners } = await import("@/lib/telegram-bot.server");
  return listBanners();
});

export const getSponsors = createServerFn({ method: "GET" }).handler(async () => {
  const { listSponsors } = await import("@/lib/telegram-bot.server");
  return listSponsors();
});

export const getBaseStats = createServerFn({ method: "GET" }).handler(async () => {
  const { publicBaseStats } = await import("@/lib/telegram-bot.server");
  return publicBaseStats();
});

export const getBaseDetails = createServerFn({ method: "GET" }).handler(async () => {
  const { publicBaseDetails } = await import("@/lib/telegram-bot.server");
  return publicBaseDetails();
});

export const getSponsorStats = createServerFn({ method: "GET" }).handler(async () => {
  const { sponsorStats } = await import("@/lib/telegram-bot.server");
  return sponsorStats();
});

export const getPostDetail = createServerFn({ method: "POST" })
  .validator(z.object({ initData: z.string().max(16384), channelId: z.string().max(40), messageId: z.number().int().positive() }))
  .handler(async ({ data }) => {
    const bot = await import("@/lib/telegram-bot.server");
    const gate = bot.allowView(data.initData);
    if (!gate.ok) return { ok: false as const, error: gate.error };
    return bot.postDetail(gate.userId, data.channelId, data.messageId);
  });

export const getLatestParsed = createServerFn({ method: "POST" })
  .validator(z.object({ initData: z.string().max(16384) }))
  .handler(async ({ data }) => {
    const bot = await import("@/lib/telegram-bot.server");
    const gate = bot.allowView(data.initData);
    if (!gate.ok) return { ok: false as const, error: gate.error };
    return { ok: true as const, items: bot.latestParsed(30) };
  });

export const getRecentBlacklist = createServerFn({ method: "POST" })
  .validator(z.object({ initData: z.string().max(16384) }))
  .handler(async ({ data }) => {
    const bot = await import("@/lib/telegram-bot.server");
    const gate = bot.allowView(data.initData);
    if (!gate.ok) return { ok: false as const, error: gate.error };
    return { ok: true as const, items: bot.recentBlacklist() };
  });

export const getBlacklistEntry = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(1).max(80), initData: z.string().max(16384) }))
  .handler(async ({ data }) => {
    const bot = await import("@/lib/telegram-bot.server");
    const gate = bot.allowView(data.initData);
    if (!gate.ok) return { ok: false as const, error: gate.error };
    return { ok: true as const, entry: bot.blacklistEntry(data.id) };
  });

export const getAccess = createServerFn({ method: "POST" })
  .validator(z.object({ initData: z.string().max(16384) }))
  .handler(async ({ data }) => {
    const { appAccess } = await import("@/lib/telegram-bot.server");
    return appAccess(data.initData);
  });

export const getCaptcha = createServerFn({ method: "POST" })
  .validator(z.object({ initData: z.string().max(16384), purpose: z.enum(["check", "submit"]).optional() }))
  .handler(async ({ data }) => {
    const bot = await import("@/lib/telegram-bot.server");
    const user = bot.verifyTelegramInitData(data.initData);
    if (!user) return { ok: false as const, error: "telegram auth required" };
    const png = bot.newCaptchaImage(user.id, data.purpose ?? "check");
    if (!png) return { ok: false as const, error: "too many" };
    return { ok: true as const, image: `data:image/png;base64,${png.toString("base64")}` };
  });

export const solveCaptcha = createServerFn({ method: "POST" })
  .validator(z.object({ initData: z.string().max(16384), answer: z.string().max(40) }))
  .handler(async ({ data }) => {
    const bot = await import("@/lib/telegram-bot.server");
    const user = bot.verifyTelegramInitData(data.initData);
    if (!user) return { ok: false as const, result: "expired" as const };
    return { ok: true as const, result: bot.solveCaptcha(user.id, data.answer) };
  });
