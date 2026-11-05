/**
 * 图片素材（目前只有剧本杀的线索图用到）。
 *
 * 游戏只在消息里放图片引用（"剧本id/文件名"）和文字说明，不存图片本身。
 * 代码裁判取消息时（referee_step 的 inline_images=true），引擎通过 AssetStore 读图，以 base64 内嵌给裁判。
 *
 * 两种来源：
 *  - localAssets：本地目录 <dir>/<剧本id>/<文件名>。
 *  - driveAssets：Google 云盘。根文件夹下每个剧本一个子文件夹，名字是剧本 id，或以 id 开头、后面跟着非字母数字
 *    （如「045-夜总会杀人夜（6人封闭）」「804霸道总裁」）。
 *  文件名可以带子文件夹（最多 3 层），如 "371/线索/04.jpg"。
 *    开局时把这一局要用的图下载到缓存目录 <cacheDir>/<对局id>/。对局结束后由 sweep 删除副本，
 *    缺了会按需重新下载（比如引擎中途重启后）。
 */
import { createSign } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface LoadedAsset {
  data: Buffer;
  mime: string;
}

export interface AssetStore {
  /** 开局时预取这一局会用到的图（后台进行，失败只记日志）。 */
  prepare(gameId: string, assets: string[]): void;
  /** 读一张图。 */
  load(gameId: string, asset: string): Promise<LoadedAsset>;
  /** 清理不在 active 里的对局的缓存副本。 */
  sweep(active: Set<string>): void;
  /** 只检查图在不在（不下载），check-script 用。 */
  exists(asset: string): Promise<boolean>;
}

/** 单张图片的大小上限 */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
export const IMAGE_FILE_RE = /^(?!\.)[^/\\:*?"<>|\u0000-\u001f]{1,100}\.(jpe?g|png|gif|webp)$/i;
const PACK_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DIR_RE = /^(?!\.)[^/\\:*?"<>|\u0000-\u001f]{1,100}$/;

/** 剧本里登记的图片路径：文件名，或「子文件夹/…/文件名」（最多 3 层子文件夹）。 */
export function isImagePath(p: string): boolean {
  const segs = p.split('/');
  if (segs.length > 4) return false;
  const file = segs.pop()!;
  return IMAGE_FILE_RE.test(file) && !file.includes('..') && segs.every((d) => DIR_RE.test(d) && d !== '..' && d.trim() === d);
}

/** 云盘里的剧本文件夹名是否对应这个剧本 id：同名，或以 id 开头、紧跟一个非字母数字字符。 */
export function folderMatchesPack(name: string, pack: string): boolean {
  if (name === pack) return true;
  return name.startsWith(pack) && name.length > pack.length && !/[A-Za-z0-9_]/.test(name[pack.length]!);
}

export function mimeOf(file: string): string {
  return MIME[file.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
}

/** 拆分并校验 "剧本id/文件名"，防止路径穿越。 */
export function splitAsset(asset: string): { pack: string; file: string; segs: string[] } {
  const i = asset.indexOf('/');
  const pack = asset.slice(0, i);
  const file = asset.slice(i + 1);
  if (i <= 0 || !PACK_ID_RE.test(pack) || !isImagePath(file)) {
    throw new Error(`图片引用无效：${asset}`);
  }
  return { pack, file, segs: file.split('/') };
}

function checkSize(data: Buffer, asset: string): Buffer {
  if (data.length > MAX_ASSET_BYTES) throw new Error(`图片 ${asset} 超过 ${MAX_ASSET_BYTES / 1024 / 1024}MB`);
  return data;
}

/** 本地目录素材库：<dir>/<剧本id>/<文件名>。 */
export function localAssets(dir: string): AssetStore {
  const root = resolve(dir);
  return {
    prepare() {},
    async load(_gameId, asset) {
      const { pack, file, segs } = splitAsset(asset);
      const full = join(root, pack, ...segs);
      return { data: checkSize(readFileSync(full), asset), mime: mimeOf(file) };
    },
    sweep() {},
    async exists(asset) {
      const { pack, segs } = splitAsset(asset);
      return existsSync(join(root, pack, ...segs));
    },
  };
}

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export interface DriveOptions {
  /** 根文件夹 ID（云盘网址 folders/ 后面那一段） */
  folderId: string;
  credentials: ServiceAccount;
  /** 本地缓存目录（每局一个子目录，结束后删除） */
  cacheDir: string;
  /** 对局结束（或引擎重启后发现无主）后缓存保留多久再删（毫秒），给结束时的图片留出发送时间 */
  graceMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Google 云盘素材库（服务账号，只读权限）。 */
export function driveAssets(o: DriveOptions): AssetStore {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const cacheRoot = resolve(o.cacheDir);
  const grace = o.graceMs ?? 15 * 60_000;
  let token: { value: string; exp: number } | null = null;
  const ids = new Map<string, string>();
  const inflight = new Map<string, Promise<LoadedAsset>>();
  /** 缓存目录 → 第一次发现它的对局已不在进行中的时间 */
  const idleSince = new Map<string, number>();

  async function accessToken(): Promise<string> {
    if (token && token.exp > now() + 60_000) return token.value;
    const iat = Math.floor(now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({
        iss: o.credentials.client_email,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        aud: 'https://oauth2.googleapis.com/token',
        iat,
        exp: iat + 3600,
      }),
    );
    const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(o.credentials.private_key).toString('base64url');
    const res = await doFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }).toString(),
    });
    if (!res.ok) throw new Error(`云盘授权失败：HTTP ${res.status}`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error('云盘授权失败：没有返回 access_token');
    token = { value: j.access_token, exp: now() + (j.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  async function api(url: string): Promise<Response> {
    const res = await doFetch(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
    if (!res.ok) throw new Error(`云盘请求失败：HTTP ${res.status}`);
    return res;
  }

  async function findChild(parent: string, name: string, folder: boolean): Promise<string> {
    const key = `${parent}/${name}`;
    const hit = ids.get(key);
    if (hit) return hit;
    const query = `'${q(parent)}' in parents and name = '${q(name)}' and trashed = false` + (folder ? ` and mimeType = '${FOLDER_MIME}'` : '');
    const url =
      'https://www.googleapis.com/drive/v3/files?' +
      new URLSearchParams({ q: query, fields: 'files(id,name,size)', pageSize: '10', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' }).toString();
    const j = (await (await api(url)).json()) as { files?: { id: string; size?: string }[] };
    const f = j.files?.[0];
    if (!f) throw new Error(`云盘里找不到 ${folder ? '文件夹' : '文件'} ${name}`);
    if (!folder && f.size && Number(f.size) > MAX_ASSET_BYTES) throw new Error(`图片 ${name} 超过 ${MAX_ASSET_BYTES / 1024 / 1024}MB`);
    ids.set(key, f.id);
    return f.id;
  }

  /** 根文件夹下这个剧本的文件夹（同名或以 id 开头）。 */
  async function packFolder(pack: string): Promise<string> {
    const key = `${o.folderId}#${pack}`;
    const hit = ids.get(key);
    if (hit) return hit;
    const query = `'${q(o.folderId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const url =
      'https://www.googleapis.com/drive/v3/files?' +
      new URLSearchParams({ q: query, fields: 'files(id,name)', pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' }).toString();
    const j = (await (await api(url)).json()) as { files?: { id: string; name: string }[] };
    const files = j.files ?? [];
    const f = files.find((x) => x.name === pack) ?? files.find((x) => folderMatchesPack(x.name, pack));
    if (!f) throw new Error(`云盘里找不到文件夹 ${pack}`);
    ids.set(key, f.id);
    return f.id;
  }

  /** 找到图片文件的 ID（逐层进子文件夹）；返回它所在文件夹的 ID 和文件 ID。 */
  async function locate(pack: string, segs: string[]): Promise<{ parent: string; id: string }> {
    let parent = await packFolder(pack);
    for (const d of segs.slice(0, -1)) parent = await findChild(parent, d, true);
    return { parent, id: await findChild(parent, segs[segs.length - 1]!, false) };
  }

  async function download(gameId: string, asset: string): Promise<LoadedAsset> {
    const { pack, file, segs } = splitAsset(asset);
    const full = join(cacheRoot, gameDir(gameId), pack, ...segs);
    if (existsSync(full)) return { data: readFileSync(full), mime: mimeOf(file) };
    const { parent, id } = await locate(pack, segs);
    let res: Response;
    try {
      res = await api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
    } catch (e) {
      // 文件可能在云盘里被替换过（ID 变了）：下次重新查
      ids.delete(`${parent}/${segs[segs.length - 1]}`);
      throw e;
    }
    const data = checkSize(Buffer.from(await res.arrayBuffer()), asset);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
    return { data, mime: mimeOf(file) };
  }

  const store: AssetStore = {
    prepare(gameId, assets) {
      for (const a of assets) store.load(gameId, a).catch((e) => log(`⚠️  预取图片 ${a} 失败：${e instanceof Error ? e.message : String(e)}`));
    },
    load(gameId, asset) {
      const key = `${gameId}\n${asset}`;
      let p = inflight.get(key);
      if (!p) {
        p = download(gameId, asset).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      return p;
    },
    async exists(asset) {
      const { pack, segs } = splitAsset(asset);
      try {
        await locate(pack, segs);
        return true;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('云盘里找不到')) return false;
        throw e;
      }
    },
    sweep(active) {
      if (!existsSync(cacheRoot)) return;
      const keep = new Set([...active].map(gameDir));
      for (const name of readdirSync(cacheRoot)) {
        if (keep.has(name)) {
          idleSince.delete(name);
          continue;
        }
        const since = idleSince.get(name) ?? now();
        idleSince.set(name, since);
        if (now() - since < grace) continue;
        const full = join(cacheRoot, name);
        try {
          rmSync(full, { recursive: true, force: true });
          idleSince.delete(name);
          log(`已清理对局 ${name} 的图片副本`);
        } catch {
          /* 下次再试 */
        }
      }
    },
  };
  return store;
}

function gameDir(gameId: string): string {
  return gameId.replace(/[^A-Za-z0-9_-]/g, '_');
}
