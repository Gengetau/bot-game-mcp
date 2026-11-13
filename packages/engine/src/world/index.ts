/**
 * 栖灯镇（内部类型 town）：一个持续运行的小镇世界。
 *
 * 装配顺序是固定的：注册钩子按这个顺序执行（先开账户发物资，再生成愿望）。
 */
import { installChat } from './chat.js';
import { installGames } from './games.js';
import { enter, installIdentity, type EnterResult, type ProfileInput } from './identity.js';
import { installInteract } from './interact.js';
import { installLife } from './life.js';
import { installMail } from './mail.js';
import { installNpc } from './npc.js';
import { installNpcTalk } from './npc-talk.js';
import { installProperty } from './property.js';
import { installReports } from './reports.js';
import { WorldService, type Auth, type WorldOptions } from './service.js';
import { installSocial, onReturn } from './social.js';
import { installSpace } from './space.js';
import { agentView, meView, type MeView } from './views.js';

export function createWorld(opts: WorldOptions): WorldService {
  const w = new WorldService(opts);
  installIdentity(w);
  installLife(w);
  installChat(w);
  installSpace(w);
  installNpc(w);
  installNpcTalk(w);
  installProperty(w);
  installMail(w);
  installInteract(w);
  installSocial(w);
  installGames(w);
  installReports(w);
  return w;
}

/** 进入世界并返回本人视图。离开过一阵再回来的，附带一份回顾。 */
export function enterWorld(w: WorldService, auth: Auth, input: { clientKind?: 'web' | 'mcp'; profile?: ProfileInput } = {}): { enter: EnterResult; view: MeView } {
  const result = enter(w, auth, input);
  if (result.wasAway) onReturn(w, result.residentId, w.now());
  const r = w.mustResident(result.residentId);
  // 短暂掉线重连不打扰；离开超过十分钟才给回顾
  const away = result.awaySince !== null && w.now() - result.awaySince > 10 * 60_000 ? result.awaySince : null;
  return { enter: result, view: meView(w, r, auth.clientId, { recapSince: away }) };
}

export function enterWorldAgent(w: WorldService, auth: Auth, profile?: ProfileInput): { enter: EnterResult; view: Record<string, unknown> } {
  const result = enter(w, auth, { clientKind: 'mcp', ...(profile ? { profile } : {}) });
  if (result.wasAway) onReturn(w, result.residentId, w.now());
  const r = w.mustResident(result.residentId);
  const away = result.awaySince !== null && w.now() - result.awaySince > 10 * 60_000 ? result.awaySince : null;
  return { enter: result, view: agentView(w, r, auth.clientId, { recapSince: away }) };
}

export { WorldService, type Auth, type CommandRequest, type WorldOptions, type StreamEvent } from './service.js';
export { WorldError, HTTP_STATUS, type WorldErrorCode } from './errors.js';
export { townParamsSchema, resolveParams, type TownParams } from './params.js';
export {
  agentPrincipal,
  claimControl,
  devLoginSession,
  enter,
  exchangeTicket,
  heartbeat,
  issueTicket,
  leaveWorld,
  principalById,
  revokeSession,
  sessionPrincipal,
  type EnterResult,
  type ProfileInput,
} from './identity.js';
export { townChatPage, townChatSince, townChatHead, townChatDigest, nearbyHistory, filterEventsForAgent, type TownChatMessage, type TownChatPage } from './chat.js';
export { canHear, nearbyAudience, roomOf } from './hearing.js';
export { agentView, chatHistory, directory, meView, publicView, type MeView, type PublicView } from './views.js';
export { publicGameView, gameViewFor } from './games.js';
export { listLetters } from './mail.js';
export { relationsOf, relationMemories } from './social.js';
export { REQUEST_ID_RE } from './service.js';
export { outboxAck, outboxPending, recap, report } from './reports.js';
export { TownDb, verifyBackup } from './db.js';
export * as townContent from './content.js';
export { controlDisconnected, mapManifest, renewNavigation, sceneKeyOfResident, sceneView, whereabouts, type ActorView, type NavBrief, type NpcView, type SceneView, type Whereabouts } from './space.js';
export type { MapManifest, MapSource } from './spatial/types.js';
