/**
 * 标准街区内容包注册表与插件校验器（CONTENT-PACK-SPEC.md §4）。
 */
import { JINBOCHO_PACK } from './jinbocho.js';
import { SHIMOKITAZAWA_PACK } from './shimokitazawa.js';
import type { CityContentPack } from './types.js';

export * from './types.js';
export { JINBOCHO_PACK } from './jinbocho.js';
export { SHIMOKITAZAWA_PACK } from './shimokitazawa.js';

/** 当前挂载的标准街区内容包列表。 */
export const MOUNTED_CONTENT_PACKS: readonly CityContentPack[] = [
  JINBOCHO_PACK,
  SHIMOKITAZAWA_PACK,
];

const MUN_ID_RE = /^mun:13\d{3}$/;
const DIST_ID_RE = /^dist:[a-z0-9-]+$/;
const STATION_ID_RE = /^st:[a-z0-9-]+$/;
const EDGE_ID_RE = /^te:[a-z0-9-]+$/;

/** 校验单个标准街区内容包的四层地理 ID、真实/虚构分层与模拟数值规范。 */
export function validateContentPack(pack: CityContentPack): string[] {
  const problems: string[] = [];
  if (pack.specVersion !== 1) problems.push(`内容包 ${pack.packId} specVersion 必须为 1`);
  if (!/^pack:[a-z0-9-]+$/.test(pack.packId)) problems.push(`内容包 ID 格式不合法：${pack.packId}`);
  if (!MUN_ID_RE.test(pack.municipality.id)) problems.push(`内容包 ${pack.packId} 自治体 ID 不符合 ^mun:13\\d{3}$：${pack.municipality.id}`);
  if (!DIST_ID_RE.test(pack.district.id)) problems.push(`内容包 ${pack.packId} 街区 ID 不符合 ^dist:[a-z0-9-]+$：${pack.district.id}`);
  if (pack.district.municipalityId !== pack.municipality.id) {
    problems.push(`内容包 ${pack.packId} 的 district.municipalityId 与 municipality.id 不一致`);
  }
  for (const s of pack.stations) {
    if (!STATION_ID_RE.test(s.id)) problems.push(`内容包 ${pack.packId} 车站 ID 格式不合法：${s.id}`);
  }
  for (const e of pack.transitEdges) {
    if (!EDGE_ID_RE.test(e.id)) problems.push(`内容包 ${pack.packId} 交通边 ID 格式不合法：${e.id}`);
    if (!e.operator) problems.push(`内容包 ${pack.packId} 交通边 ${e.id} 缺少 operator`);
    if (e.distanceKm !== undefined && (!Number.isFinite(e.distanceKm) || e.distanceKm <= 0)) {
      problems.push(`内容包 ${pack.packId} 交通边 ${e.id} 的营业里程 distanceKm 无效`);
    }
  }
  for (const p of pack.places) {
    if (p.fictional && p.source !== 'fictional') {
      problems.push(`内容包 ${pack.packId} 虚构场所 ${p.id} 的 source 必须为 "fictional"`);
    }
    if (!p.fictional && p.source === 'fictional') {
      problems.push(`内容包 ${pack.packId} 非虚构场所 ${p.id} 不能使用 source="fictional"`);
    }
    if (!p.fictional && p.goods.length > 0) {
      problems.push(`内容包 ${pack.packId} 真实公共场所 ${p.id} 不得直接挂虚构商业商品`);
    }
  }
  return problems;
}
