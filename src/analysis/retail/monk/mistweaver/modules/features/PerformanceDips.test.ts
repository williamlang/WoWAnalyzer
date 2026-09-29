import {
  DIP_WINDOW_MS,
  DipMetric,
  DipSample,
  SAMPLE_PERIOD_MS,
  findDips,
} from 'analysis/retail/monk/mistweaver/modules/features/PerformanceDips';

const FIGHT_START = 1_000_000;
const FIGHT_DURATION = 300_000;

/** A stretch of the fight where the metric sits at `value` instead of the normal level. */
interface Stretch {
  start: number;
  end: number;
  value: number | null; // null = dead, nothing to judge
}

/**
 * Builds the rolling series and `measure` the analyzer would produce for a metric that is
 * `normal` everywhere except the given stretches (times relative to fight start).
 */
function buildSeries(metric: DipMetric, normal: number, stretches: Stretch[] = []) {
  const valueAt = (ts: number): number | null => {
    const rel = ts - FIGHT_START;
    const stretch = stretches.find((s) => rel >= s.start && rel < s.end);
    return stretch ? stretch.value : normal;
  };

  // Average the metric over [start, end), ignoring dead time, sampled every 100ms.
  const measure = (start: number, end: number): DipSample => {
    let sum = 0;
    let alive = 0;
    for (let ts = start; ts < end; ts += 100) {
      const v = valueAt(ts);
      if (v !== null) {
        sum += v;
        alive += 1;
      }
    }
    const value = alive > 0 ? sum / alive : null;
    return {
      timestamp: (start + end) / 2,
      rem: metric === 'rem' ? value : null,
      kick: metric === 'kick' ? value : null,
      cpm: metric === 'cpm' ? value : null,
    };
  };

  const fightEnd = FIGHT_START + FIGHT_DURATION;
  const samples: DipSample[] = [];
  for (let t = FIGHT_START; t <= fightEnd; t += SAMPLE_PERIOD_MS) {
    const start = Math.max(FIGHT_START, t - DIP_WINDOW_MS / 2);
    const end = Math.min(fightEnd, t + DIP_WINDOW_MS / 2);
    samples.push({ ...measure(start, end), timestamp: t });
  }

  return { samples, measure, baseline: measure(FIGHT_START, fightEnd)[metric] };
}

function dipsFor(metric: DipMetric, normal: number, stretches: Stretch[] = []) {
  const { samples, measure, baseline } = buildSeries(metric, normal, stretches);
  return findDips(samples, metric, baseline, measure);
}

describe('PerformanceDips findDips', () => {
  it('finds nothing in a pull that never dips', () => {
    expect(dipsFor('cpm', 55)).toEqual([]);
    expect(dipsFor('rem', 0.98)).toEqual([]);
  });

  it('finds a clear dip and covers the stretch it happened in', () => {
    const dips = dipsFor('cpm', 60, [{ start: 100_000, end: 125_000, value: 20 }]);

    expect(dips).toHaveLength(1);
    const [dip] = dips;
    expect(dip.metric).toBe('cpm');
    expect(dip.start - FIGHT_START).toBeLessThanOrEqual(100_000);
    expect(dip.end - FIGHT_START).toBeGreaterThanOrEqual(125_000);
    expect(dip.value).toBeLessThan(dip.baseline);
    expect(dip.drop).toBeGreaterThanOrEqual(0.25);
  });

  it('ignores a drop smaller than the metric threshold', () => {
    // CPM needs a 25% drop; 55 -> 50 is about 9%.
    expect(dipsFor('cpm', 55, [{ start: 100_000, end: 130_000, value: 50 }])).toEqual([]);
    // Uptime needs 10%; 98% -> 95% is about 3%.
    expect(dipsFor('rem', 0.98, [{ start: 100_000, end: 130_000, value: 0.95 }])).toEqual([]);
  });

  it('returns at most three dips per metric, the deepest ones', () => {
    // Five stretches, every one deep enough to count on its own.
    const stretches = [
      { start: 20_000, end: 35_000, value: 0.3 },
      { start: 70_000, end: 85_000, value: 0.05 },
      { start: 120_000, end: 135_000, value: 0.2 },
      { start: 170_000, end: 185_000, value: 0.1 },
      { start: 220_000, end: 235_000, value: 0.4 },
    ];
    for (const stretch of stretches) {
      expect(dipsFor('kick', 0.95, [stretch])).toHaveLength(1);
    }

    const dips = dipsFor('kick', 0.95, stretches);

    expect(dips).toHaveLength(3);
    // The 0.05, 0.1 and 0.2 stretches; the shallower 0.3 and 0.4 ones are left out.
    const covered = (start: number, end: number) =>
      dips.some((dip) => dip.start - FIGHT_START <= start && dip.end - FIGHT_START >= end);
    expect(covered(70_000, 85_000)).toBe(true);
    expect(covered(170_000, 185_000)).toBe(true);
    expect(covered(120_000, 135_000)).toBe(true);
  });

  it('reports two low points inside one stretch as a single dip', () => {
    const dips = dipsFor('cpm', 60, [
      { start: 100_000, end: 110_000, value: 10 },
      { start: 110_000, end: 118_000, value: 30 },
      { start: 118_000, end: 128_000, value: 10 },
    ]);

    expect(dips).toHaveLength(1);
  });

  it('never overlaps its dips', () => {
    const dips = dipsFor('rem', 0.98, [
      { start: 60_000, end: 80_000, value: 0.6 },
      { start: 95_000, end: 115_000, value: 0.5 },
    ]);

    for (const a of dips) {
      for (const b of dips) {
        if (a !== b) {
          expect(a.start < b.end && a.end > b.start).toBe(false);
        }
      }
    }
  });

  it('does not treat time spent dead as a dip', () => {
    // Dead for 40s: no casts, but there is nothing to judge there.
    expect(dipsFor('cpm', 55, [{ start: 150_000, end: 190_000, value: null }])).toEqual([]);
  });

  it('finds nothing without a baseline', () => {
    const { samples, measure } = buildSeries('cpm', 55, [
      { start: 100_000, end: 120_000, value: 10 },
    ]);
    expect(findDips(samples, 'cpm', null, measure)).toEqual([]);
    expect(findDips(samples, 'cpm', 0, measure)).toEqual([]);
  });
});
