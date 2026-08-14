# Contributing to dsh-trio

感谢你愿意参与 dsh-trio 的开发!无论是一行文档、一个 bug 修复,还是一个全新工具,都欢迎。

## 开发环境

```sh
git clone https://github.com/huey1in/trio
cd trio
npm install        # 安装依赖(playwright-core + 开发工具链)
```

## 常用命令

```sh
npm run typecheck  # TypeScript 严格类型检查
npm test           # vitest 单元测试(47+ 用例)
npm run build      # tsdown 构建到 lib/(ESM + d.ts)
npm run verify     # typecheck + test + build 三连
```

## 代码规范

- **TypeScript 严格模式**:`tsc -b` 必须 0 错误;新增代码保持 `strict` 下的类型安全。
- **运行时零依赖**:`dependencies` 只允许 `playwright-core`。不要引入新的运行时依赖;
  需要类型时用 `devDependencies` + `import type`。
- **纯函数可测**:核心逻辑(协议、签名、投影、解析)写成导出的纯函数,放进
  `test/*.test.ts` 覆盖。
- **配置必须校验**:新增配置项时同步更新对应模块的 `*_SCHEMA` 与默认值。
- **工具定义**:统一用 `definePlainTool`(见 `src/lib/tools.ts`);参数用 JSON Schema;
  输出声明 `outputSchema` + `render`。
- **错误信息**:面向用户的错误用中文,内部日志用英文。
- **提交信息**:遵循 Conventional Commits(`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`)。

## 新增一个工具的建议步骤

1. 在对应模块里实现 `xxxTool(config, args, exec?)` 纯函数;
2. 在 `registerTools` 里用 `definePlainTool` 注册(含 schema/输出/render);
3. 导出可测的纯逻辑,写单测;
4. 更新 README 工具表与 `cordis.patch.yml`(如需新配置);
5. 本地 `npm run verify` 全绿后提交 PR。

## PR 流程

1. fork 仓库,创建 `feat/xxx` 或 `fix/xxx` 分支;
2. 提交并推送到 fork;
3. 打开 PR,选择模板填写;
4. CI(typecheck + test + build)通过后等待 review。

## 发布流程(维护者)

打 tag 即可触发 [release workflow](.github/workflows/release.yml) 自动发布 npm:

```sh
git tag v1.0.0 && git push origin v1.0.0
```

> 需要仓库 Secrets 里配置 `NPM_TOKEN`(带 bypass 2FA 的 npm token)。
