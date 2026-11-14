# Changelog

本项目的所有重要变更都记录在这里。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-11-14

首个可发布版本。从本地 `~/.dsh/plugins/dsh-turn-notify` 整理而来，补齐发布元数据与文档后开源。

### 新增

- `session/event` 事件订阅：监听 `turn/start` 与 `turn/end`，记录每轮开始时间并计算耗时。
- 结束原因分诊：`error` / `interrupted` 判为失败，`max_tokens` 与 `stop` 分别给出对应文案；`notifyOnSuccess` / `notifyOnError` 可独立开关。
- 右下角自绘卡片渲染器 `toast.ps1`：WPF 无边框透明置顶窗口，淡入 8 帧 × 20ms、停留可配、淡出 8 帧，`ShowInTaskbar=False` / `ShowActivated=False` 不抢焦点。
- 单例队列：`active` / `pending` / `lastShownAt` 配合 `debounceMs`，新的一轮替换排队中的旧内容，不长出一叠窗口；`(seconds + 30) * 1000` 兜底超时防止渲染进程卡死后队列永久锁死。
- 双路日志：`~/.dsh/turn-notify-debug.log`（host 侧，含 `apply() entered`、`using renderer:`、`subscribed to session/event — plugin armed`、`turn/end key=... kind=... elapsed=...ms`、`renderer exited code=...`、未识别事件 `observed other event: <type>`）与 `~/.dsh/turn-notify-wpf.log`（渲染侧，含 `start` / `shown left=... top=... actual=...x...` / `closed` / `FAILED: <message>` + 脚本堆栈）。`DSH_HOME` 可覆盖日志目录。
- 全部配置走 `cordis.patch.yml` 的 `config` 段：`enabled`、`seconds`、`width`、`bottomMargin`、`rightMargin`、`notifyOnSuccess`、`notifyOnError`、`minDurationSec`、`showSessionTitle`、`maxBodyChars`、`debounceMs`、`script`。
- `script` 自定义渲染器路径，解析顺序：配置路径 → 包内 `toast.ps1` → `~/.dsh/plugins/dsh-turn-notify/toast.ps1`。
- 发布元数据：`package.json` 声明 `dsh.bundle.patch` 与 `exports`，`files` 白名单把 `toast.ps1`、`README.md`、`CHANGELOG.md`、`LICENSE` 一并打进包。

### 实现约束（改代码前必读）

这些是实测踩出来的坑，逐条对应代码里的防御：

- **不用 Windows Toast API**：未打包的 Win32 进程没有注册 AppUserModelId 快捷方式，`ToastNotifier.Show()` 返回成功但系统静默丢弃。
- **不用 Electron `BrowserWindow`**：DSH 插件宿主是独立的 plain-node 子进程（`dsh-desktop-host` 由 `spawn` 启动），不在 Electron 主进程内，拿不到 `BrowserWindow`。
- **不加 `-WindowStyle Hidden` / `windowsHide: true`**：火绒一类 HIPS 会把「隐藏 PowerShell 执行」直接拦掉，子进程被杀，弹窗静默消失。
- **不用 `detached: true`**：启动器交出控制权立即触发 `exit`，插件会误判渲染进程 200ms 就死了，队列和日志全在说谎。固定 `detached: false`。
- **定位只用 `SystemParameters.WorkArea`**：`Screen` 给物理像素，WPF 的 `Left/Top` 用 DIP，200% 缩放下会把窗口扔到屏幕外两倍远；尺寸计算前调 `SetProcessDPIAware()`。
- **`toast.ps1` 必须保留 UTF-8 BOM**：PowerShell 5.1 把无 BOM 文件按 ANSI 读，中文注释乱码并直接解析失败。
- **`-LogPath` 只在值是非空字符串时才传**：传空串会让 `-File` 模式报 `Missing an argument for parameter 'LogPath'`，渲染进程毫秒内退出，看起来像「弹窗闪一下就没了」。

### 已知情况

- 公共 npm 注册表上的 `dsh-turn-notify` 已被另一个不相关的包占用（`0.3.4`，浏览器 Notification + Badging API 方案）。本插件不发布到该名字，分发走 GitHub Release / `github:` 安装；如确需 npm，改用 scoped 名 `@koolook123/dsh-turn-notify` 并执行 `npm publish --access public`。
- 部分 DSH 版本对 bundle 的裸包名解析基准是 loader 自身而非 profile 目录，此时需手动往 profile 的 `cordis.patch.yml` 插入一段，并把 `name` 写成相对路径 `./node_modules/dsh-turn-notify/lib/index.js`。README「安装 · 方式三」有完整写法。

[1.0.0]: https://github.com/koolook123/dsh-turn-notify/releases/tag/v1.0.0
