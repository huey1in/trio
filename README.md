# 🐋 dsh-trio — DeepSeek Harness 全家桶

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

**一条命令装三个超能力:浏览器自动化 + MCP Server + GitHub 集成。**

```
dsh plugin --profile web add dsh-trio
```

| 模块 | 做什么 | 端点/工具 |
| --- | --- | --- |
| 🧭 **浏览器自动化** | agent 直接操控浏览器(打开/点击/输入/截图),人可旁观实时画面 | `browser_*` 工具 × 12 + 实时画面页 |
| 🔌 **MCP Server** | 把 DSH 的会话与 agent 反向暴露给任何 MCP 客户端(Claude Desktop / Cursor / Cline…) | `http://127.0.0.1:3080/trio/mcp` |
| 🐙 **GitHub 集成** | issue/PR 全流程 + webhook 自动 PR 评审 | `github_*` 工具 × 10 + webhook |

零构建、零配置依赖:`src/` 直接是发布产物,不依赖任何 `@deepseek-ai` 包(版本兼容性最大化),唯一第三方依赖是 `playwright-core`(复用你系统里已装的 Edge/Chrome,不用下载 Chromium)。

---

## 安装

```sh
# 1. 安装(会自动通过 pnpm 链接到你的 web profile)
dsh plugin --profile web add dsh-trio

# 2. 重启 dsh
dsh web
```

不需要某个模块?在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里删掉对应行
(`trio-browser` / `trio-mcp` / `trio-github`)即可,或给对应行加 `config: { enabled: false }`。

## 🧭 浏览器自动化

给 agent 一个共享浏览器会话(默认 headless;`channel: auto` 自动探测
msedge → chrome → chromium,也可 `executablePath` 指定):

| 工具 | 说明 |
| --- | --- |
| `browser_open` | 打开 URL |
| `browser_snapshot` | 读取页面文本/链接/输入框(纯文本模型"看"网页的核心) |
| `browser_click` / `browser_type` / `browser_press` | 点击 / 输入(可清空、可回车提交)/ 按键 |
| `browser_eval` | 页面内执行 JS 表达式或语句 |
| `browser_screenshot` | 截图存到 `<工作区>/.dsh-trio/screenshots/` |
| `browser_wait` / `browser_back` / `browser_reload` / `browser_status` / `browser_close` | 其余控制 |

**实时画面**:浏览器打开时访问 `http://127.0.0.1:3080/trio/browser`,每 2 秒自动
刷新截图,看着 agent 操作你的浏览器。

```sh
# 换个端口的话就是 http://127.0.0.1:<你 dsh web 的端口>/trio/browser
```

> 首次调用浏览器工具时会自动启动浏览器;启动失败会提示你安装 Chromium
> (`npx playwright install chromium`)或配置 `executablePath`。

### 浏览器配置

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: trio-browser
  name: dsh-trio/browser
  config:
    channel: auto        # auto | chrome | msedge | chromium | ""(playwright 默认)
    executablePath: ""   # 显式指定浏览器可执行文件(优先于 channel)
    headless: true
    screenshotDir: .dsh-trio/screenshots
    liveViewPath: /trio/browser
    maxTextChars: 20000
    maxLinks: 50
    timeoutMs: 30000
```

## 🔌 MCP Server

把 DSH 变成一台 MCP 服务器。任何支持 Streamable HTTP 的 MCP 客户端都能接:

```json
// Claude Desktop / Cursor / Cline 等客户端的 mcpServers 配置
{
  "mcpServers": {
    "dsh": {
      "url": "http://127.0.0.1:3080/trio/mcp"
    }
  }
}
```

暴露的工具:

| 工具 | 说明 |
| --- | --- |
| `dsh_list_sessions` | 列出本机 DSH 会话(标题/目录/时间) |
| `dsh_read_session` | 读取会话事件摘要(消息、工具调用、结束原因) |
| `dsh_search_sessions` | 全文搜索会话 |
| `dsh_run_agent` | **用 DSH 默认模型跑一个一次性 agent**,返回最终文本(深度研究、代码审查、多步任务) |

安全:设置 `authTokenEnv`(如 `MCP_TOKEN`)后,所有请求要求
`Authorization: Bearer <token>`。协议:零依赖手写实现 MCP
Streamable HTTP(2025-03-26),支持 `initialize` / `ping` / `tools/list` /
`tools/call` / SSE 响应 / GET 事件流 / DELETE 会话。

### MCP 配置

```yaml
- id: trio-mcp
  name: dsh-trio/mcp
  config:
    path: /trio/mcp
    authTokenEnv: ""        # 例如 MCP_TOKEN;留空不鉴权
    runAgentTimeoutMs: 300000
    runAgentMaxOutputChars: 120000
    listSessionsLimit: 50
```

## 🐙 GitHub 集成

凭证:环境变量或 DSH credentials 里的 `GITHUB_TOKEN`(细粒度 token 只需
`repo` 权限)。

| 工具 | 说明 |
| --- | --- |
| `github_repo` | 仓库元信息 |
| `github_issues` / `github_issue_create` / `github_issue_comment` | issue 三板斧 |
| `github_pulls` / `github_pr` | PR 列表 / 详情(可带文件 diff) |
| `github_pr_review` / `github_pr_comment` / `github_pr_merge` | 评审/评论/合并 |
| `github_workflow_runs` | CI 状态 |

### Webhook 自动评审

1. 在 GitHub 仓库 Settings → Webhooks 添加:
   - Payload URL:`http://<你的机器>:3080/trio/github/webhook`
   - Content type:`application/json`
   - Secret:与 `webhookSecretEnv` 指向的环境变量一致(如 `GITHUB_WEBHOOK_SECRET`)
   - Events:勾选 **Pull requests**
2. 评审模型:默认用 DSH 的默认模型;也可指定:

```yaml
- id: trio-github
  name: dsh-trio/github
  config:
    tokenEnv: GITHUB_TOKEN
    apiBase: https://api.github.com
    webhookPath: /trio/github/webhook
    webhookSecretEnv: GITHUB_WEBHOOK_SECRET
    reviewModel:
      provider: deepseek
      model: deepseek-chat
    reviewMaxDiffChars: 60000
    autoReviewEvents: [opened, synchronize, reopened]
```

此后每个非 draft 的 PR 打开/更新时,DSH 会拉取 diff → 调用评审模型 →
以 `COMMENT` 评审提交到 PR。

> 公网部署提示:webhook 需要能从 GitHub 访问到你的机器,可配合 frp/ngrok/
> Cloudflare Tunnel;不要暴露到公网时务必配置 webhook secret。

## 开发与测试

```sh
npm install          # 安装 playwright-core(本地测试用)
npm test             # 冒烟测试(模块加载 + 工具表 + HMAC 签名)
node test/browser-launch.mjs   # 验证本机浏览器通道可启动
```

本地热加载调试(无需发布):

```sh
dsh --profile web --patch ./e2e.patch.yml --port 3111
```

## 发布

```sh
npm publish   # 纯 JS 无构建步骤,lib 即源码,无需 prepare 脚本/allowBuilds
```

发布后记得:

1. 给仓库打 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic;
2. 给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR 加入精选列表。

## 路线图

- [ ] 浏览器:`browser_download`、多标签页、表单自动填充、Cookie/登录态持久化
- [ ] MCP:暴露 `dsh_run_agent` 的流式进度、`resources/` 支持
- [ ] GitHub:PR 行内评论(`path`+`line`)、issue 自动修复闭环、GitLab 支持

## License

[MIT](LICENSE)
