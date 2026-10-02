'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// 独立临时库
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-handover-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const { app } = require('../server.js');
const dbMod = require('../src/db');

let server;
let base;

function request(method, urlPath, body) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = '';
});
after(async () => {
  await new Promise((r) => server.close(r));
});

let seedSeq = 0;
async function resetDraft() {
  const doReq = (opts, payload) =>
    new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, ...opts }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d || 'null')));
      });
      if (payload) req.write(JSON.stringify(payload));
      req.end();
    });
  const cues = await doReq({ method: 'GET', path: '/api/cues' });
  for (const c of cues) await request('DELETE', `/api/cues/${c.id}`);
  const lights = await doReq({ method: 'GET', path: '/api/lights' });
  for (const l of lights) await request('DELETE', `/api/lights/${l.id}`);
}

async function seedVersion() {
  const n = ++seedSeq;
  await resetDraft();
  await request('POST', '/api/lights', { name: `交接面光${n}a` });
  const lights = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/lights' }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    });
  });
  const l1 = lights[lights.length - 1].id;
  await request('POST', '/api/cues', [
    { cue_no: 5000 + n, light_id: l1, time: 0, target: 100, duration: 10 },
  ]);
  const v = await request('POST', '/api/versions', { label: `交接首演${n}` });
  return v.json;
}

async function setupRoom(opts = {}) {
  const v = await seedVersion();
  const r = await request('POST', '/api/rooms', { version_id: v.id, ...opts });
  assert.equal(r.status, 201);
  return r.json;
}

const issue = (code, body) => request('POST', `/api/rooms/${code}/handover/issue`, body);
const claim = (code, body) => request('POST', `/api/rooms/${code}/handover/claim`, body);
const control = (code, body) => request('POST', `/api/rooms/${code}/control`, body);

test('发起交接：缺密钥/错密钥 403、缺修订号 400、房间码与房间不存在校验', async () => {
  const room = await setupRoom();

  let r = await issue(room.code, { revision: 0 });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /缺少控制密钥/);

  r = await issue(room.code, { control_key: 'deadbeef'.repeat(6), revision: 0 });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /控制密钥无效/);

  r = await issue(room.code, { control_key: room.control_key });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /必须携带房间修订号/);

  r = await issue(room.code, { control_key: room.control_key, revision: -1 });
  assert.equal(r.status, 400);

  r = await issue('ab', { control_key: room.control_key, revision: 0 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /房间码无效/);

  r = await issue('ZZZZZZ', { control_key: room.control_key, revision: 0 });
  assert.equal(r.status, 404);

  // 被拒绝的发起不改变控制权与修订号
  const g = await request('GET', `/api/rooms/${room.code}`);
  assert.equal(g.json.revision, 0);
  assert.deepEqual(g.json.handover, { pending: false });
});

test('发起交接成功：凭证 48 位十六进制仅返回一次，房间状态不含凭证', async () => {
  const room = await setupRoom();
  const r = await issue(room.code, { control_key: room.control_key, revision: 0 });
  assert.equal(r.status, 201);
  assert.match(r.json.handover_token, /^[0-9a-f]{48}$/);
  assert.equal(r.json.handover_token_expires_in_seconds, 300);
  assert.ok(Math.abs(r.json.handover_token_expires_at - (r.json.server_wall + 300)) < 1);
  assert.equal(r.json.handover.pending, true);
  assert.equal(r.json.handover.revision, 0);
  assert.ok(r.json.handover.expires_in_seconds > 299 && r.json.handover.expires_in_seconds <= 300);
  // 状态块与顶层都不回显控制密钥
  assert.equal(r.json.control_key, undefined);

  // GET 只报告状态：没有凭证明文，也没有控制密钥
  const g = await request('GET', `/api/rooms/${room.code}`);
  assert.equal(g.json.handover.pending, true);
  assert.equal(g.json.handover.handover_token, undefined);
  assert.equal(g.json.handover_token, undefined);
  assert.equal(g.json.control_key, undefined);
  assert.equal(typeof g.json.handover.expires_at, 'number');
});

test('同一房间同时只保留一份待领取凭证：再次发起使旧凭证失效', async () => {
  const room = await setupRoom();
  const i1 = await issue(room.code, { control_key: room.control_key, revision: 0 });
  const t1 = i1.json.handover_token;

  // 发起交接不增加房间修订号，故主持人仍可凭同一修订号再次发起
  const i2 = await issue(room.code, { control_key: room.control_key, revision: 0 });
  assert.equal(i2.status, 201);
  const t2 = i2.json.handover_token;
  assert.notEqual(t1, t2);

  // 旧凭证领取失败：没有（被替换的）待领取凭证可对应——按错误凭证拒绝
  let r = await claim(room.code, { handover_token: t1 });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /交接凭证无效/);
  assert.equal(r.json.control_key, undefined); // 错误响应绝不回显新密钥

  // 新凭证可正常领取
  r = await claim(room.code, { handover_token: t2 });
  assert.equal(r.status, 200);
});

test('领取成功：原子轮换密钥并修订号 +1，旧密钥即刻失效，新密钥可控制', async () => {
  const room = await setupRoom();
  const i = await issue(room.code, { control_key: room.control_key, revision: 0 });
  const r = await claim(room.code, { handover_token: i.json.handover_token });
  assert.equal(r.status, 200);
  const newKey = r.json.control_key;
  assert.match(newKey, /^[0-9a-f]{48}$/);
  assert.notEqual(newKey, room.control_key);
  assert.equal(r.json.revision, 1);
  assert.deepEqual(r.json.handover, { pending: false });

  // 旧密钥即刻失效：用旧密钥控制被 403 拒绝
  let c = await control(room.code, { control_key: room.control_key, revision: 1, action: 'play' });
  assert.equal(c.status, 403);

  // 新密钥可控制（修订号已为 1）
  c = await control(room.code, { control_key: newKey, revision: 1, action: 'play' });
  assert.equal(c.status, 200);
  assert.equal(c.json.playing, true);
});

test('领取为一次性：重复领取（重试）404 且不回显新密钥', async () => {
  const room = await setupRoom();
  const i = await issue(room.code, { control_key: room.control_key, revision: 0 });
  const first = await claim(room.code, { handover_token: i.json.handover_token });
  assert.equal(first.status, 200);

  const retry = await claim(room.code, { handover_token: i.json.handover_token });
  assert.equal(retry.status, 404);
  assert.match(retry.json.error, /没有待领取的交接凭证/);
  assert.equal(retry.json.control_key, undefined);
});

test('并发领取：至多一人成功，其余无新密钥回显', async () => {
  const room = await setupRoom();
  const i = await issue(room.code, { control_key: room.control_key, revision: 0 });
  const token = i.json.handover_token;

  // 用独立连接并发发起 8 个相同领取
  const doClaim = () =>
    new Promise((resolve) => {
      const payload = JSON.stringify({ handover_token: token });
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: `/api/rooms/${room.code}/handover/claim`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ status: res.statusCode, body: d }));
        }
      );
      req.write(payload);
      req.end();
    });
  const results = await Promise.all(Array.from({ length: 8 }, doClaim));
  const oks = results.filter((x) => x.status === 200);
  assert.equal(oks.length, 1, `应恰有一次领取成功，实际 ${oks.length}`);
  // 成功响应彼此应为同一个新密钥（只有一人拿到），失败响应都不含密钥
  const newKeys = oks.map((x) => JSON.parse(x.body).control_key);
  assert.equal(new Set(newKeys).size, 1);
  for (const x of results.filter((y) => y.status !== 200)) {
    assert.equal(x.body.includes('control_key'), false);
  }

  const g = await request('GET', `/api/rooms/${room.code}`);
  assert.equal(g.json.revision, 1); // 只递增一次
});

test('凭证发出后原主持人成功控制房间：凭证立即作废，接班人领取 409', async () => {
  const room = await setupRoom();
  const i = await issue(room.code, { control_key: room.control_key, revision: 0 });

  // 主持人成功播放一次（修订号 0 -> 1）
  const c = await control(room.code, { control_key: room.control_key, revision: 0, action: 'play' });
  assert.equal(c.status, 200);
  assert.equal(c.json.handover.pending, false); // 控制响应显示凭证已作废

  // 接班人凭原凭证领取：409 已作废
  const r = await claim(room.code, { handover_token: i.json.handover_token });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /凭证已作废/);
  assert.equal(r.json.control_key, undefined);

  // 控制权仍在原主持人手里（修订号 1 的暂停可用原密钥）
  const pause = await control(room.code, { control_key: room.control_key, revision: 1, action: 'pause' });
  assert.equal(pause.status, 200);

  // 过期/作废后须重新索取：基于新修订号再次发起，新凭证可领取
  const i2 = await issue(room.code, { control_key: room.control_key, revision: 2 });
  assert.equal(i2.status, 201);
  const r2 = await claim(room.code, { handover_token: i2.json.handover_token });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.revision, 3);
});

test('发起交接携带过期修订号：409 拒绝，不改控制权且不影响既有凭证', async () => {
  const room = await setupRoom();
  // 先把修订号推到 1（播放）
  await control(room.code, { control_key: room.control_key, revision: 0, action: 'play' });

  const bad = await issue(room.code, { control_key: room.control_key, revision: 0 });
  assert.equal(bad.status, 409);
  assert.match(bad.json.error, /修订号冲突/);

  // 主持人控制权与播放状态不变
  const g = await request('GET', `/api/rooms/${room.code}`);
  assert.equal(g.json.playing, true);
  assert.equal(g.json.revision, 1);
  assert.deepEqual(g.json.handover, { pending: false });

  // 正确修订号 1 仍可发起
  const ok = await issue(room.code, { control_key: room.control_key, revision: 1 });
  assert.equal(ok.status, 201);
});

test('交接不重置播放时码、速度、固定版本与超载保护状态', async () => {
  const room = await setupRoom({ overload_protection: true });
  // 跳到 4 秒、0.5 倍速、暂停态
  await control(room.code, { control_key: room.control_key, revision: 0, action: 'seek', time: 4 });
  await control(room.code, { control_key: room.control_key, revision: 1, action: 'speed', speed: 0.5 });
  assert.equal((await request('GET', `/api/rooms/${room.code}`)).json.revision, 2);

  const i = await issue(room.code, { control_key: room.control_key, revision: 2 });
  const r = await claim(room.code, { handover_token: i.json.handover_token });
  assert.equal(r.status, 200);

  // 时码/速度/版本/保护开关全部原样保留
  assert.ok(Math.abs(r.json.time - 4) < 1e-6, `time=${r.json.time}`);
  assert.equal(r.json.speed, 0.5);
  assert.equal(r.json.playing, false);
  assert.equal(r.json.version.id, room.version.id);
  assert.equal(r.json.protection.enabled, true);
  assert.equal(r.json.revision, 3); // 只有领取带来一次 +1
});

test('领取鉴权：缺凭证 403、错误凭证 403（不消耗真凭证、不回显密钥）', async () => {
  const room = await setupRoom();
  const i = await issue(room.code, { control_key: room.control_key, revision: 0 });

  let r = await claim(room.code, {});
  assert.equal(r.status, 403);
  assert.match(r.json.error, /缺少交接凭证/);

  r = await claim(room.code, { handover_token: '0'.repeat(48) });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /交接凭证无效/);
  assert.equal(r.json.control_key, undefined);

  // 错误尝试没有消耗真凭证：正确凭证仍能领取
  r = await claim(room.code, { handover_token: i.json.handover_token });
  assert.equal(r.status, 200);
});

test('从未发起交接时领取：404', async () => {
  const room = await setupRoom();
  const r = await claim(room.code, { handover_token: 'a'.repeat(48) });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /没有待领取的交接凭证/);
});

test('过期凭证：数据库层置为过期后领取被明确拒绝（400），控制权与修订号不变', async () => {
  const room = await setupRoom();
  const i = await issue(room.code, { control_key: room.control_key, revision: 0 });

  // 直接把待领取凭证改为已过期（模拟五分钟过去），不经过房间控制
  const db = dbMod.get();
  db.prepare('UPDATE room_handovers SET expires_at = ? WHERE room_id = (SELECT id FROM rooms WHERE code = ?)')
    .run(Date.now() / 1000 - 1, room.code);

  const r = await claim(room.code, { handover_token: i.json.handover_token });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /交接凭证已过期/);
  assert.equal(r.json.control_key, undefined);

  // 控制权仍是原主持人、修订号未变；凭证已被清理，观看状态无待领取
  const c = await control(room.code, { control_key: room.control_key, revision: 0, action: 'pause' });
  assert.equal(c.status, 200);
  const g = await request('GET', `/api/rooms/${room.code}`);
  assert.equal(g.json.revision, 1);
  assert.deepEqual(g.json.handover, { pending: false });
});

test('过期凭证在房间状态查询时惰性清理为无待领取', async () => {
  const room = await setupRoom();
  await issue(room.code, { control_key: room.control_key, revision: 0 });
  const db = dbMod.get();
  db.prepare('UPDATE room_handovers SET expires_at = ? WHERE room_id = (SELECT id FROM rooms WHERE code = ?)')
    .run(Date.now() / 1000 - 10, room.code);

  const g = await request('GET', `/api/rooms/${room.code}`);
  assert.deepEqual(g.json.handover, { pending: false });
});

test('交接全流程不泄露：观看者视角的房间状态始终只有 handover.pending，无任何凭证/密钥', async () => {
  const room = await setupRoom();
  await issue(room.code, { control_key: room.control_key, revision: 0 });

  const g = await request('GET', `/api/rooms/${room.code}`);
  const serialized = JSON.stringify(g.json);
  assert.equal(g.json.control_key, undefined);
  assert.equal(g.json.handover_token, undefined);
  assert.equal(g.json.handover.handover_token, undefined);
  assert.equal(g.json.handover.control_key, undefined);
  // 任意 48 位十六进制串都不应出现在观看响应里
  assert.equal(/[0-9a-f]{48}/.test(serialized), false);
});
