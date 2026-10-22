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

// Longest keys first so a multi-codepoint emoji is matched before any prefix.
const KEYS = Object.keys(CUSTOM_EMOJI).sort((a, b) => b.length - a.length);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wrap each known plain emoji in a <tg-emoji> tag (requires parse_mode "HTML").
// The inner plain emoji is the fallback shown when the custom emoji can't load.
export function applyCustomEmoji(text: string): string {
  let out = text;
  for (const base of KEYS) {
    const id = CUSTOM_EMOJI[base]!;
    out = out.replace(
      new RegExp(escapeRegExp(base), "g"),
      `<tg-emoji emoji-id="${id}">${base}</tg-emoji>`,
    );
  }
  return out;
}

// Turn <tg-emoji ...>X</tg-emoji> back into its plain fallback X. Used to resend
// as plain text if Telegram rejects the custom emoji (no premium / not allowed).
export function stripCustomEmoji(text: string): string {
  return text.replace(/<tg-emoji\b[^>]*>(.*?)<\/tg-emoji>/gs, "$1");
}

export function hasCustomEmoji(text: string): boolean {
  return /<tg-emoji\b/.test(text);
}
