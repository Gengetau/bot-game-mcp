/**
 * 剧本杀数据包：格式校验与加载。
 *
 * 数据包是放在私有目录里的 JSON 文件（配置项 scriptsDir），**绝不能提交进本仓库**：
 * 剧本通常是商业作品，而且文件里含有全部真相。格式说明见 docs/JUBENSHA.md。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { isImagePath } from '../../core/assets.js';

const text = (max: number) => z.string().trim().max(max);
const key = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,24}$/, '角色 key 只能用字母、数字、下划线和短横线（1~24 个字符）');
const imageId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, '图片 id 只能用字母、数字、下划线和短横线（1~32 个字符）');
const imageList = z.array(imageId).max(30).default([]);

export const packSchema = z
  .object({
    /** 剧本编号（开房时 script=该值），如 "045" */
    id: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,32}$/, 'id 只能用字母、数字、下划线和短横线'),
    title: text(60).min(1),
    /** 玩家人数（不含 DM） */
    players: z.number().int().min(2).max(12),
    /** 一句话简介（公开，列剧本时显示，不能剧透） */
    summary: text(300).default(''),
    /** 开场念白 / 故事背景（公开，开局时群里播报） */
    intro: text(8000).default(''),
    /** 本剧本特有的规则说明（公开） */
    rules_note: text(3000).default(''),
    /**
     * 图片线索。文件放在素材库里剧本 id 同名的文件夹下（本地目录或 Google 云盘）。
     * caption 是图片的文字说明：AI 玩家只看得到它，所以要写全图上的关键信息。
     */
    images: z
      .array(
        z.object({
          id: imageId,
          file: z.string().trim().refine(isImagePath, '图片文件名要以 .jpg/.jpeg/.png/.gif/.webp 结尾，可以带最多 3 层子文件夹（如 线索/04.jpg），不能有 ..'),
          caption: text(2000).min(1),
        }),
      )
      .max(200)
      .default([]),
    /** 开场念白之后在群里发的图（如地图、人物关系图） */
    intro_images: imageList,
    roles: z
      .array(
        z.object({
          key,
          /** 角色名 */
          name: text(30).min(1),
          /** 性别（仅供选角参考，程序暂不按性别分配） */
          gender: z.enum(['male', 'female', 'any']).default('any'),
          /** 公开介绍：开局时所有人都能看到 */
          public: text(1000).default(''),
          /** 人物剧本：开局私发给扮演者 */
          script: text(20000).min(1),
          /** 认罪书：仅凶手需要；投票后凶手按它坦白 */
          confession: text(5000).default(''),
          /** 随人物剧本私发的图 */
          images: imageList,
        }),
      )
      .min(2),
    /** 按进程解锁的各幕 / 各节 */
    acts: z
      .array(
        z.object({
          title: text(40).min(1),
          /** 本幕开始时群里播报的公开内容（可空） */
          public: text(8000).default(''),
          /** 本幕私发给各角色的内容：角色 key → 文本（可只给部分角色） */
          private: z.record(z.string(), text(20000)).default({}),
          /** 本幕开始时群里发的图 */
          public_images: imageList,
          /** 本幕私发给各角色的图：角色 key → 图片 id 列表 */
          private_images: z.record(z.string(), z.array(imageId).max(30)).default({}),
          /** 本幕自由讨论时长（分钟），不填用开房选项 discuss_minutes */
          discuss_minutes: z.number().int().min(1).max(60).optional(),
        }),
      )
      .min(1),
    vote: z.object({ question: text(200).default('谁是凶手？') }).default({ question: '谁是凶手？' }),
    /** 凶手角色 key（可多个；投票得票最多者是其中之一即算破案） */
    culprits: z.array(key).min(1),
    /** 真相全文（结束时公布） */
    truth: text(30000).min(1),
    /** 公布真相时发的图 */
    truth_images: imageList,
    endings: z
      .object({
        /** 破案时的结局念白 */
        solved: text(5000).default(''),
        /** 凶手逃脱时的结局念白 */
        unsolved: text(5000).default(''),
      })
      .default({ solved: '', unsolved: '' }),
    /** 预置答疑：玩家问 DM 时，没有 DM 就按关键词自动回答 */
    faq: z
      .array(z.object({ keywords: z.array(text(30).min(1)).min(1), answer: text(1000).min(1) }))
      .default([]),
    /** 给 DM 的主持手册（只有 DM 能看到） */
    host_notes: text(20000).default(''),
  })
  .superRefine((p, ctx) => {
    const keys = p.roles.map((r) => r.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: '角色 key 有重复', path: ['roles'] });
    if (p.roles.length !== p.players) {
      ctx.addIssue({ code: 'custom', message: `roles 数量（${p.roles.length}）必须等于 players（${p.players}）`, path: ['roles'] });
    }
    for (const c of p.culprits) {
      if (!keys.includes(c)) ctx.addIssue({ code: 'custom', message: `culprits 里的 ${c} 不是已定义的角色`, path: ['culprits'] });
    }
    const imgs = p.images.map((x) => x.id);
    if (new Set(imgs).size !== imgs.length) ctx.addIssue({ code: 'custom', message: '图片 id 有重复', path: ['images'] });
    const checkImgs = (list: string[], where: string, path: (string | number)[]) => {
      for (const id of list) if (!imgs.includes(id)) ctx.addIssue({ code: 'custom', message: `${where}里的图片 ${id} 没有在 images 里定义`, path });
    };
    checkImgs(p.intro_images, 'intro_images ', ['intro_images']);
    checkImgs(p.truth_images, 'truth_images ', ['truth_images']);
    p.roles.forEach((r, i) => checkImgs(r.images, `角色 ${r.key} 的 images `, ['roles', i, 'images']));
    p.acts.forEach((a, i) => {
      for (const k of Object.keys(a.private)) {
        if (!keys.includes(k)) ctx.addIssue({ code: 'custom', message: `第 ${i + 1} 幕 private 里的 ${k} 不是已定义的角色`, path: ['acts', i, 'private'] });
      }
      checkImgs(a.public_images, `第 ${i + 1} 幕 public_images `, ['acts', i, 'public_images']);
      for (const [k, list] of Object.entries(a.private_images)) {
        if (!keys.includes(k)) ctx.addIssue({ code: 'custom', message: `第 ${i + 1} 幕 private_images 里的 ${k} 不是已定义的角色`, path: ['acts', i, 'private_images'] });
        checkImgs(list, `第 ${i + 1} 幕 private_images.${k} `, ['acts', i, 'private_images']);
      }
    });
  });

export type ScriptPack = z.infer<typeof packSchema>;
export type PackRole = ScriptPack['roles'][number];

export interface PackSummary {
  id: string;
  title: string;
  players: number;
  summary: string;
}

/** 剧本来源。引擎只通过它取数据包，不关心存放方式。 */
export interface ScriptLibrary {
  get(id: string): ScriptPack | null;
  list(): PackSummary[];
  /** 加载失败的文件（文件名 → 原因），供运维排查 */
  errors(): Record<string, string>;
}

/** 校验一个数据包对象；失败抛出带中文原因的 Error。 */
export function parsePack(raw: unknown, source = '数据包'): ScriptPack {
  const r = packSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(`${source} 格式无效：${r.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('；')}`);
  }
  return r.data;
}

/** 内存剧本库（测试、模拟器用）。 */
export function memoryLibrary(packs: unknown[]): ScriptLibrary {
  const map = new Map<string, ScriptPack>();
  for (const [i, raw] of packs.entries()) {
    const p = parsePack(raw, `第 ${i + 1} 个数据包`);
    map.set(p.id, p);
  }
  return {
    get: (id) => map.get(id) ?? null,
    list: () => [...map.values()].map(summaryOf),
    errors: () => ({}),
  };
}

function summaryOf(p: ScriptPack): PackSummary {
  return { id: p.id, title: p.title, players: p.players, summary: p.summary };
}

/**
 * 目录剧本库：读取 dir 下的 *.json。文件改动后（按修改时间）自动重新加载，新增剧本不用重启引擎。
 * dir 不存在时视为空库。
 */
export function directoryLibrary(dir: string): ScriptLibrary {
  const root = resolve(dir);
  /** 文件路径 → 解析结果（按修改时间缓存） */
  let files = new Map<string, { mtime: number; pack: ScriptPack }>();
  let byId = new Map<string, ScriptPack>();
  let errs: Record<string, string> = {};
  const scan = () => {
    const nextFiles = new Map<string, { mtime: number; pack: ScriptPack }>();
    const nextById = new Map<string, ScriptPack>();
    const nextErrs: Record<string, string> = {};
    if (existsSync(root)) {
      for (const name of readdirSync(root).sort()) {
        if (!name.endsWith('.json')) continue;
        const full = join(root, name);
        try {
          const mtime = statSync(full).mtimeMs;
          const old = files.get(full);
          const pack = old && old.mtime === mtime ? old.pack : parsePack(JSON.parse(readFileSync(full, 'utf8')), name);
          if (nextById.has(pack.id)) throw new Error(`剧本 id ${pack.id} 与其他文件重复`);
          nextFiles.set(full, { mtime, pack });
          nextById.set(pack.id, pack);
        } catch (e) {
          nextErrs[name] = e instanceof Error ? e.message : String(e);
        }
      }
    }
    files = nextFiles;
    byId = nextById;
    errs = nextErrs;
  };
  return {
    get(id) {
      scan();
      return byId.get(id) ?? null;
    },
    list() {
      scan();
      return [...byId.values()].map(summaryOf);
    },
    errors() {
      scan();
      return { ...errs };
    },
  };
}

/** 空剧本库（未配置 scriptsDir 时使用）。 */
export const emptyLibrary: ScriptLibrary = { get: () => null, list: () => [], errors: () => ({}) };

/** 剧本里所有图片的素材引用（"剧本id/文件名"），供开局预取。 */
export function packAssets(p: ScriptPack): string[] {
  return p.images.map((x) => `${p.id}/${x.file}`);
}
