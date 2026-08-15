// dsh-trio · GitLab — 面板设置字段白名单
import type { FieldSpec } from "../lib/settings.js";

export const GITLAB_SETTING_FIELDS: FieldSpec[] = [
  { key: "webhookSecret", label: "Webhook 密钥(Secret Token)", type: "password", defaultValue: "" },
  { key: "reviewModelProvider", label: "评审模型 provider(空=默认)", type: "string", defaultValue: "" },
  { key: "reviewModelModel", label: "评审模型 model(空=默认)", type: "string", defaultValue: "" },
  { key: "autoReviewEvents", label: "自动评审事件(逗号分隔,空=关闭)", type: "string", defaultValue: "open,update,reopen" },
  { key: "webhookPath", label: "Webhook 路径", type: "string", restart: true, defaultValue: "/trio/gitlab/webhook" },
];
