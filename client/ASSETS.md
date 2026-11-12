# 资产与授权台账

运行时资产放在 `client/town/assets/`，制作源和第三方许可证文本放在 `client/art_source/`。
本表每一行对应一个第三方包；自制或程序处理的部分在「修改说明」里写明。

| 包名（版本） | 作者 | 原始页面 | 取得日期 | 许可证 | 对应文件 | 修改说明 |
|---|---|---|---|---|---|---|
| Fantasy Town Kit (2.0) | Kenney (www.kenney.nl) | https://kenney.nl/assets/fantasy-town-kit | 2026-11-13 | CC0 1.0（包内 License.txt 写 "Creative Commons Zero, CC0"：`art_source/third_party/kenney_fantasy-town-kit/License.txt`）；zip 的 sha256 `1a7530c09f4d2fa2cdee259876f089334f8b1f27fa86a0c4f54ef86cdd8676ef` | `town/assets/models/kenney/`：tree、tree-high、tree-crooked、lantern、fence、fence-gate、hedge、hedge-large、stall-red、cart、rock-large、rock-small、rock-wide、banner-red、banner-green、stall-stool 的 glb，加 `Textures/colormap.png`（共约 408 KB，包里其余模型没有进仓库） | 只留用到的模型。`art_source/recolor_kenney.py` 重绘调色板贴图（奶油、木棕、灰蓝瓦的色调，更柔）；重绘后的贴图和脚本都进了仓库。网格没有改；摆放、缩放、朝向、发光点在 `town/assets/art_table.json`；房屋、地面、小物件（长椅、桌、书架、灶、花坛、喷泉……）是 `scripts/town_art.gd` 用程序生成的，不属于任何第三方包 |
| Adventurers (2.0 FREE) | Kay Lousberg (www.kaylousberg.com) | https://kaylousberg.itch.io/kaykit-adventurers | 2026-11-13 | CC0 1.0（包内 License.txt 写 "Creative Commons Zero, CC0"，署名可选：`art_source/third_party/kaykit_adventurers/License.txt`）；zip 的 sha256 `abe48f4763fba0896bab486ee9e6d08ca6b5b3884b9601f235c8847ae94dc479` | `town/assets/models/characters/body_{rogue,ranger,mage,knight}.scn`、`outfit_0..7.png` | `art_source/build_residents.sh` + `build_residents.gd`：只取 4 个身体（骨架相同），去掉武器道具，存成 Godot 场景；`recolor_residents.py` 把原调色板重绘成 8 套服装（`outfit_*.png`，重绘贴图和脚本都进仓库）。网格没有改 |
| Character Animations (1.1) | Kay Lousberg (www.kaylousberg.com) | https://kaylousberg.itch.io/kaykit-character-animations | 2026-11-13 | CC0 1.0（`art_source/third_party/kaykit_character-animations/License.txt`）；zip 的 sha256 `65882f31f905ad2e953819648a59287cdeab8f623908d5ef701971d3758be20f` | `town/assets/models/characters/residents_anims.res`（约 93 KB） | `build_residents.gd` 只摘出用到的动作（idle、walk、sit 三段、wave、interact 等）合成一个动画库，循环动作设成 LOOP_LINEAR；其余动作没有进仓库 |
| Interface Sounds (1.0) | Kenney (www.kenney.nl) | https://kenney.nl/assets/interface-sounds | 2026-11-12 | CC0 1.0（`art_source/third_party/kenney_interface-sounds/License.txt`） | 输入：`art_source/source/audio/kenney_interface_confirmation_001.ogg`；输出：`town/assets/audio/sfx/confirm.wav` | `art_source/convert_sfx.sh`：ogg 转单声道 44.1 kHz 16 位 wav，去开头静音，音量归一（峰值约 -3 dB） |
| Impact Sounds (1.0) | Kenney (www.kenney.nl) | https://kenney.nl/assets/impact-sounds | 2026-11-12 | CC0 1.0（`art_source/third_party/kenney_impact-sounds/License.txt`） | 输入：`art_source/source/audio/kenney_impact_footstep_concrete_001.ogg`；输出：`town/assets/audio/sfx/footstep.wav` | 同上（峰值约 -4 dB，比确认音轻） |
| Godot Engine (4.7.2.stable) | Godot Engine contributors | https://godotengine.org | 以 `/opt/godot/godot --headless --version` 确认：`4.7.2.stable.official.ed1daf0bf` | MIT；引擎内置的第三方组件各有自己的许可（完整清单见 Godot 自带的 `COPYRIGHT.txt`，或引擎「第三方许可」页面） | 网页导出产物里的引擎 `index.wasm`、`index.js` 等（`client/town/build/web/`） | 引擎随网页导出一起分发；没有核对过是否用了官方模板、有无自行改动 |

取得方式：用 Playwright 打开 Kenney 素材页，点页面自己的「Download」和「Continue without donating」按钮下载（正常访客流程），
压缩包解压在独立的空目录里当不可信数据处理，只把上表列出的文件和包内 License.txt 拷进仓库。其余文件没有进仓库。

**Godot 引擎的许可（发布前事项）**：随包分发的引擎二进制要求保留 Godot 的版权声明和 MIT 许可文本，并保留内置第三方组件各自的许可声明；本台账不抄写组件清单，以 Godot 自带的 `COPYRIGHT.txt` 为准。目前导出产物和页面里都没有这些许可文本的入口。**公开发布之前**必须在页面上提供入口（例如「关于」里链接到随包附带的许可文本），这一项尚未做。

CC0 不要求署名；按 Kenney 的建议，游戏的「关于」里可以写一句 Kenney (www.kenney.nl)。

**旧资产说明**：P0 的 Kenney Mini Characters (2.0，CC0，2026-11-12 取得) 已不再使用，运行时文件 `resident.glb` 等已删除；`art_source/` 里还留着它的原始输入、`build_resident.py`、`check_resident.gd` 和 License.txt，仅作历史记录，可以整体删除。

## 居民模型的实测属性（Godot 4.7.2 导入后）

- 骨架是 KayKit 的 Rig_Medium，4 个身体共用；动画库 `residents_anims.res` 里的动作：idle、walk、sit 的坐下 / 静坐 / 站起、wave、interact。客户端在运行时给身体加 `AnimationPlayer`（root_node 指到上一级），不依赖 glb 里带的播放器。
- 身高在 `actor.gd` 里按包围盒缩放到 1.72 米（约三头身）；脚底 y=0。服装由 `appearance_for(id) = abs(id.hash()) % 8` 决定，只在这一个函数里，换规则改它。
- 材质：城镇着色器（`assets/shaders/town.gdshader`）采样 `outfit_N.png` 调色板，无高光。
- 体积：4 个身体 + 动画库 + 8 张调色板合计约 0.2 MB；整个 `index.pck` 见 `docs/PROGRESS.md`。

## 可替换的美术层

物件的模型对应表在 `town/assets/art_table.json`（kind -> 模型、缩放、朝向、偏移、调色板、淡出、发光）。
可选的私有覆盖目录 `client/town/art_private/`（git 忽略，不进仓库），里面放 `art_table.json` 和模型就会覆盖同名条目；用法见 `client/README.md`。
**不是 CC0 的素材（例如 YumeForge）只能放在 art_private 里，不得进 git。**

## 怎么重新生成

```bash
# 一次性准备：Python 3.13 虚拟环境装 bpy（不需要装 Blender）；Pillow
python3.13 -m venv /tmp/bpyenv && /tmp/bpyenv/bin/pip install bpy pillow

# Kenney 调色板重绘
/tmp/bpyenv/bin/python client/art_source/recolor_kenney.py
# 居民：身体 + 动画库 + 服装调色板（需要 Godot 4.7.2；两个原始 zip 各解压在独立目录）
bash client/art_source/build_residents.sh <KayKit_Adventurers 目录> <KayKit_Character_Animations 目录>
/tmp/bpyenv/bin/python client/art_source/recolor_residents.py

# 音效（需要 ffmpeg）
bash client/art_source/convert_sfx.sh
```
