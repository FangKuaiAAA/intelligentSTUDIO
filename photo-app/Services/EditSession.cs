using System;
using Windows.Graphics.Imaging;

namespace PhotoEditor.Services;

public enum EditStage
{
    // 仅用于标记结果来源与撤销历史，不再决定依赖顺序。
    // 各面板统一以 EditSession.Latest 为输入，最后提交的那一级即为当前画面。
    Filter = 0,
    Crop = 1,
    Erase = 2,
    Expand = 3,
    Reframe = 4,
}

public sealed class StageResult
{
    public required EditStage Stage { get; init; }
    public required SoftwareBitmap Bitmap { get; init; }
    public object? Parameters { get; init; }
    public DateTime CommittedAt { get; init; } = DateTime.Now;
}

/// <summary>
/// 编辑结果集合。每次提交覆盖本级结果并成为新的 Latest，
/// 各面板读取 Latest 继续编辑，因此「先裁剪再滤镜」与「先滤镜再裁剪」都能叠加。
/// </summary>
public sealed class EditSession
{
    private readonly StageResult?[] _stages = new StageResult?[5];
    private EditStage? _lastStage;

    public SoftwareBitmap? Original { get; private set; }

    public string? SourcePath { get; private set; }

    public FilterSettings PendingFilters { get; set; } = new();

    public CropSettings PendingCrop { get; set; } = new();

    public event Action? Changed;

    /// <summary>某一级提交完成（供撤销/恢复记录快照）。</summary>
    public event Action<EditStage>? Committed;

    public bool HasImage => Original is not null;

    public int Width => Latest?.PixelWidth ?? 0;

    public int Height => Latest?.PixelHeight ?? 0;

    /// <summary>
    /// 当前应显示的位图：以最近一次提交为准，而不是按级别索引取最大值。
    /// 后者会让「先裁剪后滤镜」永远返回裁剪结果，滤镜看起来不生效。
    /// </summary>
    public SoftwareBitmap? Latest
    {
        get
        {
            if (_lastStage is { } stage && _stages[(int)stage] is { } last)
                return last.Bitmap;

            // 最近提交的那一级被撤销后，回退到仍存在的结果
            for (var i = _stages.Length - 1; i >= 0; i--)
                if (_stages[i] is { } result) return result.Bitmap;

            return Original;
        }
    }

    public void Open(SoftwareBitmap bitmap, string? path)
    {
        Reset();
        Original = bitmap;
        SourcePath = path;
        PendingFilters = new FilterSettings();
        PendingCrop = new CropSettings();
        Changed?.Invoke();
    }

    /// <summary>按级别顺序取上游结果。保留给需要固定依赖的调用方。</summary>
    public SoftwareBitmap? InputFor(EditStage stage)
    {
        for (var i = (int)stage - 1; i >= 0; i--)
            if (_stages[i] is { } result) return result.Bitmap;
        return Original;
    }

    /// <summary>本级已有结果时优先用它，否则取上游。</summary>
    public SoftwareBitmap? BaseFor(EditStage stage) => _stages[(int)stage]?.Bitmap ?? InputFor(stage);

    public StageResult? ResultOf(EditStage stage) => _stages[(int)stage];

    public bool HasResult(EditStage stage) => _stages[(int)stage] is not null;

    /// <summary>
    /// 提交某一级结果。不再作废其他级别：
    /// 各面板都基于 Latest 连续烘焙，作废会让反向顺序的操作丢掉上一步。
    /// </summary>
    public void Commit(EditStage stage, SoftwareBitmap bitmap, object? parameters)
    {
        var previous = _stages[(int)stage]?.Bitmap;

        _stages[(int)stage] = new StageResult
        {
            Stage = stage,
            Bitmap = bitmap,
            Parameters = parameters,
        };

        if (previous is not null && !ReferenceEquals(previous, bitmap))
            previous.Dispose();

        _lastStage = stage;

        Changed?.Invoke();
        Committed?.Invoke(stage);
    }

    /// <summary>用历史快照恢复某一级，并把它设为当前显示结果。</summary>
    public void Restore(EditStage stage, SoftwareBitmap bitmap)
    {
        var previous = _stages[(int)stage]?.Bitmap;

        _stages[(int)stage] = new StageResult
        {
            Stage = stage,
            Bitmap = SoftwareBitmap.Copy(bitmap),
        };

        previous?.Dispose();

        _lastStage = stage;
        Changed?.Invoke();
    }

    /// <summary>清除某一级及之后的结果。disposeSelf 为 false 时保留该级自身。</summary>
    public void InvalidateFrom(EditStage stage, bool disposeSelf = true)
    {
        var start = disposeSelf ? (int)stage : (int)stage + 1;

        for (var i = start; i < _stages.Length; i++)
        {
            if (_stages[i] is not { } result) continue;
            result.Bitmap.Dispose();
            _stages[i] = null;
        }

        // 被清掉的那一级如果正是当前显示源，Latest 需要回退到剩余结果
        if (_lastStage is { } last && (int)last >= start)
            _lastStage = null;
    }

    public void Reset()
    {
        for (var i = 0; i < _stages.Length; i++)
        {
            _stages[i]?.Bitmap.Dispose();
            _stages[i] = null;
        }

        Original?.Dispose();
        Original = null;
        SourcePath = null;
        _lastStage = null;
    }
}
