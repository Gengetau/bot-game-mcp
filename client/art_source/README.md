# art_source：美术源文件与导出约定

> 居民和街景已换成 KayKit + Kenney Fantasy Town（见 `client/ASSETS.md`）。重新生成用 `recolor_kenney.py`、`build_residents.sh`/`build_residents.gd`、`recolor_residents.py`。
> 下面「目录」里的 `build_resident.py`、`check_resident.gd` 和 Mini Characters 是旧流程（P0 验证用），运行时已不再使用，只作历史记录。

这里放 Blender 脚本、第三方原始素材（只留用到的文件）、许可证文本和导出约定。
运行时资产在 `client/town/assets/`；台账和授权见 `client/ASSETS.md`。

## 目录

- `build_resident.py`：原始角色 GLB -> `town/assets/models/characters/resident.glb`（bpy，可重复运行）。
- `audio/`：音频的再生成脚本（`build_audio.py`，调用同目录的 `loop.py`、`segpick.py`；需要 ffmpeg + numpy）。输出 `town/stream/music/`（音乐，不进 pck）、`town/assets/audio/ambience/`、`town/assets/audio/sfx/`。原始素材体积大不进仓库，来源和 sha256 见 `../ASSETS.md`，许可证据见 `third_party/opengameart/`。
- `check_resident.gd`：Godot 里检查导入结果的脚本（验收用，不属于游戏工程）。
- `source/`：脚本的输入。`kenney_mini_character_male_a.glb` 和它引用的 `Textures/colormap.png`（导入 Blender 时需要这张贴图在原位置）、`audio/*.ogg`。
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

```bash
mkdir -p /tmp/glbcheck && cp client/town/assets/models/characters/resident.glb client/art_source/check_resident.gd /tmp/glbcheck/
printf 'config_version=5\n[application]\nconfig/name="glb-check"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n' > /tmp/glbcheck/project.godot
/opt/godot/godot --headless --path /tmp/glbcheck --import
/opt/godot/godot --headless --path /tmp/glbcheck --script check_resident.gd   # 最后一行应是 RESULT PASS
```

检查内容：`AnimationPlayer` 里有 `idle`、`walk`；有 `Skeleton3D` 和 7 根骨；世界包围盒高度约 1.7、最低点约 0；walk 播放时腿骨旋转确实在变。
朝向用渲染截图确认（xvfb + `--display-driver x11 --rendering-driver opengl3`，相机放在 +Z 看向原点，能看到脸）。
