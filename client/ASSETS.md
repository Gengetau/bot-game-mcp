# 资产与授权台账

运行时资产放在 `client/town/assets/`，制作源和第三方许可证文本放在 `client/art_source/`。
本表每一行对应一个第三方包；自制或程序处理的部分在「修改说明」里写明。

| 包名（版本） | 作者 | 原始页面 | 取得日期 | 许可证 | 对应文件 | 修改说明 |
|---|---|---|---|---|---|---|
| Fantasy Town Kit (2.0) | Kenney (www.kenney.nl) | https://kenney.nl/assets/fantasy-town-kit | 2026-11-13 | CC0 1.0（包内 License.txt 写 "Creative Commons Zero, CC0"：`art_source/third_party/kenney_fantasy-town-kit/License.txt`）；zip 的 sha256 `1a7530c09f4d2fa2cdee259876f089334f8b1f27fa86a0c4f54ef86cdd8676ef` | `town/assets/models/kenney/`：tree、tree-high、tree-crooked、lantern、fence、fence-gate、hedge、hedge-large、stall-red、cart、rock-large、rock-small、rock-wide、banner-red、banner-green、stall-stool 的 glb，加 `Textures/colormap.png`（共约 408 KB，包里其余模型没有进仓库） | 只留用到的模型。`art_source/recolor_kenney.py` 重绘调色板贴图（奶油、木棕、灰蓝瓦的色调，更柔）；重绘后的贴图和脚本都进了仓库。网格没有改；摆放、缩放、朝向、发光点在 `town/assets/art_table.json`；房屋、地面、小物件（长椅、桌、书架、灶、花坛、喷泉……）是 `scripts/town_art.gd` 用程序生成的，不属于任何第三方包 |
| Adventurers (2.0 FREE) | Kay Lousberg (www.kaylousberg.com) | https://kaylousberg.itch.io/kaykit-adventurers | 2026-11-13 | CC0 1.0（包内 License.txt 写 "Creative Commons Zero, CC0"，署名可选：`art_source/third_party/kaykit_adventurers/License.txt`）；zip 的 sha256 `abe48f4763fba0896bab486ee9e6d08ca6b5b3884b9601f235c8847ae94dc479` | `town/assets/models/characters/body_{rogue,ranger,mage,knight}.scn`、`outfit_0..7.png` | `art_source/build_residents.sh` + `build_residents.gd`：只取 4 个身体（骨架相同），去掉武器道具，存成 Godot 场景；`recolor_residents.py` 把原调色板重绘成 8 套服装（`outfit_*.png`，重绘贴图和脚本都进仓库）。网格没有改 |
| Character Animations (1.1) | Kay Lousberg (www.kaylousberg.com) | https://kaylousberg.itch.io/kaykit-character-animations | 2026-11-13 | CC0 1.0（`art_source/third_party/kaykit_character-animations/License.txt`）；zip 的 sha256 `65882f31f905ad2e953819648a59287cdeab8f623908d5ef701971d3758be20f` | `town/assets/models/characters/residents_anims.res`（约 93 KB） | `build_residents.gd` 只摘出用到的动作（idle、walk、sit 三段、wave、interact 等）合成一个动画库，循环动作设成 LOOP_LINEAR；其余动作没有进仓库 |
| Interface Sounds (1.0) | Kenney (www.kenney.nl) | https://kenney.nl/assets/interface-sounds | 2026-11-12 | CC0 1.0（`art_source/third_party/kenney_interface-sounds/License.txt`） | 输入：`art_source/source/audio/kenney_interface_confirmation_001.ogg`；输出：`town/assets/audio/sfx/confirm.ogg` | `art_source/audio/build_audio.py`：去开头静音，峰值归一到 -9 dBFS，末尾 15 ms 渐出，单声道 Ogg Vorbis（q3）。详见下面「音频台账」 |
| Impact Sounds (1.0) | Kenney (www.kenney.nl) | https://kenney.nl/assets/impact-sounds | 2026-11-12 | CC0 1.0（`art_source/third_party/kenney_impact-sounds/License.txt`） | 输入：`art_source/source/audio/kenney_impact_footstep_concrete_001.ogg`；输出：`town/assets/audio/sfx/step.ogg` | 同上（峰值 -16 dBFS，比确认音轻） |
| Godot Engine (4.7.2.stable) | Godot Engine contributors | https://godotengine.org | 以 `/opt/godot/godot --headless --version` 确认：`4.7.2.stable.official.ed1daf0bf` | MIT；引擎内置的第三方组件各有自己的许可（完整清单见 Godot 自带的 `COPYRIGHT.txt`，或引擎「第三方许可」页面） | 网页导出产物里的引擎 `index.wasm`、`index.js` 等（`client/town/build/web/`） | 引擎随网页导出一起分发；许可入口见下面「Godot 引擎的许可」；模板核对见同一节 |

取得方式：用 Playwright 打开 Kenney 素材页，点页面自己的「Download」和「Continue without donating」按钮下载（正常访客流程），
压缩包解压在独立的空目录里当不可信数据处理，只把上表列出的文件和包内 License.txt 拷进仓库。其余文件没有进仓库。

**Godot 引擎的许可**：随包分发的引擎二进制要求保留 Godot 的版权声明和 MIT 许可文本，并保留内置第三方组件各自的许可声明。做法：`client/tools/gen_licenses.gd`（无界面 GDScript，`godot --headless --script` 跑）把引擎自己的 `Engine.get_license_text()`、`get_copyright_info()`、`get_license_info()` 整理成一份纯文本，开头写明「这个页面用 Godot Engine 构建；美术与音频素材均为 CC0，来源见 `client/ASSETS.md`」并列出各素材包的作者致谢；`client/tools/export.sh` 在导出后生成它，放进导出目录 `licenses.txt`（约 100 KB，不进 pck、不预压缩）；进入面板底部有一个「开源许可」链接（新窗口打开）。引擎托管 `/town/3d/` 时 `.txt` 的类型是 `text/plain; charset=utf-8`（`packages/engine/src/world/http.ts`，`client-host.test.ts` 有用例）；端到端步骤 1 断言链接可见、文件取得到且含 Godot 的 MIT 许可文字。组件清单不在本台账抄写，以引擎给出的为准。
**官方模板核对（2026-11-13）**：`/opt/godot/godot --version` 是 `4.7.2.stable.official.ed1daf0bf`；`~/.local/share/godot/export_templates/4.7.2.stable/version.txt` 是 `4.7.2.stable`（与引擎版本一致），`client/town/export_presets.cfg` 的 `custom_template/debug`、`custom_template/release` 都为空，即用的是装在模板目录里的标准模板（单线程 `web_nothreads_release.zip`）。导出产物的 `index.wasm`（sha256 `fc74679e3b97f76878947fcd4fbe1268cbfa6188182a2e33bbc3f5dc9bfa57d0`）和 `index.js`（`33c94cb3175f3333b82e2a3be5e8e86f77986f0aa2042b1631f6367a4e5bb6ba`）与模板压缩包里的 `godot.wasm`、`godot.js` 逐字节相同，说明导出没有改动引擎。**核对不了的部分**：没有拿 Godot 官方发布的模板校验和比对（这台机器上没有取得它的途径），所以只能证明「用的是模板目录里这份、没被导出过程改过」，不能证明模板目录里这份就是官方原件。

CC0 不要求署名；按 Kenney 的建议，游戏的「关于」里可以写一句 Kenney (www.kenney.nl)。

**旧资产说明**：P0 曾用 Kenney Mini Characters (2.0，CC0，2026-11-12 取得)，已不再使用；其原始输入、转换脚本和 License.txt 已于 2026-11-13 从仓库删除（核对过没有任何引用），仅留此历史记录。

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

# 音频（需要 ffmpeg 带 libvorbis、numpy；原始素材放进一个目录，布局见脚本开头的注释）
python3 -I client/art_source/audio/build_audio.py <原始素材目录> [候选试听输出目录]

# 用 Godot 验收导入结果，见 client/art_source/README.md 的「验收」
```

## 音频台账（P1）

下载日期都是 2026-11-13。**只用 CC0**。OpenGameArt 的许可是在每条素材的页面上读到的 `License(s)` 一栏（值为 CC0），页面文字、作者、发布时间和下载文件的 sha256 存成了
`art_source/third_party/opengameart/<页面名>.txt`；Kenney 的两个包用包内 `License.txt`（`art_source/third_party/kenney_*/License.txt`）。
原始文件体积大，不进仓库（`art_source/audio/build_audio.py` 的开头写了怎么摆放后重新生成）。CC0 不要求署名；「关于」里可以写一句 Kenney (www.kenney.nl)、Zane Little、neonarkade 等。

### 进了游戏的音乐、环境声（运行时文件）

| 用途 / 运行时文件 | 作者 | 来源页面 | 许可 | 原始文件与 sha256 | 我们做的处理 |
|---|---|---|---|---|---|
| 白天音乐 `town/stream/music/day.ogg` | neonarkade | https://opengameart.org/content/quaint-town | CC0 | `Quaint Town - LOOPABLE.wav`，`854ee773dbcad1b0b8d63af4f4a4c310b29da58e3f13616ed62ec6df7e4ea715` | `loop.py`：保留 0–75.43 秒（作者的「LOOPABLE」版共 102.8 秒，75.4 秒之后是空白尾巴，被剪掉；结束点按「最像开头」搜出，波形互相关 0.91），开头 1.5 秒与 75.43 秒处等功率交叉淡化；响度归一到 -23 LUFS（增益 -7.5 dB），限幅 -1 dBFS，立体声 80 kbps Ogg Vorbis |
| 夜晚音乐 `town/stream/music/night.ogg` | Zane Little Music | https://opengameart.org/content/hush-hamlet | CC0 | `hush_hamlet_loop_0.wav`（页面上的 loop 版，96.0 秒，48 kHz float），`a0761ded88634442fec6e7f02c875ec9745692acd9089c715d73a51a38b883fa` | 不剪（作者给的循环版）；重采样 44.1 kHz，响度归一到 -23 LUFS（增益 -5.7 dB），限幅，立体声 80 kbps Ogg Vorbis |
| 白天环境声 `town/assets/audio/ambience/day.ogg` | Thimras | https://opengameart.org/content/park-ambiences | CC0 | `park_ambience_birds.wav` `dc1a5ac34b89cab7f8f261b53a23da7c1c5e3cc895aae4cb6fb4a1a04001b2af`；`park_ambience_wind.wav` `5c381856745b4706e7eba55eb9271a61a530e90c05df8126adb2db89ecfa6c5a` | `segpick.py`：鸟声取第 140 秒起 36 秒（2–6 kHz 起伏最大），风声取第 195 秒起 36 秒（响度最平稳），各自首尾 3 秒等功率交叉淡化后按 1 : 0.5 混合；单声道，低通 11 kHz，-34 LUFS，40 kbps |
| 喷泉定点声 `…/ambience/fountain.ogg` | Thimras | 同上 | CC0 | `park_ambience_river.wav` `da0c0c9b1249a83a1611cc116d5737b0864a8db9f45f1ae8dcc079d0f7c0bbbf`（小溪过低坎，带少量鸟蛙声） | 取第 1 秒起 24 秒（响度最平稳），首尾 3 秒交叉淡化；单声道，低通 10 kHz，-30 LUFS，40 kbps |
| 夜晚环境声（虫鸣）`…/ambience/night.ogg` | Wolfgang_（页面版权栏写 Ted Kerr，署名可选） | https://opengameart.org/content/crickets-ambient-noise-loopable | CC0 | `crickets_1.mp3`（11.5 秒，作者标明可循环），`5b5bd1f744087888c5623543c3ff80be9c2ce106093993e7c8a8492b0280b2c0` | 不剪；单声道，-36 LUFS，40 kbps |
| 室内环境声（茶馆等）`…/ambience/indoor.ogg` | PagDev + 自制 | https://opengameart.org/content/fireplace-sound-loop | CC0 | `fire.wav`（壁炉噼啪，29.3 秒），`85ca0cc60d0c037fff8b185e31ad1fcdbda6ce45eee17c3ee1318d1b8f59e330` | 与 ffmpeg 生成的棕噪声（低通 350 Hz，当房间底声，自制）按 1 : 0.5 混合；单声道，低通 9 kHz，-36 LUFS，40 kbps |

### 只放在试听目录、没有进仓库的音乐候选

均为 CC0（页面 License(s) 一栏读到），页面证据同在 `art_source/third_party/opengameart/`：
Forget Me Not（Kistol，https://opengameart.org/content/forget-me-not ，`forget_me_not_in_f_major_0.ogg` `615761e410e828e344bbc94755c385f32e337f771f108e23710c3011ca4da874`，剪到 124.1 秒）；
Hot Springs Town（Kistol，https://opengameart.org/content/hot-springs-town ，`hot_spring_town_1.ogg` `2a38145b9f898aab620ff6b70e2ceb7604fe01e3eeee1a2e34f885796d654869`，剪到 80.1 秒）；
Sunset Plains（Yoiyami，https://opengameart.org/content/sunset-plains ，`sunset_plains.wav` `f3750f8eda8bf42662b12f5726404675689b50f05ccaa968c5cb2e33d9172a62`，取 90–196.6 秒）；
Lonely Night（Centurion_of_war，https://opengameart.org/content/lonely-night ，`night_tune3_0.ogg` `ef0f3c69e41ee1aad842fdd98735c0b544c2ae68e554bf86aa9f032a27a71464`，剪到 38.7 秒）。
要换曲就改 `build_audio.py` 里的 `FINAL`。

### 操作音效（`town/assets/audio/sfx/*.ogg`，单声道 Ogg Vorbis q3，原件在 `art_source/source/audio/`，进仓库）

处理都一样：去开头静音、截到最长秒数、峰值归一到下表 dBFS、末尾 15 ms 渐出。音乐 -23 LUFS 远低于音效峰值，再由三条总线的音量调。

| 运行时文件（用途） | Kenney 包 | 原件（sha256） | 峰值 dBFS |
|---|---|---|---|
| `confirm.ogg`（通用确认、停下、接管） | Interface Sounds 1.0，https://kenney.nl/assets/interface-sounds ，CC0 | `confirmation_001.ogg`（`063564703b6094d70718a3e787a55cc9141611e4ecd6b6637f8828f79b4a8c3a`） | -9 |
| `step.ogg`（脚步） | Impact Sounds 1.0，https://kenney.nl/assets/impact-sounds ，CC0 | `footstep_concrete_001.ogg`（`507a75eb19b897087855a3be3cf11a12d7fa37d143ad535eeebe0b8031c7325d`） | -16 |
| `tap.ogg`（点地确认） | Interface Sounds | `select_005.ogg`（`ad09146e4ea33b931b2f5dfb4051a4f1fe4a36f1a48c42c5e9269c292ae21214`） | -12 |
| `fail.ogg`（够不着、失败提示） | Interface Sounds | `error_005.ogg`（`3f75b11df5b06d68d2c25fbf0e9c9d9e7dd9250562a4007ee34856b8a309a2ae`） | -10 |
| `start.ogg`（互动开始） | Interface Sounds | `confirmation_004.ogg`（`568967a3d9f8a8f6af54ea01729c4882284308f2a27d78c07ffd7ee0d6951661`） | -9 |
| `mail.ogg`（收到信、聊天、邀请、交易提议） | Interface Sounds | `glass_001.ogg`（`183eebee20eb0a532b0b85104d139cbf2673eb66d95c3cc733ac9ea98362e7e8`） | -8 |
| `panel_open.ogg` / `panel_close.ogg`（打开、关闭面板） | RPG Audio，https://kenney.nl/assets/rpg-audio ，CC0 | `bookOpen.ogg`（`953390534377222bee89ac8cd9e60a58fdc037c71a4d7c18c43cd647c7f34ba8`）/ `bookClose.ogg`（`81e976532565f4372abd14e83d2684195fa548d0a28d345de221e56052454f32`） | -12 |
| `coin.ogg`（拿到硬币） | RPG Audio | `handleCoins2.ogg`（`4b857968d64f9ac9336a10ffac6694d7547e1f01566ad6857b30bc8db3ee6c32`） | -10 |
| `door.ogg`（进门、出门） | RPG Audio | `doorOpen_1.ogg`（`4ab93bab96522d8eb109ff96dc57cb6765deb02448fe14c10472084be5bb2a0b`），截到 0.8 秒 | -12 |

Kenney 压缩包（2026-11-13 用 Playwright 走页面自己的 Download 与「Continue without donating」按钮下载，解压在独立目录当不可信数据）：
`kenney_interface-sounds.zip` `f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232`，`kenney_rpg-audio.zip` `6dbeaf8544da958d8f2adcb4a4a4b76c1ade34a05f8ab9edccd327da7375f38b`。
`confirm` 与 `step` 的原件是 P0 时（2026-11-12）取的，没有重新核对包内是否逐字节相同。

### 体积（Ogg 实测，字节）

音乐 day 617587 + night 789427 = 1407014（**不进 pck**，导出时拷到 `build/web/music/`，进游戏后才取）；
环境声 day 178578 + fountain 126341 + indoor 161533 + night 58483 = 524935（进 pck）；音效 10 个合计约 58 KB（进 pck）。音频总计约 1.99 MB，目标 ≤ 3 MB。
首屏要下载的 `index.pck` 的前后对比见 `client/README.md`「音频」。
