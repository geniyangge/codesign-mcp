export class CoDesignError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly hint?: string,
    /** 机器可读的错误码，便于上层做分支判断 */
    public readonly code?: CoDesignErrorCode,
  ) {
    super(message);
    this.name = "CoDesignError";
  }
}

export type CoDesignErrorCode =
  | "NEED_PASSWORD"
  | "INVALID_PASSWORD"
  | "NEED_LOGIN"
  | "NO_PERMISSION"
  | "NOT_FOUND"
  | "NETWORK";

export function isCoDesignError(e: unknown): e is CoDesignError {
  return e instanceof CoDesignError;
}

/** 从错误响应体里挖出分享标题，用于提示「请输入 xxx 的密码」 */
function sharingTitleOf(body: string): string | undefined {
  try {
    const j = JSON.parse(body);
    const t = j?.context?.sharing_title;
    return typeof t === "string" && t.trim() ? t : undefined;
  } catch {
    return undefined;
  }
}

/** 错误响应体里的 message 字段（接口可能返回 JSON，也可能直接返回文本） */
function messageOf(body: string): string {
  try {
    const m = JSON.parse(body)?.message;
    if (typeof m === "string") return m;
  } catch {
    /* 非 JSON，退回原文 */
  }
  return body;
}

/** 把接口/网络错误翻译成可操作的提示 */
export function explainError(status: number, body: string, url: string): CoDesignError {
  const snippet = body.slice(0, 300);
  // 接口返回的 JSON 会把中文转义成 \uXXXX，直接对原始 body 做 includes 会漏判
  const message = messageOf(body);

  // 分享被密码保护：接口返回 403 + {"message":"请输入密码！"}
  if (message.includes("请输入密码") || body.includes("need_password")) {
    const title = sharingTitleOf(body);
    return new CoDesignError(
      `${title ? `设计稿「${title}」` : "该设计稿"}需要访问密码`,
      status,
      [
        "带密码的分享必须先换一个 state-key 才能读取。",
        "请在工具入参里加上 password，或在 MCP 配置里设置环境变量 CODESIGN_PASSWORD。",
        '例如：design_get(url, password: "ABCD")',
      ].join("\n"),
      "NEED_PASSWORD",
    );
  }

  // 密码错误：接口返回 403 + {"message":"密码错误！"}
  if (message.includes("密码错误") || body.includes("invalid_password")) {
    const title = sharingTitleOf(body);
    return new CoDesignError(
      `${title ? `设计稿「${title}」的` : ""}访问密码不正确`,
      status,
      "确认密码是否完整（通常区分大小写），然后重试。",
      "INVALID_PASSWORD",
    );
  }

  // 密码长度/格式不合法：接口返回 422，message 形如「password 必须是 4 个字符」
  if (status === 422 && /password/i.test(body)) {
    return new CoDesignError(
      message || "访问密码格式不正确",
      status,
      "确认密码长度是否符合服务端要求，然后重试。",
      "INVALID_PASSWORD",
    );
  }

  if (status === 403 && (message.includes("暂无权限") || body.includes("no_permission"))) {
    return new CoDesignError(
      "无权限访问该设计稿",
      status,
      [
        "可能的原因（按概率排序）：",
        "  1. 这是带密码的分享，但当前 Cookie 账号不在项目/团队内",
        "     —— 密码只能解锁分享，解不开团队权限，请用有权限的账号 Cookie",
        "  2. 账号没有该设计稿的查看权限",
        "  3. CODESIGN_COOKIE 已过期",
        "提示：先用不含 Cookie 的请求确认是否「请输入密码」，",
        "      若出现「您当前暂无权限」，说明 Cookie 账号确实无权访问。",
      ].join("\n"),
      "NO_PERMISSION",
    );
  }

  if (message.includes("非项目成员") || body.includes("not_project_member")) {
    return new CoDesignError(
      "不是该设计稿所属项目的成员",
      status,
      [
        "账号未加入设计稿所在团队，接口因此拒绝访问。",
        "解决办法（任选其一）：",
        "  1. 让设计同学把当前账号加入该 CoDesign 项目",
        "  2. 让设计同学在分享设置里开启「可查看标注」权限",
        "  3. 换用有权限的账号 Cookie",
      ].join("\n"),
      "NO_PERMISSION",
    );
  }

  if (status === 403) {
    return new CoDesignError(
      `请求被拒绝 (403)`,
      status,
      "CDN 资源需要 Origin 头，鉴权接口需要 Bearer token。若是手动调用，请检查请求头。",
      "NO_PERMISSION",
    );
  }

  if (status === 404) {
    return new CoDesignError(
      `资源不存在 (404)`,
      status,
      `请检查设计稿链接是否正确。请求地址：${url}`,
      "NOT_FOUND",
    );
  }

  if (status === 401) {
    return new CoDesignError(
      "未登录或登录已过期 (401)",
      status,
      "请重新从浏览器复制 Cookie 并更新 CODESIGN_COOKIE 环境变量。",
      "NEED_LOGIN",
    );
  }

  if (status === 429) {
    return new CoDesignError(
      "请求过于频繁 (429)",
      status,
      "CoDesign 做了限流，稍等片刻再试，或调小 CODESIGN_CONCURRENCY。",
    );
  }

  return new CoDesignError(`请求失败 (${status}): ${snippet}`, status, url);
}
/** 网络层失败（超时、DNS、连接重置）同样给出可操作提示 */
export function explainNetworkError(e: unknown, url: string): CoDesignError {
  const cause = e instanceof Error ? (e.cause as any) : undefined;
  const code = cause?.code ?? (e as any)?.code;
  const detail = code ? `${code}` : e instanceof Error ? e.message : String(e);

  if ((e as any)?.name === "AbortError" || code === "ABORT_ERR") {
    return new CoDesignError(
      "请求超时",
      undefined,
      `超过 CODESIGN_TIMEOUT_MS 未返回，网络较慢时可在环境变量里调大。请求地址：${url}`,
    );
  }

  return new CoDesignError(
    `网络请求失败（${detail}）`,
    undefined,
    `请检查网络或代理能否访问 CoDesign。请求地址：${url}`,
  );
}
