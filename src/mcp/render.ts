/**
 * 把待发送消息渲染成不同 QQ 框架习惯的格式：
 *  - text   纯文本，@ 显示为「@昵称」，另附 mentions 列表（通用）
 *  - cq     CQ 码字符串，如 [CQ:at,qq=123]（go-cqhttp / NapCat / LLOneBot 等 OneBot v11 实现）
 *  - onebot OneBot v11 消息段数组 [{type:'text',data:{text}}, {type:'at',data:{qq}}]
 */
import type { Delivery, MessageSegment } from '../core/types.js';

export type DeliveryFormat = 'text' | 'cq' | 'onebot';

const escapeCqText = (s: string) => s.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
const escapeCqParam = (s: string) => escapeCqText(s).replace(/,/g, '&#44;');

export function toCq(segments: MessageSegment[]): string {
  return segments
    .map((s) => (s.type === 'text' ? escapeCqText(s.text) : `[CQ:at,qq=${escapeCqParam(s.id)}]`))
    .join('');
}

export function toOneBot(segments: MessageSegment[]) {
  return segments.map((s) => (s.type === 'text' ? { type: 'text', data: { text: s.text } } : { type: 'at', data: { qq: s.id } }));
}

export function renderDelivery(d: Delivery, format: DeliveryFormat) {
  const base =
    d.target.type === 'group'
      ? { seq: d.seq, to: 'group' as const, group_id: d.target.groupId }
      : { seq: d.seq, to: 'private' as const, user_id: d.target.userId, nickname: d.target.name };
  // text 格式本应按纯文本发送；万一接入方把它当 CQ 码字符串发，也不让其中的「[CQ:」生效
  const message =
    format === 'cq' ? toCq(d.segments) : format === 'onebot' ? toOneBot(d.segments) : d.text.replace(/\[CQ:/gi, '［CQ:');
  return {
    ...base,
    category: d.category,
    message,
    ...(format === 'text' && d.mentions.length ? { mentions: d.mentions.map((m) => ({ qq: m.id, name: m.name })) } : {}),
  };
}
