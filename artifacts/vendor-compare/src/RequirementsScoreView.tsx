import React from 'react';
import { hasUnresolvedDiscovery } from './unresolved-discovery';
import UnresolvedDiscoveryNotice from './UnresolvedDiscoveryNotice';

const COLORS = ['#237e77', '#7760c5', '#3976ae', '#b07724', '#b54b78', '#497342'];

type Rating = { criterion: string; score: number; weight: number };
type Option = { vendor: string; weightedScores?: Rating[] };

export function requirementsChartData(vendors: Option[]) {
  if (hasUnresolvedDiscovery({ vendorScores: vendors })) return { criteria: [], options: [] };
  const valid = (row: Rating) => row && typeof row.criterion === 'string' && row.criterion.trim()
    && Number.isFinite(row.score) && row.score >= 0 && row.score <= 100
    && Number.isFinite(row.weight) && row.weight > 0 && row.weight <= 100;
  const options = vendors.map((vendor) => ({
    name: vendor.vendor,
    ratings: [...new Map((vendor.weightedScores ?? []).filter(valid)
      .map((row) => [row.criterion.trim(), { ...row, criterion: row.criterion.trim() }])).values()],
  }));
  const criteria = [...new Set(options.flatMap((option) => option.ratings.map((row) => row.criterion)))];
  return {
    criteria,
    options: options.map((option) => {
      const weight = option.ratings.reduce((sum, row) => sum + row.weight, 0);
      return {
        ...option,
        points: option.ratings.reduce((sum, row) => sum + row.score * row.weight / 100, 0),
        weight,
        complete: option.ratings.length === criteria.length && Math.abs(weight - 100) < 0.01,
      };
    }),
  };
}

/** The caller excludes neutral fallback rows; this view never manufactures missing scores. */
export default function RequirementsScoreView({ vendors }: { vendors: Option[] }) {
  if (hasUnresolvedDiscovery({ vendorScores: vendors })) return <UnresolvedDiscoveryNotice />;
  const { criteria, options } = requirementsChartData(vendors);
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / criteria.length;
    return [300 + Math.cos(angle) * value, 185 + Math.sin(angle) * value];
  };
  const coords = (points: number[][]) => points.map((p) => p.join(',')).join(' ');
  return <div className="mt-5 grid min-w-0 gap-4 lg:grid-cols-[1.65fr_1fr]" data-testid="chart-requirements-overview">
    <figure className="min-w-0 rounded-xl border border-[#d5cebd] bg-[#faf7ee] p-3">
      <figcaption className="px-2 pt-2 text-xs font-semibold text-[#39435a]">Requirements profile · scores out of 100</figcaption>
      {criteria.length >= 3 ? <svg viewBox="0 0 600 375" className="block w-full" role="img" aria-label="Radar chart comparing saved option ratings across your requirements. Missing ratings are gaps, not zero. Exact values are in the criterion contributions table below." data-testid="chart-requirements-radar">
        {[20, 40, 60, 80, 100].map((level) => <g key={level}>
          <polygon points={coords(criteria.map((_, index) => point(index, level * 1.25)))} fill="none" stroke="#ddd9cb" strokeWidth="1" />
          <text x="305" y={185 - level * 1.25 + 10} fontSize="9" fill="#697264">{level}</text>
        </g>)}
        {criteria.map((criterion, index) => {
          const [x, y] = point(index, 149);
          const [endX, endY] = point(index, 125);
          return <g key={criterion}>
            <line x1="300" y1="185" x2={endX} y2={endY} stroke="#ddd9cb" />
            <text x={x} y={y} textAnchor={x < 285 ? 'end' : x > 315 ? 'start' : 'middle'} dominantBaseline="middle" fontSize="10" fill="#566074">
              <title>{criterion}</title>{criterion.length > 27 ? `${criterion.slice(0, 25)}…` : criterion}
            </text>
          </g>;
        })}
        {options.map((option, optionIndex) => {
          const points = criteria.map((criterion, index) => {
            const row = option.ratings.find((rating) => rating.criterion === criterion);
            return row ? point(index, row.score * 1.25) : null;
          });
          const color = COLORS[optionIndex % COLORS.length];
          const complete = points.every((p) => p !== null);
          return <g key={option.name}>
            <title>{`${option.name}: ${option.ratings.map((row) => `${row.criterion} ${row.score}/100`).join('; ')}`}</title>
            {complete && <polygon points={coords(points as number[][])} fill={color} fillOpacity=".09" stroke={color} strokeWidth="2" strokeDasharray={optionIndex ? `${8 - optionIndex} 3` : undefined} />}
            {!complete && points.map((p, index) => {
              const next = points[(index + 1) % points.length];
              return p && next ? <line key={index} x1={p[0]} y1={p[1]} x2={next[0]} y2={next[1]} stroke={color} strokeWidth="2" strokeDasharray="4 3" /> : null;
            })}
            {points.map((p, index) => p && <circle key={index} cx={p[0]} cy={p[1]} r="3" fill={color}><title>{`${option.name}, ${criteria[index]}: ${option.ratings.find((row) => row.criterion === criteria[index])?.score}/100`}</title></circle>)}
          </g>;
        })}
      </svg> : <p className="flex min-h-48 items-center justify-center px-5 text-center text-sm text-[#566074]">A radar profile needs at least three scored requirements. Your available ratings are shown in the table below.</p>}
      <ul className="flex flex-wrap justify-center gap-x-5 gap-y-2 pb-2 text-xs" aria-label="Chart legend">
        {options.map((option, index) => <li key={option.name} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS[index % COLORS.length] }} aria-hidden="true" />{option.name}</li>)}
      </ul>
    </figure>
    <section className="min-w-0 rounded-xl bg-[#202840] p-5 text-[#f8f4e8]" aria-label="Weighted option totals" data-testid="chart-requirements-totals">
      <h3 className="mono text-[10px] font-bold uppercase tracking-[.16em] text-[#acd5c8]">Weighted total / 100</h3>
      <p className="mt-2 text-[11px] leading-4 text-[#d4d9e4]">Saved score × priority weight. Modelled, not independently verified.</p>
      <ol className="mt-6 space-y-5">
        {options.map((option, index) => <li key={option.name}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-1 text-xs">
            <span className="font-semibold">{option.name}</span>
            <span className="tabular-nums">{!option.ratings.length ? 'Not scored' : option.complete ? `${option.points.toFixed(1)} / 100` : `${option.points.toFixed(1)} pts · partial`}</span>
          </div>
          <div className="h-7 overflow-hidden rounded-sm bg-white/10" aria-hidden="true">
            {option.ratings.length > 0 && <div className="h-full rounded-sm" style={{ width: `${Math.min(100, option.points)}%`, backgroundColor: index === 0 ? '#dce969' : '#a99ade' }} />}
          </div>
          {!option.complete && option.ratings.length > 0 && <p className="mt-1 text-[10px] text-[#d4d9e4]">{option.weight.toFixed(0)}% scored weight; incomplete totals are not comparable.</p>}
        </li>)}
      </ol>
      <div className="mt-3 flex justify-between text-[10px] tabular-nums text-[#bcc4d3]" aria-hidden="true">{[0, 25, 50, 75, 100].map((n) => <span key={n}>{n}</span>)}</div>
      <ul className="mt-6 flex flex-wrap gap-1.5 text-[10px] text-[#e0e4ed]" aria-label="Saved priority weights">
        {criteria.map((criterion) => {
          const weights = [...new Set(options.flatMap((option) => option.ratings.filter((row) => row.criterion === criterion).map((row) => row.weight)))];
          return <li key={criterion} className="rounded-full border border-white/20 px-2 py-1">{criterion} · {weights.length === 1 ? `${weights[0]}%` : 'weights vary by option'}</li>;
        })}
      </ul>
    </section>
  </div>;
}