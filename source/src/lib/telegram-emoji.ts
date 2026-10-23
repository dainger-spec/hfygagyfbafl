// Telegram Premium custom emoji for the bot's private-chat messages.
//
// A regular bot may send custom emoji ("<tg-emoji>" entities) only in messages
// it sends directly to private / group / supergroup chats AND only when the
// bot owner has a Telegram Premium subscription (or the bot bought a username
// on Fragment). Channel posts are NOT eligible. So we use these only in the
// complaint-flow step prompts and the /start stats line, all private-chat text,
// and we always keep the plain emoji as the <tg-emoji> fallback so the message
// still reads correctly if a client can't render the custom emoji.
//
// IDs come from the "Telegram iOS Icons" pack the owner purchased. The key is
// the exact plain emoji as written in the message text (variation selectors
// included); the value is its custom_emoji_id.
export const CUSTOM_EMOJI: Record<string, string> = {
  "👤": "6032693626394382504", // person — accounts step
  "✏️": "6039779802741739617", // pencil — short summary step
  "📄": "6034969813032374911", // document — detailed description step
  "💰": "5778421276024509124", // coins — damage amount step
  "📎": "6039451237743595514", // paperclip — evidence step
  "📝": "5922693616953725714", // memo — "file a complaint" intro
  "📊": "5936143551854285132", // bar chart — stats line
};

// More icons from the same pack, looked up at runtime by the bot (getStickerSet):
// status marks in checks, captcha, account card. The fixed ids above always win.
const packEmoji: Record<string, string> = {};

export function registerPackEmoji(map: Record<string, string>) {
  for (const [base, id] of Object.entries(map)) {
    if (!/^\d{5,25}$/.test(id) || !base) continue;
    packEmoji[base] = id;
  }
  EMOJI_RE = undefined;
}

// Button icons are from the same pack, so their ids work in text too.
function idFor(base: string): string | undefined {
  return CUSTOM_EMOJI[base] ?? packEmoji[base] ?? BUTTON_EMOJI[base];
}

// Is there a custom emoji for this plain emoji (fixed or from the pack)?
export function hasEmojiId(base: string): boolean {
  return Boolean(idFor(base));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One pass over the text, longest emoji first, so "⛔️" and "⛔" never wrap twice.
let EMOJI_RE: RegExp | null | undefined;
function emojiRe(): RegExp | null {
  if (EMOJI_RE === undefined) {
    const keys = [...new Set([...Object.keys(CUSTOM_EMOJI), ...Object.keys(packEmoji), ...Object.keys(BUTTON_EMOJI)])].sort((a, b) => b.length - a.length);
    EMOJI_RE = keys.length ? new RegExp(keys.map(escapeRegExp).join("|"), "g") : null;
  }
  return EMOJI_RE;
}

// Wrap each known plain emoji in a <tg-emoji> tag (requires parse_mode "HTML").
// The inner plain emoji is the fallback shown when the custom emoji can't load.
export function applyCustomEmoji(text: string): string {
  const re = emojiRe();
  if (!re) return text;
  return text.replace(re, (base) => `<tg-emoji emoji-id="${idFor(base)}">${base}</tg-emoji>`);
}

// Turn <tg-emoji ...>X</tg-emoji> back into its plain fallback X. Used to resend
// as plain text if Telegram rejects the custom emoji (no premium / not allowed).
export function stripCustomEmoji(text: string): string {
  return text.replace(/<tg-emoji\b[^>]*>(.*?)<\/tg-emoji>/gs, "$1");
}

export function hasCustomEmoji(text: string): boolean {
  return /<tg-emoji\b/.test(text);
}

// Custom emoji shown BEFORE a button's text via InlineKeyboardButton.icon_custom_emoji_id.
// Same Premium-owner / private-chat rule as text custom emoji. Keyed by the plain
// emoji a button label starts with, so a button keeps a readable plain fallback.
export const BUTTON_EMOJI: Record<string, string> = {
  "🛡": "6030445631921721471", // shield — open app
  "📝": "5922693616953725714", // memo — file a complaint
  "📣": "6039422865189638057", // megaphone — channel
  "👥": "6032609071373226027", // people — chat owners
  "🌐": "5776233299424843260", // globe — language
  "⬅️": "5960671702059848143", // left arrow — back
  "✅": "5774022692642492953", // check — confirm/keep
  "🔎": "6032850693348399258", // magnifier — check counterparty
  "🌟": "5805331990618053402", // star — project sponsors
};

const BTN_KEYS = Object.keys(BUTTON_EMOJI).sort((a, b) => b.length - a.length);

type KbButton = Record<string, unknown> & { text?: unknown };
type InlineMarkup = { inline_keyboard?: KbButton[][] };

// When useIcons is true, move a button's leading plain emoji into
// icon_custom_emoji_id and drop it from the label (Telegram draws the custom
// emoji before the text). When false, the button is returned unchanged with its
// plain emoji still in the label — the fallback for when custom emoji aren't
// allowed. Always returns a fresh object; never mutates the input.
export function decorateButtons<T>(markup: T, useIcons: boolean): T {
  const m = markup as unknown as InlineMarkup;
  if (!m || !Array.isArray(m.inline_keyboard)) return markup;
  const rows = m.inline_keyboard.map((row) =>
    row.map((btn) => {
      const text = typeof btn.text === "string" ? btn.text : "";
      if (!useIcons || !text) return { ...btn };
      for (const emoji of BTN_KEYS) {
        if (text.startsWith(emoji + " ")) {
          return { ...btn, text: text.slice(emoji.length + 1), icon_custom_emoji_id: BUTTON_EMOJI[emoji] };
        }
      }
      return { ...btn };
    }),
  );
  return { ...(markup as object), inline_keyboard: rows } as unknown as T;
}

// Does this markup have at least one button whose leading emoji we can upgrade?
export function markupHasIconableButton(markup: unknown): boolean {
  const m = markup as InlineMarkup;
  if (!m || !Array.isArray(m.inline_keyboard)) return false;
  return m.inline_keyboard.some((row) =>
    row.some((btn) => typeof btn.text === "string" && BTN_KEYS.some((e) => (btn.text as string).startsWith(e + " "))),
  );
}
