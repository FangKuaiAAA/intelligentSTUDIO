/**
 * 本地最小化的 chrome.* 类型声明。
 *
 * 为什么不用 @types/chrome：扩展工程刻意不引入额外安装（依赖直接复用主项目 node_modules），
 * 这里只声明本扩展真正用到的 API，够用且不引入版本漂移。
 */
declare namespace chrome {
  namespace runtime {
    const id: string
    function getURL(path?: string): string
    function getManifest(): { version: string; name: string }
    function getPlatformInfo(): Promise<{ os: string; arch: string }>
    function sendMessage(message: unknown): Promise<unknown>
    const onMessage: {
      addListener(callback: (message: any, sender: MessageSender, sendResponse: (response?: any) => void) => void | boolean): void
      removeListener(callback: (message: any, sender: MessageSender, sendResponse: (response?: any) => void) => void | boolean): void
    }
    function connect(info: { name?: string }): Port
    const onConnect: { addListener(callback: (port: Port) => void): void }
    const lastError: { message?: string } | undefined

    interface MessageSender {
      tab?: tabs.Tab
      url?: string
      id?: string
    }

    interface Port {
      name: string
      sender?: MessageSender
      postMessage(message: unknown): void
      disconnect(): void
      onMessage: { addListener(cb: (message: any) => void): void }
      onDisconnect: { addListener(cb: () => void): void }
    }
  }

  namespace tabs {
    const TAB_ID_NONE: number
    /** 未加入任何分组的标签页的 groupId */
    const TAB_GROUP_ID_NONE: number

    interface Tab {
      id?: number
      windowId?: number
      index?: number
      title?: string
      url?: string
      active?: boolean
      pinned?: boolean
      audible?: boolean
      discarded?: boolean
      groupId?: number
      favIconUrl?: string
    }

    interface QueryInfo {
      active?: boolean
      currentWindow?: boolean
      lastFocusedWindow?: boolean
      windowId?: number
      index?: number
      pinned?: boolean
    }

    function query(info: QueryInfo): Promise<Tab[]>
    function get(tabId: number): Promise<Tab>
    function sendMessage(tabId: number, message: unknown): Promise<unknown>
    function create(props: { url?: string; active?: boolean; windowId?: number; index?: number }): Promise<Tab>
    function update(tabId: number, props: { active?: boolean; pinned?: boolean }): Promise<Tab>
    function remove(tabIds: number | number[]): Promise<void>
    function move(tabIds: number | number[], props: { windowId?: number; index?: number }): Promise<Tab[]>
    function captureVisibleTab(windowId?: number, options?: { format?: 'png' | 'jpeg'; quality?: number }): Promise<string>
    function group(options: { tabIds: number | number[]; groupId?: number; createProperties?: { windowId?: number } }): Promise<number>
    function ungroup(tabIds: number | number[]): Promise<void>

    const onCreated: { addListener(cb: (tab: Tab) => void): void }
    const onRemoved: { addListener(cb: (tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void): void }
    const onUpdated: {
      addListener(cb: (tabId: number, info: { status?: string; url?: string; pinned?: boolean; groupId?: number; title?: string }, tab: Tab) => void): void
    }
    const onMoved: { addListener(cb: (tabId: number, info: { windowId: number; fromIndex: number; toIndex: number }) => void): void }
    const onAttached: { addListener(cb: (tabId: number, info: unknown) => void): void }
    const onDetached: { addListener(cb: (tabId: number, info: unknown) => void): void }
  }

  namespace tabGroups {
    const TAB_GROUP_ID_NONE: number
    interface TabGroup {
      id: number
      title?: string
      color: string
      collapsed: boolean
      windowId: number
    }
    function get(groupId: number): Promise<TabGroup>
    function query(queryInfo: { windowId?: number; collapsed?: boolean }): Promise<TabGroup[]>
    function update(groupId: number, props: { title?: string; color?: string; collapsed?: boolean }): Promise<TabGroup>
  }

  namespace windows {
    const WINDOW_ID_CURRENT: number
    interface Window {
      id?: number
      focused: boolean
      tabs?: tabs.Tab[]
    }
    function getLastFocused(getInfo?: { populate?: boolean }): Promise<Window>
    function getAll(getInfo?: { populate?: boolean }): Promise<Window[]>
  }

  namespace bookmarks {
    interface BookmarkTreeNode {
      id: string
      parentId?: string
      index?: number
      url?: string
      title: string
      dateAdded?: number
      children?: BookmarkTreeNode[]
    }
    function getTree(): Promise<BookmarkTreeNode[]>
    function create(bookmark: { parentId?: string; index?: number; title?: string; url?: string }): Promise<BookmarkTreeNode>
    function move(id: string, destination: { parentId?: string; index?: number }): Promise<BookmarkTreeNode>
    function remove(id: string): Promise<void>
    function search(query: string | { title?: string; url?: string }): Promise<BookmarkTreeNode[]>

    const onCreated: { addListener(cb: (id: string, node: BookmarkTreeNode) => void): void }
    const onRemoved: { addListener(cb: (id: string, info: { parentId: string; index: number; node: BookmarkTreeNode }) => void): void }
    const onChanged: { addListener(cb: (id: string, info: { title: string; url?: string }) => void): void }
    const onMoved: { addListener(cb: (id: string, info: { parentId: string; index: number; oldParentId: string; oldIndex: number }) => void): void }
  }

  namespace scripting {
    interface InjectionTarget {
      tabId: number
      allFrames?: boolean
    }
    interface InjectionResult<T> {
      frameId: number
      result: T
    }
    function executeScript<T = unknown>(injection: {
      target: InjectionTarget
      files?: string[]
      func?: (...args: any[]) => T
      args?: unknown[]
      world?: 'ISOLATED' | 'MAIN'
    }): Promise<InjectionResult<T>[]>
  }

  namespace storage {
    namespace local {
      function get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, any>>
      function set(items: Record<string, unknown>): Promise<void>
      function remove(keys: string | string[]): Promise<void>
    }
  }

  namespace action {
    function setBadgeText(details: { text: string }): Promise<void>
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>
    function setTitle(details: { title: string }): Promise<void>
  }
}
