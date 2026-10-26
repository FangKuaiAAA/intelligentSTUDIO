namespace IntelligentStudio.Onboarding.Services;

/// <summary>页面容器与具体页面之间的契约：容器只管切换与按钮，页面负责自己的数据与提交。</summary>
public interface IStepView
{
    /// <summary>重新进入该页时刷新控件状态（返回上一页再回来时不能显示旧值）。</summary>
    void Reload();

    /// <summary>进入该页后开始播放媒体；没有媒体时为空实现。</summary>
    void PlayMedia();

    /// <summary>离开该页时停止并释放媒体，避免多个解码器同时占用。</summary>
    void StopMedia();

    /// <summary>点「继续 / 完成」前提交；返回 false 表示留在本页（例如保存失败）。</summary>
    Task<bool> CommitAsync();
}
