// A small reader for the Prometheus text format, enough for what Traefik writes.

/** One sample per line: { name, labels: {..}, value }. Comments and blank lines are skipped. */
export function parsePrometheus(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    let i = 0;
    while (i < line.length && /[a-zA-Z0-9_:]/.test(line[i])) i++;
    const name = line.slice(0, i);
    if (!name) continue;
    const labels = {};
    if (line[i] === '{') {
      i++;
      while (i < line.length && line[i] !== '}') {
        let k = '';
        while (i < line.length && line[i] !== '=') k += line[i++];
        i++; // =
        if (line[i] !== '"') break;
        i++;
        let v = '';
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && i + 1 < line.length) {
            const n = line[i + 1];
            v += n === 'n' ? '\n' : n;
            i += 2;
          } else v += line[i++];
        }
        i++; // closing quote
        labels[k.trim()] = v;
        if (line[i] === ',') i++;
      }
      i++; // }
    }
    const rest = line.slice(i).trim().split(/\s+/);
    const value = parseValue(rest[0]);
    if (value === null) continue;
    out.push({ name, labels, value });
  }
  return out;
}

function parseValue(s) {
  if (s === undefined) return null;
  if (s === '+Inf') return Infinity;
  if (s === '-Inf') return -Infinity;
  if (s === 'NaN') return NaN;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/**
 * A quantile from cumulative histogram buckets ([{le, count}], le ascending, +Inf last), the way
 * Prometheus' histogram_quantile does it: linear inside the bucket the rank falls in.
 */
export function histogramQuantile(q, buckets) {
  if (!buckets.length) return null;
  const total = buckets[buckets.length - 1].count;
  if (!(total > 0)) return null;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const b of buckets) {
    if (b.count >= rank) {
      if (b.le === Infinity) return prevLe; // beyond the last finite bucket: the best we can say
      const inBucket = b.count - prevCount;
      if (inBucket <= 0) return b.le;
      return prevLe + (b.le - prevLe) * ((rank - prevCount) / inBucket);
    }
    prevLe = b.le;
    prevCount = b.count;
  }
  return prevLe;
}
