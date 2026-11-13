import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { analyze } from './journey.js';
import { renderRecap } from './recap.js';
import { writeResult, writeText } from './output.js';

const COMMANDS = new Set(['summary', 'inspect', 'journey']);
const COMMON_OPTIONS = new Set(['--input', '--out']);
const JOURNEY_OPTIONS = new Set(['--config', '--recap', '--cutoff', '--period']);

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!COMMANDS.has(command)) throw new Error('命令应为 summary、inspect 或 journey');
  const result = { command, input: 'data/records.json' };
  const allowed = command === 'journey' ? new Set([...COMMON_OPTIONS, ...JOURNEY_OPTIONS]) : COMMON_OPTIONS;
  const hint = command === 'journey'
    ? '参数应为 --input、--out、--config、--recap、--cutoff、--period 后接取值'
    : '参数应为 --input 路径 或 --out 路径';
  const periods = [];
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!allowed.has(name) || !value || value.startsWith('--')) throw new Error(hint);
    if (name === '--period') {
      const parts = value.split(':');
      const [from, to] = parts.map(Number);
      if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])
        || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) {
        throw new Error('参数 --period 应为 起始:结束（非负整数分钟，起始小于结束）');
      }
      periods.push({ from, to, name: `${from}:${to}` });
      if (periods.length > 2) throw new Error('参数 --period 最多指定两期');
      continue;
    }
    if (name === '--cutoff') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('参数 --cutoff 应为非负整数分钟');
      }
      if (result.cutoff !== undefined) throw new Error('参数不可重复');
      result.cutoff = Number(value);
      continue;
    }
    if (result[name.slice(2)] && name !== '--input') throw new Error('参数不可重复');
    result[name.slice(2)] = value;
  }
  if (periods.length) result.periods = periods;
  return result;
}

export async function main(args) {
  const options = parseArguments(args);
  const dataset = await loadDataset(options.input);
  if (options.command === 'journey') {
    const policy = JSON.parse(await readFile(options.config ?? 'data/policy.json', 'utf8'));
    const document = { ...analyze(dataset.records, policy, { cutoff: options.cutoff, periods: options.periods }),
      inputFingerprint: dataset.fingerprint };
    const recap = renderRecap(document);
    if (options.recap) await writeText(options.recap, recap);
    else process.stderr.write(`${recap}\n`);
    if (options.out) await writeResult(options.out, document);
    return document;
  }
  const result = options.command === 'summary' ? summarize(dataset.records)
    : { records: dataset.records.length, fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [] };
  const document = { ...result, inputFingerprint: dataset.fingerprint };
  if (options.out) await writeResult(options.out, document);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
