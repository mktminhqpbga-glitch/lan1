// Runtime configuration access layer.
// Priority: window.__RUNTIME_CONFIG__ (injected by the container entrypoint) > build-time VITE_ variables > defaults.
// This supports both configuring the same image with docker run -e and injecting values during custom builds.
//
// Each analytics provider has its own variable; configured providers are enabled independently and all are disabled by default.
// Only GA4 and Baidu are supported. Both accept IDs only, and script URLs are assembled in code without arbitrary scripts or inline JavaScript.

type RuntimeConfig = {
    ANALYTICS_GA4_ID?: string; // GA4 measurement ID (G-XXXX)
    ANALYTICS_BAIDU_ID?: string; // Baidu Analytics site ID
    MUSE_API_BASE?: string; // 自建 muse2api 的浏览器可访问地址，如 http://1.2.3.4:1314
    MUSE_API_KEY?: string; // muse2api 的 API Key（MUSE2API_KEY）
    MUSE_CHANNEL_NAME?: string; // 渠道显示名，默认 Muse
    AGENT_URL?: string; // 右侧 Agent 的默认服务地址，如 https://agent.example.com
    AGENT_TOKEN?: string; // 右侧 Agent 的默认 Connect token；会暴露给所有访客，慎用
};

declare global {
    interface Window {
        __RUNTIME_CONFIG__?: RuntimeConfig;
    }
}

const runtime: RuntimeConfig = (typeof window !== "undefined" && window.__RUNTIME_CONFIG__) || {};

function read(key: keyof RuntimeConfig, buildTime: string | undefined, fallback = ""): string {
    const value = runtime[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof buildTime === "string" && buildTime.trim()) return buildTime.trim();
    return fallback;
}

export const ANALYTICS_GA4_ID = read("ANALYTICS_GA4_ID", import.meta.env.VITE_ANALYTICS_GA4_ID);
export const ANALYTICS_BAIDU_ID = read("ANALYTICS_BAIDU_ID", import.meta.env.VITE_ANALYTICS_BAIDU_ID);
export const MUSE_API_BASE = read("MUSE_API_BASE", import.meta.env.VITE_MUSE_API_BASE);
export const MUSE_API_KEY = read("MUSE_API_KEY", import.meta.env.VITE_MUSE_API_KEY);
export const MUSE_CHANNEL_NAME = read("MUSE_CHANNEL_NAME", import.meta.env.VITE_MUSE_CHANNEL_NAME, "Muse");
export const AGENT_URL = read("AGENT_URL", import.meta.env.VITE_AGENT_URL);
export const AGENT_TOKEN = read("AGENT_TOKEN", import.meta.env.VITE_AGENT_TOKEN);
