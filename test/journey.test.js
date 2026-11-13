import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyze, buildJourneys, normalizePolicy, resolveIdentity, selectEvents } from '../src/journey.js';
import { renderRecap } from '../src/recap.js';
import { parseArguments } from '../src/cli.js';

const data = JSON.parse(await readFile('data/records.json', 'utf8'));
const policy = JSON.parse(await readFile('data/policy.json', 'utf8'));
const examplePolicy = JSON.parse(await readFile('data/examples/policy.json', 'utf8'));
const example = async name => JSON.parse(await readFile(`data/examples/${name}.json`, 'utf8')).records;

const inlinePolicy = (funnelOverrides = {}) => ({
  funnel: {
    name: '测试漏斗',
    entry: 'every',
    reuseEvents: false,
    windowMinutes: 1440,
    segmentBy: 'region',
    steps: [{ event: 'open' }, { event: 'checkout', maxGapMinutes: 60 }, { event: 'paid' }],
    ...funnelOverrides,
  },
  cutoff: 3000,
  identityLinks: [],
});

let sequence = 0;
const row = patch => {
  sequence += 1;
  return {
    event_id: `evt-${sequence}`, person: 'q0', device: 'dq', event: 'open', time: 0,
    received: 2, sequence: 0, revision: 1, region: 'west', id: `t-${sequence}`, ...patch,
  };
};

test('主数据：24 起旅程全部完成，分区与等待分位数可复核', () => {
  const document = analyze(data.records, policy);
  assert.deepEqual(document.audit, { records: 96, visible: 96, excludedByCutoff: 0, superseded: 0 });
  assert.equal(document.periods.length, 1);
  const [period] = document.periods;
  assert.equal(period.name, 'all');
  for (const key of ['west', 'east']) {
    const segment = period.segments.find(item => item.key === key);
    assert.equal(segment.started, 12);
    assert.equal(segment.completed, 12);
    assert.equal(segment.failed, 0);
    assert.equal(segment.open, 0);
    assert.equal(segment.completionRate, 1);
    assert.deepEqual(segment.steps[0], { event: 'open', reached: 12 });
    assert.deepEqual(segment.steps[1].wait, { n: 12, min: 8, p50: 8, p90: 8, max: 8 });
    assert.deepEqual(segment.steps[2].wait, { n: 12, min: 16, p50: 16, p90: 16, max: 16 });
    assert.equal(segment.journeys.length, 12);
  }
});

test('旅程核算不依赖记录排列顺序', () => {
  assert.deepEqual(analyze(data.records, policy), analyze([...data.records].reverse(), policy));
});

test('事件更正沿 event_id 取最高 revision，重复导入不增加人数', () => {
  const records = [
    row({ id: 'c1', event_id: 'ce1', event: 'open', time: 100, received: 102, sequence: 0 }),
    row({ id: 'c2', event_id: 'ce2', event: 'checkout', time: 9999, received: 103, sequence: 1, revision: 1 }),
    row({ id: 'c3', event_id: 'ce2', event: 'checkout', time: 120, received: 104, sequence: 1, revision: 2 }),
    row({ id: 'c4', event_id: 'ce3', event: 'paid', time: 140, received: 105, sequence: 2 }),
    row({ id: 'c5', event_id: 'ce3', event: 'paid', time: 140, received: 106, sequence: 2 }),
  ];
  const document = analyze(records, inlinePolicy());
  assert.equal(document.audit.records, 5);
  assert.equal(document.audit.visible, 3);
  assert.equal(document.audit.superseded, 2);
  const segment = document.periods[0].segments[0];
  assert.equal(segment.started, 1);
  assert.equal(segment.completed, 1);
  assert.deepEqual(segment.journeys[0].matched.map(entry => entry.record), ['c1', 'c3', 'c4']);
});

test('重复起点：每次重新进入给出两段旅程，首次进入只保留第一段', async () => {
  const records = await example('repeated-start');
  const every = analyze(records, examplePolicy);
  const segment = every.periods[0].segments[0];
  assert.equal(segment.started, 2);
  assert.equal(segment.completed, 1);
  assert.equal(segment.failed, 1);
  assert.equal(segment.completionRate, 0.5);
  assert.deepEqual(segment.journeys.map(journey => journey.status), ['failed', 'completed']);
  assert.deepEqual(segment.journeys[0].failure, { step: 1, event: 'checkout', deadline: 60, limit: 'gap' });
  assert.deepEqual(segment.journeys[1].waits, [20, 20]);
  assert.deepEqual(segment.failureReasons, [{ step: 1, event: 'checkout', limit: 'gap', count: 1 }]);
  const first = analyze(records, { ...examplePolicy, funnel: { ...examplePolicy.funnel, entry: 'first' } });
  assert.equal(first.periods[0].segments[0].started, 1);
  assert.equal(first.periods[0].segments[0].journeys[0].status, 'failed');
});

test('跨日支付：窗口内隔天付款仍属同一段旅程', async () => {
  const records = await example('cross-day');
  const segment = analyze(records, examplePolicy).periods[0].segments[0];
  assert.equal(segment.key, 'east');
  assert.equal(segment.completed, 1);
  assert.deepEqual(segment.journeys[0].waits, [30, 70]);
  assert.deepEqual(segment.journeys[0].matched.map(entry => entry.time), [1400, 1430, 1500]);
});

test('身份延迟绑定：未生效链接不得合并过去的匿名旅程', async () => {
  const records = await example('late-binding');
  const document = analyze(records, examplePolicy);
  const segment = document.periods[0].segments[0];
  assert.equal(segment.started, 1);
  assert.equal(segment.completed, 0);
  assert.equal(segment.failed, 1);
  const [journey] = segment.journeys;
  assert.equal(journey.identity, 'anon:d90');
  assert.deepEqual(journey.failure, { step: 2, event: 'paid', deadline: 1540, limit: 'window' });
  // p90 的 paid 事件不单独成旅程，也不回灌匿名段。
  assert.ok(!segment.journeys.some(item => item.identity === 'p90'));
});

test('同刻多事件：按 sequence 稳定排序，等待可为 0', async () => {
  const records = await example('same-time');
  const segment = analyze(records, examplePolicy).periods[0].segments[0];
  assert.equal(segment.completed, 1);
  const [journey] = segment.journeys;
  assert.deepEqual(journey.matched.map(entry => entry.eventId), ['st-e1', 'st-e2', 'st-e4']);
  assert.deepEqual(journey.waits, [0, 10]);
});

test('未成熟旅程与截点版本：截点后收到的事件不进入当时版本', async () => {
  const records = await example('immature');
  const early = analyze(records, examplePolicy, { cutoff: 2000 });
  assert.equal(early.audit.excludedByCutoff, 1);
  const west = early.periods[0].segments.find(segment => segment.key === 'west');
  const east = early.periods[0].segments.find(segment => segment.key === 'east');
  assert.equal(west.open, 1);
  assert.equal(west.failed, 0);
  assert.equal(west.completionRate, null);
  assert.deepEqual(west.journeys[0].awaiting, { step: 2, event: 'paid', deadline: 3340 });
  assert.equal(east.failed, 1);
  assert.equal(east.completionRate, 0);
  assert.deepEqual(west.steps[1].wait, { n: 1, min: 20, p50: 20, p90: 20, max: 20 });
  assert.equal(west.steps[2].wait, null);
  const late = analyze(records, examplePolicy, { cutoff: 3000 });
  const lateWest = late.periods[0].segments.find(segment => segment.key === 'west');
  assert.equal(lateWest.completed, 1);
  assert.deepEqual(lateWest.journeys[0].waits, [20, 10]);
});

test('事件复用开关决定重叠旅程能否复用事件', () => {
  const records = [
    row({ id: 'r1', event_id: 'e1', event: 'open', time: 0, sequence: 0 }),
    row({ id: 'r2', event_id: 'e2', event: 'open', time: 10, received: 12, sequence: 1 }),
    row({ id: 'r3', event_id: 'e3', event: 'checkout', time: 20, received: 22, sequence: 2 }),
    row({ id: 'r4', event_id: 'e4', event: 'paid', time: 30, received: 32, sequence: 3 }),
  ];
  const strict = analyze(records, inlinePolicy());
  assert.equal(strict.periods[0].segments[0].started, 1);
  const reuse = analyze(records, inlinePolicy({ reuseEvents: true }));
  const segment = reuse.periods[0].segments[0];
  assert.equal(segment.started, 2);
  assert.deepEqual(segment.journeys.map(journey => journey.start), [0, 10]);
  assert.ok(segment.journeys.every(journey => journey.status === 'completed'));
});

test('步骤属性谓词过滤起点', () => {
  const records = [
    row({ id: 'w1', event_id: 'we1', event: 'open', time: 0, region: 'east' }),
    row({ id: 'w2', event_id: 'we2', event: 'open', time: 10, received: 12, sequence: 1, region: 'west' }),
    row({ id: 'w3', event_id: 'we3', event: 'checkout', time: 20, received: 22, sequence: 2 }),
    row({ id: 'w4', event_id: 'we4', event: 'paid', time: 30, received: 32, sequence: 3 }),
  ];
  const policyWithWhere = inlinePolicy({ steps: [
    { event: 'open', where: { region: 'west' } },
    { event: 'checkout', maxGapMinutes: 60 },
    { event: 'paid' },
  ] });
  const segment = analyze(records, policyWithWhere).periods[0].segments[0];
  assert.equal(segment.started, 1);
  assert.equal(segment.journeys[0].start, 10);
  assert.equal(segment.key, 'west');
});

test('等待分位数只计入完成该段的旅程', () => {
  const records = [
    row({ id: 'q1', event_id: 'qe1', person: 'qa', event: 'open', time: 0 }),
    row({ id: 'q2', event_id: 'qe2', person: 'qa', event: 'checkout', time: 10, received: 12, sequence: 1 }),
    row({ id: 'q3', event_id: 'qe3', person: 'qb', event: 'open', time: 100, received: 102 }),
    row({ id: 'q4', event_id: 'qe4', person: 'qb', event: 'checkout', time: 130, received: 132, sequence: 1 }),
    row({ id: 'q5', event_id: 'qe5', person: 'qb', event: 'paid', time: 140, received: 142, sequence: 2 }),
  ];
  const segment = analyze(records, inlinePolicy()).periods[0].segments[0];
  assert.equal(segment.started, 2);
  assert.equal(segment.completed, 1);
  assert.equal(segment.failed, 1);
  assert.deepEqual(segment.steps[1].wait, { n: 2, min: 10, p50: 20, p90: 28, max: 30 });
  assert.deepEqual(segment.steps[2].wait, { n: 1, min: 10, p50: 10, p90: 10, max: 10 });
});

test('同一配置两期并排比较，不作因果判断', () => {
  const document = analyze(data.records, policy, {
    periods: [
      { from: 0, to: 1200, name: '0:1200' },
      { from: 1200, to: 2400, name: '1200:2400' },
    ],
  });
  assert.equal(document.periods.length, 2);
  for (const period of document.periods) {
    assert.equal(period.segments.length, 2);
    for (const segment of period.segments) assert.equal(segment.completed, 6);
  }
  const comparison = document.comparison;
  assert.equal(comparison.a, '0:1200');
  assert.equal(comparison.b, '1200:2400');
  assert.match(comparison.note, /不作因果判断/);
  for (const segment of comparison.segments) {
    assert.equal(segment.delta.completed, 0);
    assert.equal(segment.delta.completionRate, 0);
    assert.deepEqual(segment.steps.map(step => step.waitP50.delta), [0, 0]);
  }
  const recap = renderRecap(document);
  assert.match(recap, /复盘：/);
  assert.match(recap, /两期并排/);
  assert.match(recap, /不作因果判断/);
});

test('身份解析：映射文件生效时间为准', () => {
  const links = new Map([['d1', [
    { device: 'd1', person: 'p1', effective: 10 },
    { device: 'd1', person: 'p2', effective: 40 },
  ]]]);
  assert.equal(resolveIdentity({ device: 'd1', person: 'other', time: 50 }, links), 'p2');
  assert.equal(resolveIdentity({ device: 'd1', person: 'other', time: 30 }, links), 'p1');
  assert.equal(resolveIdentity({ device: 'd1', person: 'p1', time: 5 }, links), 'anon:d1');
  assert.equal(resolveIdentity({ device: 'd9', person: 'p9', time: 0 }, links), 'p9');
  assert.equal(resolveIdentity({ device: 'd9', person: '', time: 0 }, links), 'anon:d9');
});

test('配置校验拒绝缺漏与冲突', () => {
  assert.throws(() => normalizePolicy({}), /配置/);
  assert.throws(() => normalizePolicy({ funnel: { entry: 'every', reuseEvents: false, windowMinutes: 10 }, cutoff: 1 }), /配置/);
  assert.throws(() => normalizePolicy({ ...inlinePolicy(), funnel: { ...inlinePolicy().funnel, entry: 'sometimes' } }), /配置/);
  assert.throws(() => normalizePolicy({ ...inlinePolicy(), funnel: { ...inlinePolicy().funnel, reuseEvents: undefined } }), /配置/);
  assert.throws(() => normalizePolicy({ ...inlinePolicy(), funnel: { ...inlinePolicy().funnel, windowMinutes: 0 } }), /配置/);
  assert.throws(() => normalizePolicy(inlinePolicy({ steps: [{ event: 'open', where: { nope: 1 } }] })), /配置/);
  assert.throws(() => normalizePolicy({ funnel: inlinePolicy().funnel, identityLinks: [] }), /配置/);
  assert.throws(() => normalizePolicy({ ...inlinePolicy(), identityLinks: [
    { device: 'd1', person: 'p1', effective: 0 },
    { device: 'd1', person: 'p2', effective: 0 },
  ] }), /配置/);
});

test('journey 命令参数解析', () => {
  const parsed = parseArguments(['journey', '--period', '0:10', '--period', '10:20', '--cutoff', '30']);
  assert.equal(parsed.periods.length, 2);
  assert.equal(parsed.cutoff, 30);
  assert.throws(() => parseArguments(['journey', '--period', '0:10', '--period', '10:20', '--period', '20:30']), /参数/);
  assert.throws(() => parseArguments(['journey', '--period', '10:10']), /参数/);
  assert.throws(() => parseArguments(['journey', '--cutoff', 'abc']), /参数/);
  assert.throws(() => parseArguments(['summary', '--config', 'x']), /参数/);
});

test('journey 命令端到端：机器结果落盘并输出中文复盘', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'journey-'));
  try {
    const out = join(folder, 'journey.json');
    const recap = join(folder, 'recap.md');
    const run = spawnSync(process.execPath, ['src/cli.js', 'journey', '--out', out, '--recap', recap,
      '--period', '0:1200', '--period', '1200:2400'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), JSON.parse(await readFile(out, 'utf8')));
    const text = await readFile(recap, 'utf8');
    assert.match(text, /复盘：促销结算旅程/);
    assert.match(text, /两期并排/);
    const bad = spawnSync(process.execPath, ['src/cli.js', 'journey', '--cutoff', '-1'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    const broken = join(folder, 'broken.json');
    await writeFile(broken, JSON.stringify({ funnel: { entry: 'every' } }));
    const failed = spawnSync(process.execPath, ['src/cli.js', 'journey', '--config', broken], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /配置/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
