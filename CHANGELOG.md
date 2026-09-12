# 更新记录

## 1.0.0

首个版本。

**桌宠本体（原样运行原版代码）**

- 通过最小 DSH 宿主（`__ModuleLoader__` 垫片 + `ctx.slots/locale/effect` 桩 +
  同源 HTTP 接口）让原版 `client.js` 一行未改地在桌面窗口里运行
- 50 个透明动画、打字机气泡、工作三态轮播、点击/双击/拖拽交互、睡眠与时间感知

**宿主端接口（严格按原版契约实现）**

- `/api/whale-pet/state` —— 破坏性读取的状态队列（mood / activity / done）
- `/api/whale-pet/usage` —— 分时段用量账本（小时/日桶、三桶、峰谷、缓存命中率）
- `/api/whale-pet/settings` —— GET 完整配置 / POST 增量 patch
- `/api/whale-balance` —— DeepSeek 余额 + 今日用量
- `/api/whale-pet/weather` —— 明日预报（支持自定义城市）
- `/pet/thumb/<名称>.webm` —— 动画视频，支持 HEAD 探测

**用量计算**

- 直接读 `~/.dsh/sessions/**/session*.jsonl.zstd`，按帧魔数切开多帧 zstd 逐帧解压
- 计费复用原版 `lib/usage.js`（vendored），与网页版同价目、同三桶

**桌面化**

- 透明、置顶、无边框、不进任务栏的窗口；整窗默认鼠标穿透，只在光标落进宠物/按钮/
  气泡的矩形时恢复可点
- 窗口尽量铺满但**不完全覆盖 DSH 窗口**，避免 Chromium 的遮挡检测导致 DSH 停止绘制
- 窗口 `focusable:false`，点击不抢 DSH 焦点
- 窗内自绘右键菜单（原生 popup 在不可聚焦窗口上不显示）
- 托盘图标、`Ctrl+Alt+W` 全局快捷键分别作为穿透模式的退出口
- 开机自启（启动文件夹）+ 守护进程 + DSH 启动插件，三层保证常驻

**修复记录（开发过程中踩到的）**

- 用「会话文件多少秒没变化」猜收工 → 长任务被误判为完成。改读 `turn/start`、`turn/end`
- 全屏置顶窗口导致 DSH 界面冻结 → 改为「不完全覆盖」的避让式布局
- 点击桌宠抢走 DSH 焦点 → 窗口设 `focusable:false`
- 守护进程互斥量在强杀后进入 abandoned 状态、`WaitOne` 抛异常导致再也拉不起来 → `try/catch` 接管
- 强杀进程留下托盘幽灵图标 → 正常退出时 `tray.destroy()`
