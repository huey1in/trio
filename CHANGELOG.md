# Changelog

本项目的变更记录。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **面板设置区扩展(五模块配置)**:除 GitHub/GitLab token 外,⚙ 设置区现在
  覆盖全部五个模块:
  - **浏览器**:headless 开关、浏览器通道、截图目录、截图保留天数/数量、
    操作超时(即时生效)+ liveViewPath(重启生效);
  - **GitHub / GitLab**:webhook 密钥(密码型,不回显)、评审模型
    provider/model、自动评审事件(逗号分隔)+ webhookPath(重启生效);
  - **MCP**:访问 token(Bearer,密码型)+ 端点路径(重启生效);
  - **面板**:基路径(重启生效)。
  普通配置写入 `$DSH_HOME/.dsh-trio/settings.json`(0600,按字段白名单
  校验,空值恢复默认);密钥类沿用凭据库/自有存储,永不回传。各模块在
  使用时点读取覆盖值(webhook 签名/评审模型/鉴权/截图清理等),重启类
  字段在启动时合并。附带设置存储单元测试。

### 修复

- **面板 token 输入框禁用**:部署未挂载 DSH credentials 服务时
  (`ctx.get("credentials")` 为 undefined),设置端点错误地把 `writable` 置
  false 导致输入框无法输入。现在凭据服务缺失时回退到插件自有存储
  `$DSH_HOME/.dsh-trio/tokens.json`(0600),工具的 `resolveToken` 也按
  凭据服务 → 环境变量 → 自有存储的顺序解析。

## [1.4.0] - 2026-08-15

### 新增

- **面板设置区(⚙)**:GitHub/GitLab token 可直接在嵌入面板里配置,写入 DSH
  凭据库(`$DSH_HOME/.credentials.yaml`,0600),保存即时生效、无需重启;
  状态只回"已配置(凭据库/环境变量)/未配置",凭据值永不回传页面。
  新增端点 `GET/POST /trio/github/settings` 与 `/trio/gitlab/settings`
  (复用 `ctx.credentials` 服务,ref 固定为模块 tokenEnv,客户端不能指定
  任意 ref)。附带输入校验单元测试。

### 变更

- **GitHub 只读工具免 token**:github_repo / github_issues / github_pulls /
  github_pr 在未配置 GITHUB_TOKEN 时改用匿名访问(公共仓库,每 IP 60 次/
  小时,403 限流时错误信息附带提示);写操作与自动化仍要求 token。
- **GitHub/GitLab 工具瘦身**:CRUD 写工具(建 issue/PR、评论、评审、合并、
  行内评论、搜索、CI 状态等)全部移除,由 agent 用 bash + `gh`/`glab` CLI
  完成;只保留 4 个 GitHub 只读工具(github_repo / github_issues /
  github_pulls / github_pr)与 3 个 GitLab 只读工具(gitlab_project /
  gitlab_issues / gitlab_mr_list)。常驻自动化(webhook 自动评审、issue
  自动修复、事件看板)保留不变。
- **嵌入面板视觉**:隐藏面板与访问历史列表的滚动条(保留滚动,`scrollbar-width`
  + `::-webkit-scrollbar` 双端);移除面板头部的 "dsh-trio" 标题,头部只留
  MCP 端点与设置齿轮。

## [1.3.1] - 2026-08-15

### 新增

- **截图自动清理**:`browser_screenshot` 保存的 `.png` 此前无任何清理逻辑,
  会无限堆积。现在双重清理:每次截图后即时修剪 + 每小时定时清扫。
  默认保留最近 7 天、最多 200 张(新增 `screenshotMaxAgeDays` /
  `screenshotMaxCount` 配置,设为 0 关闭对应规则);只清理截图目录直属
  `.png`,不递归、不动其他文件,删除失败静默跳过。附带单元测试。

## [1.3.0] - 2026-08-15

### 新增

- **大屏实时画面模态框**:面板里的浏览器缩略图现在可点击,弹出大屏模态框
  (官方设计变量、自适应亮/暗主题),2 秒轮询实时画面,Esc / 点击遮罩关闭。
- **浏览器访问历史**:每个 profile 记录主 frame 导航(去重、上限 50 条、
  自动补全标题),模态框下方按时间倒序展示,点击可在新标签打开;
  数据端点 `GET /trio/browser/history`。

### 变更

- **移除独立实时画面页**:`/trio/browser` HTML 页面删除,`/status`
  `/screenshot` `/history` 三个数据端点保留供面板/模态框使用。
  面板中"实时画面 ↗"链接一并移除(由缩略图点击取代)。

## [1.2.0] - 2026-08-15

### 变更

- **移除独立控制台页**:`/trio` 状态页与原生嵌入面板功能重叠且样式不与官方
  设计语言一致,现已删除(`CONSOLE_HTML` + `/trio` 前缀路由)。原生嵌入面板
  (embed.js + tapIndex)完整保留,并新增:
  - GitHub 行显示最近事件数与**最近 3 条事件看板**(时间/事件/仓库/编号/处理结果);
  - 面板头部直接给出 MCP 端点 URL,便于配置 MCP 客户端;
  - 移除指向已删页面的"控制台"链接。

## [1.1.3] - 2026-08-15

### 修复

- **实时画面页连接失败**:`/trio/browser` 页面用相对路径 `./status` 轮询,
  无尾斜杠访问时解析到 `/trio/status` 收到 404("not found" 纯文本),
  `r.json()` 报 `Unexpected token 'o'`。改为服务端把 API 基址以绝对路径
  注入页面(`API + '/status'`),并加 `r.ok` 检查给出明确的 HTTP 状态错误。

## [1.1.2] - 2026-08-15

### 修复

- **browser_status 输出校验失败**:DSH 对工具返回值按 `outputSchema` 严格校验
  (additionalProperties: false),browser_status 的 schema 停留在旧版——缺少
  `profile`/`tabs`/`profiles` 字段,又无条件要求 `url`/`title`(浏览器关闭时
  不存在),导致每次调用都报 INVALID_TOOL_OUTPUT。schema 已与实际返回值对齐。
- **browser_profile use 动作**:切换 profile 时返回的 `profiles` 是字符串数组,
  与 schema 声明的对象数组不符;现在 list/use 两个动作统一返回完整对象数组。
- **默认输出 schema 放宽**:未显式声明 outputSchema 的工具默认 schema 从
  `additionalProperties: false + properties: {}`(任何返回都会校验失败)改为
  宽松对象,避免未来新增工具踩同样的坑。

## [1.1.1] - 2026-08-15

### 修复

- **browser_eval 工具输出净化**:页面表达式返回 DOM 节点、函数、`NaN`、
  `undefined` 或含循环引用的对象时,DSH 工具输出校验会拒绝非 lossless JSON
  并报 `INVALID_TOOL_OUTPUT`。现在执行结果先做 JSON 往返净化,无法序列化的
  值降级为字符串,保证工具输出始终通过校验。

## [1.1.0] - 2026-08-15

### 新增

- **原生 Web UI 嵌入**:通过 `webServer.tapIndex` 向 DSH index.html 注入
  `/trio/embed.js`,在原生界面右下角渲染 dsh-trio 浮动面板(浏览器/MCP/
  GitHub 三模块状态 + 浏览器实时画面 + 跳转入口)。零依赖原生 JS,
  不依赖官方 DOM 结构;样式严格使用官方 `--dsw-alias-*` 设计变量,
  自动适配亮/暗主题。独立 `/trio` 控制台页保留。

## [1.0.1] - 2026-08-15

### 修复

- **构建产物扁平化**:tsdown 入口改为 name→path 映射,输出 `lib/browser.mjs`
  等扁平文件,与 `exports` 映射一致(拆分后产物落在子目录导致
  `dsh-trio/browser` 等子路径解析失败,插件无法加载)。
- **控制台探测路径**:页面在无尾斜杠 URL(`/trio`)下相对路径解析错位导致
  三个模块误报"模块未启用";全部改为基于 `location.pathname` 的绝对路径,
  并补全 MCP/GitHub 端点展示与实时画面链接。
- **MCP 协议层清理**:移除重复的 `oauthTokens` 定义、更新 `SERVER_VERSION`、
  GET 端点 URI 兜底。
- **CI 修复**:`.gitignore` 的 `lib/` 锚定为 `/lib/`(`src/lib/` 源码此前未被
  跟踪,干净环境构建失败);workflow YAML 改用字面块;pnpm 固定 10;Node 引擎
  与矩阵对齐为 22/24。

## [0.5.1] - 2026-08-14

### 重构

- **模块拆分**:四个大单文件拆分为职责单一的子目录模块——
  `browser/`(6 文件)、`github/`(6 文件)、`mcp/`(7 文件)、`gitlab/`(4 文件),
  单文件最大 1541 → 649 行;类型/会话/工具/协议/webhook/UI 分层清晰。
- 公共 API 与 `exports` 映射不变,升级零成本。

## [1.0.0] - 2026-08-14

### 工程化(0.5.0 起)

- **TypeScript 严格模式**:全部源码迁移至 TS,`tsc -b` 0 错误,发布带 `.d.ts` 类型声明。
- **测试套件**:vitest 单元测试 47 例,覆盖 HTTP 助手、工具定义、MCP 协议、
  签名校验、事件投影、配置解析等核心逻辑。
- **CI/CD**:GitHub Actions 双工作流 —— `ci.yml`(Node 20/22 × typecheck/test/build)
  与 `release.yml`(打 tag 自动发布 npm + GitHub Release)。
- **配置校验**:五个模块全部接入轻量 schema 校验器(`lib/config.ts`),
  非法配置在启动时即报错,附中文说明。
- **健壮性**:GitHub/GitLab API 幂等 GET 请求自动重试;下载路径目录逃逸防护。
- **文档与社区**:CONTRIBUTING / SECURITY / CODE_OF_CONDUCT / issue·PR 模板。

### 功能(0.1.0–0.4.0)

- **🧭 浏览器自动化(22 工具)**:多标签、下载、上传、Cookie 管理、表单填充与回放、
  多配置文件(工作/个人)、登录态持久化(userDataDir)、实时画面页。
- **🔌 MCP Server**:5 工具 + resources + 流式进度/输出 + OAuth 2.0
  client_credentials(RFC 8414 discovery)+ 模型覆盖。
- **🐙 GitHub 集成(13 工具)**:issue/PR 全流程、行内评论、webhook 自动评审(去重)、
  issue 自动修复闭环(agent 修 → 自动开 PR)、事件看板。
- **🦊 GitLab 集成(7 工具)**:项目/issue/MR、MR 行内评论、webhook 自动评审。
- **🎛️ 控制台**:`/trio` 状态页,一页汇总五模块状态与最近事件。

## [0.4.0] - 2026-08-14

- 浏览器:多配置文件(work/personal)、表单保存回放。
- MCP:OAuth 鉴权、`dsh_run_agent` 流式输出。
- GitHub:事件看板、评审去重。
- GitLab:MR 行内评论、webhook 评审。

## [0.3.0] - 2026-08-14

- 浏览器:userDataDir 登录态持久化、`browser_upload`。
- MCP:resources/list + resources/read、模型覆盖参数。
- GitHub:issue 自动修复闭环。
- GitLab 模块上线。

## [0.2.0] - 2026-08-14

- 浏览器:多标签、下载、Cookie、表单填充、元素清单。
- MCP:进度通知、`dsh_agents_status`。
- GitHub:行内评论、issue 更新与搜索。
- 控制台模块上线。

## [0.1.0] - 2026-08-14

- 首个发布:浏览器自动化 + MCP Server + GitHub 集成。
