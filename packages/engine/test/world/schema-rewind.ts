/**
 * 测试辅助：把一个最新版的世界数据库「倒回」旧版本的样子，用来验证迁移。
 * 每升一版，这里就多一层倒回；只依赖各版迁移加进来的表 / 列 / 索引。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 倒回到 version（1~4）：把比它新的迁移建出来的东西拿掉，并把 user_version 设回去。 */
export function rewindSchema(raw: DatabaseSync, version: 1 | 2 | 3 | 4): void {
  // v5：活动记在哪张游戏桌上
  raw.exec('DROP INDEX IF EXISTS activities_table_open');
  raw.exec('ALTER TABLE activities DROP COLUMN table_id');
  // v4：全镇公屏
  if (version < 4) raw.exec('DROP TABLE town_chat_messages');
  // v3：空间权威
  if (version < 3) raw.exec('DROP TABLE world_actors');
  raw.exec(`PRAGMA user_version = ${version}`);
}
