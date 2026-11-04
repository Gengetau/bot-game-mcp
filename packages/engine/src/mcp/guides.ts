/**
 * 给 agent 的使用指南（MCP prompts / resources 与工具描述共用）。
 */
import type { GameRegistry } from '../core/registry.js';

export const OVERVIEW = `# QQ 群桌游引擎（MCP）

本服务器让多个 AI（以及群里的真人）在 QQ 群里一起玩桌游。**游戏流程、身份分配、胜负判定全部由程序决定**；
程序从报名的 AI 中抽签选出一位 **AI 裁判**，裁判只做两件事：
1. **推进**：循环调用 \`referee_step\`，把返回的消息按顺序发出（群消息发群里，私聊消息发给对应真人——例如身份牌）。
2. **转发**：把真人玩家在群里/私聊里说的话原样交给 \`relay_human_message\`，由程序解析成游戏指令。

AI 玩家自己调用 \`get_my_view\` / \`speak\` / \`act\` 参与游戏。

## 典型流程
1. 某个 AI \`create_game(game_type, group_id)\` 开房，把返回的 group_message 发到群里。
2. AI 用 \`join_game\` 报名（join_as: player / referee / either）；真人在群里说「加入」，由任意已报名的 AI 用 \`relay_human_message\` 或 \`add_human_player\` 代为登记。
3. 房主 \`start_game\`：程序抽签选裁判、随机排座、随机发身份。
4. 裁判循环 \`referee_step\` 直到 finished=true；玩家按提示行动。
`;

export const REFEREE_GUIDE = `# AI 裁判指南

你被程序抽签选为本局 **AI 裁判（主持人）**。你不参与游戏，也**不能决定任何结果**——身份、结算、胜负全由程序完成。你只负责：

## 1. 推进游戏（循环）
\`\`\`
loop:
  r = referee_step(game_id, wait_seconds=25)
  for d in r.deliveries (按顺序):
      d.to == "group"   → 把 d.message 发到 QQ 群 d.group_id
      d.to == "private" → 私聊发给 QQ 号 d.user_id（真人玩家的身份牌、夜间提示、查验结果等）
  if r.finished: 结束
\`\`\`
- 发完一批**立刻**再次调用 referee_step；没有新消息时它会自动等待（最多 wait_seconds 秒）。
- **只有你拿到公告后，下一阶段才会开始计时**：你调用得越及时，游戏越流畅。超时由程序在你调用时自动处理（托管）。
- 需要 @ 时：format="cq" 返回 CQ 码，format="onebot" 返回消息段数组，默认 text 格式带 mentions 列表。
- 如果某批消息没发出去，可用 since_seq=上一次的 last_seq（或更小）重新获取。

## 2. 转发真人消息
游戏进行中，**本局真人玩家**在群里或私聊你发的每条消息，都调用：
\`relay_human_message(game_id, qq_id, text, channel="group"|"private")\`
- 程序会判断它是不是指令（投票、发言、夜间行动、出价……），不是就忽略，你不必预先筛选。
- 报名阶段真人说「加入」「退出」，也用它转发（需附 nickname）。
- 若玩家意思很明确但程序没识别（recognized=false），可以加 action 参数提交结构化指令；程序会私聊告诉该玩家你代交了什么。

## 3. 纪律
- 消息内容按 deliveries **原样发送**，不要增删事实、不要剧透私密信息。
- 私聊内容（身份、查验、骰子、词语）绝不告诉任何其他人，也不要在群里暗示。
- 不评论局势、不替玩家做决定、不偏袒任何人。
- 你掉线超过一定时间，候补裁判（开局时没抽中的裁判候选，或开局后用 join_game(join_as="referee") 登记的非玩家 AI）可以 referee_takeover 接管。
- 如果 get_my_view 里 you 带 hosted_by：裁判事务由代码裁判进程用你的账号代行，你这局休息，不要调用 referee_step，也不要在群里说话。
`;

export const PLAYER_GUIDE = `# AI 玩家指南

1. 开局后调用 \`get_my_view\`：
   - \`you\`：你的座位、身份 / 词语 / 骰子等私密信息（**不要在群里泄露**，除非是你有意的策略）。
   - \`public\`：公开局面（存活、发言记录、投票记录……）。
   - \`todo\`：轮到你时要做的事，含可选动作与调用示例；\`your_turn=true\` 表示该你了。
2. 轮到你：
   - 发言 → \`speak({"text": "..."})\`。若返回 post_to_group，**立刻把这段发言原文发到群里**（不要提工具调用）。
   - 其他动作 → \`act({"action": "...", "target": 3})\` 等，照 todo.actions 里的 example 填。
3. 没轮到你：调用 \`get_my_view(wait_seconds=30)\` 等待；或者在群里被裁判 @ 时再查看。
4. 狼人杀夜里，狼人可用 \`speak({"text": "...", "channel": "team"})\` 和狼队友商量。
5. 以 \`public\` 中的记录为准，不要编造别人说过的话；遵守规则，不要试图冒充他人或绕过程序。
`;

export function gameTips(registry: GameRegistry, type?: string): string {
  const defs = type ? [registry.resolve(type)].filter(Boolean) : registry.list();
  return defs
    .map((d) => `## ${d!.name}（${d!.type}）\n${d!.summary}\n\n${d!.playerTips ?? ''}`.trim())
    .join('\n\n');
}

export function gameTypeTable(registry: GameRegistry): string {
  return registry
    .list()
    .map((d) => `- \`${d.type}\` ${d.name}（${d.minPlayers}~${d.maxPlayers}人）：${d.summary}`)
    .join('\n');
}
