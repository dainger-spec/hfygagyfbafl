import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const getTelegramStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { getBotStatus } = await import("@/lib/telegram-bot.server");
  return getBotStatus();
});

export const resolveTelegramHandle = createServerFn({ method: "POST" })
  .validator(z.object({ input: z.string().min(1).max(200) }))
  .handler(async ({ data }) => {
    const { resolveHandleServer } = await import("@/lib/telegram-bot.server");
    return resolveHandleServer(data.input);
  });

const evidenceSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "video"]),
  name: z.string(),
  size: z.number(),
  mime: z.string(),
  dataUrl: z.string().optional().default(""),
  storageKey: z.string().optional(),
});

const personSchema = z.object({
  username: z.string(),
  telegramId: z.string(),
  firstName: z.string().optional(),
});

const applicationSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  status: z.enum(["pending", "published", "rejected"]),
  victim: personSchema,
  scammer: personSchema,
  scammers: z.array(personSchema).max(8).optional(),
  story: z.string().min(1),
  damageAmount: z.string(),
  damageCurrency: z.enum(["EUR", "USD", "USDT", "RUB"]),
  evidence: z.array(evidenceSchema).max(20),
});

export const submitToTelegram = createServerFn({ method: "POST" })
  .validator(applicationSchema)
  .handler(async ({ data }) => {
    const { sendApplicationToArbiters } = await import("@/lib/telegram-bot.server");
    return sendApplicationToArbiters(data);
  });

export const configureTelegram = createServerFn({ method: "POST" })
  .validator(z.object({ origin: z.string().max(300) }))
  .handler(async ({ data }) => {
    const { configureFromOrigin } = await import("@/lib/telegram-bot.server");
    return configureFromOrigin(data.origin);
  });

export const getMyComplaints = createServerFn({ method: "POST" })
  .validator(z.object({ telegramId: z.string().min(1).max(20) }))
  .handler(async ({ data }) => {
    const { listComplaintsForUser } = await import("@/lib/telegram-bot.server");
    return listComplaintsForUser(data.telegramId);
  });
