using System;
using System.Collections.Generic;
using System.Numerics;
using Microsoft.UI;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;
using Windows.System;
using Windows.UI;

namespace Dony.Controls;

/// <summary>
/// Dony 应用内的对话输入框（按 rainbow-loading-pill 技能配方实现）。
///
/// 技能原实现是 CSS + SVG。WinUI3 的 Composition 少了几样东西，做了等价替代：
///   1) 没有 conic-gradient → 彩虹改成「方向持续旋转的线性渐变」（StartPoint/EndPoint 走 Vector2 关键帧）；
///   2) StrokeDashArray 是集合、不能插值 → 光边的「边走边伸缩」用同一相位下的两个长度档
///      （短+粗 = 圆头态、长+细 = 长边态）交叉淡入实现，dashoffset 仍按技能的速度曲线跑；
///   3) 没有可用的高斯模糊（ShapeVisual 无 Shadow）→ 「中间实、外圈散」改为同一条虚线叠
///      多层递增宽度、递减透明度的描边，横截面等效于模糊。
/// 其余照搬：bleed 2px、MIN_SPEED 0.15 的三次速度曲线、每段 6 子段采样、同相位、四段各 25%、
/// 光边压在磨砂面之下（靠遮挡去掉内圈）、彩虹 12s 一圈、光边 3s 一圈、淡入 110ms / 淡出 130ms。
/// </summary>
public sealed partial class GlowChatBox : UserControl
{
    // ⚠ 需求：输入框上不要任何彩虹与加载光边 —— 整支视觉通路的**总开关**（见 SetupComposition）。
    //   用 static readonly 而不是 const：编译器无法据此判定"后续代码不可达" ⇒ 不产生 CS0162 警告，
    //   运行时会被折叠掉（零开销）。想恢复彩虹/光边：把这里改回 true 即可（其余代码一行未动）。
    private static readonly bool GlowEnabled = false;

    // ---- 技能参数（rainbow-pill.css / .js 一一对应）----
    private const float Bleed = 2f;              // --rb-bleed
    private const double RainbowSeconds = 12.0;  // --rb-rainbow-duration
    private const double EdgeSeconds = 3.0;      // --rb-edge-duration
    private const double MinSpeed = 0.15;        // MIN_SPEED（峰值速度 = 3 − 2b = 2.7）
    private const float LongThin = 1.8f;    // 长边态最细档（技能为 0.263px，无模糊太瘦）
    private const float LongThick = 5.5f;   // 长边态最粗档
    private const float CapThin = 4.5f;     // 圆头态最细档
    private const float CapThick = 17.0f;   // 圆头态最粗档

    /// <summary>横截面分档：宽度由细到宽、透明度由实到散（等效技能的 BLUR_STD 四层）。
    /// 技能原值是子像素宽度（0.26–1.4px），靠高斯模糊才看得见；这里没有模糊，所以整体加粗。
    /// 浓度刻意压低：柔光应当像「光扫过材质」，不该是一条硬白线。</summary>
    private static readonly float[] TierT = { 0f, 0.2f, 0.4f, 0.6f, 0.8f, 1f };
    private static readonly float[] TierAlpha = { 0.50f, 0.34f, 0.22f, 0.15f, 0.10f, 0.07f };

    // 彩虹：压低浓度 + 少量往白里混，避免霓虹；只让它从胶囊边缘渗出
    private const float RainbowAlpha = 0.30f;    // 单层浓度（克制：只做材质边缘的光晕）
    private const float RainbowDesat = 0.22f;    // 往白里混的比例（避免霓虹）
    /// <summary>彩虹的四层（外扩像素, 浓度系数）—— 多层淡出 = 边缘光晕，代替 blur(8px)</summary>
    private static readonly (float inset, float scale)[] RainbowLayers =
        { (2f, 1f), (5f, 0.52f), (9f, 0.26f), (14f, 0.11f) };

    private static readonly Color[] RainbowHues =
    {
        Color.FromArgb(255, 255, 50, 60),
        Color.FromArgb(255, 180, 50, 255),
        Color.FromArgb(255, 30, 60, 200),
        Color.FromArgb(255, 255, 220, 50),
        Color.FromArgb(255, 255, 140, 30),
        Color.FromArgb(255, 255, 50, 60),
    };

    /// <summary>一个长度档（短粗 / 长细），由多个宽度分档的描边组成。</summary>
    private sealed class Variant
    {
        public readonly List<CompositionSpriteShape> Shapes = new();
        public readonly List<CompositionColorBrush> Brushes = new();
        public readonly List<float> BaseThickness = new();
    }

    private Compositor? _comp;
    private ContainerVisual? _host;
    private ContainerVisual? _edgeContainer;
    private ShapeVisual? _edgeVisual;
    private CompositionRoundedRectangleGeometry? _edgeGeo;
    private readonly Variant[] _variants = { new(), new() };   // 0 = 圆头态（短粗），1 = 长边态（长细）

    /// <summary>彩虹的一层（多层淡出 = 边缘渗出，代替 blur(8px)）。</summary>
    private sealed class RainbowLayer
    {
        public ShapeVisual Visual = null!;
        public CompositionSpriteShape Shape = null!;
        public CompositionRoundedRectangleGeometry Geo = null!;
        public float Inset;
    }

    private readonly RainbowLayer[] _rainbow = new RainbowLayer[RainbowLayers.Length];

    private bool _loading;
    private bool _ready;
    private bool _animations = true;   // 系统「减少动画」设置
    private double _lastW, _lastH, _lastPillW, _lastPillH;
    private float _pathLen, _longLen, _capLen, _center0;

    /// <summary>用户提交消息（回车或点击发送）。</summary>
    public event EventHandler<string>? Submitted;

    public GlowChatBox()
    {
        InitializeComponent();
        ActualThemeChanged += (_, _) => ApplyTheme();
        ApplyTheme();
    }

    public string Text
    {
        get => Input.Text;
        set
        {
            Input.Text = value ?? "";
            Input.SelectionStart = Input.Text.Length;
        }
    }

    public string Placeholder
    {
        get => Input.PlaceholderText;
        set => Input.PlaceholderText = value;
    }

    /// <summary>加载状态：显示加载光边、禁用输入。</summary>
    public bool IsLoading
    {
        get => _loading;
        set
        {
            if (_loading == value) return;
            _loading = value;
            Input.IsEnabled = !value;
            SendButton.IsEnabled = !value && IsEnabled;
            SendText.Visibility = value ? Visibility.Collapsed : Visibility.Visible;
            SendRing.Visibility = value ? Visibility.Visible : Visibility.Collapsed;
            SendRing.IsActive = value;
            SetStatus(value ? "正在思考…" : null);

            // 技能：淡入 110ms、淡出 130ms
            if (_ready && _edgeContainer is not null)
                FadeEdge(value ? 1f : 0f, value ? 0.11f : 0.13f);
        }
    }

    /// <summary>设置加载期间的提示（如“正在执行：读取系统状态”）；传 null 收起。</summary>
    public void SetStatus(string? label)
    {
        // 始终保留这一行（只用空文字），避免出现/消失时把胶囊挤得上下跳
        StatusText.Text = string.IsNullOrWhiteSpace(label) ? "" : label;
    }

    public void FocusInput() => Input.Focus(FocusState.Programmatic);

    // ---------- 磨砂面（技能 .rb-pill-surface，浓度略提高：彩虹只作边缘渗出）----------
    private void ApplyTheme()
    {
        var dark = ActualTheme == ElementTheme.Dark;
        // 材质：不透明-ish 的磨砂面 + 顶亮底暗的 1px 边（光从上方打在材质上）
        Pill.Background = new SolidColorBrush(dark
            ? Color.FromArgb(0xD8, 0x28, 0x28, 0x2E)
            : Color.FromArgb(0xC4, 0xFF, 0xFF, 0xFF));

        var edge = new LinearGradientBrush
        {
            StartPoint = new Point(0, 0),
            EndPoint = new Point(0, 1),
        };
        var top = dark ? Color.FromArgb(0x30, 0xFF, 0xFF, 0xFF) : Color.FromArgb(0x66, 0xFF, 0xFF, 0xFF);
        var bottom = dark ? Color.FromArgb(0x10, 0xFF, 0xFF, 0xFF) : Color.FromArgb(0x22, 0xFF, 0xFF, 0xFF);
        edge.GradientStops.Add(new GradientStop { Offset = 0, Color = top });
        edge.GradientStops.Add(new GradientStop { Offset = 1, Color = bottom });
        Pill.BorderBrush = edge;

        // 材质深度：给胶囊一层柔和投影（与内容层拉开层次）
        try
        {
            Pill.Shadow = new ThemeShadow();
            Pill.Translation = new Vector3(0, 0, 12);
        }
        catch { /* 旧系统忽略 */ }
    }

    /// <summary>系统是否允许动画（对应 prefers-reduced-motion）：关掉时只保留静态光边。</summary>
    private static bool AnimationsEnabled()
    {
        try { return new Windows.UI.ViewManagement.UISettings().AnimationsEnabled; }
        catch { return true; }
    }

    // ---------- 挂载 ----------
    private void Root_Loaded(object sender, RoutedEventArgs e)
    {
        _animations = AnimationsEnabled();
        SetupComposition();
        SetupPressFeedback();
        UpdateGeometry();
    }

    /// <summary>按压缩放反馈（技能：按下去立刻有回应，100–160ms ease-out）。</summary>
    private void SetupPressFeedback()
    {
        void To(float target) => ScaleVisual(ElementCompositionPreview.GetElementVisual(SendButton), target);
        SendButton.PointerPressed += (_, _) => To(0.96f);
        SendButton.PointerReleased += (_, _) => To(1f);
        SendButton.PointerCanceled += (_, _) => To(1f);
        SendButton.PointerCaptureLost += (_, _) => To(1f);
    }

    private void ScaleVisual(Visual visual, float target)
    {
        visual.CenterPoint = new Vector3((float)SendButton.ActualWidth / 2.0f,
                                        (float)SendButton.ActualHeight / 2.0f, 0f);
        if (!_animations || _comp is null)
        {
            visual.Scale = new Vector3(target, target, 1f);
            return;
        }
        try
        {
            var anim = _comp.CreateVector3KeyFrameAnimation();
            anim.InsertKeyFrame(1f, new Vector3(target, target, 1f));
            anim.Duration = TimeSpan.FromMilliseconds(target < 1f ? 100 : 140);
            visual.StartAnimation("Scale", anim);
        }
        catch
        {
            visual.Scale = new Vector3(target, target, 1f);
        }
    }

    private void Root_SizeChanged(object sender, SizeChangedEventArgs e) => UpdateGeometry();

    private void SetupComposition()
    {
        // ⚠ 早退 ⇒ 一个 Composition 视觉都不创建。连带效果（都不需要额外改动）：
        //   · 本方法末尾的 `_ready = true` 不会执行 ⇒ _ready 恒为 false
        //     ⇒ UpdateGeometry() 立即早退 ⇒ 彩虹四层与光边两档都不创建、两条关键帧动画都不启动；
        //   · IsLoading 里的 FadeEdge 原本就有 `_comp is null || _edgeContainer is null` 守卫
        //     ⇒ 直接 no-op。
        // 换句话说：彩虹与加载光边**整支通路**都不再存在运行时开销，其余交互（输入、发送、
        // 忙碌转圈、按压缩放反馈、磨砂面与投影）全部照旧。
        if (!GlowEnabled) return;
        if (_comp is not null) return;
        _comp = ElementCompositionPreview.GetElementVisual(GlowHost).Compositor;

        // 挂在 GlowHost 上：它在胶囊之前，所以彩虹与光边的内圈会被磨砂面遮住
        _host = _comp.CreateContainerVisual();
        ElementCompositionPreview.SetElementChildVisual(GlowHost, _host);

        // 光边（最底层；内圈会被磨砂面遮住，只留向框外溢出的光）
        _edgeContainer = _comp.CreateContainerVisual();
        _edgeContainer.Opacity = 0f;
        _host.Children.InsertAtTop(_edgeContainer);

        _edgeGeo = _comp.CreateRoundedRectangleGeometry();
        _edgeVisual = _comp.CreateShapeVisual();
        _edgeContainer.Children.InsertAtTop(_edgeVisual);

        for (var v = 0; v < 2; v++)
        {
            var wide = v == 0;                       // 0 = 圆头态（短且粗），1 = 长边态（长且细）
            for (var i = 0; i < TierT.Length; i++)
            {
                var shape = _comp.CreateSpriteShape(_edgeGeo);
                // 浓度分档烘进颜色本身（CompositionBrush 在 WinUI3 里没有 Opacity 可动画）
                var brush = _comp.CreateColorBrush(
                    Color.FromArgb((byte)Math.Round(TierAlpha[i] * 255), 0xFF, 0xFF, 0xFF));
                shape.StrokeBrush = brush;
                var baseThickness = wide
                    ? Lerp(CapThin, CapThick, TierT[i])
                    : Lerp(LongThin, LongThick, TierT[i]);
                shape.StrokeThickness = baseThickness;
                shape.StrokeStartCap = CompositionStrokeCap.Round;
                shape.StrokeEndCap = CompositionStrokeCap.Round;
                _edgeVisual.Shapes.Add(shape);
                _variants[v].Shapes.Add(shape);
                _variants[v].Brushes.Add(brush);
                _variants[v].BaseThickness.Add(baseThickness);
            }
        }

        // 彩虹底层（在光边之上、磨砂面之下）：多层淡出，只从胶囊边缘渗出
        for (var i = 0; i < RainbowLayers.Length; i++)
        {
            var (inset, scale) = RainbowLayers[i];
            var layer = new RainbowLayer { Inset = inset };
            layer.Visual = _comp.CreateShapeVisual();
            layer.Geo = _comp.CreateRoundedRectangleGeometry();
            layer.Shape = _comp.CreateSpriteShape(layer.Geo);
            layer.Shape.FillBrush = BuildRainbowBrush(scale);
            layer.Visual.Shapes.Add(layer.Shape);
            _host.Children.InsertAtTop(layer.Visual);
            _rainbow[i] = layer;
        }

        _ready = true;
    }

    /// <summary>彩虹笔刷：往白里混一点去霓虹，再按层浓淡缩 alpha。</summary>
    private CompositionLinearGradientBrush BuildRainbowBrush(float alphaScale = 1f)
    {
        var brush = _comp!.CreateLinearGradientBrush();
        brush.MappingMode = CompositionMappingMode.Relative;
        foreach (var hue in RainbowHues)
        {
            var r = (byte)Math.Round(hue.R + (255 - hue.R) * RainbowDesat);
            var g = (byte)Math.Round(hue.G + (255 - hue.G) * RainbowDesat);
            var b = (byte)Math.Round(hue.B + (255 - hue.B) * RainbowDesat);
            var a = (byte)Math.Clamp(Math.Round(RainbowAlpha * alphaScale * 255), 0, 255);
            brush.ColorStops.Add(_comp.CreateColorGradientStop(0f, Color.FromArgb(a, r, g, b)));
        }
        for (var i = 0; i < RainbowHues.Length; i++)
            brush.ColorStops[i].Offset = (float)i / (RainbowHues.Length - 1);
        StartRainbowAnimation(brush);
        return brush;
    }

    private static float Lerp(float a, float b, float t) => a + (b - a) * t;

    // ---------- 几何（移植 computeGeometry）----------
    private void UpdateGeometry()
    {
        if (!_ready || _edgeGeo is null) return;
        var w = GlowHost.ActualWidth;
        var h = GlowHost.ActualHeight;
        var pillW = Pill.ActualWidth;
        var pillH = Pill.ActualHeight;
        if (w < 40 || h < 40 || pillW < 40 || pillH < 24) return;
        if (Math.Abs(w - _lastW) < 0.5 && Math.Abs(h - _lastH) < 0.5
            && Math.Abs(pillW - _lastPillW) < 0.5 && Math.Abs(pillH - _lastPillH) < 0.5) return;
        _lastW = w; _lastH = h; _lastPillW = pillW; _lastPillH = pillH;

        var origin = Pill.TransformToVisual(GlowHost).TransformPoint(new Point(0, 0));

        // 技能：光带中心线 = 卡片边界外扩 bleed；圆角 = 卡片圆角（胶囊即半高）+ bleed
        var radius = (float)Math.Min(pillH / 2 + Bleed, (pillH + 2 * Bleed) / 2);
        var ringW = (float)pillW + 2 * Bleed;
        var ringH = (float)pillH + 2 * Bleed;

        _edgeGeo.Size = new Vector2(ringW, ringH);
        _edgeGeo.CornerRadius = new Vector2(radius, radius);

        // 技能公式：直线段 LONG、端头 CAP、总长 L、两个状态的带长
        var longEdge = Math.Max(0f, ringW - 2 * radius);
        var cap = Math.Max(0f, ringH - 2 * radius) + (float)(Math.PI * radius);
        _pathLen = 2 * longEdge + 2 * cap;
        _longLen = longEdge + cap / 3;
        _capLen = cap * 2 / 3;
        _center0 = 2 * longEdge + 1.5f * cap;      // 起点：左端中点（技能 b0 + capLen/2）

        var offset = new Vector2((float)origin.X - Bleed, (float)origin.Y - Bleed);
        var canvas = new Vector2((float)w, (float)h);
        if (_edgeVisual is not null) _edgeVisual.Size = canvas;
        foreach (var variant in _variants)
        {
            foreach (var shape in variant.Shapes) shape.Offset = offset;
        }
        ApplyDash(_variants[0], _capLen);
        ApplyDash(_variants[1], _longLen);

        foreach (var layer in _rainbow)
        {
            if (layer is null) continue;
            var inset = layer.Inset;
            layer.Geo.Size = new Vector2((float)pillW + inset * 2, (float)pillH + inset * 2);
            var rr = (float)Math.Min(pillH / 2 + inset, (pillH + inset * 2) / 2);
            layer.Geo.CornerRadius = new Vector2(rr, rr);
            layer.Shape.Offset = new Vector2((float)origin.X - inset, (float)origin.Y - inset);
            layer.Visual.Size = canvas;
        }

        StartEdgeAnimation();
    }

    private void ApplyDash(Variant variant, float len)
    {
        if (_pathLen <= 1) return;
        foreach (var shape in variant.Shapes)
        {
            var arr = shape.StrokeDashArray;
            arr.Clear();
            arr.Add(len);
            arr.Add(Math.Max(0.01f, _pathLen - len));
        }
    }

    // ---------- 动画 ----------
    /// <summary>彩虹：渐变方向持续旋转，12s 一圈（等价技能的 conic 旋转）。</summary>
    private void StartRainbowAnimation(CompositionLinearGradientBrush brush)
    {
        if (_comp is null || !_animations) return;
        const int steps = 8;
        const float r = 0.5f;
        var start = _comp.CreateVector2KeyFrameAnimation();
        var end = _comp.CreateVector2KeyFrameAnimation();
        for (var i = 0; i <= steps; i++)
        {
            var rad = i * 2 * Math.PI / steps;
            var dir = new Vector2((float)Math.Cos(rad), (float)Math.Sin(rad)) * r;
            start.InsertKeyFrame((float)i / steps, new Vector2(0.5f, 0.5f) - dir);
            end.InsertKeyFrame((float)i / steps, new Vector2(0.5f, 0.5f) + dir);
        }
        foreach (var anim in new[] { start, end })
        {
            anim.Duration = TimeSpan.FromSeconds(RainbowSeconds);
            anim.IterationBehavior = AnimationIterationBehavior.Count;
            anim.IterationCount = 100000;
        }
        brush.StartAnimation(nameof(CompositionLinearGradientBrush.StartPoint), start);
        brush.StartAnimation(nameof(CompositionLinearGradientBrush.EndPoint), end);
    }

    /// <summary>
    /// 光边：四段各占 25%（上边 → 右端 → 下边 → 左端）。
    /// 位置：光带中心每段前进 L/4，走技能的三次速度曲线（长边加速、圆头减速，两端速度不为 0）。
    /// 伸缩：两个长度档交叉淡入，且相位中心一致 —— 看起来就是「同一条光带在伸缩」。
    /// </summary>
    private void StartEdgeAnimation()
    {
        if (_comp is null || _pathLen <= 1) return;
        if (!_animations)
        {
            // 减少动画：静态停一段柔光在长边中点，不跑圈
            var still = _center0 + _pathLen / 8f;
            foreach (var (variant, len) in new[] { (_variants[0], _capLen), (_variants[1], _longLen) })
            {
                foreach (var shape in variant.Shapes)
                {
                    shape.StopAnimation(nameof(CompositionSpriteShape.StrokeDashOffset));
                    shape.StopAnimation(nameof(CompositionSpriteShape.StrokeThickness));
                    shape.StrokeDashOffset = -(still - len / 2);
                }
            }
            return;
        }
        const int subs = 6;
        var duration = TimeSpan.FromSeconds(EdgeSeconds);

        // 先按技能算出帧表：(时间, 光带中心位置) 与 (时间, 长度档混合 b)
        var positions = new List<(float t, float center)>();
        var blends = new List<(float t, float b)>();
        for (var seg = 0; seg < 4; seg++)
        {
            var grow = seg % 2 == 0;                 // 0/2 段走长边（变长），1/3 段走圆头（变短）
            for (var k = 0; k <= subs; k++)
            {
                var u = (double)k / subs;
                var s = EaseAccel(u);
                if (!grow) s = 1 - EaseAccel(1 - u);  // 减速段 = 加速段的镜像
                var t = (float)((seg + u) / 4.0);
                positions.Add((t, _center0 + (float)(seg * _pathLen / 4.0) + (float)(_pathLen / 4.0 * s)));
                blends.Add((t, (float)(grow ? s : 1 - s)));   // b = 1 → 长边档
            }
        }

        for (var v = 0; v < 2; v++)
        {
            var variant = _variants[v];
            var len = v == 0 ? _capLen : _longLen;
            for (var i = 0; i < variant.Shapes.Count; i++)
            {
                var offsetAnim = _comp.CreateScalarKeyFrameAnimation();
                var widthAnim = _comp.CreateScalarKeyFrameAnimation();
                foreach (var (t, center) in positions)
                    offsetAnim.InsertKeyFrame(t, -(center - len / 2));
                // 两个长度档靠「粗细」交叉淡入：短档在圆头态最粗、长档在长边态最粗，过渡时此消彼长
                var baseThickness = variant.BaseThickness[i];
                foreach (var (t, b) in blends)
                    widthAnim.InsertKeyFrame(t, baseThickness * (v == 1 ? b : 1 - b));
                foreach (var anim in new[] { offsetAnim, widthAnim })
                {
                    anim.Duration = duration;
                    anim.IterationBehavior = AnimationIterationBehavior.Count;
                    anim.IterationCount = 100000;
                }
                variant.Shapes[i].StartAnimation(nameof(CompositionSpriteShape.StrokeDashOffset), offsetAnim);
                variant.Shapes[i].StartAnimation(nameof(CompositionSpriteShape.StrokeThickness), widthAnim);
            }
        }
    }

    /// <summary>速度曲线 s(u) = (1−b)·u³ + b·u（一次项系数 = 1 − 三次项系数，每段才走得满）。</summary>
    private static double EaseAccel(double u) => (1 - MinSpeed) * u * u * u + MinSpeed * u;

    private void FadeEdge(float to, float seconds)
    {
        if (_comp is null || _edgeContainer is null) return;
        if (!_animations)
        {
            _edgeContainer.Opacity = to;
            return;
        }
        try
        {
            var anim = _comp.CreateScalarKeyFrameAnimation();
            anim.InsertKeyFrame(1f, to);
            anim.Duration = TimeSpan.FromSeconds(seconds);
            _edgeContainer.StartAnimation(nameof(Visual.Opacity), anim);
        }
        catch
        {
            _edgeContainer.Opacity = to;
        }
    }

    // ---------- 交互 ----------
    private void Input_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter)
        {
            e.Handled = true;
            TrySubmit();
        }
    }

    private void Send_Click(object sender, RoutedEventArgs e) => TrySubmit();

    private void TrySubmit()
    {
        if (_loading) return;
        var text = Input.Text?.Trim();
        if (string.IsNullOrEmpty(text)) return;
        Submitted?.Invoke(this, text);
    }
}
