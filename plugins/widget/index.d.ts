import type { Plugin, PluginListenerHandle } from '@capacitor/core';

/** A home-screen widget visual spec pushed from web. */
export interface WidgetConfig {
  /**
   * Layout variant. Either a bundled preset ('small' | 'medium' | 'large') or the name of a layout
   * resource your app ships (e.g. 'my_dashboard') for a fully custom RemoteViews design using the
   * same id contract (widget_root/widget_value/widget_title/widget_subtitle/widget_icon/widget_image/
   * widget_progress/widget_button). Gradient/rounded drawables, ImageView and Button are all supported.
   */
  layout?: 'small' | 'medium' | 'large' | (string & {});
  /** Big headline text (e.g. a count, time, temperature). */
  value?: string;
  /** Heading above the value. */
  title?: string;
  /** Supporting line under the value. */
  subtitle?: string;
  /** Hex background color, e.g. "#0F172A". */
  backgroundColor?: string;
  /** Hex value color. Alias of `accentColor` (kept for parity with the floating options). */
  valueColor?: string;
  /** Hex accent (value) color, e.g. "#2563EB". */
  accentColor?: string;
  /** Hex title color (default white). */
  titleColor?: string;
  /** Hex subtitle color (default slate). */
  subtitleColor?: string;
  /** Hex action-button background (default "#1E293B"). */
  buttonColor?: string;
  /** Hex action-button text color (default white). */
  buttonTextColor?: string;
  /** Value text size in sp (default is the layout's size). */
  valueSize?: number;
  /** Title text size in sp. */
  titleSize?: number;
  /** Subtitle text size in sp. */
  subtitleSize?: number;
  /** Horizontal content alignment: 'start' | 'center' (default) | 'end'. */
  align?: 'start' | 'center' | 'end';
  /** Progress/level value 0..progressMax drawn as a horizontal bar (medium/large layouts). */
  progress?: number;
  /** Max of the progress bar (default 100). */
  progressMax?: number;
  /** Emoji/glyph shown as the header icon (optional). */
  icon?: string;
  /** A drawable resource name (bundled in your app) shown via an ImageView (@+id/widget_image). */
  image?: string;
  /** A base64 PNG/JPEG (optionally a "data:" URI) decoded to a Bitmap and shown via ImageView. */
  imageData?: string;

  /**
   * Render mode for the home-screen widget. 'native' (default) draws the preset RemoteViews.
   * 'html' renders an inline `html` string or a bundled `page` (your HTML/CSS/JS) to a snapshot
   * bitmap shown full-bleed. NOTE: this is a static snapshot (re-update to refresh), not a live,
   * interactive WebView — that only exists on the floating overlay.
   */
  render?: 'native' | 'html';
  /** Inline HTML used when render:'html' (overrides page). Rendered via an offscreen WebView. */
  html?: string;
  /** Base URL for relative assets in `html` (default the asset-loader host). */
  htmlBaseUrl?: string;
  /** Untrusted self-contained artifact mode: blocks network/file/content access and uses an isolated base URL. */
  sandboxed?: boolean;
  /** Snapshot render size in px (default 320x320); scaled to the widget by fitXY. */
  widthPx?: number;
  heightPx?: number;
  /** Tap a dedicated action button. Any string the host app maps to a callback. */
  action?: string;
  /** Payload handed to the action callback. */
  actionValue?: string;
  /** Label for the action button (default "Open"). */
  buttonLabel?: string;
  /**
   * Optional free-form metadata. NOTE: the home-screen widget is drawn with native Android
   * RemoteViews (TextView-only, rendered by the launcher), which cannot render arbitrary keys.
   * Pass the known layout fields directly (value/title/subtitle/icon/colors/action/buttonLabel)
   * instead. Use a custom floating page for full HTML/CSS/JS design.
   */
  extra?: Record<string, unknown>;
}

export interface FloatingWidgetOptions {
  /** Bubble header title (also the FGS notification title). */
  title?: string;
  /** Optional asset path to load into the bubble's WebView (relative to public/). Default "widgets/floating.html". */
  page?: string;
  /** Inline HTML for the WebView. Overrides `page` when set; base URL is the asset-loader host so relative ./assets resolve. */
  html?: string;
  /** Bubble size in dp (Android). Ignored when `fullscreen` is true. */
  width?: number;
  height?: number;
  /** Start collapsed to the small draggable bubble. */
  collapsed?: boolean;
  /** Fill the whole screen (MATCH_PARENT) instead of a fixed-size bubble. Hides the native header. */
  fullscreen?: boolean;
  /** True => the overlay can take input focus (typing/IME). Default false. */
  focusable?: boolean;
  /** True => FLAG_NOT_TOUCHABLE pass-through overlay (a passive badge). Default false. */
  touchThrough?: boolean;
  /** 'bar' (default) shows the native header; 'none' hides it for a pure-HTML design. */
  chrome?: 'bar' | 'none';
  /** Whether the bubble can be dragged (drag only via the native header). Default true. */
  draggable?: boolean;
  /** Start position / anchor. */
  position?: {
    /** top (default) | center | bottom. */
    gravity?: 'top' | 'center' | 'bottom';
    /** start (default) | center | end. */
    align?: 'start' | 'center' | 'end';
    /** dp offset from the anchor (edge-relative). */
    x?: number;
    y?: number;
    /** dp margin from the screen edge — used when x/y are omitted. */
    marginX?: number;
    marginY?: number;
  };
  /** Untrusted artifact mode: no network/file/content access and no NativeKitFloating JS interface. */
  sandboxed?: boolean;
  /** Initial data posted into the floating page. */
  data?: unknown;
}

export interface NativeKitWidgetPlugin extends Plugin {
  setConfig(options: { kind: string; config: WidgetConfig }): Promise<{ kind: string; saved: boolean }>;
  getConfig(options: { kind: string }): Promise<{ kind: string; config: WidgetConfig | null }>;
  listConfigs(): Promise<Record<string, WidgetConfig>>;
  getWidgetIds(options: { kind: string }): Promise<{ ids: number[] }>;
  reload(options?: { kind?: string }): Promise<{ updated: number }>;
  requestPin(options: { kind: string }): Promise<{ requested: boolean; hint?: string }>;
  checkOverlayPermission(): Promise<{ granted: boolean }>;
  requestOverlayPermission(): Promise<void>;
  showFloating(options?: FloatingWidgetOptions): Promise<{ running: boolean; shown: boolean; error?: string }>;
  hideFloating(): Promise<void>;
  isFloatingVisible(): Promise<{ visible: boolean; error?: string }>;
  updateFloating(options?: Partial<FloatingWidgetOptions>): Promise<{ delivered: boolean; running: boolean; shown: boolean }>;
  runFloatingJavascript(options: { script: string }): Promise<{ delivered: boolean; running: boolean }>;
  sendToFloating(options: { data: unknown }): Promise<{ delivered: boolean; running: boolean; shown: boolean }>;
  addListener(
    eventName: 'nativeWidgetTap' | 'nativeFloatingMessage',
    listenerFunc: (event: any) => void,
  ): Promise<PluginListenerHandle>;
}

export declare const Widget: NativeKitWidgetPlugin;
