# 资产与授权台账

运行时资产放在 `client/town/assets/`，制作源和第三方许可证文本放在 `client/art_source/`。
本表每一行对应一个第三方包；自制或程序处理的部分在「修改说明」里写明。

| 包名（版本） | 作者 | 原始页面 | 取得日期 | 许可证 | 对应文件 | 修改说明 |
|---|---|---|---|---|---|---|
| Mini Characters (2.0) | Kenney (www.kenney.nl) | https://kenney.nl/assets/mini-characters | 2026-11-12 | CC0 1.0（包内 License.txt：`art_source/third_party/kenney_mini-characters/License.txt`） | 输入：`art_source/source/kenney_mini_character_male_a.glb`（原包 `character-male-a.glb`）、`art_source/source/Textures/colormap.png`；输出：`town/assets/models/characters/resident.glb` | `art_source/build_resident.py` 整理：只留 `idle`、`walk` 两个动作（原包 34 个，其余删除）；整体放大到身高 1.7 米，缩放烘进顶点、骨骼和动作位移；脚底在 y=0；贴图内嵌。网格、骨架、两个动作的内容和贴图是原作，没有重画 |
| Interface Sounds (1.0) | Kenney (www.kenney.nl) | https://kenney.nl/assets/interface-sounds | 2026-11-12 | CC0 1.0（`art_source/third_party/kenney_interface-sounds/License.txt`） | 输入：`art_source/source/audio/kenney_interface_confirmation_001.ogg`；输出：`town/assets/audio/sfx/confirm.wav` | `art_source/convert_sfx.sh`：ogg 转单声道 44.1 kHz 16 位 wav，去开头静音，音量归一（峰值约 -3 dB） |
| Impact Sounds (1.0) | Kenney (www.kenney.nl) | https://kenney.nl/assets/impact-sounds | 2026-11-12 | CC0 1.0（`art_source/third_party/kenney_impact-sounds/License.txt`） | 输入：`art_source/source/audio/kenney_impact_footstep_concrete_001.ogg`；输出：`town/assets/audio/sfx/footstep.wav` | 同上（峰值约 -4 dB，比确认音轻） |

取得方式：用 Playwright 打开 Kenney 素材页，点页面自己的「Download」和「Continue without donating」按钮下载（正常访客流程），
压缩包解压在独立的空目录里当不可信数据处理，只把上表列出的文件和包内 License.txt 拷进仓库。其余文件没有进仓库。

CC0 不要求署名；按 Kenney 的建议，游戏的「关于」里可以写一句 Kenney (www.kenney.nl)。

## 居民模型的实测属性（Godot 4.7.2 导入后）

- 动作：`idle`（1.333 秒）、`walk`（0.667 秒，一个周期两步，约每 0.33 秒一次脚落地）。**导入后 loop_mode 是 NONE（glTF 没有循环标志）**，客户端播放前要设成 `Animation.LOOP_LINEAR`（或在 `resident.glb.import` 里设置）。
- 骨架 `Skeleton3D`，7 根骨：`root`、`leg-left`、`leg-right`、`torso`、`arm-left`、`arm-right`、`head`；`AnimationPlayer` 在导入出的场景根下面。
- 身高 1.698 米，脚底 y=0，原点在两脚中间；静止姿态是 T 字，所以左右宽约 1.9 米（只是两臂平伸，不是身体宽）。
- 朝向：**正面朝 +Z**（Godot 里 glTF 的「前」，用渲染截图确认过：相机在 +Z 看到的是脸）。Godot 的「向前」约定是 -Z，所以客户端要让角色朝移动方向时，用 `atan2(dx, dz)` 作为绕 Y 轴的旋转，不要用 `look_at`（它让 -Z 指向目标）；或者给模型外面套一层旋转 180 度的节点。
- 文件体积：resident.glb 约 109 KB；confirm.wav 约 25 KB；footstep.wav 约 9 KB。
- 材质：一张 colormap 调色板贴图（内嵌在 glb 里），一个 `StandardMaterial3D`。

## 怎么重新生成

```bash
# 一次性准备：Python 3.13 虚拟环境装 bpy（不需要装 Blender）
python3.13 -m venv /tmp/bpyenv && /tmp/bpyenv/bin/pip install bpy

# 居民模型（输入在 art_source/source/，输出 town/assets/models/characters/resident.glb）
/tmp/bpyenv/bin/python client/art_source/build_resident.py

# 音效（需要 ffmpeg）
bash client/art_source/convert_sfx.sh

# 用 Godot 验收导入结果，见 client/art_source/README.md 的「验收」
```

## 这是 P0 的验证资产

Mini Characters 的这个角色是为 P0 验证「Blender -> GLB -> Godot -> 网页」链路选的，不是正式居民美术。
设计文档里说的坐下、站起、挥手等动作，原包有 `sit`、`emote-yes`、`interact-*` 等，后续需要时可以从同一个原始文件里加回来（改 `KEEP_ACTIONS`）。
