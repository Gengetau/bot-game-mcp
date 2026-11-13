# art_source：美术源文件与导出约定

> 居民和街景已换成 KayKit + Kenney Fantasy Town（见 `client/ASSETS.md`）。重新生成用 `recolor_kenney.py`、`build_residents.sh`/`build_residents.gd`、`recolor_residents.py`。
> P0 的 Kenney Mini Characters 旧流程（`build_resident.py`、`check_resident.gd`、原始 glb 与贴图、License）已从仓库删除，见 `ASSETS.md` 的「旧资产说明」。

这里放 Blender 脚本、第三方原始素材（只留用到的文件）、许可证文本和导出约定。
运行时资产在 `client/town/assets/`；台账和授权见 `client/ASSETS.md`。

## 目录

- `audio/`：音频的再生成脚本（`build_audio.py`，调用同目录的 `loop.py`、`segpick.py`；需要 ffmpeg + numpy）。输出 `town/stream/music/`（音乐，不进 pck）、`town/assets/audio/ambience/`、`town/assets/audio/sfx/`。原始素材体积大不进仓库，来源和 sha256 见 `../ASSETS.md`，许可证据见 `third_party/opengameart/`。
- `source/audio/*.ogg`：音效脚本的输入。
- `third_party/<包名>/License.txt`：随素材放的许可证原文。

## 导出约定

- **单位**：米。1 个单位 = 1 米。居民身高 1.7 米。
- **坐标和朝向**：glTF 标准（Y 向上，右手系）。角色**正面朝 +Z**。Blender 里就是 Z 向上、正面朝 -Y，导出时勾 `+Y Up`。
- **原点**：居民在两脚中间的地面上（脚底 y=0）。其他物件也以底面中心为原点。
- **缩放**：物件缩放保持 1，不要用物件缩放凑尺寸；缩放烘进顶点、骨骼和动作位移键。（用物件缩放的话，Godot 里蒙皮网格的包围盒会算大，实测 4.3 米。）
- **动作命名**：小写英文，`idle`、`walk`；后续 `sit`、`sit_idle`、`stand_up`、`wave`、`use_item`。导出模式用 ACTIONS（每个动作一条）。glTF 没有循环标志，循环动作要在 Godot 里设 loop_mode（见 ASSETS.md）。
- **骨骼命名**：沿用 `root`、`torso`、`head`、`arm-left`、`arm-right`、`leg-left`、`leg-right`，所有居民共用，换外观不改骨架。
- **贴图**：内嵌在 GLB 里（`export_image_format=AUTO`）。
- **文件名**：小写英文加下划线，换外观不改内容编号。

## 验收（Godot 导入）

居民模型的导入验收随 `build_residents.sh` 的流程做（身体、动画库导入后在 Godot 里检查骨架与动作）。
