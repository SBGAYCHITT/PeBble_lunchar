#!/usr/bin/env node
/**
 * SignPath 提交脚本 —— 把构建产物提交到 SignPath Foundation 签名并下载签名结果。
 * 纯 Node 实现（Node 18+ 自带 fetch / FormData / Blob），无需额外依赖。
 *
 * 为什么走 SignPath：自签名证书在 Smart App Control（SAC）强制模式下会被拦（SAC 要求
 * 「受信任 CA 链 + 云信誉」，自签名两样都不占）。SignPath Foundation 提供免费 OV 级证书，
 * 且身为知名发行方、证书有现成信誉，分发时 SAC / SmartScreen 都能放行。
 *
 * 前置（一次性，详见 SIGNING.md）：
 *   1) 项目开源（公开仓库 + OSI 许可证）并在 https://signpath.org 申请通过
 *   2) SignPath 后台建项目、签名策略(signingPolicySlug)、构件配置(artifactConfigurationSlug，
 *      类型选 Zip，并配置"对全部 .exe / .dll 签名")
 *   3) 拿到 API token（CI 用户）与 organizationId
 *
 * 环境变量（必填）：
 *   SIGNPATH_API_TOKEN               SignPath API token
 *   SIGNPATH_ORG_ID                 organizationId
 *   SIGNPATH_PROJECT_SLUG            projectSlug
 *   SIGNPATH_POLICY_SLUG             signingPolicySlug
 * 可选：
 *   SIGNPATH_ARTIFACT_CONFIG_SLUG    构件配置 slug（不填用项目默认）
 *   SIGNPATH_API_URL                 默认 https://app.signpath.io/Api/v1/
 *
 * 用法：
 *   node scripts/signpath-sign.js <input.zip> <output.zip> [description]
 *   注意：input 必须是 .zip（SignPath 走构件配置批量签名，把要签的文件打进 zip 再传）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const API_URL = (process.env.SIGNPATH_API_URL || 'https://app.signpath.io/Api/v1/').replace(/\/+$/, '') + '/';
const TOKEN = process.env.SIGNPATH_API_TOKEN;
const ORG = process.env.SIGNPATH_ORG_ID;
const PROJECT = process.env.SIGNPATH_PROJECT_SLUG;
const POLICY = process.env.SIGNPATH_POLICY_SLUG;
const ARTIFACT_CFG = process.env.SIGNPATH_ARTIFACT_CONFIG_SLUG;

function fail(msg) {
  console.error('[signpath] ' + msg);
  process.exit(1);
}

if (!TOKEN || !ORG || !PROJECT || !POLICY) {
  fail('缺少环境变量：需要 SIGNPATH_API_TOKEN / SIGNPATH_ORG_ID / SIGNPATH_PROJECT_SLUG / SIGNPATH_POLICY_SLUG（见 SIGNING.md）');
}
if (typeof globalThis.fetch !== 'function') {
  fail('当前 Node 版本过低，需要 Node 18+（自带 fetch）');
}

const [, , input, output, description] = process.argv;
if (!input || !output) fail('用法：node scripts/signpath-sign.js <input.zip> <output.zip> [description]');
if (!fs.existsSync(input)) fail('输入文件不存在：' + input);
if (!/\.zip$/i.test(input)) fail('input 必须是 .zip（把要签的文件打成 zip 再传）');

const AUTH = { Authorization: 'Bearer ' + TOKEN };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submit() {
  const buf = fs.readFileSync(input);
  const form = new FormData();
  form.append('projectSlug', PROJECT);
  form.append('signingPolicySlug', POLICY);
  if (ARTIFACT_CFG) form.append('artifactConfigurationSlug', ARTIFACT_CFG);
  form.append('artifact', new Blob([buf], { type: 'application/zip' }), path.basename(input));
  if (description) form.append('description', description);

  const url = API_URL + ORG + '/SigningRequests/SubmitWithArtifact';
  console.log('[signpath] 提交签名请求 → ' + url + '  (' + Math.round(buf.length / 1048576) + ' MB)');
  const res = await fetch(url, { method: 'POST', headers: AUTH, body: form });
  if (res.status !== 201) {
    const txt = await res.text().catch(() => '');
    fail('提交失败 HTTP ' + res.status + '：' + txt.slice(0, 600));
  }
  const loc = res.headers.get('Location');
  if (!loc) fail('提交成功但未返回 Location 头');
  // Location 可能是相对路径，归一化到完整 URL
  const full = /^https?:\/\//i.test(loc) ? loc : API_URL + ORG + '/' + loc.replace(/^\/+/, '');
  console.log('[signpath] 签名请求已创建：' + full);
  return full;
}

async function waitStatus(loc) {
  const deadline = Date.now() + 30 * 60 * 1000; // 最多等 30 分钟（含人工批准）
  while (Date.now() < deadline) {
    const r = await fetch(loc + '/Status', { headers: AUTH });
    if (!r.ok) fail('查询状态失败 HTTP ' + r.status);
    const j = await r.json();
    const s = j.status || j.workflowStatus || 'Unknown';
    console.log('[signpath] 状态: ' + s + (j.isFinalStatus ? ' (终态)' : ''));
    if (j.isFinalStatus) {
      if (s === 'Completed') return true;
      fail('签名请求终态非成功：' + s);
    }
    if (s === 'WaitingForApproval') {
      console.log('[signpath] 等待人工批准 —— 去 SignPath 后台（Signing Requests）点 Approve。');
    }
    await sleep(10000);
  }
  fail('等待超时（30 分钟）。若仍在等待批准，请去后台确认；产物已在 SignPath 侧，可重新拉取。');
}

async function download(loc) {
  const r = await fetch(loc + '/SignedArtifact', { headers: AUTH });
  if (!r.ok) fail('下载签名结果失败 HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(output, buf);
  console.log('[signpath] 已写入签名结果：' + output + ' （' + Math.round(buf.length / 1024) + ' KB）');
}

(async () => {
  try {
    const loc = await submit();
    if (await waitStatus(loc)) await download(loc);
  } catch (e) {
    fail('异常：' + (e && e.message ? e.message : String(e)));
  }
})();
