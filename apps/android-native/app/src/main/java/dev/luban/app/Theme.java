package dev.luban.app;

import android.content.SharedPreferences;

/**
 * Palette for the native console.
 *
 * Both palettes are hand-tuned instead of being inversions of each other: a
 * diff still has to read as green/red, and an approval still has to read as a
 * warning, on a phone held outside in daylight.
 */
final class Theme {
    static final String PREF_DARK = "dark_theme";
    static final String PREF_SCALE = "font_scale";

    final boolean dark;
    final int bg, surface, surfaceAlt, surfaceSunken, line, lineSoft,
            text, muted, dim, accent, accentSoft, accentLine,
            ok, okSoft, warn, warnSoft, danger, dangerSoft, codeBg, onAccent;

    private Theme(boolean dark) {
        this.dark = dark;
        if (dark) {
            bg = 0xFF0A0E14;
            surface = 0xFF121824;
            surfaceAlt = 0xFF18202E;
            surfaceSunken = 0xFF0D1119;
            line = 0xFF243040;
            lineSoft = 0xFF1B2431;
            text = 0xFFE9EEF7;
            muted = 0xFF93A0B4;
            dim = 0xFF6C7889;
            accent = 0xFF7AA2FF;
            accentSoft = 0x267AA2FF;
            accentLine = 0xFF3D5B96;
            ok = 0xFF4FD1A5;
            okSoft = 0x224FD1A5;
            warn = 0xFFE7C079;
            warnSoft = 0x22E7C079;
            danger = 0xFFFF8A9B;
            dangerSoft = 0x22FF8A9B;
            codeBg = 0xFF0D1219;
            onAccent = 0xFF08111F;
        } else {
            bg = 0xFFF2F5FA;
            surface = 0xFFFFFFFF;
            surfaceAlt = 0xFFF6F8FC;
            surfaceSunken = 0xFFEEF2F8;
            line = 0xFFDEE5EF;
            lineSoft = 0xFFEAEFF6;
            text = 0xFF111823;
            muted = 0xFF5B6675;
            dim = 0xFF8A94A3;
            accent = 0xFF2F6FEB;
            accentSoft = 0xFFE7EFFD;
            accentLine = 0xFFB9CFF5;
            ok = 0xFF128A63;
            okSoft = 0xFFE4F6EE;
            warn = 0xFF8A6100;
            warnSoft = 0xFFFBF1DC;
            danger = 0xFFC02B46;
            dangerSoft = 0xFFFDECEF;
            codeBg = 0xFFF4F7FB;
            onAccent = 0xFFFFFFFF;
        }
    }

    static Theme dark() { return new Theme(true); }
    static Theme light() { return new Theme(false); }

    static Theme of(SharedPreferences prefs) {
        return prefs.getBoolean(PREF_DARK, true) ? dark() : light();
    }

    static float scaleOf(SharedPreferences prefs) {
        try {
            float value = Float.parseFloat(prefs.getString(PREF_SCALE, "1"));
            return Math.max(0.85f, Math.min(1.35f, value));
        } catch (NumberFormatException ignored) {
            return 1f;
        }
    }

    static void applyToWindow(android.app.Activity activity, Theme theme) {
        android.view.Window window = activity.getWindow();
        window.setStatusBarColor(theme.bg);
        window.setNavigationBarColor(theme.bg);
        int flags = window.getDecorView().getSystemUiVisibility();
        flags &= ~android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (!theme.dark) flags |= android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        window.getDecorView().setSystemUiVisibility(flags);
    }
}
