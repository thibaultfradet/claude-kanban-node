// Timestamps are stored as naive UTC strings, "YYYY-MM-DD HH:MM:SS.ffffff",
// exactly as the Python version writes them. These helpers render them the way
// Python's datetime methods do, so templates and prompts stay identical.

/** Python's datetime.isoformat(): "T" separator, fraction dropped when zero. */
export function isoformat(value) {
  if (!value) return "";
  let [date, time = "00:00:00"] = String(value).split(/[ T]/);
  const [hms, fraction] = time.split(".");
  if (fraction && Number(fraction) !== 0) {
    return `${date}T${hms}.${fraction.padEnd(6, "0").slice(0, 6)}`;
  }
  return `${date}T${hms}`;
}

/** The small strftime subset the templates use. */
export function strftime(value, format) {
  const iso = isoformat(value);
  const parts = {
    Y: iso.slice(0, 4),
    m: iso.slice(5, 7),
    d: iso.slice(8, 10),
    H: iso.slice(11, 13),
    M: iso.slice(14, 16),
    S: iso.slice(17, 19),
  };
  return format.replace(/%([YmdHMS%])/g, (_, key) => (key === "%" ? "%" : parts[key]));
}

/**
 * Wraps a stored timestamp so templates can keep Jinja's `.isoformat()` and
 * `.strftime(...)` calls. valueOf() returns the raw string, which sorts
 * chronologically.
 */
export class PyDateTime {
  constructor(raw) {
    this.raw = raw;
  }

  isoformat() {
    return isoformat(this.raw);
  }

  strftime(format) {
    return strftime(this.raw, format);
  }

  valueOf() {
    return this.raw;
  }

  toString() {
    return this.raw;
  }
}
