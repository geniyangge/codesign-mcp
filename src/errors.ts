export class CoDesignError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "CoDesignError";
  }
}

export function isCoDesignError(e: unknown): e is CoDesignError {
  return e instanceof CoDesignError;
}

/** 把接口/网络错误翻译成可操作的提示 */
export function explainError(status: number, body: string, url: string): CoDesignError {
  const snippet = body.slice(0, 300);

  if (body.includes("非项目成员") || body.includes("not_project_member")) {
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
    );
  }

  if (body.includes("暂无权限")) {
    return new CoDesignError(
      "无权限访问该资源",
      status,
      "请确认 CODESIGN_COOKIE 环境变量有效且未过期（access_token 通常 30 天有效）。",
    );
  }

  if (status === 403) {
    return new CoDesignError(
      `请求被拒绝 (403)`,
      status,
      "CDN 资源需要 Origin 头，鉴权接口需要 Bearer token。若是手动调用，请检查请求头。",
    );
  }

  if (status === 404) {
    return new CoDesignError(
      `资源不存在 (404)`,
      status,
      `请检查设计稿链接是否正确。请求地址：${url}`,
    );
  }

  if (status === 401) {
    return new CoDesignError(
      "未登录或登录已过期 (401)",
      status,
      "请重新从浏览器复制 Cookie 并更新 CODESIGN_COOKIE 环境变量。",
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
