/**
 * 剧本杀 AI 座位视图的预算与分段工具（纯函数：不读 rec、不取时间、不用随机数）。
 *
 * 背景：反馈单 FB261108-02，get_my_view 一次返回几万字，AI 主持人读不下。
 * 做法：默认视图只给摘要和目录（you.sections），长文截成开头一段并写明去哪取全；
 * 详情用 get_my_view({section, page}) 按需取（纯读）。预算只管「静态部分」（整个返回值去掉 new_events），
 * 事件另外约束（见 agentEventText）。真人座位网页不受影响。
 */
import { normalizeText } from '../../core/text.js';

/** 一段详情一页的字数（与旧的 DM lookup 一致，已在线上跑过） */
export const SECTION_PAGE = 6000;
/** 静态部分上限；适用于座位数 ≤6 且幕数 ≤6 的包 */
export const DM_VIEW_BUDGET = 16000;
export const PLAYER_VIEW_BUDGET = 30000;
export const DM_NOTES_INLINE = 2500;
export const DM_TRUTH_INLINE = 1500;
export const DM_FAQ_INLINE = 1000;
export const DM_CLUES_LISTED = 12;
export const OPEN_Q_LISTED = 4;
export const MY_Q_LISTED = 5;
/** 列出的每条提问 / 回答在视图里最多给多少字（提问最长 600 字）；全文用 section:"questions" */
export const Q_TEXT_INLINE = 400;
export const PLAYER_SCRIPT_INLINE = 4000;
/** 凶手的认罪书（和人物剧本、各幕私密同时出现在坦白阶段，所以单独给小一点的上限） */
export const PLAYER_CONFESSION_INLINE = 2000;
export const PLAYER_ACTS_INLINE = 3500;
export const PLAYER_CARDS_INLINE = 2500;
export const PLACE_TITLES_LISTED = 5;
export const IMAGE_CAPTION_INLINE = 400;
/** 一个视图里所有图片说明（人物剧本、各幕、线索卡；公开线索另算一份）合计的内联字数；放不下的张数在列表末尾留一行指引 */
export const IMAGES_INLINE = 2400;
/** public.search.log（每次搜证一条，公开）只给最近几条，其余记 log_more */
export const SEARCH_LOG_LISTED = 20;
export const QUIZ_PUBLIC_INLINE = 2000;
export const CAST_PUBLIC_INLINE = 150;
export const SHARED_CLUE_INLINE = 800;
export const SHARED_TOTAL_INLINE = 4000;
export const PUBLIC_TRUTH_INLINE = 800;
/** 被改写成指引行的私密重复事件，每条的字数上限 */
export const POINTER_MAX = 200;
export const FIND_MAX_HITS = 8;
export const FIND_SNIPPET = 160;
/** 被截成「前几个字」的幕 / 线索卡留多少字 */
export const STUB_CHARS = 200;
/** 公开线索放不下时留多少字 */
export const SHARED_STUB_CHARS = 120;
export const SECTION_MAX_LEN = 80;

/** 座位和幕多的包按比例放宽（目录、角色表、acts 列表、幕存根都随之变长） */
export function viewBudget(role: 'dm' | 'player', seats: number, acts: number): number {
  const s = Math.max(0, seats - 6);
  const a = Math.max(0, acts - 6);
  return role === 'dm' ? DM_VIEW_BUDGET + 250 * (s + a) : PLAYER_VIEW_BUDGET + 400 * s + 300 * a;
}

/** 超过 max 字时截成开头一段，并写明总字数和去哪取；不超过时原样返回同一个字符串。 */
export function clip(text: string, max: number, where: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（共 ${text.length} 字，这里只给了前 ${max} 字；${where}）`;
}

/**
 * 图片说明列表的内联预算：每条先截到 IMAGE_CAPTION_INLINE，再按 budget.left 合计限制；
 * 放不下的从这一张起整体省略，列表末尾留一行指引（仍是字符串数组）。
 */
export function capCaptions(list: string[], where: string, budget: { left: number }): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    const t = c.length > IMAGE_CAPTION_INLINE ? `${c.slice(0, IMAGE_CAPTION_INLINE)}…（共 ${c.length} 字，全文见 ${where}）` : c;
    if (t.length > budget.left) {
      out.push(`…（还有 ${list.length - i} 张图的说明这里没有显示，全文见 ${where}）`);
      break;
    }
    budget.left -= t.length;
    out.push(t);
  }
  return out;
}

/** 存根：前 STUB_CHARS 字 + 指引（用于放不下的幕、线索卡） */
export function stub(text: string, where: string): string {
  return `${text.slice(0, STUB_CHARS)}…（共 ${text.length} 字；${where}）`;
}

export function getViewCall(section: string, page?: number): string {
  return `get_my_view({"section":${JSON.stringify(section)}${page ? `,"page":${page}` : ''}})`;
}

/**
 * 从最新的往前放：items 按时间从旧到新排列，返回每项是否完整放得下。
 * size(i) 是第 i 项的字数；放不下的项不占预算（它们只留存根）。
 */
export function fitFromNewest(sizes: number[], budget: number): boolean[] {
  const fits = new Array<boolean>(sizes.length).fill(false);
  let used = 0;
  for (let i = sizes.length - 1; i >= 0; i--) {
    if (used + sizes[i]! <= budget) {
      fits[i] = true;
      used += sizes[i]!;
    }
  }
  return fits;
}

export interface Paged {
  page: number;
  pages: number;
  chars: number;
  text: string;
}

/** 按固定字数分页（与旧 lookup 一致：pages = ceil(chars / SECTION_PAGE)）；超出范围按最后一页。 */
export function paginate(text: string, page: number): Paged {
  const pages = Math.max(1, Math.ceil(text.length / SECTION_PAGE));
  const p = Math.min(pages, Math.max(1, Math.trunc(page) || 1));
  return { page: p, pages, chars: text.length, text: text.slice((p - 1) * SECTION_PAGE, p * SECTION_PAGE) };
}

// ───────────────────────── 段名 ─────────────────────────

export type SectionRef =
  | { kind: 'host_notes' | 'truth' | 'faq' | 'clues' | 'questionnaire' | 'images' | 'questions' | 'places' | 'script' | 'confession' }
  | { kind: 'role'; n: number }
  | { kind: 'act'; n: number }
  | { kind: 'clue'; id: string }
  | { kind: 'find'; q: string };

const FIXED = ['host_notes', 'truth', 'faq', 'clues', 'questionnaire', 'images', 'questions', 'places', 'script', 'confession'] as const;

/**
 * 解析段名（lookup 别名和取段都走这一个，没有第二套）。
 * 失败（格式不对）返回 null；段存不存在、是不是你的由游戏判断，三者对外是同一个拒绝。
 */
export function parseSection(raw: string): SectionRef | null {
  if (typeof raw !== 'string' || raw.length > SECTION_MAX_LEN) return null;
  const s = normalizeText(raw);
  if (!s) return null;
  const colon = s.indexOf(':');
  if (colon < 0) {
    const low = s.toLowerCase();
    const hit = FIXED.find((k) => k === low);
    return hit ? ({ kind: hit } as SectionRef) : null;
  }
  const head = s.slice(0, colon).trim().toLowerCase();
  if (head === 'clue') {
    // 线索 id 区分大小写，取原文（和 pack.clues[].id 一致）
    const id = raw.slice(raw.search(/[:：]/u) + 1).trim();
    return id ? { kind: 'clue', id } : null;
  }
  const rest = s.slice(colon + 1).trim();
  if (head === 'find') {
    const q = rest.trim();
    return q ? { kind: 'find', q } : null;
  }
  if (head === 'role' || head === 'act') {
    const m = rest.match(/^(\d{1,3})号?$/u);
    if (!m) return null;
    const n = Number(m[1]);
    return { kind: head, n } as SectionRef;
  }
  return null;
}

/** 规范名（目录里的写法） */
export function sectionName(ref: SectionRef): string {
  switch (ref.kind) {
    case 'role':
    case 'act':
      return `${ref.kind}:${ref.n}`;
    case 'clue':
      return `clue:${ref.id}`;
    case 'find':
      return `find:${ref.q}`;
    default:
      return ref.kind;
  }
}

// ───────────────────────── 事件整理 ─────────────────────────

export type EventKindRef = { type: 'script'; i: number } | { type: 'act'; n: number; i: number } | { type: 'confession'; i: number } | { type: 'clue'; id: string; i: number };

/** 图片事件的 kind（script_img:j、act{N}_img:j、clue_{id}_img:j） */
export function isImageKind(kind: string): boolean {
  return /^(?:script|act\d+)_img:\d+$/.test(kind) || /^clue_.+_img:\d+$/.test(kind);
}

/** 认出「私发给本人、you 里一定有」的重复类事件。act 的 N 从 0 起（对应 you.acts[N]）。 */
export function parseEventKind(kind: string): EventKindRef | null {
  if (isImageKind(kind)) return null;
  let m = kind.match(/^script:(\d+)$/);
  if (m) return { type: 'script', i: Number(m[1]) };
  m = kind.match(/^act(\d+):(\d+)$/);
  if (m) return { type: 'act', n: Number(m[1]), i: Number(m[2]) };
  m = kind.match(/^confession:(\d+)$/);
  if (m) return { type: 'confession', i: Number(m[1]) };
  m = kind.match(/^clue_(.+):(\d+)$/);
  if (m) return { type: 'clue', id: m[1]!, i: Number(m[2]) };
  return null;
}

/** 重复类事件的指引行（只拼序号和剧本包线索 id，不含任何玩家文字） */
export function pointerLine(ref: EventKindRef): string {
  switch (ref.type) {
    case 'script':
      return `〔你的人物剧本第 ${ref.i + 1} 段，内容在 you.script；you.script 被截断时用 get_my_view({"section":"script"}) 取全〕`;
    case 'act':
      return `〔第 ${ref.n + 1} 幕你的新剧本第 ${ref.i + 1} 段，内容在 you.acts；被截断时用 get_my_view({"section":"act:${ref.n + 1}"}) 取全〕`;
    case 'confession':
      return `〔你的认罪书第 ${ref.i + 1} 段，内容在 you.confession；被截断时用 get_my_view({"section":"confession"}) 取全〕`;
    case 'clue':
      return `〔线索 ${ref.id} 第 ${ref.i + 1} 段，内容在 you.search.my_cards；被截断时用 get_my_view({"section":"clue:${ref.id}"}) 取全〕`;
  }
}

// ───────────────────────── 按关键词找 ─────────────────────────

export interface FindSource {
  /** 可直接再取的段名 */
  section: string;
  /** 中文来源 */
  where: string;
  text: string;
}

export interface FindHit {
  section: string;
  where: string;
  snippet: string;
}

/** 逐字符折叠：全角转半角、小写；保持长度不变，这样能在折叠串上找位置再回原文取片段。 */
function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    let c = ch;
    if (code === 0x3000) c = ' ';
    else if (code >= 0xff01 && code <= 0xff5e) c = String.fromCodePoint(code - 0xfee0);
    const lower = c.toLowerCase();
    out += lower.length === c.length ? lower : c;
  }
  return out;
}

/**
 * 纯字符串子串匹配：关键词按空白切成几个词，所有词都出现在同一段落（按换行切）才算命中。
 * 命中词次数多的在前，同样多时按 sources 的顺序（即目录顺序）。
 */
export function findIn(sources: FindSource[], query: string): FindHit[] {
  const terms = fold(normalizeText(query)).split(' ').filter(Boolean);
  if (!terms.length) return [];
  const scored: { score: number; order: number; hit: FindHit }[] = [];
  let order = 0;
  for (const src of sources) {
    for (const para of src.text.split('\n')) {
      const f = fold(para);
      const at = (t: string) => f.indexOf(t);
      if (terms.every((t) => at(t) >= 0)) {
        let score = 0;
        for (const t of terms) {
          for (let i = f.indexOf(t); i >= 0; i = f.indexOf(t, i + t.length)) score++;
        }
        const first = Math.min(...terms.map(at));
        const termLen = terms.find((t) => at(t) === first)!.length;
        const pad = Math.max(0, Math.floor((FIND_SNIPPET - termLen) / 2));
        const from = Math.max(0, first - pad);
        const to = Math.min(para.length, from + FIND_SNIPPET);
        scored.push({
          score,
          order: order++,
          hit: { section: src.section, where: src.where, snippet: `${from > 0 ? '…' : ''}${para.slice(from, to)}${to < para.length ? '…' : ''}` },
        });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, FIND_MAX_HITS).map((x) => x.hit);
}
