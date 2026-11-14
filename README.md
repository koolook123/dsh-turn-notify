# dsh-turn-notify

DeepSeek Harness（DSH）的 Windows 桌面提醒插件：**每一轮 agent 任务结束时，在桌面右下角弹出一个自动消失的提示卡片**，显示会话名、完成状态和耗时。

不用盯着窗口等长任务跑完 —— 切出去干别的事，结束时会有一张卡片飘出来。

## 它做什么

插件在 host 侧订阅 `session/event` 事件流里的 `turn/start` 与 `turn/end`：

- `turn/start`：记录该会话的开始时间；
- `turn/end`：计算耗时，按结束原因生成文案（`消息完成` / `本轮失败` / `达到 token 上限` / `本轮已停止`），调起渲染进程弹卡片。

弹窗队列保证同一时刻只有一张卡片，新的一轮会替换掉排队中的旧内容而不是叠一堆窗口。

### 文案示例

```
DeepSeek Harness · 复盘 A 股收盘数据
消息完成 · 耗时 1m23s
```

## 为什么是 PowerShell + WPF 而不是别的

这几条是实测踩出来的，改实现前先读：

| 方案 | 结论 |
| --- | --- |
| Windows Toast（`ToastNotifier.Show()`） | 未打包的 Win32 进程没有注册 AppUserModelId 快捷方式，API 返回成功但系统静默丢弃通知 |
| Electron `BrowserWindow` | DSH 的插件宿主是独立的 plain-node 子进程（`dsh-desktop-host` 由 `spawn` 启动），不在 Electron 主进程内，`require('electron')` 拿不到 `BrowserWindow` |
| `-WindowStyle Hidden` / `windowsHide: true` | 火绒一类 HIPS 会把「隐藏 PowerShell 执行」这个组合直接拦掉，子进程被杀，弹窗静默消失。渲染进程按普通（最小化）方式启动 |
| `detached: true` | 启动器一交出控制权就触发 `exit`，插件以为弹窗 200ms 就死了，队列和日志全在说谎。必须 `detached: false`，让子进程活着直到卡片消失 |
| `System.Windows.Forms.Screen` 定位 | 它给的是物理像素，WPF 的 `Left/Top` 用 DIP；200% 缩放下会把窗口扔到屏幕外两倍远。必须用 `SystemParameters.WorkArea`（已是 DIP），并在尺寸计算前调 `SetProcessDPIAware()` |
| `toast.ps1` 去掉 UTF-8 BOM | PowerShell 5.1 会把无 BOM 文件按 ANSI 读，中文注释乱码并直接解析失败。**这个文件必须保留 BOM** |

另外 `-LogPath` 只在值是真实字符串时才传给 `powershell.exe`；传空串会让 `-File` 模式报 `Missing an argument for parameter 'LogPath'`，渲染进程毫秒内退出，看起来像「弹窗闪一下就没了」。

## 环境要求

- Windows（`process.platform !== 'win32'` 时插件直接静默退出）
- PowerShell 5.1+，能加载 `PresentationFramework` / `PresentationCore` / `WindowsBase` / `System.Windows.Forms`
- Node.js 18+（ESM）
- DeepSeek Harness，profile 支持 `dsh.bundle.patch`

## 安装

### 方式一：作为 DSH bundle 从 GitHub 安装（推荐）

在 profile 目录（默认 `~/.dsh/profiles/desktop`）里：

```bash
cd ~/.dsh/profiles/desktop
pnpm add github:koolook123/dsh-turn-notify
```

然后把包名加进 `package.json` 的 `dsh.profile.bundles`：

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dsh-turn-notify"
    ]
  }
}
```

DSH 会读取包内 `dsh.bundle.patch` 指向的 `cordis.patch.yml` 并合并挂载。**改完需要重启 DSH**（插件宿主是常驻子进程，热更新不生效）。

### 方式二：本地 link（开发/调试）

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:C:/path/to/dsh-turn-notify
```

同样把 `dsh-turn-notify` 加进 `dsh.profile.bundles`，重启 DSH。

### 方式三：手动写进 profile 的 `cordis.patch.yml`

部分 DSH 版本对 bundle 的裸包名解析基准是 loader 自身而不是 profile 目录，会静默加载失败。这时手动插入一段，并把 `name` 写成相对路径：

```yaml
- insert:
    - id: turn-notify
      name: ./node_modules/dsh-turn-notify/lib/index.js
      config:
        enabled: true
        seconds: 6
        width: 380
        bottomMargin: 24
        rightMargin: 24
        notifyOnSuccess: true
        notifyOnError: true
        minDurationSec: 0
        showSessionTitle: true
        maxBodyChars: 160
```

同时确保 `package.json` 的 `dependencies` 里有这个包（`"dsh-turn-notify": "link:..."` 或 `github:` 形式）。

## 配置项

包内 `cordis.patch.yml` 的 `config` 段，也可以在安装后直接改 profile 的 `cordis.patch.yml`：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时 `apply()` 直接返回 |
| `seconds` | `6` | 卡片停留秒数（含淡入淡出） |
| `width` | `380` | 卡片宽度，DIP |
| `bottomMargin` / `rightMargin` | `24` / `24` | 距屏幕右下角边距，DIP |
| `notifyOnSuccess` | `true` | 正常结束时弹 |
| `notifyOnError` | `true` | `error` / `interrupted` 结束时弹 |
| `minDurationSec` | `0` | 最短耗时阈值（秒），短于它的轮次不弹，用来防刷屏；`0` = 全弹 |
| `showSessionTitle` | `true` | 标题里带会话名；`false` 只显示 `DeepSeek Harness` |
| `maxBodyChars` | `160` | 正文最多字符数，超出截断加 `…` |
| `debounceMs` | `400` | 两次弹窗的最小间隔 |
| `script` | 自动探测 | 自定义渲染脚本路径，优先级高于包内 `toast.ps1` |

`script` 的解析顺序：配置的路径 → 包内 `toast.ps1` → `~/.dsh/plugins/dsh-turn-notify/toast.ps1`。

## 日志与自检

所有分支都留痕，静默失败是最糟的失效方式：

- `~/.dsh/turn-notify-debug.log`：host 侧。`apply() entered`、`using renderer:`、`subscribed to session/event — plugin armed`、`turn/end key=... kind=... elapsed=...ms failed=...`、`renderer exited code=...`；未见过的事件类型记一行 `observed other event: <type>`。
- `~/.dsh/turn-notify-wpf.log`：渲染侧。`start title=... seconds=...` → `shown left=... top=... actual=...x...` → `closed`；异常记 `FAILED: <message>` 加脚本堆栈。

`DSH_HOME` 环境变量可覆盖日志目录，未设置时用 `%USERPROFILE%\.dsh`。

快速自检：

```bash
# host 侧语法
node --check lib/index.js

# 渲染脚本 BOM（必须输出 efbbbf）
xxd -l 3 toast.ps1

# 直接手动弹一次（不依赖 DSH）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File toast.ps1 \
  -Title "DeepSeek Harness" -Body "消息完成 · 耗时 12s" -Seconds 6
```

## 发布状态

- GitHub：`koolook123/dsh-turn-notify`，v1.0.0 Release。
- npm：公共注册表上的 `dsh-turn-notify` 已被另一个不相关的包（`0.3.4`，浏览器 Notification 方案）占用，本插件**没有**发布到那个名字。需要 npm 分发时改用 scoped 名：

  ```bash
  npm pkg set name=@koolook123/dsh-turn-notify
  npm publish --access public
  ```

  安装方式一/三里的包名要同步换成 scoped 名。走 GitHub Release 或 `github:` 安装则无需改。

## 文件结构

```
dsh-turn-notify/
├── package.json          # ESM 入口 + dsh.bundle.patch 声明
├── cordis.patch.yml      # bundle 挂载行与默认配置
├── lib/index.js          # host 半边：事件订阅、队列、spawn
├── toast.ps1             # 渲染半边：WPF 卡片（UTF-8 BOM，勿去）
├── README.md
├── CHANGELOG.md
└── LICENSE              # MIT
```

## License

MIT
