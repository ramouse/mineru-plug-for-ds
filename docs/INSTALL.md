# 安装 / 卸载 / 更新手册

## 一键安装（Windows，推荐：全局插件）

```powershell
git clone <repo-url> mineru-dsh-plugin
cd mineru-dsh-plugin
pwsh -File tools\install.ps1
```

安装器自动完成（**全局插件形态，无预设**）：

1. **探测解析根**：`%DSH_HOME%\profiles\node_modules`、`E:\ds harness\deepseek-harness\node_modules`（源码仓）、运行中 `node.exe` 进程命令行、`-InstallDir` 指定目录——凡含 `@deepseek-ai` 的 node_modules 都会链入；
2. **junction**：`<解析根>\mineru-plugin` → `packages\mineru-plugin`（junction 无需管理员权限，只加链接不改任何现有文件）；
3. **用户补丁层**：向 `%DSH_HOME%\profiles\*\cordis.patch.yml`（DSH 官方用户扩展点，注释写明 "Your patch layer"，支持 insert 列表）写入一条 `insert` 补丁，把 `mineru-plugin` 挂为**宿主级全局行**——应用热重载后，**所有会话、所有预设**自动获得工具与面板（事务性热加载：失败自动回滚，不会拖垮应用）。

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-InstallDir <path>` | 自动探测 | 强制指定 DSH 安装根（如 `E:\ds harness\deepseek-harness`） |
| `-PresetMode` | 关 | 旧形态：改为按预设安装（复制 standard 预设并追加行；适用于不希望全局生效的场景） |
| `-PresetId <id>` / `-PresetName <name>` | mineru / MinerU Plugin | 仅 `-PresetMode` 使用 |
| `-Uninstall` | — | 卸载（移除补丁条目 + 所有 junction） |
| `-RemovePreset` | — | 与 `-Uninstall` 连用：一并删除 `-PresetMode` 创建的预设目录 |

## 安装后验证

1. **工具立即生效**：补丁热加载后新会话（任何预设）即有 `parse_document` / `mineru_status` / `mineru_doctor`；可请求 Agent 运行 `mineru_doctor` 自检。
2. **面板需重启一次 DSH**：浏览器 bundle 在进程启动时编入 boot 图；重启后刷新页面——侧边栏与输入框「📄 文档解析」入口、右下角拖拽面板出现。
3. `http://127.0.0.1:3080/mineru/state` 返回 JSON 即 Host 半区在线。
4. 「设置 → 插件」页可看到 mineru-plugin。

## 卸载

```powershell
pwsh -File tools\install.ps1 -Uninstall          # 移除 junction（预设保留）
pwsh -File tools\install.ps1 -Uninstall -RemovePreset   # 连预设一起删
```

- 只删链接与预设，插件源码（本仓库）与已解析的 `.mineru\out\` 产物不受影响。

## 更新

```bash
git pull                         # 拉取新版本
pwsh -File tools\install.ps1     # 重跑安装器（junction 已存在则跳过；行已存在则跳过）
# 重启 DSH 生效
```

> 插件代码变更需重启 DSH 进程生效（模块与 bundle 图在启动时加载）。

## 手动安装（不用脚本）

1. 把 `packages\mineru-plugin` 以目录链接（`mklink /J`）放到 DSH 包解析根（含 `@deepseek-ai` 的 node_modules，可用 `node -e "console.log(require.resolve('@deepseek-ai/cordis', {paths:['<某目录>']}))"` 试探）；
2. 复制部署自带 `standard` 预设到 `%DSH_HOME%\.agent-presets\<id>\`，向其 `agent.cordis.yml` 末尾追加：

```yaml
- id: mineru-plugin
  name: mineru-plugin
  config:
    projectDir: <本仓库绝对路径>
```

3. 写入 `preset.yml`（name/description），重启 DSH。

## 排障

| 症状 | 处理 |
| --- | --- |
| 安装器报"未探测到 DSH 安装" | 用 `-InstallDir` 指定；确认该目录含 `node_modules\@deepseek-ai` |
| Host 端点正常（`/mineru/state` 返回 JSON）但面板不出现 | 客户端 bundle 未编入 boot 图：**再重启一次 DSH**（bundle 在进程启动时扫描；若安装过程中 junction 曾短暂缺失，扫描会把包缓存为否定结论，需重启刷新） |
| 重启后新预设没有 mineru 工具 | 新会话是否选了「MinerU 文档解析/Plugin」预设；`agent.cordis.yml` 末尾是否有 `name: mineru-plugin` 行；junction 是否被 `pnpm install` 修剪（重跑安装器） |
| 面板打开但解析一直"排队" | 免费 Agent API 队列拥堵（正常现象）；面板设置 API Key 走精准模式 |
| `mineru_doctor` 网络 FAIL | 子进程无法访问 mineru.net（企业网络/代理）；检查 `python` 可用性与网络策略 |
| Token 校验失败 A0202/A0211 | 到 mineru.net 刷新 Token |
| 上传提示"不支持的文件类型" | 检查扩展名（PDF/图片/Office/HTML） |
