/**
 * 通用的哈希、稳定序列化与请求号校验规则。
 */
import { createHash } from 'node:crypto';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/** 请求号：8~80 个字符，只能是字母、数字、下划线和 . : -（文档、MCP schema、接入端同一个规则）。 */
export const REQUEST_ID_RE = /^[\w.:-]{8,80}$/;
