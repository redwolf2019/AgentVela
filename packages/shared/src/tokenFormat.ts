const INTEGER = new Intl.NumberFormat("en-US");
const TOKEN_SUFFIXES = ["K", "M", "B", "T"] as const;

export function formatTokens(value: number): string {
  if (Math.abs(Math.round(value)) < 1e3) return INTEGER.format(Math.round(value));
  let scaled = value / 1e3;
  let unit = 0;
  // Choose the unit after rounding, so 999,999 reads 1M rather than 1000K.
  while (Math.abs(Number(trim(scaled))) >= 1e3 && unit < TOKEN_SUFFIXES.length - 1) {
    scaled /= 1e3;
    unit += 1;
  }
  return `${trim(scaled)}${TOKEN_SUFFIXES[unit]}`;
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}
