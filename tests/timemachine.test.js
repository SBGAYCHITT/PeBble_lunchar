// 合成一个存档，验证时光机与健康检查（含主动注入损坏区块/实体热点）
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const tm = require('../savetimemachine');

function nbtWithEntities(n) {
  const p = [];
  p.push(Buffer.from([10]));                       // TAG_Compound
  p.push(Buffer.from([0, 0]));                     // 根名：空
  p.push(Buffer.from([9]));                        // TAG_List
  const name = Buffer.from('Entities', 'utf8');
  const nl = Buffer.alloc(2); nl.writeUInt16BE(name.length);
  p.push(nl, name);
  p.push(Buffer.from([10]));                       // 元素类型 compound
  const c = Buffer.alloc(4); c.writeInt32BE(n);
  p.push(c);
  for (let i = 0; i < n; i++) p.push(Buffer.from([0])); // 空 compound
  p.push(Buffer.from([0]));                        // 根结束
  return Buffer.concat(p);
}

// 构造 region 文件：entries = [{i, entities|null|'corrupt'|'huge'}]
function buildRegion(file, entries) {
  const header = Buffer.alloc(8192);
  const sectors = [];
  let nextSector = 2; // 0,1 给 header
  for (const e of entries) {
    let payload;
    let comp = 2;
    if (e.kind === 'corrupt') {
      payload = Buffer.from('THIS_IS_NOT_VALID_ZLIB_DATA_!!!!');
    } else if (e.kind === 'huge') {
      payload = zlib.deflateSync(Buffer.concat([nbtWithEntities(1), Buffer.alloc(1100000)]));
    } else {
      payload = zlib.deflateSync(nbtWithEntities(e.entities || 0));
    }
    const total = 4 + 1 + payload.length;   // len(4) + comp(1) + data
    const cnt = Math.ceil(total / 4096);
    const buf = Buffer.alloc(cnt * 4096);
    buf.writeUInt32BE(payload.length + 1, 0);
    buf[4] = comp;
    payload.copy(buf, 5);
    sectors.push({ off: nextSector, cnt, buf });
    header[e.i * 4] = (nextSector >> 16) & 0xff;
    header[e.i * 4 + 1] = (nextSector >> 8) & 0xff;
    header[e.i * 4 + 2] = nextSector & 0xff;
    header[e.i * 4 + 3] = cnt;
    nextSector += cnt;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = Buffer.concat([header, ...sectors.map((s) => s.buf)]);
  fs.writeFileSync(file, out);
}

(async () => {
  const save = path.join(os.tmpdir(), 'pl-fake-world');
  fs.rmSync(save, { recursive: true, force: true });
  fs.mkdirSync(path.join(save, 'region'), { recursive: true });
  fs.mkdirSync(path.join(save, 'DIM-1', 'region'), { recursive: true });
  fs.writeFileSync(path.join(save, 'level.dat'), zlib.gzipSync(Buffer.from('fake-level-dat')));
  fs.writeFileSync(path.join(save, 'session.lock'), Buffer.from('x'));

  // 主世界：正常(5实体) / 热点(300实体) / 损坏 / 超大
  buildRegion(path.join(save, 'region', 'r.0.0.mca'), [
    { i: 0, entities: 5 },
    { i: 1, entities: 300 },
    { i: 35, kind: 'corrupt' },
    { i: 70, kind: 'huge' }
  ]);
  // 下界：一个正常区块
  buildRegion(path.join(save, 'DIM-1', 'region', 'r.-1.0.mca'), [{ i: 3, entities: 12 }]);
  // 1.18+ 实体独立目录：这里放一个 150 实体的热点
  buildRegion(path.join(save, 'entities', 'r.0.0.mca'), [{ i: 0, entities: 150 }]);

  const size = (p) => { let s = 0; const w = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); if (e.isDirectory()) w(a); else try { s += fs.statSync(a).size; } catch {} } }; w(p); return s; };
  console.log('合成存档大小:', (size(save) / 1024).toFixed(0), 'KB');

  console.log('\n=== 健康检查 ===');
  const h = tm.healthCheck({ saveDir: save });
  console.log('扫描 region:', h.scannedFiles, '个 | 有效区块:', h.chunkTotal, '| 整体健康:', h.ok);
  console.log('损坏区块:', h.corrupt.length, '->', JSON.stringify(h.corrupt.map((c) => c.dim + ':' + c.file + ' chunk(' + c.cx + ',' + c.cz + ') ' + c.reason)));
  console.log('实体热点:', h.hotspots.length, '->', JSON.stringify(h.hotspots.map((x) => x.dim + ' (' + x.cx + ',' + x.cz + ')=' + x.entities)));
  console.log('超大区块:', h.oversize.length, '->', JSON.stringify(h.oversize.map((o) => o.dim + ' ' + (o.bytes / 1048576).toFixed(2) + 'MB')));

  // 预期：损坏1、超大1、热点2(300 区块 + 150 实体文件)
  //   有效区块 = 主世界(5/300/超大1) 3 + 下界 1 + 实体文件 1 = 5，损坏的 1 个不计入
  //   实体总数 = 5 + 300 + 1(超大区块内) + 12 + 150 = 468
  const ok1 = h.corrupt.length === 1 && h.oversize.length === 1 && h.hotspots.length === 2 &&
              h.hotspots[0].entities === 300 && h.chunkTotal === 5 && h.badTotal === 1 && h.entityTotal === 468;
  console.log('★ 健康检查判定:', ok1 ? '正确（有效5/损坏1/超大1/热点2/实体468）'
    : '不符预期 -> 有效' + h.chunkTotal + ' 损坏' + h.badTotal + ' 实体' + h.entityTotal + ' 热点' + h.hotspots.length);

  console.log('\n=== 时光机 ===');
  const store = path.join(os.tmpdir(), 'pl-tm-test');
  fs.rmSync(store, { recursive: true, force: true });

  const s1 = await tm.createSnapshot({ saveDir: save, storeDir: store, label: '首次' });
  console.log('快照1: 文件', s1.fileCount, '| 逻辑', (s1.totalSize / 1024).toFixed(0), 'KB | 实际写入', (s1.newBytes / 1024).toFixed(0), 'KB');

  const s2 = await tm.createSnapshot({ saveDir: save, storeDir: store, label: '未改动' });
  console.log('快照2: 逻辑', (s2.totalSize / 1024).toFixed(0), 'KB | 实际写入', (s2.newBytes / 1024).toFixed(2), 'KB  <-- 趋近0说明去重生效');

  // 改一点内容再快照：只应有少量新增
  fs.writeFileSync(path.join(save, 'region', 'r.0.0.mca'), Buffer.concat([fs.readFileSync(path.join(save, 'region', 'r.0.0.mca'))]));
  const s3 = await tm.createSnapshot({ saveDir: save, storeDir: store, label: '微调后' });
  console.log('快照3: 逻辑', (s3.totalSize / 1024).toFixed(0), 'KB | 实际写入', (s3.newBytes / 1024).toFixed(2), 'KB');

  const st = tm.stats({ storeDir: store });
  console.log('\n存储:', st.count, '个快照 | 逻辑', (st.logical / 1024).toFixed(0), 'KB | 物理', (st.physical / 1024).toFixed(0), 'KB | 去重比', st.ratio.toFixed(2) + 'x');

  console.log('\n=== 回滚 ===');
  // 先破坏存档
  fs.rmSync(path.join(save, 'region'), { recursive: true, force: true });
  fs.writeFileSync(path.join(save, 'BROKEN.txt'), 'oops');
  console.log('破坏后 region 存在:', fs.existsSync(path.join(save, 'region')));
  const r = await tm.restoreSnapshot({ saveDir: save, storeDir: store, id: s1.id });
  console.log('回滚:', JSON.stringify(r));
  console.log('回滚后 region 恢复:', fs.existsSync(path.join(save, 'region', 'r.0.0.mca')), '| 残留 BROKEN.txt:', fs.existsSync(path.join(save, 'BROKEN.txt')));
  console.log('回滚后大小:', (size(save) / 1024).toFixed(0), 'KB（应与原 一致）');
  const h2 = tm.healthCheck({ saveDir: save });
  console.log('回滚后再次体检 —— 有效区块:', h2.chunkTotal, '/ 损坏:', h2.badTotal, '（应为 5 / 1）');

  console.log('\n=== 快照清理 + GC ===');
  console.log('pruneAuto(keep=1):', JSON.stringify(tm.pruneAuto({ storeDir: store, world: path.basename(save), keep: 1 })));
  const g = tm.gc({ storeDir: store });
  console.log('GC: 回收', g.removed, '块, 释放', (g.freed / 1024).toFixed(0), 'KB');
  console.log('剩余快照:', tm.listSnapshots({ storeDir: store }).map((s) => s.label).join(', '));

  fs.rmSync(save, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
  console.log('\n临时目录已清理');
})();
