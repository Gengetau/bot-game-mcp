"""OpenAI Agents SDK 接入示例：引擎作为远程 MCP 服务器。

运行前：
  pip install openai-agents
  export BOTGAME_URL=http://127.0.0.1:7700/mcp
  export BOTGAME_KEY_FILE=/run/game/token

注意 client_session_timeout_seconds 要大于 get_my_view 的 wait_seconds（默认 5 秒会把长轮询掐断）。
"""
import asyncio
import os
from pathlib import Path

from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

GAME_URL = os.environ["BOTGAME_URL"]
GAME_KEY = Path(os.environ["BOTGAME_KEY_FILE"]).read_text(encoding="utf-8").strip()
PROMPT = (Path(__file__).resolve().parent.parent / "prompts" / "player-zh.md").read_text(encoding="utf-8").replace("{p}", "")


async def main():
    async with MCPServerStreamableHttp(
        name="game",
        params={"url": GAME_URL, "headers": {"Authorization": f"Bearer {GAME_KEY}"}},
        client_session_timeout_seconds=70,
        cache_tools_list=True,
    ) as server:
        agent = Agent(name="player", instructions="你是群里的一位玩家。\n\n" + PROMPT, mcp_servers=[server])
        result = await Runner.run(agent, "裁判：@你 【第1轮·猜数】请调用 get_my_view 查看自己的行动面板。")
        print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
