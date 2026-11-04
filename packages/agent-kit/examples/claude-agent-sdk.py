"""Claude Agent SDK 接入示例：把 bot-game-mcp 挂成名为 game 的 MCP 服务，只放行玩家该用的工具。

运行前：
  pip install claude-agent-sdk
  export BOTGAME_URL=http://127.0.0.1:7700/mcp   # 引擎地址
  export BOTGAME_KEY_FILE=/run/game/token         # 这个 bot 的密钥文件（不要把密钥写进代码或日志）

这个例子只演示「怎么接」，真正的聊天 bot 还要自己处理 QQ 消息的收发；提示词用 agent-kit 的 playerPrompt()
（Python 里直接把 prompts/player-zh.md 的内容拼进 system prompt 即可，工具前缀是 mcp__game__）。
"""
import asyncio
import os
from pathlib import Path

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, PermissionResultAllow, PermissionResultDeny

GAME_URL = os.environ["BOTGAME_URL"]
GAME_KEY = Path(os.environ["BOTGAME_KEY_FILE"]).read_text(encoding="utf-8").strip()
GAME_TOOLS = {"whoami", "list_games", "get_rules", "join_game", "leave_game", "get_my_view", "speak", "act", "get_game_log"}
PROMPT = (Path(__file__).resolve().parent.parent / "prompts" / "player-zh.md").read_text(encoding="utf-8")


async def can_use_tool(tool, args, context):  # noqa: ARG001
    """只放行玩家工具；开房、开局、裁判工具一律拒绝。"""
    if tool.startswith("mcp__game__") and tool[11:] in GAME_TOOLS:
        return PermissionResultAllow()
    return PermissionResultDeny(message="这个工具不可用")


async def main():
    options = ClaudeAgentOptions(
        system_prompt="你是群里的一位玩家。\n\n" + PROMPT.replace("{p}", "mcp__game__"),
        mcp_servers={"game": {"type": "http", "url": GAME_URL, "headers": {"Authorization": f"Bearer {GAME_KEY}"}}},
        strict_mcp_config=True,
        permission_mode="default",
        can_use_tool=can_use_tool,
    )
    async with ClaudeSDKClient(options=options) as client:
        # 群里裁判 @ 了你：把那条消息交给 agent，它会自己调用 get_my_view 并行动
        await client.query("裁判：@你 【第1轮·猜数】请调用 get_my_view 查看自己的行动面板。")
        async for message in client.receive_response():
            print(message)


if __name__ == "__main__":
    asyncio.run(main())
