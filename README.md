# PDF API Translate

一个可直接安装到 Obsidian 的桌面端插件：

- 在 Obsidian PDF 视图里选中文本后自动触发翻译
- 仅在 PDF 的文本层内生效，不干扰普通笔记编辑
- 默认将英文翻译成简体中文
- 支持 Gemini / OpenAI 兼容等大型模型 API，可自定义模型、接口地址和配置
- 全新液态玻璃（Liquid Glass）绝美浮窗：原生支持 SVG 高级畸变滤镜（Chromatic Aberration）与光晕透射，带来物理级玻璃折射的超强通透视觉体验
- 提供悬浮翻译面板，支持复制译文和手动重译

## 安装

把当前目录整体放到你的 Obsidian 仓库插件目录：

```text
<你的 Vault>/.obsidian/plugins/pdf-gemini-translate/
```

目录中至少需要这些文件：

- `manifest.json`
- `main.js`
- `styles.css`

然后在 Obsidian 中：

1. 打开 `设置 -> 第三方插件`
2. 刷新插件列表
3. 启用即可 (原插件文件夹名可能仍为 PDF Gemini Translate)
4. 进入插件设置，选择您需要的 API 格式并填入 API Key

## 默认行为

- 只有在 `.pdf-container .textLayer` 内选择文字时才会自动翻译
- 默认只对“看起来像英文”的选区触发自动翻译
- 默认结果为简体中文
- 也可以通过命令面板执行手动提取翻译

## API 设置

插件默认预置了 Gemini 的参数：

- 接口地址：`https://generativelanguage.googleapis.com/v1beta/models`
- 模型：`gemini-3.1-flash-lite-preview`

您也可以在 **API 协议格式** 中选择 **OpenAI 兼容格式**，并在下方填写对应代理大模型（如 DeepSeek, ChatGPT）的 Base URL 及模型名称。
- 安全速率：针对免费 Key 提供 15 RPM（每分钟15次）的调用速率防护，默认最小请求间隔为 `4000` 毫秒（4秒）。若您使用付费版无限制 Key，可在设置面板中将其清零以解锁全速翻译。

如果你使用代理或兼容网关，也可以在设置里改成自己的地址。

## 已知限制

- 当前版本依赖 Obsidian 桌面端 PDF DOM 结构，不支持移动端
- 这是选区翻译，不会把译文写回 PDF 批注
- 没有做流式输出，结果会在请求完成后一次性显示
