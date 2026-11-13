import { schema } from './schema.js';
import { fingerprint, validateRecords } from './dataset.js';

const ENTRY_MODES = new Set(['first', 'every']);

export function round6(value) {
  return value === null ? null : Math.round(value * 1e6) / 1e6;
}

export function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const next = sorted[base + 1];
  const value = next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
  return round6(value);
}

function normalizeStep(step, index) {
  const label = `配置 steps[${index}]`;
  if (step === null || typeof step !== 'object' || Array.isArray(step)) throw new Error(`${label} 应为对象`);
  if (typeof step.event !== 'string' || step.event.length === 0) throw new Error(`${label} 的 event 应为非空字符串`);
  const maxGapMinutes = step.maxGapMinutes ?? null;
  if (maxGapMinutes !== null && (!Number.isSafeInteger(maxGapMinutes) || maxGapMinutes <= 0)) {
    throw new Error(`${label} 的 maxGapMinutes 应为正整数分钟`);
  }
  const where = step.where ?? {};
  if (where === null || typeof where !== 'object' || Array.isArray(where)) throw new Error(`${label} 的 where 应为对象`);
  for (const [field, expected] of Object.entries(where)) {
    if (!(field in schema)) throw new Error(`${label} 的 where 引用了未知字段 ${field}`);
    const values = Array.isArray(expected) ? expected : [expected];
    if (values.length === 0 || values.some(item => !['string', 'number', 'boolean'].includes(typeof item))) {
      throw new Error(`${label} 的 where 取值应为标量或标量数组`);
    }
  }
  return { event: step.event, maxGapMinutes, where };
}

function normalizeLinks(links) {
  if (!Array.isArray(links)) throw new Error('配置 identityLinks 应为数组');
  const seen = new Set();
  return links.map((link, index) => {
    const label = `配置 identityLinks[${index}]`;
    if (link === null || typeof link !== 'object' || Array.isArray(link)) throw new Error(`${label} 应为对象`);
    if (typeof link.device !== 'string' || link.device.length === 0) throw new Error(`${label} 的 device 应为非空字符串`);
    if (typeof link.person !== 'string' || link.person.length === 0) throw new Error(`${label} 的 person 应为非空字符串`);
    if (!Number.isSafeInteger(link.effective) || link.effective < 0) throw new Error(`${label} 的 effective 应为非负整数分钟`);
    const key = `${link.device} ${link.effective}`;
    if (seen.has(key)) throw new Error('配置 identityLinks 存在同设备同生效时间冲突');
    seen.add(key);
    return { device: link.device, person: link.person, effective: link.effective };
  });
}

export function normalizePolicy(policy, overrides = {}) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('配置应为对象');
  const funnel = policy.funnel;
  if (funnel === null || typeof funnel !== 'object' || Array.isArray(funnel)) throw new Error('配置缺少 funnel 对象');
  const name = funnel.name ?? '未命名漏斗';
  if (typeof name !== 'string' || name.length === 0) throw new Error('配置 name 应为非空字符串');
  if (!ENTRY_MODES.has(funnel.entry)) throw new Error('配置 entry 应为 first 或 every');
  if (typeof funnel.reuseEvents !== 'boolean') throw new Error('配置 reuseEvents 应明确为布尔值，不得省略');
  if (!Number.isSafeInteger(funnel.windowMinutes) || funnel.windowMinutes <= 0) {
    throw new Error('配置 windowMinutes 应为正整数分钟');
  }
  const segmentBy = funnel.segmentBy ?? 'region';
  if (typeof segmentBy !== 'string' || !(segmentBy in schema)) throw new Error('配置 segmentBy 应为记录字段');
  if (!Array.isArray(funnel.steps) || funnel.steps.length === 0) throw new Error('配置 steps 应为非空数组');
  const steps = funnel.steps.map((step, index) => normalizeStep(step, index));
  const cutoff = overrides.cutoff ?? policy.cutoff;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) throw new Error('配置缺少有效 cutoff，可用 --cutoff 指定非负整数分钟');
  const links = normalizeLinks(policy.identityLinks ?? []);
  return { name, entry: funnel.entry, reuseEvents: funnel.reuseEvents, windowMinutes: funnel.windowMinutes,
    segmentBy, steps, cutoff, links };
}

// 先按截点过滤，再沿 event_id 取最高 revision：截点后才收到的更正不进入当时版本。
export function selectEvents(records, cutoff) {
  const visible = records.filter(record => record.received <= cutoff);
  const byEventId = new Map();
  for (const record of visible) {
    const key = record.event_id.length ? record.event_id : `record:${record.id}`;
    const current = byEventId.get(key);
    if (!current || record.revision > current.revision
      || (record.revision === current.revision && record.id.localeCompare(current.id, 'en') < 0)) {
      byEventId.set(key, record);
    }
  }
  const events = [...byEventId.values()];
  return { events, excludedByCutoff: records.length - visible.length, superseded: visible.length - events.length };
}

// 身份以映射文件生效时间为准：链接尚未生效的设备事件记为匿名，不得被后来的绑定无条件合并。
export function resolveIdentity(record, linksByDevice) {
  const links = linksByDevice.get(record.device);
  if (links) {
    let chosen = null;
    for (const link of links) {
      if (link.effective <= record.time && (!chosen || link.effective > chosen.effective)) chosen = link;
    }
    return chosen ? chosen.person : `anon:${record.device}`;
  }
  return record.person.length ? record.person : `anon:${record.device}`;
}

const byTimeSequenceId = (left, right) => left.time - right.time || left.sequence - right.sequence
  || left.id.localeCompare(right.id, 'en');

function matchesStep(step, event) {
  if (event.event !== step.event) return false;
  return Object.entries(step.where).every(([field, expected]) => {
    const actual = event[field];
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });
}

function matchJourney(identity, sorted, startIndex, config) {
  const start = sorted[startIndex];
  const windowEnd = start.time + config.windowMinutes;
  const matched = [{ step: 0, index: startIndex, event: start.event, eventId: start.event_id, record: start.id, time: start.time }];
  let failure = null;
  let awaiting = null;
  for (let stepIndex = 1; stepIndex < config.steps.length; stepIndex += 1) {
    const step = config.steps[stepIndex];
    const previous = matched[matched.length - 1];
    const gapEnd = step.maxGapMinutes === null ? Infinity : previous.time + step.maxGapMinutes;
    const deadline = Math.min(windowEnd, gapEnd);
    let found = -1;
    for (let index = previous.index + 1; index < sorted.length; index += 1) {
      if (sorted[index].time > deadline) break;
      if (matchesStep(step, sorted[index])) { found = index; break; }
    }
    if (found === -1) {
      const detail = { step: stepIndex, event: step.event, deadline };
      if (deadline <= config.cutoff) failure = { ...detail, limit: gapEnd < windowEnd ? 'gap' : 'window' };
      else awaiting = detail;
      break;
    }
    matched.push({ step: stepIndex, index: found, event: sorted[found].event,
      eventId: sorted[found].event_id, record: sorted[found].id, time: sorted[found].time });
  }
  const waits = matched.slice(1).map((entry, index) => entry.time - matched[index].time);
  const status = failure ? 'failed' : awaiting ? 'open' : 'completed';
  return { identity, segment: String(start[config.segmentBy]), start: start.time, status, matched, waits,
    ...(failure ? { failure } : {}), ...(awaiting ? { awaiting } : {}) };
}

export function buildJourneys(events, config) {
  const linksByDevice = new Map();
  for (const link of config.links) {
    if (!linksByDevice.has(link.device)) linksByDevice.set(link.device, []);
    linksByDevice.get(link.device).push(link);
  }
  const byIdentity = new Map();
  for (const event of events) {
    const identity = resolveIdentity(event, linksByDevice);
    if (!byIdentity.has(identity)) byIdentity.set(identity, []);
    byIdentity.get(identity).push(event);
  }
  const journeys = [];
  for (const identity of [...byIdentity.keys()].sort((left, right) => left.localeCompare(right, 'en'))) {
    const sorted = byIdentity.get(identity).sort(byTimeSequenceId);
    let cursor = 0;
    while (cursor < sorted.length) {
      let startIndex = -1;
      for (let index = cursor; index < sorted.length; index += 1) {
        if (matchesStep(config.steps[0], sorted[index])) { startIndex = index; break; }
      }
      if (startIndex === -1) break;
      const journey = matchJourney(identity, sorted, startIndex, config);
      journeys.push(journey);
      if (config.entry === 'first') break;
      const lastConsumed = journey.matched[journey.matched.length - 1].index;
      cursor = config.reuseEvents ? startIndex + 1 : lastConsumed + 1;
    }
  }
  journeys.sort((left, right) => left.start - right.start || left.identity.localeCompare(right.identity, 'en'));
  return journeys.map(({ matched, ...rest }) => ({
    ...rest,
    matched: matched.map(({ index, ...entry }) => entry),
  }));
}

function summarizeWait(waits) {
  if (waits.length === 0) return null;
  const sorted = [...waits].sort((left, right) => left - right);
  return { n: sorted.length, min: sorted[0], p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9),
    max: sorted[sorted.length - 1] };
}

function summarizeSegment(key, list, config) {
  const started = list.length;
  const completed = list.filter(journey => journey.status === 'completed').length;
  const failed = list.filter(journey => journey.status === 'failed').length;
  const open = started - completed - failed;
  const mature = completed + failed;
  const completionRate = mature === 0 ? null : round6(completed / mature);
  const steps = config.steps.map((step, stepIndex) => {
    const reached = list.filter(journey => journey.matched.length > stepIndex).length;
    if (stepIndex === 0) return { event: step.event, reached };
    // 等待分位数只使用已经完成该段的旅程，未走完与未成熟都不计入。
    const waits = list.filter(journey => journey.matched.length > stepIndex)
      .map(journey => journey.matched[stepIndex].time - journey.matched[stepIndex - 1].time);
    return { event: step.event, reached, wait: summarizeWait(waits) };
  });
  const reasonCounts = new Map();
  for (const journey of list) {
    if (journey.status !== 'failed') continue;
    const key2 = `${journey.failure.step} ${journey.failure.limit}`;
    reasonCounts.set(key2, (reasonCounts.get(key2) ?? 0) + 1);
  }
  const failureReasons = [...reasonCounts.entries()].map(([key2, count]) => {
    const [step, limit] = key2.split(' ');
    return { step: Number(step), event: config.steps[Number(step)].event, limit, count };
  }).sort((left, right) => left.step - right.step || left.limit.localeCompare(right.limit, 'en'));
  return { key, started, completed, failed, open, completionRate, steps, failureReasons, journeys: list };
}

function summarizePeriod(journeys, period, config) {
  const selected = period
    ? journeys.filter(journey => journey.start >= period.from && journey.start < period.to)
    : journeys;
  const segments = new Map();
  for (const journey of selected) {
    if (!segments.has(journey.segment)) segments.set(journey.segment, []);
    segments.get(journey.segment).push(journey);
  }
  const result = [...segments.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, list]) => summarizeSegment(key, list, config));
  return { name: period ? period.name : 'all',
    ...(period ? { from: period.from, to: period.to } : {}), segments: result };
}

function comparePeriods(periodA, periodB, config) {
  const keys = new Set([...periodA.segments.map(segment => segment.key),
    ...periodB.segments.map(segment => segment.key)]);
  const segments = [...keys].sort((left, right) => left.localeCompare(right, 'en')).map(key => {
    const segmentA = periodA.segments.find(segment => segment.key === key);
    const segmentB = periodB.segments.find(segment => segment.key === key);
    const pick = segment => segment
      ? { started: segment.started, completed: segment.completed, failed: segment.failed,
        open: segment.open, completionRate: segment.completionRate }
      : { started: 0, completed: 0, failed: 0, open: 0, completionRate: null };
    const a = pick(segmentA);
    const b = pick(segmentB);
    const steps = config.steps.slice(1).map((step, index) => {
      const waitA = segmentA?.steps[index + 1].wait ?? null;
      const waitB = segmentB?.steps[index + 1].wait ?? null;
      return { event: step.event, waitP50: { a: waitA?.p50 ?? null, b: waitB?.p50 ?? null,
        delta: waitA && waitB ? round6(waitB.p50 - waitA.p50) : null } };
    });
    return { key, a, b, steps, delta: { completed: b.completed - a.completed,
      completionRate: a.completionRate === null || b.completionRate === null
        ? null : round6(b.completionRate - a.completionRate) } };
  });
  return { a: periodA.name, b: periodB.name, note: '两期并排描述，不作因果判断', segments };
}

export function analyze(records, policy, options = {}) {
  validateRecords(records);
  const config = normalizePolicy(policy, { cutoff: options.cutoff });
  const { events, excludedByCutoff, superseded } = selectEvents(records, config.cutoff);
  const journeys = buildJourneys(events, config);
  const periods = (options.periods && options.periods.length ? options.periods : [null])
    .map(period => summarizePeriod(journeys, period, config));
  const comparison = periods.length === 2 ? comparePeriods(periods[0], periods[1], config) : null;
  return {
    command: 'journey',
    funnel: config.name,
    entry: config.entry,
    reuseEvents: config.reuseEvents,
    windowMinutes: config.windowMinutes,
    segmentBy: config.segmentBy,
    cutoff: config.cutoff,
    steps: config.steps,
    configFingerprint: fingerprint(policy),
    audit: { records: records.length, visible: events.length, excludedByCutoff, superseded },
    periods,
    comparison,
  };
}
