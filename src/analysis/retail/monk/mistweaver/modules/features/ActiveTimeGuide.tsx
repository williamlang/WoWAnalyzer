import { formatDuration, formatNumber, formatPercentage } from 'common/format';
import SPELLS from 'common/SPELLS';
import { TALENTS_MONK } from 'common/TALENTS';
import { SpellLink } from 'interface';
import { qualitativePerformanceToColor, SubSection, useAnalyzer, useInfo } from 'interface/guide';
import GuideDataWrapper, {
  StatCard,
  StatCardDivider,
  StatCardLabel,
  StatCardValue,
  StatsRow,
} from 'interface/guide/components/GuideDataWrapper';
import ActiveTimeGraph, { ActiveTimeHighlight } from 'parser/ui/ActiveTimeGraph';
import { getCurrentRSKTalent, getSelectedPrimaryHeal } from '../../constants';
import AlwaysBeCasting from './AlwaysBeCasting';
import PerformanceDips, { DIP_WINDOW_MS, DipMetric, PerformanceDip } from './PerformanceDips';

const DIP_COLORS: Record<DipMetric, string> = {
  rem: '#4caf50',
  kick: '#c5b0d5',
  cpm: '#42a5f5',
};

function formatDipValue(metric: DipMetric, value: number) {
  return metric === 'cpm' ? formatNumber(value) : `${formatPercentage(value, 1)}%`;
}

export default function ActiveTimeGuide() {
  const info = useInfo();
  const alwaysBeCasting = useAnalyzer(AlwaysBeCasting);
  const performanceDips = useAnalyzer(PerformanceDips);

  if (!info || !alwaysBeCasting || !performanceDips) {
    return null;
  }

  const activeTimeColor = qualitativePerformanceToColor(alwaysBeCasting.DowntimePerformance);
  const kickSpell = getCurrentRSKTalent(info.combatant);
  const metricName: Record<DipMetric, string> = {
    rem: `${SPELLS.RENEWING_MIST_CAST.name} uptime`,
    kick: `${kickSpell.name} uptime`,
    cpm: 'CPM',
  };
  const describeDip = (dip: PerformanceDip) =>
    `${metricName[dip.metric]} ${formatDipValue(dip.metric, dip.value)} vs ${formatDipValue(dip.metric, dip.baseline)} for the pull`;
  const { baseline, dips } = performanceDips;
  const highlights: ActiveTimeHighlight[] = dips.map((dip) => ({
    start: dip.start,
    end: dip.end,
    label: describeDip(dip),
    color: DIP_COLORS[dip.metric],
  }));

  return (
    <SubSection>
      <p>
        <strong>Active Time Graph</strong> - this graph shows how much of the fight you spent
        casting or inside of a global cooldown. Mistweaver is a high APM spec, so every second spent
        idle is potential healing lost. Fill movement with instant casts like{' '}
        <SpellLink spell={SPELLS.RENEWING_MIST_CAST} /> and{' '}
        <SpellLink spell={getCurrentRSKTalent(info.combatant)} />, or make use of{' '}
        <SpellLink spell={TALENTS_MONK.SOOTHING_MIST_TALENT} /> to cast{' '}
        <SpellLink spell={getSelectedPrimaryHeal(info.combatant)} /> and{' '}
        <SpellLink spell={TALENTS_MONK.ENVELOPING_MIST_TALENT} /> while on the move. Dipping during
        downtime is ok, but globals should still be used with <i>anything</i> rather than{' '}
        <i>nothing</i>.
      </p>
      <p>
        Shaded stretches mark where <SpellLink spell={SPELLS.RENEWING_MIST_CAST} /> uptime,{' '}
        <SpellLink spell={kickSpell} /> uptime or casts per minute fell well below their own average
        for this pull, over a rolling {DIP_WINDOW_MS / 1000} second window. Uptime here is the share
        of time the spell was on cooldown rather than sitting ready. These are the moments worth
        reviewing in a recording of the pull.
      </p>
      <GuideDataWrapper
        title="Timeline"
        bare
        stats={
          <StatsRow>
            <StatCard color={activeTimeColor}>
              <StatCardValue color={activeTimeColor}>
                {formatPercentage(alwaysBeCasting.activeTimePercentage, 1)}%
              </StatCardValue>
              <StatCardDivider color={activeTimeColor} />
              <StatCardLabel>Active Time</StatCardLabel>
            </StatCard>
            {(['rem', 'kick', 'cpm'] as DipMetric[]).map((metric) => {
              const value = baseline[metric];
              return (
                <StatCard key={metric} color={DIP_COLORS[metric]}>
                  <StatCardValue color={DIP_COLORS[metric]}>
                    {value === null ? '-' : formatDipValue(metric, value)}
                  </StatCardValue>
                  <StatCardDivider color={DIP_COLORS[metric]} />
                  <StatCardLabel>{metricName[metric]}</StatCardLabel>
                </StatCard>
              );
            })}
          </StatsRow>
        }
      >
        <ActiveTimeGraph
          activeTimeSegments={alwaysBeCasting.activeTimeSegments}
          fightStart={info.fightStart}
          fightEnd={info.fightEnd}
          highlights={highlights}
        />
        {dips.length > 0 && (
          <ul style={{ marginTop: '1.5em' }}>
            {dips.map((dip) => (
              <li key={`${dip.metric}-${dip.start}`}>
                <strong style={{ color: DIP_COLORS[dip.metric] }}>
                  {formatDuration(dip.start - info.fightStart)} -{' '}
                  {formatDuration(dip.end - info.fightStart)}
                </strong>
                : {describeDip(dip)} ({formatPercentage(dip.drop, 0)}% lower)
              </li>
            ))}
          </ul>
        )}
      </GuideDataWrapper>
    </SubSection>
  );
}
