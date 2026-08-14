// dsh-trio · GitHub — PR 自动评审(LLM 调用、评审去重)
import type { TrioContext } from "../lib/types.js";
import type { GithubConfig } from "./types.js";
import { runLlm } from "../lib/llm.js";
import { ghFetch } from "./api.js";
const reviewedPrs = new Map();

const REVIEW_SYSTEM_PROMPT = `你是资深代码评审员。请审阅下面这个 Pull Request 的变更,输出简洁的中文评审意见,格式:
## 总结
(2-4 句总体评价)
## 问题(按严重程度排序)
- [P0/P1/P2] 文件:行号 — 问题与修改建议
## 亮点
(如有)
不要奉承,不要输出空话。只针对 diff 中真实存在的内容。`;

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------


async function runReviewLlm(ctx: TrioContext, config: GithubConfig, prompt: string, signal: AbortSignal): Promise<string> {
  return runLlm(ctx, config.reviewModel, REVIEW_SYSTEM_PROMPT, prompt, signal, { maxTokens: 2000 });
}

export function buildReviewPrompt(pr: Record<string, any>, files: Record<string, any>[]): string {
  const head = `# PR #${pr.number} ${pr.title}\n\n${pr.body ?? ""}\n\n分支:${pr.base?.ref ?? ""} ← ${pr.head?.ref ?? ""}\n改动:+${pr.additions ?? 0} / -${pr.deletions ?? 0},共 ${pr.changed_files ?? 0} 个文件\n`;
  const diffs = (files ?? [])
    .map((file: any) => {
      const patch = file.patch ?? "(二进制或过大,无 patch)";
      return `### ${file.status ?? "modified"} ${file.filename} (+${file.additions ?? 0}/-${file.deletions ?? 0})\n\`\`\`diff\n${patch}\n\`\`\``;
    })
    .join("\n\n");
  return `${head}\n\n${diffs}`;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------


export async function reviewPullRequest(ctx: TrioContext, config: GithubConfig, pr: Record<string, any>) {
  // 评审去重:同一 head sha 已评审过则跳过
  if (config.reviewDedupe !== false && pr.headSha) {
    const key = `${pr.owner}/${pr.repo}#${pr.number}:${pr.headSha}`;
    if (reviewedPrs.has(key)) {
      ctx.logger?.info?.(`dsh-trio/github: review dedupe hit for ${key}`);
      return { deduped: true };
    }
    reviewedPrs.set(key, Date.now());
    if (reviewedPrs.size > 200) {
      const oldest = reviewedPrs.keys().next().value;
      if (oldest !== undefined) reviewedPrs.delete(oldest);
    }
  }
  const detail = await ghFetch(
    ctx,
    config,
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
    {},
  );
  const files = await ghFetch(
    ctx,
    config,
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=30`,
  );
  const prompt = buildReviewPrompt(detail, files);
  const aborted = new AbortController();
  // 已配置超时;评审结束即清理。
  const timer = setTimeout(() => aborted.abort(), 60000);
  try {
    const review = await runReviewLlm(ctx, config, prompt.slice(0, config.reviewMaxDiffChars), aborted.signal);
    if (!review) throw new Error("empty review output");
    await ghFetch(ctx, config, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, {
      method: "POST",
      body: { body: review.slice(0, 60000), event: "COMMENT" },
    });
    ctx.logger?.info?.(`dsh-trio/github: reviewed ${pr.owner}/${pr.repo}#${pr.number}`);
    return { reviewed: true };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Issue 自动修复闭环(webhook → agent 修 → 自动开 PR)
// ---------------------------------------------------------------------------

/** 并发锁:同一时间只跑一个自动修复任务。 */
