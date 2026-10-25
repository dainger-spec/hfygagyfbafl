// Member cards: the card on the home screen depends on how many of the user's
// complaints became blacklists (published in the channel). Lowest to highest,
// Gold (everyone starts with it), Platinum, Black (Centurion).
export type Metal = "gold" | "platinum" | "black";

export type Tier = { metal: Metal; name: string; min: number };

export const TIERS: Tier[] = [
  { metal: "gold", name: "Gold", min: 0 },
  { metal: "platinum", name: "Platinum", min: 3 },
  { metal: "black", name: "Black", min: 10 },
];

export function tierFor(published: number): Tier {
  let tier = TIERS[0]!;
  for (const t of TIERS) if (published >= t.min) tier = t;
  return tier;
}

export function nextTier(published: number): Tier | null {
  return TIERS.find((t) => t.min > published) ?? null;
}
