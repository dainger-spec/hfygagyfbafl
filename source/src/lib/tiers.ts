// Member cards: the card on the home screen depends on how many of the user's
// complaints became blacklists (published in the channel). Lowest to highest,
// the usual order of premium card tiers: Bronze, Silver, Gold, Platinum, Black.
export type Metal = "bronze" | "silver" | "gold" | "platinum" | "black";

export type Tier = { metal: Metal; name: string; min: number };

export const TIERS: Tier[] = [
  { metal: "bronze", name: "Bronze", min: 0 },
  { metal: "silver", name: "Silver", min: 1 },
  { metal: "gold", name: "Gold", min: 3 },
  { metal: "platinum", name: "Platinum", min: 10 },
  { metal: "black", name: "Black", min: 25 },
];

export function tierFor(published: number): Tier {
  let tier = TIERS[0]!;
  for (const t of TIERS) if (published >= t.min) tier = t;
  return tier;
}

export function nextTier(published: number): Tier | null {
  return TIERS.find((t) => t.min > published) ?? null;
}
