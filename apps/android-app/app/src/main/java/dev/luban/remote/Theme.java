package dev.luban.remote;

import android.app.Activity;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.view.View;

/**
 * One palette for the whole shell.
 *
 * The phone console itself is a web page, so this only owns the native chrome:
 * window bars, the slim status strip, the setup screen and the appearance
 * screen. The resolved palette is also handed to the page as `?theme=` so both
 * sides can never disagree about light versus dark.
 */
final class Theme {
    static final String MODE_DARK = "dark";
    static final String MODE_LIGHT = "light";
    static final String MODE_SYSTEM = "system";

    static final String PREF_MODE = "shell_theme_mode";
    static final String PREF_TEXT_ZOOM = "shell_text_zoom";

    static final int[] TEXT_ZOOMS = {100, 115, 130};
    static final String[] TEXT_ZOOM_LABELS = {"标准", "大", "特大"};

    static final String[] MODES = {MODE_DARK, MODE_LIGHT, MODE_SYSTEM};
    static final String[] MODE_LABELS = {"深色", "浅色", "跟随系统"};

    /** What the user picked: dark, light, or system. */
    final String mode;
    /** The palette in force now, after resolving "system". */
    final boolean dark;
    /** WebView text zoom in percent. */
    final int textZoom;

    final int bg;
    final int panel;
    final int panelAlt;
    final int line;
    final int lineSoft;
    final int fg;
    final int muted;
    final int dim;
    final int accent;
    final int accentSoft;
    final int onAccent;
    final int danger;
    final int success;
    final int scrim;

    private Theme(String mode, boolean dark, int textZoom, int bg, int panel, int panelAlt, int line,
                  int lineSoft, int fg, int muted, int dim, int accent, int accentSoft, int onAccent,
                  int danger, int success, int scrim) {
        this.mode = mode;
        this.dark = dark;
        this.textZoom = textZoom;
        this.bg = bg;
        this.panel = panel;
        this.panelAlt = panelAlt;
        this.line = line;
        this.lineSoft = lineSoft;
        this.fg = fg;
        this.muted = muted;
        this.dim = dim;
        this.accent = accent;
        this.accentSoft = accentSoft;
        this.onAccent = onAccent;
        this.danger = danger;
        this.success = success;
        this.scrim = scrim;
    }

    static boolean systemDark(Configuration configuration) {
        return (configuration.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    static String readMode(SharedPreferences preferences) {
        String stored = preferences.getString(PREF_MODE, MODE_SYSTEM);
        for (String candidate : MODES) {
            if (candidate.equals(stored)) return stored;
        }
        return MODE_SYSTEM;
    }

    static int readTextZoom(SharedPreferences preferences) {
        int stored = preferences.getInt(PREF_TEXT_ZOOM, TEXT_ZOOMS[0]);
        for (int candidate : TEXT_ZOOMS) {
            if (candidate == stored) return stored;
        }
        return TEXT_ZOOMS[0];
    }

    static Theme of(SharedPreferences preferences, Configuration configuration) {
        String mode = readMode(preferences);
        boolean dark = MODE_SYSTEM.equals(mode) ? systemDark(configuration) : MODE_DARK.equals(mode);
        int zoom = readTextZoom(preferences);
        if (dark) {
            return new Theme(mode, true, zoom,
                    Color.rgb(5, 7, 10), Color.rgb(16, 19, 24), Color.rgb(23, 27, 36),
                    Color.rgb(37, 42, 52), Color.rgb(28, 33, 41),
                    Color.rgb(237, 240, 245), Color.rgb(146, 153, 168), Color.rgb(89, 97, 113),
                    Color.rgb(105, 210, 245), Color.argb(0x24, 105, 210, 245), Color.rgb(4, 15, 20),
                    Color.rgb(242, 121, 139), Color.rgb(114, 214, 181), Color.argb(0xCC, 5, 7, 10));
        }
        return new Theme(mode, false, zoom,
                Color.rgb(244, 246, 249), Color.rgb(255, 255, 255), Color.rgb(247, 249, 252),
                Color.rgb(221, 227, 236), Color.rgb(234, 239, 245),
                Color.rgb(16, 20, 27), Color.rgb(91, 101, 115), Color.rgb(138, 148, 163),
                Color.rgb(28, 111, 216), Color.argb(0x1A, 28, 111, 216), Color.rgb(255, 255, 255),
                Color.rgb(192, 43, 70), Color.rgb(15, 138, 99), Color.argb(0xCC, 15, 23, 42));
    }

    /** Window bars follow the palette, including the icon tint. */
    static void apply(Activity activity, Theme theme) {
        activity.getWindow().setStatusBarColor(theme.panel);
        activity.getWindow().setNavigationBarColor(theme.panel);
        View decor = activity.getWindow().getDecorView();
        int flags = decor.getSystemUiVisibility();
        flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        if (!theme.dark) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        decor.setSystemUiVisibility(flags);
    }

    /** `#rrggbb` for `meta[name=theme-color]` and the WebView background. */
    String hex(int color) {
        return String.format("#%06X", 0xFFFFFF & color);
    }

    String pageTheme() {
        return dark ? MODE_DARK : MODE_LIGHT;
    }
}
