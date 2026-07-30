// Auto-assigns an emoji for a taxonomy item name so DRIs never have to pick
// one by hand. Keyword rules cover common cases (road signs, street
// furniture, natural features, ...); anything unmatched falls back to a
// deterministic pick from a generic pool, keyed off the name itself so the
// same name always gets the same emoji.
const KEYWORD_EMOJI: [RegExp, string][] = [
  [/construction/i, "🚧"],
  [/crosswalk/i, "🦓"],
  [/cycl|bike|bicycle/i, "🚴"],
  [/do not enter/i, "⛔"],
  [/no (pedestrian|walk)/i, "🚷"],
  [/one way.*left/i, "⬅️"],
  [/one way.*right/i, "➡️"],
  [/park(ing)?/i, "🅿️"],
  [/pedestrian/i, "🚶"],
  [/railroad|rail\b/i, "🚆"],
  [/school/i, "🏫"],
  [/\bstop\b/i, "🛑"],
  [/street name|street sign/i, "🪧"],
  [/traffic light|signal/i, "🚦"],
  [/trailhead|\btrail\b/i, "🥾"],
  [/turn/i, "↩️"],
  [/tree/i, "🌳"],
  [/bench/i, "🪑"],
  [/trash|waste|garbage/i, "🗑️"],
  [/water|fountain/i, "⛲"],
  [/art|mural|sculpture/i, "🎨"],
  [/storm drain|\bdrain\b/i, "🌊"],
  [/hydrant/i, "🧯"],
  [/bus\b/i, "🚌"],
  [/bird|wildlife|animal/i, "🐦"],
  [/plant|flower|garden/i, "🌿"],
  [/lamp|light\b/i, "💡"],
  [/camera|surveillance/i, "📷"],
  [/bin\b|recycl/i, "♻️"],
  [/bridge/i, "🌉"],
  [/mail|post\b/i, "📮"],
  [/bollard/i, "🚧"],
  [/curb|ramp/i, "♿"],
  [/graffiti/i, "🖌️"],
  [/vendor|cart/i, "🛒"],
];

const GENERIC_POOL = ["🔹", "📍", "🏷️", "🔺", "⭐", "🔶", "🔷", "🟢", "🔻", "✳️"];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function autoEmoji(name: string): string {
  const trimmed = (name || "").trim();
  for (const [pattern, emoji] of KEYWORD_EMOJI) {
    if (pattern.test(trimmed)) return emoji;
  }
  const idx = hashString(trimmed.toLowerCase()) % GENERIC_POOL.length;
  return GENERIC_POOL[idx];
}
