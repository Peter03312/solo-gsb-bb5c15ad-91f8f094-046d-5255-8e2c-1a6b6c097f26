'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { open, get } = require('./src/db');
const Engine = require('./public/engine');
const Merge = require('./src/merge');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');

open(DB_PATH);
const db = get();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------- 校验工具 ------------------------------- */

const NAME_RE = /\S/;

// 严格数字转换：数字、数字字符串通过；NaN/Infinity/其他类型一律拒绝
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '' && v.trim() !== '-') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function toPosInt(v) {
  const n = toNum(v);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

// 正实数：容量、额定瓦数
function toPosNum(v) {
  const n = toNum(v);
  return typeof n === 'number' && n > 0 ? n : NaN;
}

/**
 * 校验一条 Cue 的可写字段。
 * 返回 { value: {cue_no?, light_id, time, target, duration} } 或 { error }。
 */
function validateCue(input, { allowCueNo = true, existingId = null } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Cue 必须是一个对象' };
  }

  // 灯具编号
  const lightId = toPosInt(input.light_id);
  if (Number.isNaN(lightId)) {
    return { error: `灯具编号无效：${JSON.stringify(input.light_id)}（须为已存在的灯具编号）` };
  }
  const light = db.prepare('SELECT id FROM lights WHERE id = ?').get(lightId);
  if (!light) {
    return { error: `未知灯具：编号 ${lightId} 不存在` };
  }

  // 触发时码：非负演出秒数
  const time = toNum(input.time);
  if (Number.isNaN(time)) {
    return { error: `非法时码：${JSON.stringify(input.time)}（须为数字）` };
  }
  if (time < 0) {
    return { error: `非法时码：${time}（不得为负）` };
  }

  // 目标亮度 0～100
  const target = toNum(input.target);
  if (Number.isNaN(target)) {
    return { error: `无效亮度：${JSON.stringify(input.target)}（须为数字）` };
  }
  if (target < 0 || target > 100) {
    return { error: `无效亮度：${target}（须在 0～100 之间）` };
  }

  // 渐变时长：非负秒数
  const duration = toNum(input.duration);
  if (Number.isNaN(duration)) {
    return { error: `非法渐变时长：${JSON.stringify(input.duration)}（须为数字）` };
  }
  if (duration < 0) {
    return { error: `非法渐变时长：${duration}（不得为负）` };
  }

  const value = { light_id: lightId, time, target, duration };

  // Cue 编号可选（不传则自动分配）
  if (input.cue_no !== undefined && input.cue_no !== null && input.cue_no !== '') {
    if (!allowCueNo) return { error: '不允许指定 Cue 编号' };
    const cueNo = toPosInt(input.cue_no);
    if (Number.isNaN(cueNo)) {
      return { error: `非法 Cue 编号：${JSON.stringify(input.cue_no)}（须为正整数）` };
    }
    const dup = db
      .prepare('SELECT id FROM cues WHERE cue_no = ? AND id IS NOT ?')
      .get(cueNo, existingId);
    if (dup) {
      return { error: `Cue 编号 ${cueNo} 已被占用（同秒触发按编号顺序生效，编号须唯一）` };
    }
    value.cue_no = cueNo;
  }

  return { value };
}

function err(res, code, message) {
  return res.status(code).json({ error: message });
}

function readCue(row) {
  return {
    id: row.id,
    cue_no: row.cue_no,
    light_id: row.light_id,
    light_name: row.light_name,
    time: row.time,
    target: row.target,
    duration: row.duration,
  };
}

const cueSelect = `
  SELECT c.id, c.cue_no, c.light_id, l.name AS light_name,
         c.time, c.target, c.duration
  FROM cues c JOIN lights l ON l.id = c.light_id
  ORDER BY c.time ASC, c.cue_no ASC
`;

/* -------------------------------- 灯具 -------------------------------- */

app.get('/api/lights', (req, res) => {
  res.json(db.prepare('SELECT * FROM lights ORDER BY id ASC').all());
});

app.post('/api/lights', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!NAME_RE.test(name)) return err(res, 400, '灯具名称不能为空');

  try {
    const info = db
      .prepare('INSERT INTO lights (name, created_at) VALUES (?, ?)')
      .run(name, Date.now() / 1000);
    res.status(201).json(db.prepare('SELECT * FROM lights WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return err(res, 409, `灯具名称已存在：${name}`);
    throw e;
  }
});

app.delete('/api/lights/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const light = db.prepare('SELECT * FROM lights WHERE id = ?').get(id);
  if (!light) return err(res, 404, `灯具 ${id} 不存在`);

  const used = db.prepare('SELECT COUNT(*) AS n FROM cues WHERE light_id = ?').get(id).n;
  if (used > 0) {
    return err(res, 409, `灯具 ${light.name} 仍被 ${used} 条草稿 Cue 引用，请先删除这些 Cue`);
  }
  db.prepare('DELETE FROM lights WHERE id = ?').run(id);
  res.status(204).end();
});

/* ------------------------------- 灯光回路 ------------------------------ */
// 草稿期配置：回路有正数容量（瓦）；灯具可分配到某回路并登记正数额定瓦数。
// 未分配回路（circuit_id 为空）的灯具不计入任何回路负载。
// 全部写接口逐条严格校验，单条请求为一个事务，非法即拒绝、不部分保存。

const circuitSelect = `
SELECT c.id, c.name, c.capacity, c.created_at,
       (SELECT COUNT(*) FROM lights l WHERE l.circuit_id = c.id) AS light_count
FROM circuits c ORDER BY c.id ASC
`;

function readCircuit(row) {
  return {
    id: row.id,
    name: row.name,
    capacity: row.capacity,
    light_count: row.light_count,
    created_at: row.created_at,
  };
}

function getCircuit(id) {
  return db
    .prepare(
      `SELECT c.id, c.name, c.capacity, c.created_at,
              (SELECT COUNT(*) FROM lights l WHERE l.circuit_id = c.id) AS light_count
       FROM circuits c WHERE c.id = ?`
    )
    .get(id);
}

app.get('/api/circuits', (req, res) => {
  res.json(db.prepare(circuitSelect).all().map(readCircuit));
});

app.post('/api/circuits', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!NAME_RE.test(name)) return err(res, 400, '回路名称不能为空');

  const capacity = toPosNum(req.body?.capacity);
  if (Number.isNaN(capacity)) {
    return err(res, 400, `无效容量：${JSON.stringify(req.body?.capacity)}（须为正数瓦数）`);
  }

  try {
    const info = db
      .prepare('INSERT INTO circuits (name, capacity, created_at) VALUES (?, ?, ?)')
      .run(name, capacity, Date.now() / 1000);
    res.status(201).json(readCircuit(getCircuit(info.lastInsertRowid)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return err(res, 409, `回路名称已存在：${name}`);
    throw e;
  }
});

app.patch('/api/circuits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM circuits WHERE id = ?').get(id);
  if (!row) return err(res, 404, `回路 ${id} 不存在`);

  const body = req.body || {};
  const merged = {
    name: 'name' in body ? body.name : row.name,
    capacity: 'capacity' in body ? body.capacity : row.capacity,
  };
  const name = typeof merged.name === 'string' ? merged.name.trim() : '';
  if (!NAME_RE.test(name)) return err(res, 400, '回路名称不能为空');
  const capacity = toPosNum(merged.capacity);
  if (Number.isNaN(capacity)) {
    return err(res, 400, `无效容量：${JSON.stringify(merged.capacity)}（须为正数瓦数）`);
  }

  try {
    db.prepare('UPDATE circuits SET name = ?, capacity = ? WHERE id = ?').run(name, capacity, id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return err(res, 409, `回路名称已存在：${name}`);
    throw e;
  }
  res.json(readCircuit(getCircuit(id)));
});

app.delete('/api/circuits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM circuits WHERE id = ?').get(id);
  if (!row) return err(res, 404, `回路 ${id} 不存在`);

  const n = db.prepare('SELECT COUNT(*) AS n FROM lights WHERE circuit_id = ?').get(id).n;
  if (n > 0) {
    return err(
      res,
      409,
      `回路 ${row.name} 下仍有 ${n} 盏灯，请先把这些灯改投其他回路或取消分配后再删除`
    );
  }
  db.prepare('DELETE FROM circuits WHERE id = ?').run(id);
  res.status(204).end();
});

// 灯具接线：设置所属回路与正数额定瓦数；circuit_id 传 null/空 表示取消分配（瓦数一并清空）
app.put('/api/lights/:id/wiring', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const light = db.prepare('SELECT * FROM lights WHERE id = ?').get(id);
  if (!light) return err(res, 404, `灯具 ${id} 不存在`);

  const body = req.body || {};
  const rawCircuit = body.circuit_id;
  const unassign = rawCircuit === null || rawCircuit === undefined || rawCircuit === '';

  let circuitId = null;
  if (!unassign) {
    circuitId = toPosInt(rawCircuit);
    if (Number.isNaN(circuitId)) {
      return err(res, 400, `无效回路引用：${JSON.stringify(rawCircuit)}（须为已存在回路编号，或 null 取消分配）`);
    }
    const circuit = db.prepare('SELECT id FROM circuits WHERE id = ?').get(circuitId);
    if (!circuit) return err(res, 400, `回路引用不存在：编号 ${circuitId} 尚未建立`);
  }

  let watts = null;
  if (!unassign) {
    watts = toPosNum(body.watts);
    if (Number.isNaN(watts)) {
      return err(res, 400, `无效额定瓦数：${JSON.stringify(body.watts)}（灯具已分配回路时须为正数额定瓦数）`);
    }
  } else if (body.watts !== undefined && body.watts !== null && body.watts !== '') {
    return err(res, 400, '未分配回路的灯具不能设置额定瓦数（不计入任何回路负载）');
  }

  db.prepare('UPDATE lights SET circuit_id = ?, watts = ? WHERE id = ?').run(circuitId, watts, id);
  res.json(db.prepare('SELECT * FROM lights WHERE id = ?').get(id));
});

/* ------------------------------- 草稿 Cue ------------------------------ */

app.get('/api/cues', (req, res) => {
  res.json(db.prepare(cueSelect).all().map(readCue));
});

// 新增：接受单条对象，或数组（批量提交；任一条非法则整次拒绝、全部不落库）
app.post('/api/cues', (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [req.body];
  if (rows.length === 0) return err(res, 400, '提交内容为空');

  const parsed = [];
  for (let i = 0; i < rows.length; i++) {
    const prefix = Array.isArray(req.body) ? `第 ${i + 1} 行：` : '';
    const r = validateCue(rows[i]);
    if (r.error) return err(res, 400, prefix + r.error);
    parsed.push(r.value);
  }

  // 已有编号（库内 + 本批显式指定）都要在自动分配时避开
  const used = new Set(db.prepare('SELECT cue_no FROM cues').all().map((r) => r.cue_no));
  let nextNo = (used.size ? Math.max(...used) : 0) + 1;
  for (const v of parsed) {
    if (v.cue_no !== undefined) {
      if (used.has(v.cue_no)) {
        return err(res, 409, `Cue 编号 ${v.cue_no} 冲突，本次提交已全部撤销`);
      }
      used.add(v.cue_no);
    }
  }
  for (const v of parsed) {
    if (v.cue_no === undefined) {
      while (used.has(nextNo)) nextNo++;
      v.cue_no = nextNo;
      used.add(nextNo);
      nextNo++;
    }
  }

  const insert = db.prepare(
    'INSERT INTO cues (cue_no, light_id, time, target, duration) VALUES (?, ?, ?, ?, ?)'
  );
  const tx = db.transaction((items) => {
    for (const v of items) insert.run(v.cue_no, v.light_id, v.time, v.target, v.duration);
  });
  try {
    tx(parsed);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return err(res, 409, 'Cue 编号冲突，本次提交已全部撤销');
    }
    throw e;
  }

  const created = db.prepare(cueSelect).all().map(readCue);
  res.status(201).json(created);
});

// 修改草稿 Cue
app.patch('/api/cues/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM cues WHERE id = ?').get(id);
  if (!row) return err(res, 404, `Cue ${id} 不存在`);

  const merged = {
    cue_no: 'cue_no' in req.body ? req.body.cue_no : row.cue_no,
    light_id: 'light_id' in req.body ? req.body.light_id : row.light_id,
    time: 'time' in req.body ? req.body.time : row.time,
    target: 'target' in req.body ? req.body.target : row.target,
    duration: 'duration' in req.body ? req.body.duration : row.duration,
  };
  const r = validateCue(merged, { existingId: id });
  if (r.error) return err(res, 400, r.error);
  const v = r.value;

  db.prepare(
    'UPDATE cues SET cue_no = ?, light_id = ?, time = ?, target = ?, duration = ? WHERE id = ?'
  ).run(v.cue_no, v.light_id, v.time, v.target, v.duration, id);

  res.json(db.prepare(cueSelect).all().map(readCue));
});

app.delete('/api/cues/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM cues WHERE id = ?').get(id);
  if (!row) return err(res, 404, `Cue ${id} 不存在`);
  db.prepare('DELETE FROM cues WHERE id = ?').run(id);
  res.status(204).end();
});

/* --------------------------- 发布不可变版本 ---------------------------- */

function loadVersionSnapshot(versionId) {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId);
  if (!version) return null;
  const lights = db
    .prepare('SELECT light_id AS id, name FROM version_lights WHERE version_id = ? ORDER BY pos')
    .all(versionId);
  const cues = db
    .prepare(
      `SELECT cue_no, light_id, time, target, duration
       FROM version_cues WHERE version_id = ? ORDER BY time, cue_no`
    )
    .all(versionId);
  // 回路配置随发布冻结；无回路表数据的早期版本返回空集（播放照常，不产生回路负载）
  const circuits = db
    .prepare(
      `SELECT circuit_id AS id, name, capacity
       FROM version_circuits WHERE version_id = ? ORDER BY pos`
    )
    .all(versionId);
  const wiring = db
    .prepare(
      `SELECT light_id, circuit_id, watts
       FROM version_light_wiring WHERE version_id = ?`
    )
    .all(versionId);
  return {
    id: version.id,
    label: version.label,
    created_at: version.created_at,
    cue_count: version.cue_count,
    lights,
    cues,
    circuits,
    wiring,
  };
}

app.post('/api/versions', (req, res) => {
  const labelRaw = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const label = labelRaw || `演出版本 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;

  const lights = db.prepare('SELECT * FROM lights ORDER BY id').all();
  const cues = db
    .prepare(
      `SELECT cue_no, light_id, time, target, duration
       FROM cues ORDER BY time, cue_no`
    )
    .all();
  const circuits = db.prepare('SELECT * FROM circuits ORDER BY id').all();

  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO versions (label, created_at, cue_count) VALUES (?, ?, ?)')
      .run(label, Date.now() / 1000, cues.length);
    const vid = info.lastInsertRowid;
    const insL = db.prepare(
      'INSERT INTO version_lights (version_id, light_id, name, pos) VALUES (?, ?, ?, ?)'
    );
    lights.forEach((l, i) => insL.run(vid, l.id, l.name, i));
    const insC = db.prepare(
      'INSERT INTO version_cues (version_id, cue_no, light_id, time, target, duration, pos) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    cues.forEach((c, i) =>
      insC.run(vid, c.cue_no, c.light_id, c.time, c.target, c.duration, i)
    );
    // 回路与接线（灯具的所属回路 + 额定瓦数）随版本一并冻结
    const insCircuit = db.prepare(
      'INSERT INTO version_circuits (version_id, circuit_id, name, capacity, pos) VALUES (?, ?, ?, ?, ?)'
    );
    circuits.forEach((c, i) => insCircuit.run(vid, c.id, c.name, c.capacity, i));
    const insWiring = db.prepare(
      'INSERT INTO version_light_wiring (version_id, light_id, circuit_id, watts) VALUES (?, ?, ?, ?)'
    );
    lights.forEach((l) => insWiring.run(vid, l.id, l.circuit_id, l.watts));
    return vid;
  });

  const vid = tx();
  res.status(201).json(loadVersionSnapshot(vid));
});

app.get('/api/versions', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT v.id, v.label, v.created_at, v.cue_count,
                (SELECT COUNT(*) FROM version_circuits vc WHERE vc.version_id = v.id) AS circuit_count
         FROM versions v ORDER BY id DESC`
      )
      .all()
  );
});

app.get('/api/versions/:id', (req, res) => {
  const snap = loadVersionSnapshot(parseInt(req.params.id, 10));
  if (!snap) return err(res, 404, '版本不存在');
  res.json(snap);
});

/* --------------------------- 两版亮度差比对 ---------------------------- */
// 只读已发布快照：不触碰草稿 Cue/灯具，也不影响任何播放会话。
// GET（query，方便直接调用/分享链接）与 POST（JSON body）均支持，同一套校验。

function round6(n) {
  const r = Math.round(n * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

function handleCompare(req, res) {
  const input = { ...req.query, ...(req.body || {}) };

  // 版本编号：正整数且必须存在（相同版本可与自身比较）
  const ids = {};
  for (const key of ['a', 'b']) {
    const field = `version_${key}`;
    const id = toPosInt(input[field]);
    if (Number.isNaN(id)) {
      return err(res, 400, `版本编号无效：${JSON.stringify(input[field])}（须为正整数）`);
    }
    ids[key] = id;
  }
  const snapA = loadVersionSnapshot(ids.a);
  if (!snapA) return err(res, 404, `版本不存在：#${ids.a}`);
  const snapB = ids.b === ids.a ? snapA : loadVersionSnapshot(ids.b);
  if (!snapB) return err(res, 404, `版本不存在：#${ids.b}`);

  // 时窗起止 / 查看时刻：非负数字
  const nums = {};
  const numFields = { start: '时窗起点', end: '时窗终点', at: '查看时刻' };
  for (const field of ['start', 'end', 'at']) {
    const n = toNum(input[field]);
    if (Number.isNaN(n)) {
      return err(res, 400, `${numFields[field]}无效：${JSON.stringify(input[field])}（须为非负数字秒数）`);
    }
    if (n < 0) {
      return err(res, 400, `${numFields[field]}无效：${n}（不得为负）`);
    }
    nums[field] = n;
  }
  if (nums.start > nums.end) {
    return err(res, 400, `时窗起点（${nums.start}）不能大于终点（${nums.end}）`);
  }
  if (nums.at < nums.start || nums.at > nums.end) {
    return err(
      res,
      400,
      `查看时刻 ${nums.at} 超出时窗 [${nums.start}, ${nums.end}]`
    );
  }

  // 亮度差阈值：0～100
  const threshold = toNum(input.threshold);
  if (Number.isNaN(threshold)) {
    return err(res, 400, `亮度差阈值无效：${JSON.stringify(input.threshold)}（须为 0～100 的数字）`);
  }
  if (threshold < 0 || threshold > 100) {
    return err(res, 400, `亮度差阈值越界：${threshold}（须在 0～100 之间）`);
  }

  const cuesA = Engine.prepareCues(snapA.cues);
  const cuesB = Engine.prepareCues(snapB.cues);
  const mapA = new Map(snapA.lights.map((l) => [l.id, l.name]));
  const mapB = new Map(snapB.lights.map((l) => [l.id, l.name]));
  const commonIds = [...mapA.keys()].filter((id) => mapB.has(id)).sort((x, y) => x - y);

  const levels = [];
  const intervals = [];
  for (const id of commonIds) {
    const va = Engine.brightnessAt(cuesA, id, nums.at);
    const vb = Engine.brightnessAt(cuesB, id, nums.at);
    const diff = Math.abs(va - vb);
    levels.push({
      light_id: id,
      name: mapA.get(id),
      brightness_a: round6(va),
      brightness_b: round6(vb),
      difference: round6(diff),
      exceeds: diff > threshold + 1e-9,
    });
    // 零长度时窗：只返回该时刻亮度，不产生任何区间
    const segs =
      nums.end > nums.start
        ? Engine.differenceIntervals(cuesA, cuesB, id, nums.start, nums.end, threshold)
        : [];
    if (segs.length > 0) intervals.push({ light_id: id, name: mapA.get(id), intervals: segs });
  }

  // 配置差异：仅在一版存在的灯具单列；缺失不等于熄灭，不参与逐灯亮度比较
  const onlyA = [...mapA.keys()]
    .filter((id) => !mapB.has(id))
    .sort((x, y) => x - y)
    .map((id) => ({ light_id: id, name: mapA.get(id) }));
  const onlyB = [...mapB.keys()]
    .filter((id) => !mapA.has(id))
    .sort((x, y) => x - y)
    .map((id) => ({ light_id: id, name: mapB.get(id) }));

  res.json({
    versions: {
      a: { id: snapA.id, label: snapA.label },
      b: { id: snapB.id, label: snapB.label },
    },
    window: { start: nums.start, end: nums.end },
    at: nums.at,
    threshold,
    levels,
    intervals,
    config_differences: { only_in_a: onlyA, only_in_b: onlyB },
  });
}

app.get('/api/compare', handleCompare);
app.post('/api/compare', handleCompare);

/* ------------------------- 临时调光记录（覆盖/归还） ------------------------- */
// 记录绑定已发布版本快照：原版 Cue 始终取快照在后台运行，草稿修改与新版本发布均不影响既有记录。
// 每次追加成功 revision + 1；提交须携带当前修订号，过期返回 409 且整次提交不写入。

function loadRecordMeta(recordId) {
  return db
    .prepare(
      `SELECT r.id, r.version_id, r.label, r.created_at, r.revision,
              v.label AS version_label
       FROM rehearsal_records r JOIN versions v ON v.id = r.version_id
       WHERE r.id = ?`
    )
    .get(recordId);
}

function loadRecordOps(recordId) {
  return db
    .prepare(
      `SELECT seq, light_id, time, op_type, target, duration
       FROM record_ops WHERE record_id = ? ORDER BY seq ASC`
    )
    .all(recordId);
}

function readRecordOp(row) {
  return {
    seq: row.seq,
    light_id: row.light_id,
    time: row.time,
    op_type: row.op_type,
    target: row.target,
    duration: row.duration,
  };
}

app.post('/api/records', (req, res) => {
  const versionId = toPosInt(req.body?.version_id);
  if (Number.isNaN(versionId)) {
    return err(res, 400, `版本编号无效：${JSON.stringify(req.body?.version_id)}（须为已发布版本的正整数编号）`);
  }
  const version = db.prepare('SELECT id FROM versions WHERE id = ?').get(versionId);
  if (!version) return err(res, 404, `版本不存在：#${versionId}，无法为其建立调光记录`);

  const labelRaw = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const label = labelRaw || `临时调光记录 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;

  const info = db
    .prepare('INSERT INTO rehearsal_records (version_id, label, created_at, revision) VALUES (?, ?, ?, 0)')
    .run(versionId, label, Date.now() / 1000);

  res.status(201).json(loadRecordDetail(info.lastInsertRowid));
});

// 记录完整内容（元数据 + 操作序列 + 绑定的版本快照）：刷新/跳转后前端据此重算
function loadRecordDetail(recordId, res) {
  const meta = loadRecordMeta(recordId);
  if (!meta) {
    if (res) return err(res, 404, `调光记录 ${recordId} 不存在`);
    return null;
  }
  const snap = loadVersionSnapshot(meta.version_id);
  return {
    id: meta.id,
    label: meta.label,
    created_at: meta.created_at,
    revision: meta.revision,
    version: { id: snap.id, label: snap.label, cue_count: snap.cue_count },
    lights: snap.lights,
    cues: snap.cues,
    ops: loadRecordOps(recordId).map(readRecordOp),
  };
}

app.get('/api/records', (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.id, r.version_id, r.label, r.created_at, r.revision,
              v.label AS version_label,
              (SELECT COUNT(*) FROM record_ops o WHERE o.record_id = r.id) AS op_count
       FROM rehearsal_records r JOIN versions v ON v.id = r.version_id
       ORDER BY r.id DESC`
    )
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      version_id: r.version_id,
      version_label: r.version_label,
      label: r.label,
      created_at: r.created_at,
      revision: r.revision,
      op_count: r.op_count,
    }))
  );
});

app.get('/api/records/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const detail = loadRecordDetail(id, res);
  if (detail) res.json(detail);
});

app.delete('/api/records/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const meta = db.prepare('SELECT id FROM rehearsal_records WHERE id = ?').get(id);
  if (!meta) return err(res, 404, `调光记录 ${id} 不存在`);
  db.prepare('DELETE FROM rehearsal_records WHERE id = ?').run(id); // 操作级联删除
  res.status(204).end();
});

/**
 * 校验一条调光操作。snapshotLightIds 为绑定版本快照中的灯具编号集合。
 * 返回 { value } 或 { error }。
 */
function validateRecordOp(input, snapshotLightIds) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: '操作必须是一个对象' };
  }

  const lightId = toPosInt(input.light_id);
  if (Number.isNaN(lightId)) {
    return { error: `灯具编号无效：${JSON.stringify(input.light_id)}（须为正整数）` };
  }
  if (!snapshotLightIds.has(lightId)) {
    return { error: `灯具 #${lightId} 不在绑定的版本快照中（仅可操作该版本发布时存在的灯具）` };
  }

  const time = toNum(input.time);
  if (Number.isNaN(time)) {
    return { error: `非法时码：${JSON.stringify(input.time)}（须为非负数字秒数）` };
  }
  if (time < 0) return { error: `非法时码：${time}（不得为负）` };

  const opType = input.op_type;
  if (opType !== 'override' && opType !== 'return') {
    return { error: `非法操作类型：${JSON.stringify(opType)}（须为 "override" 覆盖 或 "return" 归还）` };
  }

  const duration = toNum(input.duration);
  if (Number.isNaN(duration)) {
    return { error: `非法时长：${JSON.stringify(input.duration)}（须为非负数字秒数）` };
  }
  if (duration < 0) return { error: `非法时长：${duration}（不得为负）` };

  const value = { light_id: lightId, time, op_type: opType, duration, target: null };

  if (opType === 'override') {
    const target = toNum(input.target);
    if (Number.isNaN(target)) {
      return { error: `覆盖操作缺少有效目标亮度：${JSON.stringify(input.target)}（须为 0～100 的数字）` };
    }
    if (target < 0 || target > 100) {
      return { error: `覆盖目标亮度越界：${target}（须在 0～100 之间）` };
    }
    value.target = target;
  } else if (input.target !== undefined && input.target !== null) {
    return { error: '归还操作不接受目标亮度（只需时码与时长，结束后完全跟随原版）' };
  }

  return { value };
}

// 追加操作：接受单条对象或数组（整批一次提交，任一非法则整批不写入）
app.post('/api/records/:id/ops', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const meta = db.prepare('SELECT * FROM rehearsal_records WHERE id = ?').get(id);
  if (!meta) return err(res, 404, `调光记录 ${id} 不存在`);

  // 修订号：必须携带且与当前一致
  if (req.body === null || typeof req.body !== 'object' || !('revision' in req.body)) {
    return err(res, 400, '提交必须携带记录修订号 revision（与服务器当前修订号一致才允许追加）');
  }
  const clientRev = toNum(req.body.revision);
  if (!Number.isInteger(clientRev) || clientRev < 0) {
    return err(res, 400, `修订号无效：${JSON.stringify(req.body.revision)}（须为非负整数）`);
  }
  if (clientRev !== meta.revision) {
    return err(
      res,
      409,
      `修订号冲突：提交基于修订号 ${clientRev}，记录当前已为修订号 ${meta.revision}；请刷新操作序列后重试（本次未写入）`
    );
  }

  const rows = Array.isArray(req.body.ops) ? req.body.ops : [req.body.op !== undefined ? req.body.op : null];
  if (!Array.isArray(req.body.ops) && req.body.op === undefined) {
    return err(res, 400, '提交缺少操作内容：请提供单个 op 对象或 ops 数组');
  }
  if (rows.length === 0) return err(res, 400, '操作数组为空，没有可追加的内容');

  const snapshotLightIds = new Set(
    db.prepare('SELECT light_id FROM version_lights WHERE version_id = ?').all(meta.version_id).map((r) => r.light_id)
  );

  // 时码不早于末项：先对库内末项比较，批内再逐条比较
  let lastRow = db
    .prepare('SELECT time FROM record_ops WHERE record_id = ? ORDER BY seq DESC LIMIT 1')
    .get(id);
  let minTime = lastRow ? lastRow.time : null;

  const parsed = [];
  for (let i = 0; i < rows.length; i++) {
    const prefix = Array.isArray(req.body.ops) ? `第 ${i + 1} 条操作：` : '';
    const r = validateRecordOp(rows[i], snapshotLightIds);
    if (r.error) return err(res, 400, prefix + r.error + '（整次提交已拒绝，未写入任何操作）');
    if (minTime !== null && r.value.time < minTime - 1e-9) {
      return err(
        res,
        400,
        `${prefix}时码 ${r.value.time} 早于上一操作时码 ${minTime}：仅允许追加不早于末项的操作（整次提交已拒绝）`
      );
    }
    minTime = r.value.time;
    parsed.push(r.value);
  }

  const tx = db.transaction(() => {
    // 事务内复查修订号，杜绝并发覆盖（better-sqlite3 同步执行，此处为双保险）
    const cur = db.prepare('SELECT revision FROM rehearsal_records WHERE id = ?').get(id);
    if (cur.revision !== clientRev) {
      const e = new Error(`REVISION_CONFLICT:${cur.revision}`);
      e.code = 'REVISION_CONFLICT';
      e.current = cur.revision;
      throw e;
    }
    const maxSeq =
      db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM record_ops WHERE record_id = ?').get(id).m;
    const ins = db.prepare(
      'INSERT INTO record_ops (record_id, seq, light_id, time, op_type, target, duration) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    parsed.forEach((v, i) => {
      ins.run(id, maxSeq + i + 1, v.light_id, v.time, v.op_type, v.target, v.duration);
    });
    db.prepare('UPDATE rehearsal_records SET revision = revision + 1 WHERE id = ?').run(id);
  });

  try {
    tx();
  } catch (e) {
    if (e.code === 'REVISION_CONFLICT') {
      return err(res, 409, `修订号冲突：记录当前修订号为 ${e.current}（本次未写入）`);
    }
    throw e;
  }

  res.status(201).json(loadRecordDetail(id, res));
});

// 查看任意时刻的逐灯实际输出（原版在后台运行，叠加覆盖/归还操作序列后重算）
app.get('/api/records/:id/output', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const meta = loadRecordMeta(id);
  if (!meta) return err(res, 404, `调光记录 ${id} 不存在`);

  const at = toNum(req.query.at);
  if (Number.isNaN(at)) {
    return err(res, 400, `查看时刻无效：${JSON.stringify(req.query.at)}（须为非负数字秒数）`);
  }
  if (at < 0) return err(res, 400, `查看时刻无效：${at}（不得为负）`);

  const snap = loadVersionSnapshot(meta.version_id);
  const baseCues = Engine.prepareCues(snap.cues);
  const byLight = Engine.prepareOverrides(loadRecordOps(id), baseCues);

  const levels = snap.lights.map((l) => {
    const original = Engine.brightnessAt(baseCues, l.id, at);
    const actual = Engine.overrideBrightnessAt(byLight, baseCues, l.id, at);
    const active = Engine.activeOverride(byLight, l.id, at);
    return {
      light_id: l.id,
      name: l.name,
      original: round6(original),
      actual: round6(actual),
      overridden: Math.abs(actual - original) > 1e-9 || active !== null,
      state: active ? active.state : 'original', // override 覆盖中 / return 归还融合中 / original 跟随原版
      active_seq: active ? active.seq : null,
    };
  });

  res.json({
    record: { id: meta.id, label: meta.label, revision: meta.revision },
    version: { id: snap.id, label: snap.label },
    at,
    levels,
  });
});

/* ----------------------- 回路负载预判（只读精确分析） ----------------------- */
// 针对已发布版本，或绑定它的临时调光记录：按每灯【实际亮度/100×额定瓦数】汇总到回路，
// 返回查看时刻各回路负载，以及时窗内【严格超出】容量的全部连续区间（含端点包含性）。
// 瞬变、同秒顺序、渐变接管、归还与持续变化原版亮度的融合均走灯光引擎既有规则；
// 区间在转折点之间用一/二次方程精确求根，不做固定步长采样。只读，不改动任何数据。

function parseLoadWindow(input) {
  const nums = {};
  const labels = { start: '时窗起点', end: '时窗终点', at: '查看时刻' };
  for (const field of ['start', 'end', 'at']) {
    const n = toNum(input[field]);
    if (Number.isNaN(n)) {
      return { error: `${labels[field]}无效：${JSON.stringify(input[field])}（须为非负数字秒数）` };
    }
    if (n < 0) return { error: `${labels[field]}无效：${n}（不得为负）` };
    nums[field] = n;
  }
  if (nums.start > nums.end) {
    return { error: `时窗起点（${nums.start}）不能大于终点（${nums.end}）` };
  }
  if (nums.at < nums.start || nums.at > nums.end) {
    return { error: `查看时刻 ${nums.at} 超出时窗 [${nums.start}, ${nums.end}]` };
  }
  return { value: nums };
}

// 由版本快照构造回路 -> 成员灯具（{light_id, watts}）映射；未分配回路的灯具不计入
function buildCircuitMembers(snap) {
  const members = new Map();
  for (const c of snap.circuits) members.set(c.id, []);
  for (const w of snap.wiring) {
    if (w.circuit_id === null || w.circuit_id === undefined) continue;
    if (!members.has(w.circuit_id)) continue; // 防御：接线指向快照内不存在的回路
    members.get(w.circuit_id).push({ light_id: w.light_id, watts: w.watts });
  }
  for (const list of members.values()) list.sort((x, y) => x.light_id - y.light_id);
  return members;
}

function handleLoad(req, res) {
  const input = { ...req.query, ...(req.body || {}) };

  // 分析目标：版本 或 绑定版本的调光记录，二者恰好给一个
  const hasVersion = input.version_id !== undefined && input.version_id !== '';
  const hasRecord = input.record_id !== undefined && input.record_id !== '';
  if (hasVersion === hasRecord) {
    return err(res, 400, '请且仅请指定一个分析目标：version_id（已发布版本）或 record_id（绑定该版本的调光记录）');
  }

  let snap;
  let recordInfo = null;
  if (hasRecord) {
    const recordId = toPosInt(input.record_id);
    if (Number.isNaN(recordId)) {
      return err(res, 400, `调光记录编号无效：${JSON.stringify(input.record_id)}（须为正整数）`);
    }
    const meta = loadRecordMeta(recordId);
    if (!meta) return err(res, 404, `调光记录不存在：#${recordId}`);
    snap = loadVersionSnapshot(meta.version_id);
    recordInfo = {
      id: meta.id,
      label: meta.label,
      revision: meta.revision,
      ops: loadRecordOps(recordId),
    };
  } else {
    const versionId = toPosInt(input.version_id);
    if (Number.isNaN(versionId)) {
      return err(res, 400, `版本编号无效：${JSON.stringify(input.version_id)}（须为正整数）`);
    }
    snap = loadVersionSnapshot(versionId);
    if (!snap) return err(res, 404, `版本不存在：#${versionId}`);
  }

  const win = parseLoadWindow(input);
  if (win.error) return err(res, 400, win.error);
  const { start, end, at } = win.value;

  // 实际亮度：版本直接跑快照 Cue；记录则叠加其覆盖/归还操作序列
  const baseCues = Engine.prepareCues(snap.cues);
  const byLight = recordInfo
    ? Engine.prepareOverrides(recordInfo.ops, baseCues)
    : new Map();

  const membersByCircuit = buildCircuitMembers(snap);
  const nameOfLight = new Map(snap.lights.map((l) => [l.id, l.name]));

  const circuits = snap.circuits.map((c) => {
    const members = membersByCircuit.get(c.id) || [];
    const load = Engine.circuitLoadAt(byLight, baseCues, members, at);
    const intervals =
      end > start
        ? Engine.circuitOverloadIntervals(byLight, baseCues, members, start, end, c.capacity)
        : [];
    return {
      circuit_id: c.id,
      name: c.name,
      capacity: c.capacity,
      lights: members.map((m) => ({
        light_id: m.light_id,
        name: nameOfLight.get(m.light_id) ?? `#${m.light_id}`,
        watts: m.watts,
      })),
      load_at: round6(load),
      overloaded: load - c.capacity > 1e-9,
      intervals,
    };
  });

  res.json({
    source: recordInfo
      ? {
          kind: 'record',
          record: { id: recordInfo.id, label: recordInfo.label, revision: recordInfo.revision },
          version: { id: snap.id, label: snap.label },
        }
      : { kind: 'version', version: { id: snap.id, label: snap.label } },
    window: { start, end },
    at,
    // 早期无回路配置的版本：回路为空，播放照常，不产生回路负载
    has_circuit_config: snap.circuits.length > 0,
    circuits,
  });
}

app.get('/api/load', handleLoad);
app.post('/api/load', handleLoad);

/* ----------------- 草稿三方合并（预览令牌 + 一次事务提交） ----------------- */
// 两组排演人员从同一已发布版本（base 共同基线）各自改稿：当前草稿（draft）为一方成果，
// 另一已发布版本（incoming 待合入）按灯具/回路编号、Cue 编号、灯具接线做三方比较。
// 预览只读并颁发一次性令牌；提交逐项抉择，草稿在预览后被编辑过则 409 要求重新预览，
// 最终结果仍违反唯一性/引用规则则整次拒绝；成功后一次事务重写灯具/回路/接线/Cue。

const PREVIEW_TTL_SECONDS = 24 * 3600;

// 当前草稿按版本快照同构读出（接线来自灯具行）
function loadDraftState() {
  const lights = db.prepare('SELECT id, name, circuit_id, watts FROM lights ORDER BY id ASC').all();
  const circuits = db
    .prepare('SELECT id, name, capacity FROM circuits ORDER BY id ASC')
    .all();
  const cues = db
    .prepare('SELECT cue_no, light_id, time, target, duration FROM cues ORDER BY cue_no ASC')
    .all();
  return {
    lights: lights.map(({ id, name }) => ({ id, name })),
    circuits,
    cues,
    wiring: lights.map((l) => ({
      light_id: l.id,
      circuit_id: l.circuit_id ?? null,
      watts: l.watts ?? null,
    })),
  };
}

// 草稿内容版本戳：灯具/回路/Cue/接线任一变化都会改变；提交时据此判断预览后是否被编辑
function computeDraftStamp(state) {
  return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

// 三方快照中出现过的编号 -> 名称（重名/改名时以后遍历侧为准），仅供展示
function buildNameCtx(base, draft, incoming) {
  const lightNames = new Map();
  const circuitNames = new Map();
  for (const snap of [base, draft, incoming]) {
    for (const l of snap.lights) lightNames.set(l.id, l.name);
    for (const c of snap.circuits) circuitNames.set(c.id, c.name);
  }
  return {
    lightName: (id) => lightNames.get(id) ?? `#${id}（该侧不存在）`,
    circuitName: (id) => circuitNames.get(id) ?? `#${id}（该侧不存在）`,
  };
}

function enrichValue(kind, v, ctx) {
  if (v === null || v === undefined) return null;
  if (kind === 'cue') {
    return { ...v, light_name: ctx.lightName(v.light_id) };
  }
  if (kind === 'wiring') {
    return {
      ...v,
      light_name: ctx.lightName(v.light_id),
      circuit_name: v.circuit_id === null ? null : ctx.circuitName(v.circuit_id),
    };
  }
  return { ...v };
}

function entryTitle(c) {
  if (c.kind === 'cue') return `Cue #${c.id}`;
  if (c.kind === 'wiring') return `灯具 #${c.id} 的接线`;
  return `${c.label} #${c.id}`;
}

// 单条冲突原因的中文说明（name_collision / reference_missing 区分抉择侧）
function describeReason(kind, id, r) {
  const sideText = r.side === 'draft' ? '保留草稿侧' : '采用待合入版本侧';
  switch (r.code) {
    case 'both_modified':
      return '两侧相对共同基线做了不同修改';
    case 'delete_vs_modify':
      return '一侧删除而另一侧做了修改（删除与修改并存）';
    case 'same_key_diff':
      return '同编号新增但两侧内容不同';
    case 'name_collision':
      return `若${sideText}，名称「${r.detail.name}」与同表另一项重名（${kind === 'light' ? '灯具' : '回路'}名称须唯一）`;
    case 'reference_missing':
      if (kind === 'cue') {
        return `若${sideText}，Cue #${id} 引用的灯具 #${r.detail.missing_light_id} 在合并结果中不存在`;
      }
      return `若${sideText}，灯具 #${id} 的接线引用了合并结果中不存在的回路 #${r.detail.missing_circuit_id}`;
    case 'reference_dependency': {
      const sideText2 = r.side === 'draft' ? '保留草稿侧' : '采用待合入版本侧';
      const who = r.detail.by_kind === 'cue' ? `Cue #${r.detail.by_id}` : `灯具 #${r.detail.by_id} 的接线`;
      const what = kind === 'light' ? '灯具' : '回路';
      return `若${sideText2}，${who} 引用本${what}；请与该冲突选择同一侧（删除本项则该引用无法保留）`;
    }
    case 'attached_to_conflict': {
      const hostLabel = r.detail.host_kind === 'light' ? `灯具 #${r.detail.host_id}` : `回路 #${r.detail.host_id}`;
      return `随冲突项 ${hostLabel} 一并新增：选择是否引入该${hostLabel}时此项跟随同侧处理`;
    }
    default:
      return r.code;
  }
}

function describeViolation(v) {
  const { kind, id } = Merge.parseKey(v.key);
  return describeReason(kind, id, { code: v.code, detail: v.detail });
}

function presentAuto(e, ctx) {
  const actionText = {
    add: '采用待合入版本的新增',
    update: '采用待合入版本的修改',
    delete: '按待合入版本删除（草稿侧未改）',
  };
  return {
    kind: e.kind,
    key: e.key,
    id: e.id,
    title: entryTitle(e),
    action: e.action,
    action_text: actionText[e.action],
    base: enrichValue(e.kind, e.base, ctx),
    current: enrichValue(e.kind, e.current, ctx),
    incoming: enrichValue(e.kind, e.incoming, ctx),
    applied: enrichValue(e.kind, e.applied, ctx),
  };
}

function presentConflict(c, ctx) {
  return {
    kind: c.kind,
    key: c.key,
    id: c.id,
    title: entryTitle(c),
    reason: c.reason,
    reason_text: describeReason(c.kind, c.id, c.reasons[0]),
    reasons: c.reasons.map((r) => ({
      code: r.code,
      side: r.side || null,
      text: describeReason(c.kind, c.id, r),
    })),
    base: enrichValue(c.kind, c.base, ctx),
    draft: enrichValue(c.kind, c.draft, ctx),
    incoming: enrichValue(c.kind, c.incoming, ctx),
  };
}

function parseMergeVersions(body) {
  const out = {};
  for (const [field, label] of [
    ['base_version_id', '共同基线版本'],
    ['incoming_version_id', '待合入版本'],
  ]) {
    const id = toPosInt(body?.[field]);
    if (Number.isNaN(id)) {
      return { error: `${label}编号无效：${JSON.stringify(body?.[field])}（须为正整数）` };
    }
    out[field] = id;
  }
  return { value: out };
}

// POST /api/merge/preview  只读三方比较，颁发预览令牌（不写任何业务数据）
app.post('/api/merge/preview', (req, res) => {
  const parsed = parseMergeVersions(req.body);
  if (parsed.error) return err(res, 400, parsed.error);
  const { base_version_id: baseId, incoming_version_id: incomingId } = parsed.value;

  const base = loadVersionSnapshot(baseId);
  if (!base) return err(res, 404, `共同基线版本不存在：#${baseId}`);
  const incoming =
    incomingId === baseId ? base : loadVersionSnapshot(incomingId);
  if (!incoming) return err(res, 404, `待合入版本不存在：#${incomingId}`);

  const draftState = loadDraftState();
  const cls = Merge.classify(base, draftState, incoming);
  const ctx = buildNameCtx(base, draftState, incoming);

  // 清理过期预览令牌
  db.prepare('DELETE FROM merge_previews WHERE created_at < ?').run(
    Date.now() / 1000 - PREVIEW_TTL_SECONDS
  );

  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(
    `INSERT INTO merge_previews (token, base_id, incoming_id, draft_stamp, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    token,
    baseId,
    incomingId,
    computeDraftStamp(draftState),
    JSON.stringify({ auto: cls.auto, conflicts: cls.conflicts, summary: cls.summary }),
    Date.now() / 1000
  );

  res.json({
    token,
    base: { id: base.id, label: base.label },
    incoming: { id: incoming.id, label: incoming.label },
    draft_stamp: computeDraftStamp(draftState),
    summary: cls.summary,
    auto: cls.auto.map((e) => presentAuto(e, ctx)),
    conflicts: cls.conflicts.map((c) => presentConflict(c, ctx)),
    draft: draftState,
  });
});

// POST /api/merge/commit  凭令牌与逐项抉择一次事务提交
app.post('/api/merge/commit', (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const row = token ? db.prepare('SELECT * FROM merge_previews WHERE token = ?').get(token) : null;
  if (!row) {
    return err(res, 404, '合并预览不存在或已失效：请重新发起预览（预览不写库，令牌一次性有效）');
  }

  const base = loadVersionSnapshot(row.base_id);
  const incoming =
    row.incoming_id === row.base_id ? base : loadVersionSnapshot(row.incoming_id);
  if (!base || !incoming) {
    db.prepare('DELETE FROM merge_previews WHERE token = ?').run(token);
    return err(res, 404, '预览引用的版本已不存在，请重新预览');
  }

  // 草稿在预览后发生编辑：当前内容版本戳与预览时不一致 → 409，要求重新预览
  const draftState = loadDraftState();
  const currentStamp = computeDraftStamp(draftState);
  if (currentStamp !== row.draft_stamp) {
    db.prepare('DELETE FROM merge_previews WHERE token = ?').run(token);
    return err(
      res,
      409,
      '草稿在预览之后已被编辑，本次合并结果已过期：请重新预览并逐项抉择后再提交（本次未写入）'
    );
  }

  const resolutions = req.body?.resolutions;
  if (resolutions === null || typeof resolutions !== 'object' || Array.isArray(resolutions)) {
    return err(res, 400, '提交必须携带 resolutions 抉择对象（冲突 key -> "draft" 或 "incoming"）');
  }

  const result = Merge.resolve(base, draftState, incoming, resolutions);
  if (!result.ok) {
    const body = { error: '合并结果仍不合法，整次提交已拒绝（未写入任何数据）' };
    if (result.badResolutions.length > 0) {
      body.error = `抉择内容无效：${result.badResolutions[0].key} ${result.badResolutions[0].reason}`;
      body.bad_resolutions = result.badResolutions;
    } else if (result.unresolved.length > 0) {
      body.error = `仍有 ${result.unresolved.length} 个冲突未做选择，请逐项选择「保留草稿」或「采用待合入版本」后再提交`;
      body.unresolved = result.unresolved;
    } else if (result.violations.length > 0) {
      body.error = '合并结果仍违反唯一性或引用规则，整次提交已拒绝：' +
        result.violations.map(describeViolation).join('；');
      body.violations = result.violations.map((v) => ({
        key: v.key,
        code: v.code,
        detail: v.detail,
        text: describeViolation(v),
      }));
    }
    return res.status(400).json(body);
  }

  const finalState = result.final;
  const stampExpected = row.draft_stamp;

  const applyMerge = db.transaction(() => {
    // 事务内再次确认草稿未被并发改动（双保险）
    if (computeDraftStamp(loadDraftState()) !== stampExpected) {
      const e = new Error('DRAFT_CHANGED');
      e.code = 'DRAFT_CHANGED';
      throw e;
    }

    const keepLightIds = new Set(finalState.lights.map((l) => l.id));
    const keepCircuitIds = new Set(finalState.circuits.map((c) => c.id));
    const keepCueNos = new Set(finalState.cues.map((c) => c.cue_no));

    // 1) 灯具：先 upsert（Cue 外键需要），最后删除不再保留的
    const upsertLight = db.prepare(
      `INSERT INTO lights (id, name, created_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name`
    );
    for (const l of finalState.lights) {
      upsertLight.run(l.id, l.name, Date.now() / 1000);
    }

    // 2) Cue：删除待移除编号，upsert 保留项（编号即业务身份，保持稳定）
    db.prepare('DELETE FROM cues WHERE cue_no NOT IN (SELECT value FROM json_each(?))').run(
      JSON.stringify([...keepCueNos])
    );
    const upsertCue = db.prepare(
      `INSERT INTO cues (cue_no, light_id, time, target, duration) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (cue_no) DO UPDATE SET
         light_id = excluded.light_id, time = excluded.time,
         target = excluded.target, duration = excluded.duration`
    );
    for (const c of finalState.cues) {
      upsertCue.run(c.cue_no, c.light_id, c.time, c.target, c.duration);
    }

    // 3) 删除不再保留的灯具（其 Cue 已随上面的投影结果移除）
    db.prepare('DELETE FROM lights WHERE id NOT IN (SELECT value FROM json_each(?))').run(
      JSON.stringify([...keepLightIds])
    );

    // 4) 接线：逐灯落定所属回路与额定瓦数
    const setWiring = db.prepare(
      'UPDATE lights SET circuit_id = ?, watts = ? WHERE id = ?'
    );
    for (const w of finalState.wiring) {
      setWiring.run(w.circuit_id, w.watts, w.light_id);
    }

    // 5) 回路：upsert 保留项，删除不再保留的（最终接线已不再引用它们）
    const upsertCircuit = db.prepare(
      `INSERT INTO circuits (id, name, capacity, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, capacity = excluded.capacity`
    );
    for (const c of finalState.circuits) {
      upsertCircuit.run(c.id, c.name, c.capacity, Date.now() / 1000);
    }
    db.prepare('DELETE FROM circuits WHERE id NOT IN (SELECT value FROM json_each(?))').run(
      JSON.stringify([...keepCircuitIds])
    );

    // 6) 令牌一次性使用
    db.prepare('DELETE FROM merge_previews WHERE token = ?').run(token);
  });

  try {
    applyMerge();
  } catch (e) {
    if (e.code === 'DRAFT_CHANGED') {
      return err(res, 409, '草稿在提交时已被他人编辑，请重新预览后再提交（本次未写入）');
    }
    // 兜底：唯一性/外键等约束未被前置校验覆盖时，整次回滚并返回可读中文错误
    if (String(e.message || '').includes('UNIQUE') || String(e.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return err(res, 400, `合并结果违反数据库唯一/引用约束，整次提交已拒绝：${e.message}（未写入任何数据）`);
    }
    throw e;
  }

  // 返回合并后的新草稿（已发布版本与绑定的调光记录均不变）
  res.json({
    merged: true,
    base: { id: base.id, label: base.label },
    incoming: { id: incoming.id, label: incoming.label },
    summary: result.summary,
    draft: {
      lights: db.prepare('SELECT * FROM lights ORDER BY id ASC').all(),
      circuits: db.prepare(circuitSelect).all().map(readCircuit),
      cues: db.prepare(cueSelect).all().map(readCue),
    },
  });
});

/* ----------------------- 共享房间（同一舞台同步观看） ----------------------- */
// 排演人员基于一个已发布版本创建共享房间：创建者取得控制密钥，其他人凭房间码观看
// 同一舞台与逐灯亮度。房间固定所选版本，保存播放/暂停、基准时码、速度及修订号；
// 服务端按墙钟推算当前时码，到版本末尾自动停住；页面刷新、服务重启、观看者重连后
// 均能恢复进度。后续草稿修改和发布不影响它。房间操作不改版本、草稿或调光记录。
// 持密钥者可播放、暂停、跳转及设置 0.5/1/2 倍速；控制请求携带当前修订号，过期返回
// 409 冲突且不改房间。
//
// 回路超载保护（创建时可选启用）：只使用房间固定版本快照中的回路容量与灯具接线
// （旧版快照无回路配置时没有任何超载回路）。服务端按既有逐灯亮度与负载规则，找出
// 播放方向上首个负载【严格大于】容量的区间左边界；播放惰性推算一旦抵达该边界即
// 暂停在此并惰性落库（不增加控制修订号），返回触发回路与演出时码——观看端轮询
// 间隔再长也不会越过危险段。当前时码已超载时拒绝播放；播放中跳入超载段拒绝且
// 房间不变；暂停时允许跳转（可用于跳过/避开危险段）。

const ROOM_CODE_LEN = 6;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除 0/O/1/I 等易混字符
const ROOM_SPEEDS = [0.5, 1, 2];
// 与引擎一致的端点浮点容差（超载区间端点已按 1e-9 归整）
const ROOM_EPS = 1e-7;

function genRoomCode() {
  for (;;) {
    let code = '';
    const bytes = crypto.randomBytes(ROOM_CODE_LEN);
    for (let i = 0; i < ROOM_CODE_LEN; i++) code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    if (!db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code)) return code;
  }
}

const roomSelect = `
  SELECT r.*, v.label AS version_label
  FROM rooms r JOIN versions v ON v.id = r.version_id
`;

function getRoomRowByCode(code) {
  return db.prepare(`${roomSelect} WHERE r.code = ?`).get(code);
}

// 房间码归一化：去除首尾空白与内部连字符/空格并转大写；长度不符视为格式非法
function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return '';
  const code = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return code;
}

// 由版本快照求房间末尾时刻：最后一条 Cue 渐变结束时刻（无 Cue 为 0）
function roomDurationForSnapshot(snap) {
  return Engine.showDuration(Engine.prepareCues(snap.cues));
}

/* ---------------- 房间超载保护（基于不可变版本快照，进程内缓存） ---------------- */

// versionId -> 保护器。版本快照不可变，故缓存永不失效；快照无回路配置时
// circuits 为空数组（启用了保护也不会产生任何超载回路）。
const roomGuardCache = new Map();

function loadRoomGuard(versionId) {
  const cached = roomGuardCache.get(versionId);
  if (cached) return cached;
  const snap = loadVersionSnapshot(versionId);
  if (!snap) return null;
  const baseCues = Engine.prepareCues(snap.cues);
  const duration = Engine.showDuration(baseCues);
  const membersByCircuit = buildCircuitMembers(snap);

  const circuitsInOrder = [];
  // 全部回路的超载区间左边界（按时码、再按回路编号定序），供播放方向上取“首个”
  const boundaries = [];
  for (const c of snap.circuits) {
    const members = membersByCircuit.get(c.id) || [];
    // 保护判定与负载预判页同一套精确求根（一/二次方程，不做步长采样）
    const intervals =
      duration > 0
        ? Engine.circuitOverloadIntervals(new Map(), baseCues, members, 0, duration, c.capacity)
        : [];
    const entry = { id: c.id, name: c.name, capacity: c.capacity, members, intervals };
    circuitsInOrder.push(entry);
    for (const iv of intervals) boundaries.push({ start: iv.start, interval: iv, circuit: entry });
  }
  boundaries.sort((x, y) => x.start - y.start || x.circuit.id - y.circuit.id);

  const guard = {
    duration,
    circuitsInOrder,
    circuitsById: new Map(circuitsInOrder.map((c) => [c.id, c])),
    boundaries,
  };
  roomGuardCache.set(versionId, guard);
  return guard;
}

// t 是否落在某条（严格超载）区间内：交点开端点不算超载，触发瞬间闭端点算
function intervalContains(iv, t) {
  if (t < iv.start - ROOM_EPS || t > iv.end + ROOM_EPS) return false;
  if (Math.abs(t - iv.start) <= ROOM_EPS) return !!iv.start_inclusive;
  if (Math.abs(t - iv.end) <= ROOM_EPS) return !!iv.end_inclusive;
  return true;
}

function circuitRef(c) {
  return { circuit_id: c.id, name: c.name, capacity: c.capacity };
}

// 时刻 t 全部处于超载状态的回路（按回路编号排序）
function overloadedCircuitsAt(guard, t) {
  const out = [];
  for (const c of guard.circuitsInOrder) {
    if (c.intervals.some((iv) => intervalContains(iv, t))) out.push(circuitRef(c));
  }
  return out;
}

/**
 * 播放从锚点时码 fromTime 推进到 t 时撞上的首个超载区间左边界。
 *  - 边界严格在锚点前方：推进抵达（含恰好抵达开端点——该瞬间负载等于容量，
 *    按“抵达边界即停”冻结在此，不进入其后的危险段）即拦截；
 *  - 边界与锚点重合/仅差浮点噪声（开端点恰好等于锚点）：锚点本身尚安全，
 *    但墙钟一旦真正推进（t > fromTime）就立刻冻结在边界上；
 *  - 严格位于锚点后方的边界不再拦截。
 */
function tripBoundaryBetween(guard, fromTime, t) {
  for (const b of guard.boundaries) {
    if (b.start < fromTime - ROOM_EPS) continue; // 严格在身后
    if (b.start > fromTime + ROOM_EPS) {
      if (b.start <= t + ROOM_EPS) return b; // 前方边界：已抵达
    } else if (t > fromTime + ROOM_EPS) {
      return b; // 锚点就在（开）边界上：时间一推进即冻结在此
    }
  }
  return null;
}

// 当前位置前方最近的超载边界（仅用于页面提示）
function nextBoundaryAfter(guard, t) {
  for (const b of guard.boundaries) {
    if (b.start >= t - ROOM_EPS) return b;
  }
  return null;
}

/**
 * 读取房间当前状态：服务端按墙钟推算时码。
 * 播放中按 time + (now - anchor_wall) * speed 推算；到末尾则自动停住并惰性落库
 * （不改修订号：这只是时间流逝的结果，不与任何控制竞争）。
 * 启用超载保护且提供 guard 时：推算一旦抵达前方首个超载区间左边界，即暂停在该
 * 边界上并惰性落库（同样不改修订号），返回 trip 信息——无论观看端多久轮询一次，
 * 时码都不会越过危险段。
 */
function computeRoomState(row, { now = Date.now() / 1000, persistStopped = false, guard = null } = {}) {
  let playing = !!row.playing;
  let time = row.time;
  let ended = false;
  let trip = null;

  if (playing) {
    const elapsed = Math.max(0, now - row.anchor_wall) * row.speed;
    let t = row.time + elapsed;

    // 超载保护先于末尾判定：边界一定不晚于版本末尾
    if (guard) {
      const hit = tripBoundaryBetween(guard, row.time, t);
      if (hit) {
        t = hit.start;
        playing = false;
        trip = { circuit_id: hit.circuit.id, time: hit.start };
      }
    }

    if (playing && t >= row.duration) {
      t = row.duration;
      playing = false;
      ended = true;
    }

    if (!playing && persistStopped) {
      if (ended) {
        db.prepare(
          `UPDATE rooms SET playing = 0, time = duration, anchor_wall = ?,
                           tripped_circuit_id = NULL, tripped_time = NULL WHERE id = ?`
        ).run(now, row.id);
      } else if (trip) {
        // 自动暂停：固化在超载区间左边界；不增加控制修订号
        db.prepare(
          `UPDATE rooms SET playing = 0, time = ?, anchor_wall = ?,
                           tripped_circuit_id = ?, tripped_time = ? WHERE id = ?`
        ).run(trip.time, now, trip.circuit_id, trip.time, row.id);
      }
    }
    time = t;
  }
  return {
    playing,
    time,
    speed: row.speed,
    duration: row.duration,
    revision: row.revision,
    ended,
    trip,
  };
}

// 组装对外的超载保护状态块（页面据此显示保护状态与触发原因）
function buildProtection(row, state, guard) {
  if (!row.overload_protection) return { enabled: false };
  const block = { enabled: true, configured: !!(guard && guard.circuitsInOrder.length > 0) };
  if (!guard || guard.circuitsInOrder.length === 0) return block;

  const over = overloadedCircuitsAt(guard, state.time);
  block.overloaded_now = over.length > 0;
  block.circuits_overloaded_now = over;

  // 未处于超载段时，预告前方最近的触发边界
  if (over.length === 0) {
    const nb = nextBoundaryAfter(guard, state.time);
    if (nb) {
      block.next_trip = {
        time: round6(nb.start),
        seconds_ahead: round6(Math.max(0, nb.start - state.time)),
        circuit: circuitRef(nb.circuit),
      };
    }
  }

  // 自动暂停标记由惰性落库的两列恢复（服务重启后同样有效）
  if (row.tripped_circuit_id !== null && row.tripped_circuit_id !== undefined) {
    const c = guard.circuitsById.get(row.tripped_circuit_id);
    block.tripped = {
      reason: 'overload_boundary',
      reason_text:
        '回路超载保护已触发：播放抵达超载区间左边界，已自动暂停在此（自动暂停不增加控制修订号），暂停状态下可跳转避险',
      time: round6(row.tripped_time ?? state.time),
      circuit: c
        ? circuitRef(c)
        : { circuit_id: row.tripped_circuit_id, name: `回路 #${row.tripped_circuit_id}`, capacity: null },
    };
  }
  return block;
}

// 房间对外视图（创建/查询/控制共用）；state 由 computeRoomState 得到
function buildRoomView(row, state, now, guard) {
  return {
    code: row.code,
    label: row.label,
    version: { id: row.version_id, label: row.version_label },
    duration: round6(state.duration),
    playing: state.playing,
    time: round6(state.time),
    speed: state.speed,
    revision: state.revision,
    protection: buildProtection(row, state, guard),
    // 服务端墙钟与对应时码：观看端据此校时（基准时码 + 流逝时间 × 速度）
    server_wall: now,
    server_time: round6(state.time),
  };
}

// 创建共享房间：基于已发布版本，固定版本快照，初始暂停在 0 秒
app.post('/api/rooms', (req, res) => {
  const versionId = toPosInt(req.body?.version_id);
  if (Number.isNaN(versionId)) {
    return err(res, 400, `版本编号无效：${JSON.stringify(req.body?.version_id)}（须为已发布版本的正整数编号）`);
  }
  const snap = loadVersionSnapshot(versionId);
  if (!snap) return err(res, 404, `版本不存在：#${versionId}，无法基于它创建共享房间`);

  // 回路超载保护：可选布尔开关；不传等同不启用，沿用原房间行为
  let overloadProtection = false;
  if (req.body?.overload_protection !== undefined) {
    if (typeof req.body.overload_protection !== 'boolean') {
      return err(res, 400, `超载保护开关无效：${JSON.stringify(req.body.overload_protection)}（须为布尔值 true/false）`);
    }
    overloadProtection = req.body.overload_protection;
  }

  const labelRaw = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const label = labelRaw || `共享房间（${snap.label}）`;
  const duration = roomDurationForSnapshot(snap);
  const now = Date.now() / 1000;
  const code = genRoomCode();
  const controlKey = crypto.randomBytes(24).toString('hex');

  const info = db
    .prepare(
      `INSERT INTO rooms (code, version_id, control_key, label, playing, time, anchor_wall, speed,
                          duration, revision, overload_protection, tripped_circuit_id, tripped_time, created_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, 1, ?, 0, ?, NULL, NULL, ?)`
    )
    .run(code, versionId, controlKey, label, now, duration, overloadProtection ? 1 : 0, now);

  // 启用保护即预热保护器（仅读冻结快照，不写任何业务数据）
  if (overloadProtection) loadRoomGuard(versionId);

  const row = db.prepare(`${roomSelect} WHERE r.id = ?`).get(info.lastInsertRowid);
  const guard = overloadProtection ? loadRoomGuard(versionId) : null;
  const state = computeRoomState(row, { now, guard });
  res.status(201).json({
    ...buildRoomView(row, state, now, guard),
    // 控制密钥仅在创建响应中完整返回一次；之后任何接口都不再回显
    control_key: controlKey,
  });
});

// 加入/查看房间：凭房间码（无需密钥）只读服务端状态，观看端按返回的服务端墙钟校时
app.get('/api/rooms/:code', (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (code.length !== ROOM_CODE_LEN) {
    return err(res, 400, `房间码无效：${JSON.stringify(req.params.code)}（须为 ${ROOM_CODE_LEN} 位房间码）`);
  }
  let row = getRoomRowByCode(code);
  if (!row) return err(res, 404, `房间不存在：房间码 ${code}（请核对后重新加入）`);
  const now = Date.now() / 1000;
  const guard = row.overload_protection ? loadRoomGuard(row.version_id) : null;
  // 到末尾自动停住 / 撞上超载边界自动暂停：此处惰性落库，刷新/重启/重连后状态一致
  const state = computeRoomState(row, { now, guard, persistStopped: true });
  if (!state.playing) row = getRoomRowByCode(code);
  res.json(buildRoomView(row, state, now, guard));
});

// 房间控制：持密钥者播放/暂停/跳转/设置速度；携带修订号，过期 409 且不改房间
app.post('/api/rooms/:code/control', (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (code.length !== ROOM_CODE_LEN) {
    return err(res, 400, `房间码无效：${JSON.stringify(req.params.code)}（须为 ${ROOM_CODE_LEN} 位房间码）`);
  }
  const row = getRoomRowByCode(code);
  if (!row) return err(res, 404, `房间不存在：房间码 ${code}（请核对后重试）`);

  // 控制密钥：必须携带且正确（不回显房间当前密钥；等长比较避免计时侧信道）
  const key = req.body?.control_key;
  if (key === undefined || key === null || key === '') {
    return err(res, 403, '缺少控制密钥：仅房间创建者（持密钥者）可以控制播放，请在页面填写密钥');
  }
  const keyBuf = Buffer.from(String(key));
  const expectedBuf = Buffer.from(row.control_key);
  if (keyBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(keyBuf, expectedBuf)) {
    return err(res, 403, '控制密钥无效：无权控制该房间（观看者只能同步观看）');
  }

  // 修订号：必须携带且与当前一致（先按墙钟惰性推算，末尾自动停住不改修订号）
  if (req.body === null || typeof req.body !== 'object' || !('revision' in req.body)) {
    return err(res, 400, '控制请求必须携带房间修订号 revision（与服务器当前修订号一致才允许控制）');
  }
  const clientRev = toNum(req.body.revision);
  if (!Number.isInteger(clientRev) || clientRev < 0) {
    return err(res, 400, `修订号无效：${JSON.stringify(req.body.revision)}（须为非负整数）`);
  }

  const action = req.body.action;
  if (!['play', 'pause', 'seek', 'speed'].includes(action)) {
    return err(
      res,
      400,
      `非法控制动作：${JSON.stringify(action)}（须为 play 播放 / pause 暂停 / seek 跳转 / speed 设置速度）`
    );
  }

  // 跳转时码：非负数字且不得超过版本末尾
  let seekTime = null;
  if (action === 'seek') {
    seekTime = toNum(req.body.time);
    if (Number.isNaN(seekTime)) {
      return err(res, 400, `非法时码：${JSON.stringify(req.body.time)}（须为数字秒数）`);
    }
    if (seekTime < 0) return err(res, 400, `非法时码：${seekTime}（不得为负）`);
    if (seekTime > row.duration) {
      return err(res, 400, `时码越界：${seekTime}（房间固定版本长度为 ${round6(row.duration)} 秒，不得跳到末尾之后）`);
    }
  }

  // 速度：仅允许现有的 0.5 / 1 / 2 倍
  let speed = null;
  if (action === 'speed') {
    speed = toNum(req.body.speed);
    if (!ROOM_SPEEDS.some((s) => Math.abs(s - speed) <= 1e-12)) {
      return err(res, 400, `非法速度：${JSON.stringify(req.body.speed)}（仅支持 0.5、1、2 倍速）`);
    }
  }

  const guard = row.overload_protection ? loadRoomGuard(row.version_id) : null;
  const now = Date.now() / 1000;
  const tx = db.transaction(() => {
    const cur = db.prepare(`${roomSelect} WHERE r.id = ?`).get(row.id);
    // 事务内复查密钥与修订号（双保险）
    if (cur.control_key !== key) {
      const e = new Error('ROOM_FORBIDDEN');
      e.code = 'ROOM_FORBIDDEN';
      throw e;
    }
    if (cur.revision !== clientRev) {
      const e = new Error(`ROOM_CONFLICT:${cur.revision}`);
      e.code = 'ROOM_CONFLICT';
      e.current = cur.revision;
      throw e;
    }
    // 先按墙钟实时推算（可能已到末尾或已撞上超载边界；此处不落库，随本次控制一并固化）
    const live = computeRoomState(cur, { now, guard });

    let { playing, time } = live;
    let nextSpeed = cur.speed;
    const anchor = now;
    // 写库的自动暂停标记：仅当本次结果确为保护触发的暂停时保留
    let tripCircuit = live.trip ? live.trip.circuit_id : null;
    let tripTime = live.trip ? live.trip.time : null;

    if (action === 'play') {
      if (live.time >= cur.duration) {
        if (cur.duration <= 0) {
          const e = new Error('ROOM_ZERO_DURATION');
          e.code = 'ROOM_ZERO_DURATION';
          throw e;
        }
        time = 0; // 已停在末尾：再播放从头开始
      }
      // 当前时码已处于超载区间（含闭端点）：拒绝播放，房间不变
      if (guard) {
        const over = overloadedCircuitsAt(guard, time);
        if (over.length > 0) {
          const e = new Error('ROOM_UNSAFE');
          e.code = 'ROOM_UNSAFE';
          e.time = time;
          e.circuits = over;
          throw e;
        }
      }
      playing = true;
      tripCircuit = null;
      tripTime = null;
    } else if (action === 'pause') {
      playing = false;
      // 非保护触发的普通暂停清除超载标记
      if (!live.trip) {
        tripCircuit = null;
        tripTime = null;
      }
    } else if (action === 'seek') {
      // 播放中跳入超载段：拒绝且房间不变；暂停（含已被保护自动暂停）时允许任意跳转避险
      if (guard && live.playing) {
        const over = overloadedCircuitsAt(guard, seekTime);
        if (over.length > 0) {
          const e = new Error('ROOM_UNSAFE');
          e.code = 'ROOM_UNSAFE';
          e.time = seekTime;
          e.circuits = over;
          throw e;
        }
      }
      time = seekTime;
      if (seekTime >= cur.duration) playing = false; // 跳到末尾即停住
      // 跳转后人不在触发边界上：清除既有自动暂停标记
      tripCircuit = null;
      tripTime = null;
      // 播放/暂停状态沿用（播放则从新时码起按速度继续；暂停锚住该时码）
    } else {
      // speed：以当前实时推算时码为新基准（若保护刚把播放截停，则停在边界上），
      // 立刻按新速度继续（暂停则保持暂停）
      nextSpeed = speed;
      if (!live.trip) {
        tripCircuit = null;
        tripTime = null;
      }
    }

    db.prepare(
      `UPDATE rooms
       SET playing = ?, time = ?, anchor_wall = ?, speed = ?, revision = revision + 1,
           tripped_circuit_id = ?, tripped_time = ?
       WHERE id = ?`
    ).run(playing ? 1 : 0, time, anchor, nextSpeed, tripCircuit, tripTime, cur.id);
    return db.prepare(`${roomSelect} WHERE r.id = ?`).get(cur.id);
  });

  let updated;
  try {
    updated = tx();
  } catch (e) {
    if (e.code === 'ROOM_CONFLICT') {
      return err(
        res,
        409,
        `修订号冲突：提交基于修订号 ${clientRev}，房间当前已为修订号 ${e.current}；请按服务端最新状态校时后重试（本次未改动房间）`
      );
    }
    if (e.code === 'ROOM_FORBIDDEN') {
      return err(res, 403, '控制密钥无效：无权控制该房间（本次未改动房间）');
    }
    if (e.code === 'ROOM_ZERO_DURATION') {
      return err(res, 400, '该房间固定的版本时长为 0（没有 Cue），无法播放');
    }
    if (e.code === 'ROOM_UNSAFE') {
      // 400 明确拒绝：当前/目标时码已超载。不改动房间、不增加修订号
      const names = e.circuits.map((c) => `回路 #${c.circuit_id}「${c.name}」`).join('、');
      return res.status(400).json({
        error: `时码 ${round6(e.time)} 秒处 ${names} 负载严格大于容量：${action === 'play' ? '当前已超载，拒绝播放' : '播放中不得跳入超载段'}；请先在暂停状态下跳转到安全时码（本次未改动房间）`,
        reason: 'overloaded_timecode',
        time: round6(e.time),
        circuits: e.circuits,
      });
    }
    throw e;
  }

  const state = computeRoomState(updated, { now, guard });
  res.json(buildRoomView(updated, state, now, guard));
});

/* ------------------------------- 错误处理 ------------------------------ */

// JSON 解析失败（如非法时码导致的畸形 JSON 之外的格式错误）
app.use((e, req, res, next) => {
  if (e.type === 'entity.parse.failed') {
    return err(res, 400, '请求体不是合法 JSON，提交已拒绝');
  }
  console.error(e);
  err(res, 500, '服务器内部错误');
});

// 前端单页回退（API 未命中返回 JSON 404）
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 直接运行（node server.js / npm start / Docker）时启动监听；被测试 require 时只导出 app
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`小剧场灯光 Cue 排演应用已启动: http://localhost:${PORT}`);
    console.log(`数据库: ${DB_PATH}`);
  });
}

module.exports = { app, PORT, DB_PATH };
