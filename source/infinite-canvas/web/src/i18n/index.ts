import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enUS from "@/i18n/locales/en-US";
import zhCN from "@/i18n/locales/zh-CN";
import viVN from "@/i18n/locales/vi-VN";

export type AppLocale = "zh-CN" | "en-US" | "vi-VN";

const LOCALE_STORAGE_KEY = "infinite-canvas:locale";

i18n.use(initReactI18next).init({
    resources: {
        "zh-CN": { translation: zhCN },
        "en-US": { translation: enUS },
        "vi-VN": { translation: viVN },
    },
    lng: (localStorage.getItem(LOCALE_STORAGE_KEY) as AppLocale) || "vi-VN",
    fallbackLng: "vi-VN",
    supportedLngs: ["zh-CN", "en-US", "vi-VN"],
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
});

export function changeAppLocale(locale: AppLocale) {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    return i18n.changeLanguage(locale);
}

export default i18n;
