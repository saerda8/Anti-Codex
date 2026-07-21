# Anti-Codex 真人短视频纠错回归：Stage 6

继续同一个原生任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`，不得新建任务，不得启动第二个 Anti-Codex 窗口。用户已经明确否决 Stage 4 的二维动画：它不是“真人短视频”。本轮必须在原工程目录

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-18-character-dialogue-short-video`

内新建且只操作子目录 `live-action-stage6`。禁止修改或覆盖 Stage 1-5 文件，禁止修改 Anti-Codex 产品源码，禁止调用九个开发 MCP worker。开始每组命令前先用一句简短中文说明目的；命令完成后继续下一步，不要无意义重复执行、反复启动渲染器或只写文字报告。

## 目标

制作一支 35-50 秒、1080x1920 的真人护肤带货短片，观感接近抖音真人产品演示。画面主体必须是真实拍摄的人物动态视频，不能出现矢量人物、卡通人物、Canvas/SVG 动画、生成静帧、图片轮播或用平移缩放冒充真人表演。

主题：`下班后 40 秒快速补水流程`。使用无品牌、无医疗功效承诺的泛护肤产品表达。可以采用真人演示加中文主播配音，不要求伪造嘴型同步；但必须有完整的人声、字幕、动作节奏和明确开场/演示/结果/行动提示，不能只是素材拼接或 PPT 式朗读。

## 已预检的真人竖屏素材

以下 5 段均为同一真人模特、同一浴室场景的 Mixkit 动态视频，主机已确认下载端点 HTTP 200，并实际抽帧确认是真人实拍。每段约 23.976 fps，720x1280，总可用时长约 79.7 秒。必须下载并实际使用至少 4 段，最终有效画面时长至少 90% 来自这些真人动态素材。

1. `51183`，10.80 秒：`https://assets.mixkit.co/videos/51183/51183-720.mp4`
   来源页：`https://mixkit.co/free-stock-video/a-young-woman-gently-cleans-her-face-with-a-cotton-51183/`
2. `51184`，14.51 秒：`https://assets.mixkit.co/videos/51184/51184-720.mp4`
   来源页：`https://mixkit.co/free-stock-video/vertical-video-of-a-young-woman-placing-golden-eye-bag-51184/`
3. `51185`，23.65 秒：`https://assets.mixkit.co/videos/51185/51185-720.mp4`
   来源页：`https://mixkit.co/free-stock-video/a-young-woman-delicately-applies-a-beauty-face-cream-to-51185/`
4. `51186`，16.89 秒：`https://assets.mixkit.co/videos/51186/51186-720.mp4`
   来源页：`https://mixkit.co/free-stock-video/a-young-woman-gently-places-a-beauty-paper-facemask-51186/`
5. `51187`，13.89 秒：`https://assets.mixkit.co/videos/51187/51187-720.mp4`
   来源页：`https://mixkit.co/free-stock-video/a-young-woman-with-a-towel-robe-applying-skincare-product-51187/`

许可证页：`https://mixkit.co/license/`。在 `sources.json` 和 `README.md` 中记录每段素材的来源页、直接下载 URL、下载时间、文件字节数、SHA-256 和许可证页。不要下载或使用任何 Envato 付费素材、AI 生成素材、带水印素材或来源不明素材。

## 必须完成

1. 先下载素材并用 ffprobe 验证每段视频流；任何下载失败只重试对应文件一次，仍失败就明确报错停止，不能用动画或静帧代替。
2. 写 `script.md` 和 `storyboard.md`，设计至少 9 个有意义的剪辑段落。开头 2 秒内出现真人和明确钩子；中段依次呈现清洁、眼周、面霜/面膜等动作；结尾给出非品牌行动提示和“测试成片/非功效承诺”说明。
3. 生成自然中文配音和逐句字幕。至少 8 句有效中文台词，字幕必须在竖屏安全区内，不能遮住眼睛、嘴和产品动作。使用本机已有 TTS 能力；如果一种 TTS 不可用，检查一次并换本机可用方案，不要反复启动同一失败命令。
4. 编写可重复执行的构建脚本，将真人素材按叙事节奏裁切、调色、轻度变速或重构图，并加入克制的标题、字幕、环境/动作声音和音乐。不得用静态画面填充时长。音乐必须可合法生成或来自本机既有无版权来源，并在来源清单中说明。
5. 输出 `final-live-action.mp4`：35-50 秒、1080x1920、23.976/24/30 fps、H.264、yuv420p、AAC 48 kHz。完整解码必须通过；目标综合响度约 -16 LUFS，真峰值不高于 -1 dBTP，无非剧情黑场，最长非剧情静音少于 1.5 秒。
6. 从最终成片实际抽帧生成 `poster.png`、至少 12 帧且覆盖全部剪辑段落的 `contact-sheet.png`，以及同一真人动作段连续至少 12 帧的 `motion-strip.png`。联系表必须一眼能看出真人、不同动作和剪辑进展。
7. 输出 `captions.srt`、`ffprobe.json`、`media-qa.json`、`visual-qa.md`、`sources.json`、`README.md`、可重复构建源码和 `release-package.zip`。发布包排除缓存、临时文件、密钥和下载失败残留。
8. 新增并运行一个本地验收命令，至少校验：输出规格、时长、音视频流、8 句字幕、9 个剪辑段落、4 个以上不同真人源片段、真人源时长占比、全部来源哈希、必需文件非空、发布包可完整读取。

## 完成标记

只有全部构建和 QA 通过后，才写 `done-live-action.txt`，内容必须精确为：

`LIVE_ACTION_STAGE6_OK_20260719`

UTF-8 无 BOM、无回车、无换行。最终回复简要给出成片路径、时长、哈希和 QA 结果，最后一行只输出该标记。主机将实际观看成片和抽帧，任何文字自述都不能代替真人画面与文件验收。
