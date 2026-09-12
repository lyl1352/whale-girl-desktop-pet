# Third-party notices / 第三方组件声明

本项目**只拥有外壳部分的著作权**；桌宠的立绘、动画、浏览器端行为逻辑与计费内核
来自下面的开源项目，均按 MIT 许可原样使用。分发本仓库时请一并保留这些声明。

---

## 1. dsh-whale-girl-pet — 桌宠本体（MIT）

- 项目：https://github.com/yanzwzz/dsh-whale-girl-pet
- npm：`dsh-whale-girl-pet`
- 版权：Copyright (c) 2026 dsh-whale-girl-pet contributors
- 许可证：MIT（全文见 `vendor/LICENSE-dsh-whale-girl-pet`）

本仓库用到的部分：

| 路径 | 内容 | 说明 |
|---|---|---|
| `vendor/dsh-whale-girl-pet.client.js` | 浏览器半侧完整代码 | 原样 vendored，仅 **2 处**小改动（见下） |
| `vendor/usage.mjs` | 用量与计费内核（`lib/usage.js`） | 原样 vendored，用于本地算费用 |
| `assets/*.webm` | 50 个透明动画（`assets/thumb/`） | **不随仓库分发**，由 `tools/fetch-assets.ps1` 在安装时从 npm 拉取 |
| `assets/preview-*.gif`、`qr-donate.png` | 预览图与赞助码 | 同上，安装时拉取 |

### 对原版 client.js 的全部改动（共 2 处，均为本 fork 新增功能）

1. **`WORKING_POOL` 增加 `'吃小鱼干'`**
   让她在工作轮播里也会顺手吃根小鱼干。

2. **`handleFeed()` 里清掉工作轮播定时器**
   ```js
   if (workingTimerRef.current) clearTimeout(workingTimerRef.current);
   ```
   让「投喂 / 充值到账」的吃零食动画能完整播完而不被工作轮播顶掉。
   播完后 `handleEnded` 原本就会判断：仍在工作 → `playWorking()` 接回工作轮播；
   否则 → 回待机链（`吃小鱼干` 本来就在 `INTERRUPT` 集合里，无需额外改动）。

除这 2 处外，动画节奏、文案、看板、拖拽、漫游、点击回应等全部行为都来自原版代码。

> 说明：`vendor/dsh-whale-girl-pet.client.js` 里包含的原版注释、文案、角色设计
> 均归原作者所有。本项目仅提供让它**脱离 DSH 网页、在 Windows 桌面上运行**
> 的宿主外壳。

## 2. React / ReactDOM（MIT）

- 项目：https://github.com/facebook/react
- 版权：Copyright (c) Meta Platforms, Inc. and affiliates
- 许可证：MIT
- 用到：`vendor/react.js`、`vendor/react-dom.js`（18.3.1 的 UMD 生产构建，原样分发）

## 3. Electron（MIT）

- 项目：https://github.com/electron/electron
- 版权：Copyright (c) Electron contributors / OpenJS Foundation
- 许可证：MIT
- 用到：运行时**不随仓库分发**，由 `tools/fetch-electron.ps1` 在安装时下载。

---

## 合规提示

- MIT 允许再分发与修改，但**必须保留版权声明与许可全文**——所以上面三个
  `LICENSE-*` 文件不要删。
- 如果你要发布自己的 fork，请在你的 README 里同样注明上述来源。
- 仓库**不包含** DeepSeek 的任何密钥；余额接口用的是使用者本机的
  `~/.dsh/.credentials.yaml`。
