// A tile's sparkline: a small line over time with a faint fill, no axes. The kit's Tile has no
// sparkline of its own, so tiles pass this in beside their value.
import type { ReactNode } from 'react';

const W = 72;
const H = 24;

/** Points as [time ms, value]; hidden until there are two. `label` names the window for screen readers and hover. */
export function Spark({ points, label }: { points: [number, number][]; label: string }) {
  if (points.length < 2) return null;
  const t0 = points[0][0];
  const span = points.at(-1)![0] - t0 || 1;
  const lo = Math.min(...points.map((p) => p[1]));
  const hi = Math.max(...points.map((p) => p[1]));
  const x = (t: number) => ((t - t0) / span) * W;
  // A flat line sits in the middle; otherwise the lowest value touches the bottom.
  const y = (v: number) => (hi === lo ? H / 2 : H - 1 - ((v - lo) / (hi - lo)) * (H - 2));
  const line = points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const end = points.at(-1)!;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="shrink-0 overflow-visible text-(--chart-1)">
      <title>{label}</title>
      <path d={`${line}L${W},${H}L0,${H}Z`} fill="currentColor" opacity={0.12} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(end[0])} cy={y(end[1])} r={2} fill="currentColor" />
    </svg>
  );
}

/** A tile value with its sparkline at the right. */
export function WithSpark({ value, spark }: { value: string; spark: ReactNode }) {
  return (
    <span className="flex items-end justify-between gap-3">
      <span>{value}</span>
      {spark}
    </span>
  );
}
