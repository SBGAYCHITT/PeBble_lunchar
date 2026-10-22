// 从 Mojang 的 version_manifest 里挑选「要展示给用户的版本」。
//
// 抽成独立模块的理由：这段逻辑之前埋在 ipc/versions.js 里写成 `slice(0, 120)`，
// 而 Mojang 的清单是按时间倒序的，于是 2023-06 发布的 1.20.1（第 223 位）
// 直接被截没了 —— 想装老版本的用户在列表里根本找不到它。
// 纯函数、零依赖，才能单独把「哪些版本必须存在」钉成测试。

/** 快照最多保留多少个（正式版不设上限） */
const MAX_SNAPSHOTS = 60;

/**
 * 正式版全收 + 最近 N 个快照，保持原有顺序。
 *
 * 为什么正式版不设上限：Mojang 至今一共才一百多个正式版，增长速度是每年十几个，
 * 全量带上的体积可以忽略；而"某个特定年份的版本必须能选到"是硬需求 ——
 * Mod 生态里 1.20.1 这类老版本至今仍是主流。
 * 快照则相反：数量多、生命周期短，只留最近的，否则列表会一直膨胀。
 *
 * @param {Array<{id:string,type:string}>} all 完整清单（时间倒序）
 * @param {number} [maxSnapshots]
 * @returns {Array<{id:string,type:string}>}
 */
function pickManifestVersions(all, maxSnapshots = MAX_SNAPSHOTS) {
  if (!Array.isArray(all)) return [];
  const limit = Number.isFinite(maxSnapshots) && maxSnapshots >= 0 ? maxSnapshots : MAX_SNAPSHOTS;
  /** @type {Array<{id:string,type:string}>} */
  const out = [];
  let snaps = 0;
  for (const v of all) {
    if (!v || typeof v !== 'object') continue;
    if (v.type === 'release') {
      out.push(v);
    } else if (v.type === 'snapshot' && snaps < limit) {
      out.push(v);
      snaps++;
    }
  }
  return out;
}

module.exports = { pickManifestVersions, MAX_SNAPSHOTS };
