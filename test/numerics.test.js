import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('事件时间与收到时间分离，最近事件不取文件末行', () => {

  assert.equal(probe([{time: 100, received: 101}, {time: 20, received: 200}]).latestTime, 100);
  assert.equal(probe([{time: 0}]).latestTime, 0);
});
