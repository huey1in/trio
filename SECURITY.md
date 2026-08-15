# Security Policy / 安全政策

## 报告漏洞

dsh-reef 处理浏览器自动化、MCP 服务器与 GitHub/GitLab 凭据,安全至关重要。

- **请勿**在公开 issue 中披露漏洞细节。
- 直接发送邮件至仓库维护者(通过 GitHub 主页的联系方式),或创建
  **private vulnerability report**(仓库 Settings → Security → Report a vulnerability)。

请提供:

- 受影响版本;
- 复现步骤(最小示例);
- 影响描述(能否泄露凭据、执行任意代码、越权访问等);
- 建议修复方案(如有)。

## 安全边界说明

| 面 | 风险与缓解 |
| --- | --- |
| **MCP 端点** | 默认 `127.0.0.1` 绑定;公网暴露时必须配置 `authTokenEnv` 或 OAuth。 |
| **Webhook** | GitHub/GitLab 均支持签名校验(`GITHUB_WEBHOOK_SECRET` / `GITLAB_WEBHOOK_SECRET`),建议必配。 |
| **浏览器** | 页面 JS 在受控浏览器内执行;`browser_eval` 能力等同本机浏览器权限,注意模型指令注入风险。 |
| **下载/上传** | 下载文件名经过净化与目录逃逸防护;上传需显式文件路径。 |
| **凭据** | token 优先通过 DSH credentials seam 解析;日志不输出 token 值。 |

## 支持版本

| 版本 | 支持 |
| --- | --- |
| 1.x | ✅ 积极维护 |
| 0.x | ❌ 仅安全修复 |
