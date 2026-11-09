/**
 * 网页舞台演示：起一个本地引擎，开一局网页舞台的剧本杀（示例剧本），用随机动作推进到指定步数，
 * 打印观战链接，然后保持运行（看页面、截图用）。
 *
 *   npx tsx scripts/web-demo.ts [--steps 40] [--port 7788] [--end] [--human]
 *
 * --human：4 号座位换成真人「小明」，再打印他的座位链接（推进到轮到他时停下，方便看「我的」页签）。
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { configSchema } from '../src/config.js';
import { startHttpServer } from '../src/server/http.js';
import { createRuntime } from '../src/server/runtime.js';

const { values } = parseArgs({ options: { steps: { type: 'string', default: '40' }, port: { type: 'string', default: '7788' }, end: { type: 'boolean', default: false }, human: { type: 'boolean', default: false } } });
const port = Number(values.port);
const rt = createRuntime(
  configSchema.parse({
    host: '127.0.0.1',
    port,
    stateFile: null,
    scriptsDir: join(import.meta.dirname, '../examples/jubensha'),
    webUrl: `http://127.0.0.1:${port}/web/`,
    auth: { mode: 'open' },
  }),
  () => undefined,
);
const http = await startHttpServer(rt, () => undefined);
const m = rt.manager;
const REF = { id: '999', name: '裁判' };
const names = ['林夕', '艾莉希娅', '克蕾雅', '苏菲'];
const { summary } = m.createGame(REF, { type: 'jubensha', groupId: 'demo', joinAs: 'referee', options: { stage: 'web', script: 'demo-search', random_seats: false } });
const id = summary.game_id;
names.forEach((n, i) => {
  if (values.human && i === names.length - 1) m.addHuman(REF, id, { userId: '20001', name: '小明' });
  else m.joinGame({ id: `10${i + 1}`, name: n }, id, { as: 'player' });
});
const started = m.startGame(REF, id);
const rec = m.getRecord(id);
const LINES = [
  '我九点半在码头，看见灯塔顶的灯灭了一次。',
  '3号你说你在书房，那你听到楼梯上的声音了吗？',
  '我一直在书房整理航海日志。楼梯响过两次，第二次很急，像是有人在跑。@艾莉希娅 你那时在哪里？',
  '我在厨房煮茶。说起来，1号身上那股海水味，可不像是一直待在屋里的人。',
  '风太大了，我只是出去收了晾在外面的衣服而已。倒是4号，你的鞋底为什么沾着灯塔台阶上的红泥？\n\n我不是在指控你，只是想把时间线对清楚：九点十分到九点四十之间，谁能证明自己一直待在某个地方？我先说，我九点十分在门口和守塔人打过招呼，他当时还好好的。之后我在码头附近绕了一圈，大概九点半看见灯灭。回来的时候大门是虚掩着的，我以为是风吹开的。\n\n这些都是我亲眼看到的，大家可以拿来对照。',
];
let line = 0;
const steps = Number(values.steps);
for (let i = 0; i < steps * 10 && rec.status === 'running'; i++) {
  await m.refereeStep(REF, id);
  const ph = rec.phase;
  if (!ph || ph.openedAt === null) continue;
  const seats = Object.values(ph.pending).filter((r) => !r.done).map((r) => r.seat);
  if (seats.length === 0) continue;
  if (!values.end && i >= steps) break;
  for (const seat of seats.slice(0, 1)) {
    const p = rec.players.find((x) => x.seat === seat)!;
    if (p.kind === 'human') {
      if (!values.end) i = steps * 10;
      continue;
    }
    const input = m.randomActionFor(id, seat);
    if (!input) continue;
    if (input.action === 'speech' && line < LINES.length) input.text = LINES[line++]!;
    try {
      m.act({ id: p.id, name: p.name }, id, input);
    } catch {
      /* 随机动作偶尔不合法：跳过 */
    }
  }
}
console.log(started.watch_url ?? '(no url)');
for (const p of rec.players.filter((x) => x.kind === 'human')) console.log(`seat ${p.seat} ${p.name}: ${m.seatUrl(rec, p.seat) ?? '(no seat url)'}`);
console.log(`status=${rec.status} phase=${rec.phase?.title ?? '-'}`);
process.on('SIGTERM', () => void http.close().then(() => process.exit(0)));
