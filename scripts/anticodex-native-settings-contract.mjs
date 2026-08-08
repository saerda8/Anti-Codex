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
