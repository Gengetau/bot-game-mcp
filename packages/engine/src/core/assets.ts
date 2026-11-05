/**
 * 图片素材（目前只有剧本杀的线索图用到）。
 *
 * 游戏只在消息里放图片引用（"剧本id/文件名"）和文字说明，不存图片本身。
 * 代码裁判取消息时（referee_step 的 inline_images=true），引擎通过 AssetStore 读图，以 base64 内嵌给裁判。
 *
 * 两种来源：
 *  - localAssets：本地目录 <dir>/<剧本id>/<文件名>。
 *  - driveAssets：Google 云盘。根文件夹下每个剧本一个子文件夹（以剧本 id 命名）。
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

export function mimeOf(file: string): string {
  return MIME[file.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
}

/** 拆分并校验 "剧本id/文件名"，防止路径穿越。 */
export function splitAsset(asset: string): { pack: string; file: string } {
  const i = asset.indexOf('/');
  const pack = asset.slice(0, i);
  const file = asset.slice(i + 1);
  if (i <= 0 || !PACK_ID_RE.test(pack) || !IMAGE_FILE_RE.test(file) || file.includes('..')) {
    throw new Error(`图片引用无效：${asset}`);
  }
  return { pack, file };
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
      const { pack, file } = splitAsset(asset);
      const full = join(root, pack, file);
      return { data: checkSize(readFileSync(full), asset), mime: mimeOf(file) };
    },
    sweep() {},
    async exists(asset) {
      const { pack, file } = splitAsset(asset);
      return existsSync(join(root, pack, file));
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

  async function download(gameId: string, asset: string): Promise<LoadedAsset> {
    const { pack, file } = splitAsset(asset);
    const full = join(cacheRoot, gameDir(gameId), pack, file);
    if (existsSync(full)) return { data: readFileSync(full), mime: mimeOf(file) };
    const folder = await findChild(o.folderId, pack, true);
    const id = await findChild(folder, file, false);
    let res: Response;
    try {
      res = await api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
    } catch (e) {
      // 文件可能在云盘里被替换过（ID 变了）：下次重新查
      ids.delete(`${folder}/${file}`);
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
      const { pack, file } = splitAsset(asset);
      try {
        await findChild(await findChild(o.folderId, pack, true), file, false);
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
