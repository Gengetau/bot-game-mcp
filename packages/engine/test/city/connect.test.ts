/**
 * 灯都外来 bot 接入页（GET /city/connect）和接入说明（docs/CITY-BOTS.md）的回归测试（#285）。
 *
 * 页面和文档是给外部主人看的：数字必须取自真实参数；不能出现任何密钥（桥接密钥、管理员密钥是内部凭证）、
 * 不能出现 R0 禁用旧词，也不能暴露常驻居民的家那一侧（页面里没有「小屋」）。
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOK_SHELF_BUYBACK_YEN } from '../../src/city/catalog.js';
import { mountCity } from '../../src/city/http.js';
import { HOUSE_ENTRANCE } from '../../src/city/index.js';
import { resolveCityParams } from '../../src/city/params.js';
import { makeCity, type CityTest } from './helpers.js';

const BRIDGE_SENTINEL = 'bridge-sentinel-do-not-print-0123456789';
const ADMIN_SENTINEL = 'admin-sentinel-do-not-print-0123456789';

const RENAME_R0 = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../docs/city/rename-r0.json', import.meta.url)), 'utf8')) as {
  forbidden_legacy_tokens_in_public_and_views: string[];
};
// R1（2026-11-20 主人改名：灯都→晴空都，绯渡→日和坂，镜池→棱光街，千灯→云港，澪川→浮光川；19:07 片区编号也换）。
// 禁用清单直接读对照表 docs/city/rename-r1.json（旧名和旧片区编号都在里面）。world_id city 不动。
const RENAME_R1 = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../docs/city/rename-r1.json', import.meta.url)), 'utf8')) as {
  forbidden_legacy_tokens_in_public_and_views: string[];
};
const FORBIDDEN_TOKENS = [
  ...new Set([...RENAME_R0.forbidden_legacy_tokens_in_public_and_views, ...RENAME_R1.forbidden_legacy_tokens_in_public_and_views]),
];
const DOC_PATH = fileURLToPath(new URL('../../../../docs/CITY-BOTS.md', import.meta.url));
const TOWN_BOTS_PATH = fileURLToPath(new URL('../../../../docs/TOWN-BOTS.md', import.meta.url));

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function serve(t: CityTest, opts: { requestsPerMinute?: number; admissionList?: boolean } = {}): Promise<string> {
  const app = express();
  mountCity(app, t.c, () => undefined, { bridgeKey: BRIDGE_SENTINEL, adminKeys: [ADMIN_SENTINEL], ...opts });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const legacyHits = (raw: string): string[] => FORBIDDEN_TOKENS.filter((tok) => raw.toLowerCase().includes(tok.toLowerCase()));

describe('接入页 /city/connect', () => {
  it('公开、只读、服务器渲染：状态码和安全头', async () => {
    const t = makeCity();
    const base = await serve(t);
    const res = await fetch(`${base}/city/connect`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // 带不带结尾斜杠都行
    expect((await fetch(`${base}/city/connect/`)).status).toBe(200);
    // 只读：不接受 POST
    expect((await fetch(`${base}/city/connect`, { method: 'POST' })).status).toBe(404);
  });

  it('不显示、不生成任何密钥：没有脚本、表单、输入框，也没有内部凭证和桥接接口的影子', async () => {
    const t = makeCity();
    const base = await serve(t);
    const html = await (await fetch(`${base}/city/connect`)).text();
    expect(html.includes(BRIDGE_SENTINEL)).toBe(false);
    expect(html.includes(ADMIN_SENTINEL)).toBe(false);
    const lower = html.toLowerCase();
    for (const bad of ['<script', '<form', '<input', '<textarea', 'bridgekey', 'bridge_key', '/city/bridge', '/city/api/admin', 'adminkeys']) {
      expect(lower.includes(bad), `页面不该出现 ${bad}`).toBe(false);
    }
    // 用的是「给该 bot 单独发的 MCP 密钥」，放请求头里，不放网址里
    expect(html).toContain('MCP 密钥');
    expect(html).toContain('Authorization: Bearer');
    expect(html).not.toContain('?key=');
  });

  it('零旧词、零内部口径：R0 禁用词、小屋、隐藏交接点都不出现', async () => {
    const t = makeCity();
    const base = await serve(t);
    const html = await (await fetch(`${base}/city/connect`)).text();
    expect(html).toContain('晴空都');
    expect(html).not.toContain('undefined');
    expect(legacyHits(html)).toEqual([]);
    expect(html.includes(HOUSE_ENTRANCE) || html.includes('小屋')).toBe(false);
  });

  it('数字取自真实参数：覆盖参数后页面跟着变；30 写明是外来 bot 的上限', async () => {
    const d = resolveCityParams({});
    const t0 = makeCity();
    const html0 = await (await fetch(`${await serve(t0)}/city/connect`)).text();
    expect(html0).toContain(`¥${d.firstEntryGrantYen.toLocaleString('en-US')}`);
    expect(html0).toContain(`${d.maxPresentExternal} 个外来 bot`);
    expect(html0).toContain('240'); // HTTP 每 IP 每分钟默认值

    const t = makeCity({
      params: { firstEntryGrantYen: 123_456, externalActsPerHour: 7, externalActsPerDay: 77, wakeBurst: 4, wakePerHour: 9, chatPerMinute: 2, chatMaxChars: 88, maxPresentExternal: 5, presenceLeaseMs: 20 * 60_000 },
    });
    const base = await serve(t, { requestsPerMinute: 99 });
    const html = await (await fetch(`${base}/city/connect`)).text();
    for (const s of ['¥123,456', '每小时 7 次', '每天 77 次', '突发 4 次', '每小时恢复 9 次', '每分钟 2 句', '每句最多 88 字', '5 个外来 bot', '20 分钟', '每个 IP 每分钟 99 次']) {
      expect(html.includes(s), `页面应含「${s}」`).toBe(true);
    }
    expect(html.includes('¥200,000')).toBe(false);
  });

  it('入口地点、准入和满员的口径与服务器一致', async () => {
    const t = makeCity();
    const base = await serve(t);
    const html = await (await fetch(`${base}/city/connect`)).text();
    expect(html).toContain('kumominato:station');
    expect(html).toContain('ryokogai:station');
    expect(html).toContain('not_admitted'); // 不在名单：不要重试
    expect(html).toContain('city_full'); // 人满了：过一阵再来
    expect(html).toContain('RATE_LIMITED');
    expect(html).toContain('world_query');
    expect(html).toContain('heartbeat'); // 保持在场的专用工具
    expect(html).toContain('同一把'); // 已有的栖灯镇/公共对局密钥通用，不用另要
    expect(html).toContain('云港片区'); // 入口编号对应新片区名
  });

  it('准入名单的口径跟着服务器实际设置走', async () => {
    const open = await (await fetch(`${await serve(makeCity())}/city/connect`)).text();
    expect(open).toContain('拿到密钥就能进城');
    expect(open.includes('有密钥还不够')).toBe(false);

    const listed = await (await fetch(`${await serve(makeCity(), { admissionList: true })}/city/connect`)).text();
    expect(listed).toContain('有密钥还不够');
    expect(listed).toContain('not_admitted');
    expect(listed.includes('拿到密钥就能进城')).toBe(false);
  });
});

describe('接入说明 docs/CITY-BOTS.md', () => {
  // 放在各条测试里读（不在 describe 体里），文档缺失时每条各自失败，不会拖垮整个文件的收集
  const readDoc = (): string => readFileSync(DOC_PATH, 'utf8');

  it('零旧词、零内部口径、不带密钥样子的串', () => {
    const doc = readDoc();
    expect(legacyHits(doc)).toEqual([]);
    expect(doc).toContain('晴空都');
    expect(doc.includes(HOUSE_ENTRANCE) || doc.includes('小屋')).toBe(false);
    expect(/bridgeKey|bridge_key|\/city\/bridge/i.test(doc)).toBe(false);
    // 没有看起来像真实密钥的长串，也没有 QQ 号样子的长数字
    expect(/[A-Za-z0-9_-]{32,}/.test(doc)).toBe(false);
    expect(/\b\d{6,}\b/.test(doc.replace(/\d{1,3}(,\d{3})+/g, ''))).toBe(false);
  });

  it('数字与默认参数一致，凭证口径写清', () => {
    const doc = readDoc();
    const d = resolveCityParams({});
    expect(doc).toContain(`¥${d.firstEntryGrantYen.toLocaleString('en-US')}`);
    expect(doc).toContain(`每小时 ${d.externalActsPerHour} 次`);
    expect(doc).toContain(`每天 ${d.externalActsPerDay} 次`);
    expect(doc).toContain(`${d.maxPresentExternal} 个外来 bot`);
    expect(doc).toContain('给该 bot 单独发的 MCP 密钥');
    expect(doc).toContain('city.allowedAgents');
    expect(doc).toContain('not_admitted');
    expect(doc).toContain('city_full');
    // 其余写死在文档里的数字也跟默认参数对上，改了默认值这里会红
    expect(doc).toContain(`每分钟 ${d.chatPerMinute} 句`);
    expect(doc).toContain(`每句最多 ${d.chatMaxChars} 字`);
    expect(doc).toContain(`突发 ${d.wakeBurst} 次`);
    expect(doc).toContain(`每小时恢复 ${d.wakePerHour} 次`);
    expect(doc).toContain('每个 IP 每分钟 240 次');
    expect(doc).toContain(`连续 ${Math.round(d.presenceLeaseMs / 60_000)} 分钟没有续期`);
    expect(doc).toContain(`每本 ¥${BOOK_SHELF_BUYBACK_YEN}`);
    expect(doc).toContain('同一把');
    expect(doc).toContain('heartbeat');
  });

  it('旧文档 TOWN-BOTS.md 已删除', () => {
    expect(existsSync(TOWN_BOTS_PATH)).toBe(false);
  });
});
