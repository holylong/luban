package dev.luban.app;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Small view factory used by every screen.
 *
 * The console is built from a handful of primitives (card, pill, button, row)
 * so spacing and radii stay consistent; nothing here depends on AppCompat.
 */
final class Ui {
    private final Context context;
    final Theme theme;
    final float scale;

    Ui(Context context, Theme theme, float scale) {
        this.context = context;
        this.theme = theme;
        this.scale = scale;
    }

    int dp(float value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    int sp(float value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value * scale,
                context.getResources().getDisplayMetrics()));
    }

    Drawable shape(int fill, int stroke, float radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.RECTANGLE);
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radiusDp));
        if (stroke != 0) drawable.setStroke(dp(1), stroke);
        return drawable;
    }

    Drawable gradient(int from, int to, float radiusDp) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{from, to});
        drawable.setCornerRadius(dp(radiusDp));
        return drawable;
    }

    Drawable ripple(Drawable content) {
        return new RippleDrawable(ColorStateList.valueOf(theme.dark ? 0x33FFFFFF : 0x1F000000), content, null);
    }

    TextView text(String value, float size, int color, boolean strong) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, sp(size));
        view.setTextColor(color);
        view.setTypeface(strong ? Typeface.create("sans-serif-medium", Typeface.NORMAL) : Typeface.SANS_SERIF);
        view.setLineSpacing(dp(3), 1f);
        return view;
    }

    TextView title(String value) {
        TextView view = text(value, 19, theme.text, true);
        view.setLetterSpacing(-0.01f);
        return view;
    }

    TextView label(String value) {
        TextView view = text(value, 12.5f, theme.dim, true);
        view.setLetterSpacing(0.06f);
        view.setAllCaps(true);
        return view;
    }

    TextView note(String value) {
        return text(value, 12.8f, theme.muted, false);
    }

    LinearLayout column() {
        LinearLayout view = new LinearLayout(context);
        view.setOrientation(LinearLayout.VERTICAL);
        return view;
    }

    LinearLayout row() {
        LinearLayout view = new LinearLayout(context);
        view.setOrientation(LinearLayout.HORIZONTAL);
        view.setGravity(Gravity.CENTER_VERTICAL);
        return view;
    }

    LinearLayout card() {
        LinearLayout view = column();
        int pad = dp(16);
        view.setPadding(pad, dp(14), pad, dp(15));
        view.setBackground(shape(theme.surface, theme.line, 18));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(11);
        view.setLayoutParams(params);
        return view;
    }

    TextView pill(String value, int foreground, int background) {
        TextView view = text(value, 11.5f, foreground, true);
        view.setGravity(Gravity.CENTER);
        view.setSingleLine(true);
        view.setPadding(dp(9), dp(3), dp(9), dp(3));
        view.setBackground(shape(background, 0, 99));
        return view;
    }

    TextView button(String value, boolean primary, View.OnClickListener click) {
        TextView view = text(value, primary ? 15.5f : 14.5f, primary ? theme.onAccent : theme.text, true);
        view.setGravity(Gravity.CENTER);
        view.setMinHeight(dp(46));
        view.setPadding(dp(16), dp(11), dp(16), dp(11));
        view.setBackground(ripple(primary
                ? shape(theme.accent, 0, 14)
                : shape(theme.surfaceAlt, theme.line, 14)));
        view.setOnClickListener(click);
        return view;
    }

    TextView outlineButton(String value, View.OnClickListener click) {
        TextView view = text(value, 14.5f, theme.muted, true);
        view.setGravity(Gravity.CENTER);
        view.setMinHeight(dp(44));
        view.setPadding(dp(14), dp(10), dp(14), dp(10));
        view.setBackground(ripple(shape(0, theme.line, 14)));
        view.setOnClickListener(click);
        return view;
    }

    TextView iconButton(String glyph, View.OnClickListener click) {
        TextView view = text(glyph, 17, theme.text, false);
        view.setGravity(Gravity.CENTER);
        view.setBackground(ripple(shape(theme.surfaceAlt, theme.line, 22)));
        view.setOnClickListener(click);
        view.setLayoutParams(new LinearLayout.LayoutParams(dp(42), dp(42)));
        return view;
    }

    View dot(int color) {
        View view = new View(context);
        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.OVAL);
        shape.setColor(color);
        view.setBackground(shape);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(9), dp(9));
        params.rightMargin = dp(8);
        view.setLayoutParams(params);
        return view;
    }

    View divider() {
        View view = new View(context);
        view.setBackgroundColor(theme.lineSoft);
        view.setLayoutParams(new LinearLayout.LayoutParams(-1, dp(1)));
        return view;
    }

    View gap(int heightDp) {
        View view = new View(context);
        view.setLayoutParams(new LinearLayout.LayoutParams(1, dp(heightDp)));
        return view;
    }

    void weight(View view, float value) {
        LinearLayout.LayoutParams params = view.getLayoutParams() instanceof LinearLayout.LayoutParams
                ? (LinearLayout.LayoutParams) view.getLayoutParams()
                : new LinearLayout.LayoutParams(0, -2);
        params.width = 0;
        params.weight = value;
        view.setLayoutParams(params);
    }

    TextView body(String value, int color) {
        TextView view = text(value, 14.6f, color, false);
        view.setTextIsSelectable(true);
        return view;
    }

    LinearLayout scrollable() {
        LinearLayout view = column();
        int pad = dp(14);
        view.setPadding(pad, dp(12), pad, dp(18));
        return view;
    }

    static void clear(ViewGroup group) {
        group.removeAllViews();
    }

    static String ellipsize(String value, int max) {
        if (value == null) return "";
        String text = value.replace('\n', ' ').trim();
        return text.length() <= max ? text : text.substring(0, Math.max(0, max - 1)) + "…";
    }

    static String join(String separator, String... parts) {
        StringBuilder builder = new StringBuilder();
        for (String part : parts) {
            if (TextUtils.isEmpty(part)) continue;
            if (builder.length() > 0) builder.append(separator);
            builder.append(part);
        }
        return builder.toString();
    }
}
