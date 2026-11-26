/** Parse bounded integer configuration; unset, empty and invalid values use the default. */
export function intEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : def;
}
