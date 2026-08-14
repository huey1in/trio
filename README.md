<p align="center">
  <img src="assets/banner-web.jpg" alt="dsh-trio — DeepSeek Harness 全家桶" width="100%">
</p>

<p align="center">
  <a href="https://linux.do?ref=seal-click" target="_blank" rel="noopener noreferrer" title="LINUX DO Pioneer Project">
    <img src="https://linuxdo-seal.cuishushu.com/seals/seal-pioneer-project.svg" alt="LINUX DO Pioneer Project" width="65" height="20">
  </a>
  <a href="https://www.npmjs.com/package/dsh-trio"><img src="https://img.shields.io/npm/v/dsh-trio?color=blue" alt="npm version"></a>
  <a href="https://github.com/huey1in/trio"><img src="https://img.shields.io/github/stars/huey1in/trio" alt="GitHub stars"></a>
  <a href="https://github.com/huey1in/trio/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/huey1in/trio/ci.yml?label=CI" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/dsh-trio" alt="License: MIT"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-1f425f" alt="dsh-plugin"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="Node >= 20"></a>
</p>

# 🐋 dsh-trio — DeepSeek Harness 全家桶

**一条命令装三个超能力:浏览器自动化 + MCP Server + GitHub 集成。**

```
dsh plugin --profile web add dsh-trio
```

| 模块 | 做什么 | 端点/工具 |
| --- | --- | --- |
| 🧭 **浏览器自动化** | 多配置文件(工作/个人隔离)+ 多标签 + 下载/上传 + Cookie 持久化 + 表单填充与**回放**,人可旁观实时画面 | `browser_*` 工具 × 22 + 实时画面页 |
| 🔌 **MCP Server** | 会话/agent 反向暴露,长任务流式输出 + 进度,resources,**OAuth 2.0 鉴权** | `http://127.0.0.1:3080/trio/mcp` |
| 🐙 **GitHub 集成** | issue/PR 全流程 + webhook 自动评审(去重)+ issue 自动修复闭环 + **事件看板** | `github_*` 工具 × 13 + webhook |
| 🦊 **GitLab 集成** | 项目/issue/MR(含行内评论)+ **webhook 自动 MR 评审** | `gitlab_*` 工具 × 7 + webhook |
| 🎛️ **控制台** | `/trio` 一页汇总模块状态 + **GitHub 最近事件** | `http://127.0.0.1:3080/trio` |

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
(`trio-browser` / `trio-mcp` / `trio-github` / `trio-gitlab` / `trio-console`)即可,或给对应行加 `config: { enabled: false }`。

## 🧭 浏览器自动化

给 agent 一个共享浏览器会话(**多标签页**,默认 headless;`channel: auto` 自动探测
msedge → chrome → chromium,也可 `executablePath` 指定):

| 工具 | 说明 |
| --- | --- |
| `browser_open` | 打开 URL |
| `browser_tabs` | 标签管理:list / new / switch / close(按 id 或 index) |
| `browser_snapshot` | 读取页面文本/链接/输入框(纯文本模型"看"网页的核心) |
| `browser_elements` | 可交互元素结构化清单(input/button/select/链接 + 现成 CSS 选择器) |
| `browser_click` / `browser_type` / `browser_press` | 点击 / 输入(可清空、可回车提交)/ 按键 |
| `browser_form` | 批量填充表单(selector 或 label 定位,可选回车提交) |
| `browser_eval` | 页面内执行 JS 表达式或语句 |
| `browser_screenshot` | 截图存到 `<工作区>/.dsh-trio/screenshots/` |
| `browser_download` | 保存页面触发的下载到 `<工作区>/.dsh-trio/downloads/` |
| `browser_upload` | 上传本地文件到页面 `input[type=file]` |
| `browser_cookies` | Cookie 管理:list(可显示值)/ set / clear,处理登录态 |
| `browser_wait` / `browser_back` / `browser_reload` / `browser_status` / `browser_close` | 其余控制 |
| `browser_profile` | **多浏览器配置**:list / use(work、personal…各自独立会话与登录态) |
| `browser_form_save` / `browser_forms` | **表单保存与回放**:保存填充记录,`browser_form from=<name>` 一键重填 |

**多配置文件**:`config.profiles` 声明命名配置,每个可带独立的 `userDataDir`
(登录态隔离)——工作账号与个人账号互不干扰:

```yaml
- id: trio-browser
  name: dsh-trio/browser
  config:
    profiles:
      work:     { userDataDir: C:/path/work-profile, channel: msedge }
      personal: { userDataDir: C:/path/personal-profile }
```

**登录态持久化**:配置 `userDataDir` 后,浏览器使用独立的用户数据目录
(`launchPersistentContext`),Cookie 与 localStorage **跨 DSH 重启保留**——登录一次,
重启后 agent 还是登录状态:

```yaml
- id: trio-browser
  name: dsh-trio/browser
  config:
    userDataDir: C:/path/to/dsh-trio-profile   # 留空 = 临时会话(默认)
```
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
    downloadDir: .dsh-trio/downloads
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
| `dsh_run_agent` | **用 DSH 模型跑一个一次性 agent**,返回最终文本;支持 `provider`/`model` 覆盖;带 `_meta.progressToken` 收到进度通知;带 `_meta.streamOutput: true` 收到**逐段流式输出**(notifications/message) |
| `dsh_agents_status` | 列出当前运行中的 agent(会话 id + 状态) |

**Resources 支持**:`resources/list` 暴露 `dsh://sessions/<id>` 会话资源,
`resources/read` 读取完整事件摘要(JSON)。`tools/list` 响应中同时声明资源目录。

**OAuth 2.0 鉴权**(可选,替代静态 token):启用后提供
`client_credentials` token 端点(`/trio/mcp/oauth/token`)与 RFC 8414
授权服务器元数据(`/.well-known/oauth-authorization-server`):

```yaml
- id: trio-mcp
  name: dsh-trio/mcp
  config:
    oauthEnabled: true
    oauthClientIdEnv: MCP_CLIENT_ID        # 客户端凭据从环境变量读取
    oauthClientSecretEnv: MCP_CLIENT_SECRET
    oauthTokenTtlMs: 3600000
```

客户端流程:POST token 端点(`grant_type=client_credentials`)→ 拿
`access_token` → 所有 MCP 请求带 `Authorization: Bearer <token>`。
静态 `authTokenEnv` 与 OAuth 可并存;均未配置时不鉴权。

安全:设置 `authTokenEnv`(如 `MCP_TOKEN`)后,所有请求要求
`Authorization: Bearer <token>`。协议:零依赖手写实现 MCP
Streamable HTTP(2025-03-26),支持 `initialize` / `ping` / `tools/list` /
`tools/call` / `resources/list` / `resources/read` / SSE 响应 / GET 事件流 /
DELETE 会话 / **服务器主动进度与流式输出通知**。

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
| `github_issue_update` | 更新 issue/PR 状态、标签、指派、标题、正文 |
| `github_search_issues` | 仓库内 issue/PR 搜索(支持 GitHub 搜索语法) |
| `github_pulls` / `github_pr` | PR 列表 / 详情(可带文件 diff) |
| `github_pr_review` / `github_pr_comment` / `github_pr_merge` | 评审/评论/合并 |
| `github_pr_review_comment` | **diff 行内评论**(path + line) |
| `github_workflow_runs` | CI 状态 |

**Webhook 评审去重**:同一 PR 的同一 head commit 只评审一次(`reviewDedupe`,
默认开启),`synchronize` 推送新 commit 才会触发新一轮评审。

**事件看板**:控制台 `/trio` 的 GitHub 卡片下方实时展示最近 webhook 事件
(时间/类型/仓库/编号/处理结果),数据源 `GET /trio/github/events`。

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

### Issue 自动修复闭环(webhook → agent 修 → 自动开 PR)

配置 `autoFixRepos`(仓库 → 本地路径)后,新 issue 会自动触发一个 DSH agent
在本地仓库里修复:fetch → 建 `fix/issue-N` 分支 → 修复 + 测试 → push →
**自动开 PR**(`Fix #N: 标题`,正文 `Closes #N`)。可选 `autoFixLabels`
只处理带指定标签的 issue(如 `bug`):

```yaml
- id: trio-github
  name: dsh-trio/github
  config:
    ...
    autoFixRepos:
      "owner/repo": C:/path/to/local/repo
    autoFixLabels: [bug, priority-high]   # 空数组 = 所有 issue
```

> 前提:仓库 webhook 同时勾选 **Issues** 事件;本地仓库路径存在且可写;
> agent 需要能 push(配置好 git 凭据);同一时间只跑一个修复任务。

> 公网部署提示:webhook 需要能从 GitHub 访问到你的机器,可配合 frp/ngrok/
> Cloudflare Tunnel;不要暴露到公网时务必配置 webhook secret。

## 🦊 GitLab 集成

凭证:环境变量或 DSH credentials 里的 `GITLAB_TOKEN`(PRIVATE-TOKEN 方式)。

| 工具 | 说明 |
| --- | --- |
| `gitlab_project` | 项目信息(星标/fork/issues/默认分支) |
| `gitlab_issues` / `gitlab_issue_create` / `gitlab_issue_comment` | issue 三件套 |
| `gitlab_mr_list` / `gitlab_mr_create` | MR 列表(含来源/目标分支)/ 创建 MR |
| `gitlab_mr_inline_comment` | **MR diff 行内评论**(path + new_line) |

**Webhook 自动 MR 评审**:仓库 Settings → Webhooks 添加
`http://<机器>:3080/trio/gitlab/webhook`(Secret Token 与
`GITLAB_WEBHOOK_SECRET` 一致,事件勾选 Merge Request)。MR 打开/更新时自动
评审并以 note 发布(带 🤖 前缀)。`reviewModel` 配置与 GitHub 模块相同。

自建 GitLab 实例:改 `apiBase`(如 `https://gitlab.example.com/api/v4`)。

## 🎛️ 控制台

浏览器打开 `http://127.0.0.1:3080/trio`:

- **浏览器卡**:开/关状态、标签数、当前 URL,一键跳转实时画面
- **MCP 卡**:端点协议版本、工具数量、一键"测试连接"
- **GitHub 卡**:webhook 端点在线状态 + 配置指引

页面每 5 秒自动刷新,样式与 banner 同源的 anthropic.com 人文简朴风。

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

- [x] 浏览器:多标签页、下载、Cookie 登录态、表单自动填充 ✅(0.2.0)
- [x] MCP:`dsh_run_agent` 流式进度通知 ✅(0.2.0)
- [x] GitHub:PR 行内评论、issue 更新与搜索 ✅(0.2.0)
- [x] `/trio` 控制台 ✅(0.2.0)
- [x] 浏览器:登录态持久化(userDataDir)、`browser_upload` 文件上传 ✅(0.3.0)
- [x] MCP:`resources/` 支持、`dsh_run_agent` 模型覆盖参数 ✅(0.3.0)
- [x] GitHub:issue 自动修复闭环(webhook → 子 agent 修 → 开 PR)✅(0.3.0)
- [x] GitLab 支持 ✅(0.3.0)
- [x] 浏览器:多配置文件(工作/个人)、表单保存回放 ✅(0.4.0)
- [x] MCP:OAuth 鉴权(client_credentials + RFC 8414)、流式输出推送 ✅(0.4.0)
- [x] GitHub:webhook 事件看板(控制台内)、评审缓存去重 ✅(0.4.0)
- [x] GitLab:MR 行内评论、webhook 评审 ✅(0.4.0)
- [ ] 浏览器:表单值加密存储(敏感字段)、录制回放(动作序列)
- [ ] MCP:`dsh_run_agent` 可取消(progress 上报 + cancel)、会话续跑
- [ ] GitHub:webhook 事件持久化(重启保留)、批处理评审队列
- [ ] GitLab:issue 自动修复闭环(镜像 GitHub 方案)

## License

[MIT](LICENSE)
