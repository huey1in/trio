// dsh-reef 包入口(元信息;实际插件行引用 ./browser ./mcp ./github 子路径)。
export const name = "dsh-reef";
export const description = "浏览器自动化 + MCP Server + GitHub 集成全家桶";

export function apply() {
  // 无操作:真正的插件在 cordis.patch.yml 的三个行里。
}
