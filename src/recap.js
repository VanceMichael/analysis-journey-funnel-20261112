const percent = value => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);

const signedPoints = value => (value === null ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}`);

const segmentLabel = key => (key === '' ? '（空）' : key);

export function renderRecap(document) {
  const lines = [];
  const entryLabel = document.entry === 'first' ? '首次进入' : '每次重新进入';
  const reuseLabel = document.reuseEvents ? '允许事件复用' : '禁止事件复用';
  lines.push(`复盘：${document.funnel}（截点 ${document.cutoff} 分钟，窗口 ${document.windowMinutes} 分钟，${entryLabel}，${reuseLabel}）`);
  lines.push(`口径：event_id 取最高 revision，仅用截点前收到的事件（排除迟到 ${document.audit.excludedByCutoff} 条、被更正或重复 ${document.audit.superseded} 条）；身份以映射文件生效时间为准。`);
  for (const period of document.periods) {
    const totals = period.segments.reduce((sum, segment) => ({
      started: sum.started + segment.started,
      completed: sum.completed + segment.completed,
      failed: sum.failed + segment.failed,
      open: sum.open + segment.open,
    }), { started: 0, completed: 0, failed: 0, open: 0 });
    const mature = totals.completed + totals.failed;
    const rate = mature === 0 ? null : totals.completed / mature;
    const label = period.name === 'all' ? '全量' : `时期 ${period.name}`;
    lines.push(`${label}：旅程 ${totals.started} 起，完成 ${totals.completed}、未走完 ${totals.failed}、窗口未成熟 ${totals.open}；完成率 ${percent(rate)}（按已成熟旅程计）。`);
    for (const segment of period.segments) {
      const waits = segment.steps.slice(1).map((step, index) => {
        const previous = segment.steps[index].event;
        const p50 = step.wait ? `${step.wait.p50} 分钟` : '—';
        return `${previous}→${step.event} p50 ${p50}`;
      }).join('，');
      lines.push(`  ${document.segmentBy}=${segmentLabel(segment.key)}：${segment.started} 起，完成率 ${percent(segment.completionRate)}；${waits}（分位数仅计完成该段的旅程）。`);
      if (segment.failureReasons.length) {
        const reasons = segment.failureReasons
          .map(reason => `${reason.event} 步${reason.limit === 'gap' ? '超出最大间隔' : '超出窗口'} ${reason.count} 起`)
          .join('；');
        lines.push(`  未匹配原因：${reasons}。`);
      }
    }
  }
  if (document.comparison) {
    lines.push(`两期并排（${document.comparison.a} vs ${document.comparison.b}，仅作描述，不作因果判断）：`);
    for (const segment of document.comparison.segments) {
      lines.push(`  ${document.segmentBy}=${segmentLabel(segment.key)}：完成率 ${percent(segment.a.completionRate)} → ${percent(segment.b.completionRate)}（${signedPoints(segment.delta.completionRate)} 个百分点），完成 ${segment.a.completed} → ${segment.b.completed} 起。`);
    }
  }
  return lines.join('\n');
}
