# ADR 0003 — Host rules name device codes, and a code names one file

- 状态：已采纳
- 日期：2026-11-26

## 背景

同一份 `~/.pi/agent/settings.json` 会跟着 dotfiles 同步到家里和公司的电脑，但两边的上下文并不一样：

- 公司机器要带上内网/业务线相关的约定（`AGENTS-kfCode.md`）
- 家里机器要带上个人项目的约定（`AGENTS-homeCode.md`）
- 一台机器可以同时属于多种场景，一个场景也覆盖多台机器

`extraContext.files` + `includes` 只能表达「这个项目要哪些标签」，表达不了「这台机器是谁」。而 `includes` 写在项目级的 `.pi/settings.json` 里、跟着仓库走，拿它来编码「机器身份」会让配置跟着错误的维度传播。

另一个约束来自文件名：上下文文件必须能被静态地看出来源。`AGENTS-<code>.md` 这样的名字比在 `files` 数组里再登记一次要少一步，也少一处会与磁盘不一致的重复声明。

## 决定

配置写在**全局** `~/.pi/agent/settings.json` 的 `extraContext.hostRules`，是一个扁平规则表：

```json
{
  "extraContext": {
    "hostRules": [
      { "host": "desktop-3ubepm3", "codes": ["kfCode"] },
      { "host": "home-pc", "codes": ["homeCode", "kfCode"] }
    ]
  }
}
```

- **多对多**：一条规则可以带多个 code（一台机器多种场景），同一个 code 可以出现在多条规则里（一种场景多台机器）。
- **主机名口径唯一**：两侧都用 `normalizeDeviceName()`（小写、非 `[a-z0-9._-]` 折成 `-`、去掉首尾 `-.`），`PI_DEVICE_NAME` 优先生效。配置里写 `DESKTOP-3UBEPM3` 或 `desktop-3ubepm3` 等价。
- **代码即文件名**：命中的 code 直接对应 `~/.pi/agent/AGENTS-<code>.md`，不在 `files` 里登记；文件存在就注入，不存在就跳过。
- **错配不静默**：命中的 code 找不到文件时不注入，但记入缺失列表，`/extra-files show` 以 ⚠️ 列出，避免文件名打错被当成「这台机器没配置」。
- **code 是文件名的一部分**：只接受 `[a-z0-9][a-z0-9._-]*` 且不含 `..`，其余一律丢弃——配置错误不能变成路径穿越。
- **只读全局、只读一处**：`hostRules` 只从全局 settings 读取。主机身份是机器事实，写进项目 settings 会随仓库传播到别的机器上，没有意义。

注入顺序：全局 `files` → 主机文件 → 项目 `files`，同一路径只加载一次。

## 备选方案与放弃原因

- **以 hostname 为键**（`"devices": {"pc-a": ["kfCode"]}`）：读起来最贴近「hostname → code」，但反查「这个 code 覆盖哪些机器」要扫全表，且增删一台机器得改多处。
- **code 并入 `includes` 复用标签机制**：改动最小，但同一个 code 会有两种语义（机器命中 / 项目声明），排障时无法从配置判断某个文件为什么被加载。
- **同时支持约定文件与标签**：功能最全，行为最难讲清，README 与 `/extra-files` 都要解释两遍。
- **原始 hostname 精确匹配**：少一次归一化，但 Windows 与 Git-Bash 的大小写、`PI_DEVICE_NAME` 覆盖都会造成静默不命中。
- **支持 `desk-*` 通配**：省几条规则，代价是要定义通配语义与多条命中时的合并顺序，当前机器量级用不上。

## 后果

- 换机器、加场景只改一处配置或只丢一个文件，不动 `files` 数组。
- 归一化只在一处实现：`normalizeDeviceName()` 同时服务用量统计的设备名与主机规则，两条路径不会各说各话。
- 机器重名（WSL 与宿主同名）依靠 `PI_DEVICE_NAME` 区分，与 ADR 0001 的做法保持一致。
- `hostRules` 解析失败或条目畸形时整条规则被丢弃，不会退化成「全部注入」。
