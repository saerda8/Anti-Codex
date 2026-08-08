export function classifyUnsupportedExternalSettingsTarget({ href = "", label = "" } = {}) {
  const normalizedHref = String(href).trim();
  const normalizedLabel = String(label).replace(/\s+/g, " ").trim();
  const lowerHref = normalizedHref.toLowerCase();
  const knownSettingsHref = lowerHref.includes("chatgpt.com/#settings")
    || lowerHref.includes("chatgpt.com/open-security-settings");
  const providerHref = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:chatgpt\.com|openai\.com)(?:[/:?#]|$)/i.test(normalizedHref);
  const accountSurfaceLabel = /^(?:(?:ChatGPT|OpenAI)\s+)?(?:Account|Account Settings|Security Settings|Usage|Profile)$|^(?:Manage|Open)\s+(?:Account|Account Settings|Security Settings|Usage|Profile)$|^(?:(?:ChatGPT|OpenAI)\s*)?(?:账户|账号|账户设置|账号设置|安全设置|用量|使用情况|个人资料|个人档案)$|^(?:管理|打开)(?:账户|账号|账户设置|账号设置|安全设置|用量|使用情况|个人资料|个人档案)$/i.test(normalizedLabel);

  if (knownSettingsHref) {
    return { href: normalizedHref, label: normalizedLabel, reason: "known-chatgpt-settings" };
  }
  if (accountSurfaceLabel && (providerHref || normalizedHref.length === 0)) {
    return { href: normalizedHref, label: normalizedLabel, reason: providerHref ? "provider-account-surface" : "button-account-surface" };
  }
  return null;
}

export function classifyNativeSettingsCrashSnapshot({
  headings = [],
  buttons = [],
  bodyText = "",
  hasComposer = false,
} = {}) {
  if (hasComposer === true) return false;
  const normalizedHeadings = Array.isArray(headings)
    ? headings.map((value) => String(value ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
    : [];
  const normalizedButtons = Array.isArray(buttons)
    ? buttons.map((value) => String(value ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
    : [];
  const normalizedBody = String(bodyText ?? "").replace(/\s+/g, " ").trim();
  const fatalHeading = normalizedHeadings.some((heading) => /^(?:(?:ChatGPT|Anti-Codex)\s*)?(?:已意外停止|unexpectedly\s+(?:stopped|quit|closed)|has\s+unexpectedly\s+(?:stopped|crashed)|(?:quit|stopped|closed)\s+unexpectedly)[.!。！]?$/i.test(heading));
  const genericError = normalizedBody.length > 0
    && normalizedBody.length <= 1_600
    && /(?:^|\s)(?:糟糕[，,]\s*出错了|Oops,?\s+an error has occurred|Something went wrong)[.!。！]?(?:\s|$)/i.test(normalizedBody);
  const recoveryAction = normalizedButtons.some((label) => /^(?:重试|重新加载|重新启动|重启|再试一次|retry|reload|restart|try again)$/i.test(label));
  return recoveryAction && (fatalHeading || genericError);
}
