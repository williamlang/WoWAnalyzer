import SPELLS from 'common/SPELLS';
import Analyzer, { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import Events, {
  BeginChannelEvent,
  CastEvent,
  FightEndEvent,
  UpdateSpellUsableEvent,
  UpdateSpellUsableType,
} from 'parser/core/Events';
import Abilities from 'parser/core/modules/Abilities';
import DeathTracker from 'parser/shared/modules/DeathTracker';
import { getCurrentRSKTalent } from '../../constants';

/** Width of the rolling window the series are smoothed over, in ms. */
export const DIP_WINDOW_MS = 15000;
/** Time between samples of the rolling series, in ms. */
const SAMPLE_PERIOD_MS = 1000;
/** A window needs at least this much time alive in it to be judged. */
const MIN_ALIVE_IN_WINDOW_MS = 5000;
/** Stretches shown per metric. */
const MAX_DIPS_PER_METRIC = 3;
/** Longest a single dip is allowed to grow on each side of its low point, in ms. */
const MAX_DIP_WIDEN_MS = 60000;

export type DipMetric = 'rem' | 'kick' | 'cpm';

/**
 * How far below the pull's own level a window must fall, relative to that level,
 * before it counts as a dip. CPM is noisier than the cooldown uptimes.
 */
const MIN_DROP: Record<DipMetric, number> = { rem: 0.1, kick: 0.15, cpm: 0.25 };

/** Channels whose `cast` events are ticks; each channel is counted once at its start instead. */
const TICKING_CHANNELS = [SPELLS.CRACKLING_JADE_LIGHTNING.id];

interface Segment {
  start: number;
  end: number;
}

export interface DipSample {
  timestamp: number;
  /** Share of the window Renewing Mist was recharging (had fewer than max charges). */
  rem: number | null;
  /** Share of the window Rising Sun Kick / Rushing Wind Kick was on cooldown. */
  kick: number | null;
  /** Casts per minute over the window. */
  cpm: number | null;
}

export interface PerformanceDip {
  metric: DipMetric;
  start: number;
  end: number;
  /** The metric over the dip. */
  value: number;
  /** The metric over the whole pull. */
  baseline: number;
  /** How far below the baseline, relative to it (0..1). */
  drop: number;
}

/**
 * Finds the stretches of a pull where Renewing Mist uptime, Rising Sun Kick / Rushing Wind
 * Kick uptime or casts per minute fell well below the pull's own level.
 *
 * "Uptime" for these two is the share of time the spell was on cooldown, read from
 * SpellUsable, so it inherits every cooldown reduction the spec already models (Pool of
 * Mists, Heart of the Jade Serpent, empowered kicks). Time spent dead is left out.
 */
class PerformanceDips extends Analyzer {
  static dependencies = {
    abilities: Abilities,
    deathTracker: DeathTracker,
  };

  protected abilities!: Abilities;
  protected deathTracker!: DeathTracker;

  private readonly kickSpellId: number;
  private readonly remCooldown: Segment[] = [];
  private readonly kickCooldown: Segment[] = [];
  private remCooldownStart: number | null = null;
  private kickCooldownStart: number | null = null;
  private readonly castTimestamps: number[] = [];

  private computed: { samples: DipSample[]; dips: PerformanceDip[]; baseline: DipSample } | null =
    null;

  constructor(options: Options) {
    super(options);
    this.kickSpellId = getCurrentRSKTalent(this.selectedCombatant).id;

    this.addEventListener(
      Events.UpdateSpellUsable.by(SELECTED_PLAYER).spell([
        SPELLS.RENEWING_MIST_CAST,
        getCurrentRSKTalent(this.selectedCombatant),
      ]),
      this.onUpdateSpellUsable,
    );
    this.addEventListener(Events.cast.by(SELECTED_PLAYER), this.onCast);
    this.addEventListener(
      Events.BeginChannel.by(SELECTED_PLAYER).spell(SPELLS.CRACKLING_JADE_LIGHTNING),
      this.onTickingChannelStart,
    );
    this.addEventListener(Events.fightend, this.onFightEnd);
  }

  get dips(): PerformanceDip[] {
    return this.compute().dips;
  }

  /** Each metric over the whole pull, excluding time spent dead. */
  get baseline(): DipSample {
    return this.compute().baseline;
  }

  private onUpdateSpellUsable(event: UpdateSpellUsableEvent) {
    const isRem = event.ability.guid === SPELLS.RENEWING_MIST_CAST.id;
    const segments = isRem ? this.remCooldown : this.kickCooldown;
    const open = isRem ? this.remCooldownStart : this.kickCooldownStart;

    if (event.updateType === UpdateSpellUsableType.BeginCooldown && open === null) {
      this.setOpen(isRem, event.timestamp);
    } else if (event.updateType === UpdateSpellUsableType.EndCooldown && open !== null) {
      segments.push({ start: open, end: event.timestamp });
      this.setOpen(isRem, null);
    }
  }

  private setOpen(isRem: boolean, timestamp: number | null) {
    if (isRem) {
      this.remCooldownStart = timestamp;
    } else {
      this.kickCooldownStart = timestamp;
    }
  }

  private onCast(event: CastEvent) {
    const spellId = event.ability.guid;
    // Only real button presses: spells in the spellbook, and not channel ticks.
    if (TICKING_CHANNELS.includes(spellId) || !this.abilities.getAbility(spellId)) {
      return;
    }
    this.castTimestamps.push(event.timestamp);
  }

  private onTickingChannelStart(event: BeginChannelEvent) {
    this.castTimestamps.push(event.timestamp);
  }

  private onFightEnd(event: FightEndEvent) {
    if (this.remCooldownStart !== null) {
      this.remCooldown.push({ start: this.remCooldownStart, end: event.timestamp });
    }
    if (this.kickCooldownStart !== null) {
      this.kickCooldown.push({ start: this.kickCooldownStart, end: event.timestamp });
    }
  }

  private get deadSegments(): Segment[] {
    const { deaths, resurrections } = this.deathTracker;
    return deaths.map((death) => ({
      start: death.timestamp,
      end:
        resurrections.find((res) => res.timestamp > death.timestamp)?.timestamp ??
        this.owner.fight.end_time,
    }));
  }

  private compute() {
    if (this.computed) {
      return this.computed;
    }
    const fightStart = this.owner.fight.start_time;
    const fightEnd = this.owner.fight.end_time;
    const dead = this.deadSegments;

    const measure = (start: number, end: number): DipSample => {
      const alive = end - start - overlap(dead, start, end);
      if (alive < Math.min(MIN_ALIVE_IN_WINDOW_MS, end - start)) {
        return { timestamp: (start + end) / 2, rem: null, kick: null, cpm: null };
      }
      const casts = this.castTimestamps.filter(
        (ts) => ts >= start && ts < end && !inSegments(dead, ts),
      ).length;
      return {
        timestamp: (start + end) / 2,
        rem: aliveOverlap(this.remCooldown, dead, start, end) / alive,
        kick: aliveOverlap(this.kickCooldown, dead, start, end) / alive,
        cpm: casts / (alive / 60000),
      };
    };

    const samples: DipSample[] = [];
    for (let t = fightStart; t <= fightEnd; t += SAMPLE_PERIOD_MS) {
      const start = Math.max(fightStart, t - DIP_WINDOW_MS / 2);
      const end = Math.min(fightEnd, t + DIP_WINDOW_MS / 2);
      samples.push({ ...measure(start, end), timestamp: t });
    }

    const baseline = measure(fightStart, fightEnd);
    const dips = (['rem', 'kick', 'cpm'] as DipMetric[]).flatMap((metric) =>
      findDips(samples, metric, baseline[metric], measure),
    );
    dips.sort((a, b) => b.drop - a.drop);

    this.computed = { samples, dips, baseline };
    return this.computed;
  }
}

/**
 * Picks the lowest non-overlapping windows that sit at least MIN_DROP below the baseline,
 * then widens each while the rolling value stays low, and re-measures it over that span.
 */
function findDips(
  samples: DipSample[],
  metric: DipMetric,
  baseline: number | null,
  measure: (start: number, end: number) => DipSample,
): PerformanceDip[] {
  if (!baseline || baseline <= 0) {
    return [];
  }
  const valueAt = (i: number) => samples[i]?.[metric] ?? null;
  const candidates = samples
    .map((sample, index) => ({ index, value: sample[metric] }))
    .filter((c): c is { index: number; value: number } => c.value !== null)
    .filter((c) => (baseline - c.value) / baseline >= MIN_DROP[metric])
    .sort((a, b) => a.value - b.value);

  const threshold = baseline * (1 - MIN_DROP[metric] / 2);
  const isLow = (i: number) => {
    const v = valueAt(i);
    return v !== null && v < threshold;
  };
  const maxWiden = MAX_DIP_WIDEN_MS / SAMPLE_PERIOD_MS;

  const dips: PerformanceDip[] = [];
  for (const candidate of candidates) {
    if (dips.length >= MAX_DIPS_PER_METRIC) {
      break;
    }
    let first = candidate.index;
    let last = candidate.index;
    while (first > 0 && isLow(first - 1) && candidate.index - first < maxWiden) {
      first -= 1;
    }
    while (last < samples.length - 1 && isLow(last + 1) && last - candidate.index < maxWiden) {
      last += 1;
    }
    const fightStart = samples[0].timestamp;
    const fightEnd = samples[samples.length - 1].timestamp;
    const start = Math.max(fightStart, samples[first].timestamp - DIP_WINDOW_MS / 2);
    const end = Math.min(fightEnd, samples[last].timestamp + DIP_WINDOW_MS / 2);
    // Two low points inside one stretch widen into the same window; keep it once.
    if (dips.some((dip) => start < dip.end && end > dip.start)) {
      continue;
    }
    const value = measure(start, end)[metric];
    if (value === null) {
      continue;
    }
    const drop = (baseline - value) / baseline;
    // Widening can pull a sharp dip back toward the average; drop the ones that no longer read as a dip.
    if (drop < MIN_DROP[metric] * 0.6) {
      continue;
    }
    dips.push({ metric, start, end, value, baseline, drop });
  }
  return dips;
}

function overlap(segments: Segment[], start: number, end: number): number {
  let total = 0;
  for (const segment of segments) {
    total += Math.max(0, Math.min(end, segment.end) - Math.max(start, segment.start));
  }
  return total;
}

/** Time inside `segments` within [start, end), not counting time inside `dead`. */
function aliveOverlap(segments: Segment[], dead: Segment[], start: number, end: number): number {
  let total = 0;
  for (const segment of segments) {
    const s = Math.max(start, segment.start);
    const e = Math.min(end, segment.end);
    if (e > s) {
      total += e - s - overlap(dead, s, e);
    }
  }
  return total;
}

function inSegments(segments: Segment[], timestamp: number): boolean {
  return segments.some((segment) => timestamp >= segment.start && timestamp < segment.end);
}

export default PerformanceDips;
